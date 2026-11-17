(() => {
  "use strict";

  if (typeof window.__gmTimerCleanup === "function") {
    try {
      window.__gmTimerCleanup();
    } catch (_e) {}
  }

  const WIDGET_ID = "gm-duration-timer-widget";
  const STORAGE_KEY_ACTIVE = "gm_timer_active_sessions";
  const STORAGE_KEY_HISTORY = "gm_timer_call_history";
  const STORAGE_KEY_PROFILES = "gm_timer_code_profiles";
  const STORAGE_KEY_SETTINGS = "gm_timer_settings";

  const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

  let currentMeetingCode = null;
  let isInCall = false;
  let isPaused = false;
  let firstStartedAtMs = null;
  let pausedAtMs = null;
  let totalPausedMs = 0;
  let manualOffsetMs = 0;
  let sessionHistoryId = null;

  let classMilestoneNotified = false;
  let warningAlertNotified = false;
  let warningBannerDismissed = false;
  let autoRecPromptDismissed = false;
  let initialBootCheckDone = false;

  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let activeDisplayStream = null;
  let activeMicStream = null;
  let activeAudioCtx = null;
  let activeMixDestination = null;
  let activeAudioNodes = [];
  let hookedTrackIds = new Set();
  let audioMeterAnalyser = null;
  let audioMeterRafId = null;

  let codeProfiles = {};
  let callHistoryCache = [];

  let settings = {
    showOverlay: true,
    minClassMinutes: 35,
    warnMinutes: 70,
    soundAlert: true,
    autoOpenCalendarTab: true,
    autoRecordClass: true,
    autoFocusPresentation: true,
    autoBackupLocalFile: true,
    googleSheetsUrl: "",
    calendarWebhookUrl: "",
    calendarOAuthToken: "",
    position: "top-center",
    customX: null,
    customY: null
  };

  function isExtensionContextValid() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  function safeStorageGet(keys, callback) {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) {
      callback({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (res) => {
        if (chrome.runtime.lastError) {
          callback({});
          return;
        }
        callback(res || {});
      });
    } catch (_e) {
      callback({});
    }
  }

  function safeStorageSet(obj, callback) {
    if (!isExtensionContextValid() || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.set(obj, () => {
        if (typeof callback === "function") callback();
      });
    } catch (_e) {}
  }

  function safeSendRuntimeMessage(payload, callback) {
    if (!isExtensionContextValid() || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) return;
        if (typeof callback === "function") callback(res);
      });
    } catch (_e) {}
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== "hidden";
  }

  function getMeetingCode() {
    const rawPath = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (!rawPath) return null;

    const stdMatchAnywhere = rawPath.match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    if (stdMatchAnywhere) {
      return stdMatchAnywhere[1].toLowerCase();
    }

    const segments = rawPath.split("/").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ignored = new Set(["meet", "landing", "new", "_meet", "whoops", "calling", "lookup"]);

    for (const seg of segments) {
      if (ignored.has(seg)) continue;
      if (/^[a-z0-9-_]{6,64}$/i.test(seg)) {
        return seg.toLowerCase();
      }
    }

    const titleMatch = (document.title || "").match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    if (titleMatch) {
      return titleMatch[1].toLowerCase();
    }

    return null;
  }

  function detectCalendarEventTitleFromMeetDOM() {
    try {
      const selectors = [
        "[data-meeting-title]",
        ".u6vdEc",
        "[jscontroller] [data-tooltip-id][role='heading']"
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const attrTitle = el.getAttribute("data-meeting-title") || el.textContent || "";
          const cleaned = attrTitle.trim();
          if (
            cleaned &&
            cleaned.length > 2 &&
            cleaned.toLowerCase() !== "meeting details" &&
            !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(cleaned)
          ) {
            return cleaned;
          }
        }
      }
    } catch (_e) {}
    return "";
  }

  function focusPresentationInMeetDOM() {
    if (!settings.autoFocusPresentation || !isInCall) {
      document.body.classList.remove("gm-presentation-spotlight-active");
      return;
    }

    try {
      const videos = Array.from(document.querySelectorAll("video")).filter((v) => isElementVisible(v) && v.videoWidth > 0);
      let presentationVideo = null;

      for (const v of videos) {
        const tile = v.closest("[data-participant-id], [data-allocation-index], [jscontroller]");
        const tileText = tile ? (tile.innerText || "").toLowerCase() : "";
        if (
          v.videoWidth >= 960 ||
          tileText.includes("presenting") ||
          tileText.includes("your screen") ||
          tileText.includes("presentation")
        ) {
          presentationVideo = v;
          break;
        }
      }

      if (presentationVideo) {
        document.body.classList.add("gm-presentation-spotlight-active");
        const tile = presentationVideo.closest("[data-participant-id], [data-allocation-index]");
        if (tile) {
          tile.classList.add("gm-presentation-focused-tile");
          const pinBtn = tile.querySelector('button[aria-label*="Pin" i]:not([aria-label*="Unpin" i])');
          if (pinBtn && !tile.dataset.gmAutoPinned) {
            tile.dataset.gmAutoPinned = "true";
            pinBtn.click();
          }
        }
      } else {
        document.body.classList.remove("gm-presentation-spotlight-active");
      }
    } catch (_e) {}
  }

  function attachMeetParticipantAudioStreamsToMixer() {
    if (!isRecording || !activeAudioCtx || !activeMixDestination) return;

    if (activeAudioCtx.state === "suspended") {
      activeAudioCtx.resume().catch(() => {});
    }

    const mediaElements = document.querySelectorAll("audio, video");
    for (const el of mediaElements) {
      try {
        let stream = el.srcObject;
        if (!stream && typeof el.captureStream === "function") {
          stream = el.captureStream();
        } else if (!stream && typeof el.mozCaptureStream === "function") {
          stream = el.mozCaptureStream();
        }
        if (!stream || typeof stream.getAudioTracks !== "function") continue;

        const audioTracks = stream.getAudioTracks();
        for (const track of audioTracks) {
          if (!track || track.readyState !== "live" || hookedTrackIds.has(track.id)) continue;
          if (el.tagName === "VIDEO" && el.muted) continue;

          hookedTrackIds.add(track.id);
          const singleTrackStream = new MediaStream([track]);
          const sourceNode = activeAudioCtx.createMediaStreamSource(singleTrackStream);
          const gainNode = activeAudioCtx.createGain();
          gainNode.gain.value = 1.05;
          sourceNode.connect(gainNode);
          gainNode.connect(activeMixDestination);
          if (audioMeterAnalyser) {
            gainNode.connect(audioMeterAnalyser);
          }
          activeAudioNodes.push(sourceNode, gainNode);
        }
      } catch (_err) {}
    }
  }

  function startAudioLevelMeterLoop() {
    if (!audioMeterAnalyser) return;
    const dataArray = new Uint8Array(audioMeterAnalyser.frequencyBinCount);

    function updateMeter() {
      if (!isRecording || !audioMeterAnalyser) return;
      audioMeterAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const widget = document.getElementById(WIDGET_ID);
      if (widget) {
        const bars = widget.querySelectorAll(".gm-vu-bar");
        bars.forEach((bar, idx) => {
          const threshold = (idx + 1) * 8;
          const heightPx = avg > threshold ? Math.min(14, Math.max(4, Math.round((avg / 48) * (idx + 2) * 3))) : 3;
          bar.style.height = `${heightPx}px`;
          bar.style.backgroundColor = avg > threshold ? "#81c995" : "#5f6368";
        });
      }
      audioMeterRafId = requestAnimationFrame(updateMeter);
    }

    audioMeterRafId = requestAnimationFrame(updateMeter);
  }

  async function startLocalPresentationRecording() {
    if (isRecording) return;

    focusPresentationInMeetDOM();

    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      activeAudioCtx = new AudioCtxClass();
      await activeAudioCtx.resume();

      activeMixDestination = activeAudioCtx.createMediaStreamDestination();
      audioMeterAnalyser = activeAudioCtx.createAnalyser();
      audioMeterAnalyser.fftSize = 64;
      activeAudioNodes = [];
      hookedTrackIds = new Set();

      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
        activeMicStream = micStream;

        for (const micTrack of micStream.getAudioTracks()) {
          hookedTrackIds.add(micTrack.id);
          const micSource = activeAudioCtx.createMediaStreamSource(new MediaStream([micTrack]));
          const micGain = activeAudioCtx.createGain();
          micGain.gain.value = 1.25;
          micSource.connect(micGain);
          micGain.connect(activeMixDestination);
          micGain.connect(audioMeterAnalyser);
          activeAudioNodes.push(micSource, micGain);
        }
      } catch (_micErr) {
        try {
          const fallbackMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          activeMicStream = fallbackMic;
          const micSource = activeAudioCtx.createMediaStreamSource(fallbackMic);
          const micGain = activeAudioCtx.createGain();
          micGain.gain.value = 1.25;
          micSource.connect(micGain);
          micGain.connect(activeMixDestination);
          micGain.connect(audioMeterAnalyser);
          activeAudioNodes.push(micSource, micGain);
        } catch (_e2) {}
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser",
          frameRate: { ideal: 30, max: 60 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include"
      });

      activeDisplayStream = displayStream;

      if (activeAudioCtx.state === "suspended") {
        await activeAudioCtx.resume();
      }

      if (displayStream.getAudioTracks().length > 0) {
        for (const sysTrack of displayStream.getAudioTracks()) {
          hookedTrackIds.add(sysTrack.id);
          const sysSource = activeAudioCtx.createMediaStreamSource(new MediaStream([sysTrack]));
          const sysGain = activeAudioCtx.createGain();
          sysGain.gain.value = 1.05;
          sysSource.connect(sysGain);
          sysGain.connect(activeMixDestination);
          sysGain.connect(audioMeterAnalyser);
          activeAudioNodes.push(sysSource, sysGain);
        }
      }

      isRecording = true;
      attachMeetParticipantAudioStreamsToMixer();

      const keepAliveOsc = activeAudioCtx.createOscillator();
      const silentGain = activeAudioCtx.createGain();
      silentGain.gain.value = 0.00001;
      keepAliveOsc.connect(silentGain);
      silentGain.connect(activeMixDestination);
      keepAliveOsc.start();
      activeAudioNodes.push(keepAliveOsc, silentGain);

      const combinedStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...activeMixDestination.stream.getAudioTracks()
      ]);

      recordedChunks = [];
      const mimeTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ];
      const selectedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || "";
      mediaRecorder = selectedMime
        ? new MediaRecorder(combinedStream, { mimeType: selectedMime, audioBitsPerSecond: 128000 })
        : new MediaRecorder(combinedStream);

      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunks.push(ev.data);
        }
      };

      mediaRecorder.onstop = () => {
        saveRecordedVideoFile();
        cleanupRecordingStreams();
      };

      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (isRecording) stopLocalPresentationRecording();
      });

      mediaRecorder.start(1000);
      autoRecPromptDismissed = true;
      startAudioLevelMeterLoop();
      updateWidgetUI();
    } catch (_err) {
      cleanupRecordingStreams();
      updateWidgetUI();
    }
  }

  function stopLocalPresentationRecording() {
    if (!isRecording || !mediaRecorder) return;
    isRecording = false;
    try {
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch (_e) {
      cleanupRecordingStreams();
    }
    updateWidgetUI();
  }

  function cleanupRecordingStreams() {
    if (audioMeterRafId) {
      cancelAnimationFrame(audioMeterRafId);
      audioMeterRafId = null;
    }
    try {
      if (activeDisplayStream) activeDisplayStream.getTracks().forEach((t) => t.stop());
      if (activeMicStream) activeMicStream.getTracks().forEach((t) => t.stop());
      if (activeAudioCtx) activeAudioCtx.close();
    } catch (_e) {}
    activeDisplayStream = null;
    activeMicStream = null;
    activeAudioCtx = null;
    activeMixDestination = null;
    audioMeterAnalyser = null;
    activeAudioNodes = [];
    hookedTrackIds.clear();
    mediaRecorder = null;
    isRecording = false;
    updateWidgetUI();
  }

  function saveRecordedVideoFile() {
    if (!recordedChunks || recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    recordedChunks = [];
    const url = URL.createObjectURL(blob);
    const prof = getCodeProfile(currentMeetingCode);
    const safeLabel = (prof.label || "Tuition-Class").replace(/[^a-z0-9-_]+/gi, "-");
    const classNum = Math.max(1, getEffectiveMonthlyClassCountForCode(currentMeetingCode));
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${safeLabel}_Class-${classNum}_${currentMeetingCode || "meet"}_${dateStr}.webm`;

    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 3000);
  }

  function buildHomeworkMailUrl(code, customHomeworkText = "") {
    const prof = getCodeProfile(code);
    const classNum = Math.max(1, getEffectiveMonthlyClassCountForCode(code));
    const className = prof.label || `Google Meet Class (${code})`;
    const students = prof.students || "Students";
    const emails = (prof.studentEmails || "").trim();
    const schedule = prof.schedule || "Regular Schedule";
    const dateStr = new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const hwTask = customHomeworkText.trim() || prof.defaultHomework || "[Write today's homework tasks & chapter exercises here]";

    const subject = `📚 Homework: ${className} — Class #${classNum} (${dateStr})`;
    const body = [
      `Hi ${students},`,
      ``,
      `Here is the homework assignment and summary for ${className} (Class #${classNum} on ${dateStr}):`,
      ``,
      `📝 Homework Assignment:`,
      `${hwTask}`,
      ``,
      `📌 Classroom Details:`,
      `• Class Name: ${className}`,
      `• Typical Schedule: ${schedule}`,
      `• Class Meet Link: https://meet.google.com/${code}`,
      ``,
      `Please complete the homework before our next scheduled class.`,
      ``,
      `Best regards`
    ].join("\n");

    const params = new URLSearchParams({
      view: "cm",
      fs: "1",
      to: emails,
      su: subject,
      body
    });
    return `https://mail.google.com/mail/?${params.toString()}`;
  }

  function detectMeetInternalStartTimeMs() {
    try {
      const origin = window.performance && window.performance.timeOrigin
        ? window.performance.timeOrigin
        : Date.now() - (window.performance ? window.performance.now() : 0);

      if (window.performance && typeof window.performance.getEntriesByType === "function") {
        const marks = window.performance.getEntriesByType("mark") || [];
        for (const m of marks) {
          const name = (m.name || "").toLowerCase();
          if (name.includes("call") || name.includes("join") || name.includes("media") || name.includes("rtc")) {
            if (m.startTime > 0) return Math.floor(origin + m.startTime);
          }
        }

        const resources = window.performance.getEntriesByType("resource") || [];
        for (const r of resources) {
          const url = (r.name || "");
          if (
            url.includes("MeetingsUi") ||
            url.includes("$rpc") ||
            url.includes("SyncMeetingSpaceCollections") ||
            url.includes("CreateMeetingDevice") ||
            url.includes("ResolveMeetingSpace")
          ) {
            if (r.startTime > 0) return Math.floor(origin + r.startTime);
          }
        }
      }

      if (origin && origin < Date.now()) return Math.floor(origin);
    } catch (_e) {}
    return Date.now();
  }

  function detectActiveCallInDOM() {
    const code = getMeetingCode();
    if (!code) return false;

    const allButtons = document.querySelectorAll("button, [role='button']");
    for (const btn of allButtons) {
      if (!isElementVisible(btn)) continue;
      const text = (btn.innerText || "").trim().toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
      if (
        text === "join now" ||
        text === "ask to join" ||
        text === "rejoin" ||
        text === "return to home screen" ||
        aria === "join now" ||
        aria === "ask to join"
      ) {
        return false;
      }
    }

    const iconCandidates = document.querySelectorAll(
      "i.google-material-icons, span.google-material-icons, i.material-icons, span.google-symbols, i.google-symbols, [data-icon='call_end']"
    );
    for (const icon of iconCandidates) {
      if ((icon.textContent || "").trim() === "call_end") {
        const btn = icon.closest("button, [role='button']");
        if (btn && isElementVisible(btn)) return true;
      }
    }

    const inCallControls = document.querySelectorAll(
      'button[aria-label*="Leave call" i], ' +
      'button[aria-label*="End call" i], ' +
      'button[data-tooltip*="Leave call" i], ' +
      '[role="button"][aria-label*="Leave call" i], ' +
      'button[aria-label*="Raise hand" i], ' +
      'button[aria-label*="Send a reaction" i], ' +
      'button[aria-label*="Present now" i], ' +
      'button[aria-label*="Share screen" i], ' +
      'button[aria-label*="Meeting details" i], ' +
      'button[aria-label*="Chat with everyone" i], ' +
      'button[aria-label*="Show everyone" i], ' +
      'button[aria-label*="People" i]'
    );
    for (const ctrl of inCallControls) {
      if (isElementVisible(ctrl)) return true;
    }

    const participants = document.querySelectorAll(
      "[data-participant-id], [data-self-name], [data-requested-participant-id], [data-allocation-index]"
    );
    for (const p of participants) {
      if (isElementVisible(p)) return true;
    }

    return false;
  }

  function formatDuration(totalSeconds) {
    const sec = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function getElapsedMs() {
    if (!firstStartedAtMs) return Math.max(0, manualOffsetMs);
    const now = Date.now();
    const currentPauseDuration = isPaused && pausedAtMs ? Math.max(0, now - pausedAtMs) : 0;
    const raw = now - firstStartedAtMs - totalPausedMs - currentPauseDuration + manualOffsetMs;
    return Math.max(0, raw);
  }

  function getMinClassMs() {
    const mins = Number(settings.minClassMinutes);
    return (mins > 0 ? mins : 35) * 60 * 1000;
  }

  function isCurrentSessionQualifiedClass() {
    return getElapsedMs() >= getMinClassMs();
  }

  function getCodeProfile(code) {
    if (!code) {
      return {
        label: "",
        category: "Tuition / Class",
        students: "",
        schedule: "",
        studentEmails: "",
        defaultHomework: "",
        initialClassOffset: 0,
        offsetMonth: new Date().toISOString().slice(0, 7)
      };
    }
    return codeProfiles[code] || {
      label: "",
      category: "Tuition / Class",
      students: "",
      schedule: "",
      studentEmails: "",
      defaultHomework: "",
      initialClassOffset: 0,
      offsetMonth: new Date().toISOString().slice(0, 7)
    };
  }

  // Count recorded qualified classes (<code, currentMonth>) from history + active call
  function getRecordedMonthlyQualifiedClassesForCode(code) {
    if (!code) return 0;
    const minMs = getMinClassMs();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const completedIds = new Set();

    for (const item of callHistoryCache) {
      if (item && item.meetingCode === code) {
        const itemMonth = (item.startedAt || item.endedAt || "").slice(0, 7) || currentMonth;
        if (itemMonth !== currentMonth) continue;
        const qualified = item.isQualifiedClass !== undefined
          ? Boolean(item.isQualifiedClass)
          : (item.durationMs || 0) >= minMs;
        if (qualified) {
          completedIds.add(item.historyId || `${item.meetingCode}-${item.startedAt || item.endedAt}`);
        }
      }
    }
    if (isInCall && currentMeetingCode === code && sessionHistoryId && isCurrentSessionQualifiedClass()) {
      completedIds.add(sessionHistoryId);
    }
    return completedIds.size;
  }

  // Effective Monthly Class Count = (initialClassOffset if in offsetMonth, else 0) + recordedMonthlyQualifiedClasses
  // Automatically resets to 1 when a new calendar month begins!
  function getEffectiveMonthlyClassCountForCode(code) {
    if (!code) return 0;
    const prof = getCodeProfile(code);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const offsetMonth = prof.offsetMonth || currentMonth;
    const initialOffset = currentMonth === offsetMonth ? Math.max(0, parseInt(prof.initialClassOffset, 10) || 0) : 0;
    return initialOffset + getRecordedMonthlyQualifiedClassesForCode(code);
  }

  function playAudioAlert(type = "warning") {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (type === "milestone") {
        const notes = [523.25, 659.25];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.16);
          gain.gain.setValueAtTime(0.12, ctx.currentTime + idx * 0.16);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.45);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + idx * 0.16);
          osc.stop(ctx.currentTime + idx * 0.16 + 0.45);
        });
      } else {
        const notes = [587.33, 880, 587.33, 880];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.18);
          gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.18);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.18 + 0.35);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + idx * 0.18);
          osc.stop(ctx.currentTime + idx * 0.18 + 0.35);
        });
      }
    } catch (_e) {}
  }

  function saveSessionState() {
    if (!currentMeetingCode || !firstStartedAtMs) return;
    safeStorageGet([STORAGE_KEY_ACTIVE], (res) => {
      const sessions = res[STORAGE_KEY_ACTIVE] || {};
      const now = Date.now();
      for (const key of Object.keys(sessions)) {
        if (now - (sessions[key].lastUpdated || 0) > SESSION_TTL_MS) {
          delete sessions[key];
        }
      }
      sessions[currentMeetingCode] = {
        meetingCode: currentMeetingCode,
        firstStartedAtMs,
        pausedAtMs,
        totalPausedMs,
        manualOffsetMs,
        isPaused,
        isInCall,
        sessionHistoryId,
        classMilestoneNotified,
        warningAlertNotified,
        lastUpdated: now
      };
      safeStorageSet({ [STORAGE_KEY_ACTIVE]: sessions });
    });
  }

  function upsertCallHistory(meetingCode, durationMs, historyId, callback) {
    if (!meetingCode || durationMs < 3000) return;
    safeStorageGet([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      codeProfiles = profiles;

      const calendarTitle = detectCalendarEventTitleFromMeetDOM();
      const profile = profiles[meetingCode] || {
        meetingCode,
        classLink: `https://meet.google.com/${meetingCode}`,
        label: calendarTitle || "",
        category: "Tuition / Class",
        students: "",
        schedule: "",
        studentEmails: "",
        defaultHomework: "",
        initialClassOffset: 0,
        offsetMonth: new Date().toISOString().slice(0, 7),
        createdAt: new Date().toISOString()
      };
      if (!profile.label && calendarTitle) {
        profile.label = calendarTitle;
      }
      profiles[meetingCode] = profile;

      const minMs = getMinClassMs();
      const isQualifiedClass = durationMs >= minMs;
      const effectiveId = historyId || `${meetingCode}-${firstStartedAtMs || Date.now()}`;
      const existingIdx = history.findIndex(
        (item) => (item.historyId && item.historyId === effectiveId) ||
          (item.meetingCode === meetingCode && Date.now() - new Date(item.endedAt).getTime() < SESSION_TTL_MS)
      );

      const startIso = firstStartedAtMs ? new Date(firstStartedAtMs).toISOString() : new Date().toISOString();
      const endIso = new Date().toISOString();

      const entry = {
        historyId: effectiveId,
        meetingCode,
        label: profile.label || "",
        category: profile.category || "Tuition / Class",
        students: profile.students || "",
        schedule: profile.schedule || "",
        studentEmails: profile.studentEmails || "",
        durationMs,
        isQualifiedClass,
        calendarSynced: existingIdx !== -1 ? Boolean(history[existingIdx].calendarSynced) : false,
        date: startIso.slice(0, 10),
        startedAt: startIso,
        endedAt: endIso
      };

      if (existingIdx !== -1) {
        entry.notes = history[existingIdx].notes || "";
        history[existingIdx] = entry;
      } else {
        entry.notes = "";
        history.unshift(entry);
      }

      callHistoryCache = history.slice(0, 500);
      safeStorageSet({
        [STORAGE_KEY_HISTORY]: callHistoryCache,
        [STORAGE_KEY_PROFILES]: profiles
      }, () => {
        safeSendRuntimeMessage({ type: "MIRROR_CLOUD_SYNC" });
        if (typeof callback === "function") callback(entry);
      });
    });
  }

  function buildQuickCalendarUrl() {
    const startIso = firstStartedAtMs ? new Date(firstStartedAtMs).toISOString() : new Date(Date.now() - getElapsedMs()).toISOString();
    const endIso = new Date().toISOString();
    const toCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const prof = getCodeProfile(currentMeetingCode);
    const classNum = Math.max(1, getEffectiveMonthlyClassCountForCode(currentMeetingCode));
    const studentPart = prof.label ? `${prof.label} (${currentMeetingCode})` : currentMeetingCode;
    const title = `🎓 Class #${classNum}: ${studentPart}`;
    const mins = Math.round(getElapsedMs() / 60000);
    const details = `Online Tuition Class #${classNum}\nClass Name: ${prof.label || "Unlabeled"}\nStudents: ${prof.students || "N/A"}\nMeeting Code: ${currentMeetingCode}\nDuration: ${formatDuration(Math.floor(getElapsedMs() / 1000))} (${mins} mins)`;
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${toCalDate(startIso)}/${toCalDate(endIso)}`,
      details,
      location: `https://meet.google.com/${currentMeetingCode}`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function applyPresetPosition(widget, pos) {
    widget.style.top = "auto";
    widget.style.bottom = "auto";
    widget.style.left = "auto";
    widget.style.right = "auto";
    widget.style.transform = "none";

    if (pos === "custom" && typeof settings.customX === "number" && typeof settings.customY === "number") {
      const clampedX = Math.max(8, Math.min(window.innerWidth - 120, settings.customX));
      const clampedY = Math.max(8, Math.min(window.innerHeight - 48, settings.customY));
      widget.style.left = `${clampedX}px`;
      widget.style.top = `${clampedY}px`;
    } else if (pos === "top-left") {
      widget.style.top = "16px";
      widget.style.left = "16px";
    } else if (pos === "top-right") {
      widget.style.top = "16px";
      widget.style.right = "16px";
    } else if (pos === "bottom-center") {
      widget.style.bottom = "84px";
      widget.style.left = "50%";
      widget.style.transform = "translateX(-50%)";
    } else if (pos === "bottom-left") {
      widget.style.bottom = "84px";
      widget.style.left = "16px";
    } else if (pos === "bottom-right") {
      widget.style.bottom = "84px";
      widget.style.right = "16px";
    } else {
      widget.style.top = "16px";
      widget.style.left = "50%";
      widget.style.transform = "translateX(-50%)";
    }
  }

  function createWidget() {
    let widget = document.getElementById(WIDGET_ID);
    if (widget) return widget;
    if (!document.body) return null;

    widget = document.createElement("div");
    widget.id = WIDGET_ID;
    widget.className = "gm-timer-container";
    widget.title = "Drag anywhere on this Google Meet pill to reposition";
    widget.innerHTML = `
      <div class="gm-timer-main-row">
        <div class="gm-timer-drag-handle" title="Drag anywhere to move timer">
          <span class="gm-timer-grip" aria-hidden="true">⋮⋮</span>
          <span class="gm-timer-dot gm-dot-active" id="gm-timer-dot"></span>
          <span class="gm-timer-code" id="gm-timer-code">Meet</span>
          <span class="gm-timer-class-pill gm-pill-pending" id="gm-timer-class-pill" title="Click ✎ to initialize or fix which Class # this is">⏳ &lt;35m</span>
        </div>
        <div class="gm-timer-display" id="gm-timer-display">00:00:00</div>
        <div class="gm-vu-meter" id="gm-vu-meter" style="display: none;" title="Live Audio Meter: Capturing Your Mic + Participants' Voices">
          <span class="gm-vu-bar"></span>
          <span class="gm-vu-bar"></span>
          <span class="gm-vu-bar"></span>
          <span class="gm-vu-bar"></span>
        </div>
        <div class="gm-timer-controls">
          <button type="button" class="gm-timer-btn" id="gm-timer-rec-btn" title="Record Class Video + Your Mic + Participants' Audio (.webm)">⏺</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-hw-btn" title="Send Homework Email to Students">✉️</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-cal-btn" title="Save Class to Google Calendar">📅</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-pause-btn" title="Pause / Resume Timer">⏸</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-edit-btn" title="Set Class #, Classroom Details & Manual Time Adjust">✎</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-reset-btn" title="Reset Timer to 00:00:00">↺</button>
          <button type="button" class="gm-timer-btn" id="gm-timer-min-btn" title="Minimize / Expand">–</button>
        </div>
      </div>

      <!-- Auto-Record Presentation Prompt -->
      <div class="gm-timer-rec-prompt" id="gm-timer-rec-prompt" style="display: none;">
        <span>🔴 Record Class (Video + Your Mic + Students' Voices)?</span>
        <div style="display: flex; gap: 4px;">
          <button type="button" class="gm-rec-start-chip" id="gm-rec-prompt-start">⏺ Start Rec</button>
          <button type="button" class="gm-rec-skip-chip" id="gm-rec-prompt-skip">Skip</button>
        </div>
      </div>

      <!-- In-Call Alert Banner (1h 10m Warning) -->
      <div class="gm-timer-alert-toast" id="gm-timer-alert-toast" style="display: none;">
        <span id="gm-timer-alert-text">⚠️ 1 hr 10 min Warning! Class time reached.</span>
        <button type="button" class="gm-toast-dismiss" id="gm-timer-alert-dismiss">OK</button>
      </div>

      <div class="gm-timer-adjust-drawer" id="gm-timer-adjust-drawer" style="display: none;">
        <div class="gm-adjust-profile-row">
          <input type="text" id="gm-inline-label" placeholder="Class Name (e.g. HSC Physics)" />
          <span style="font-size: 11px; color: #9aa0a6; white-space: nowrap;">This Class #:</span>
          <input type="number" id="gm-inline-class-num" min="1" max="500" placeholder="#" title="Set which Class # this is for this month (auto-increments afterward)" style="width: 52px; flex: none; text-align: center;" />
        </div>
        <div class="gm-adjust-profile-row">
          <input type="text" id="gm-inline-students" placeholder="Students (e.g. Rahim, Karim)" />
          <input type="text" id="gm-inline-schedule" placeholder="Schedule (e.g. Sat/Mon 7PM)" />
        </div>
        <div class="gm-adjust-profile-row">
          <input type="text" id="gm-inline-emails" placeholder="Student Mails (comma-separated)" />
          <button type="button" class="gm-set-btn" id="gm-inline-save-profile-btn">Save Class</button>
        </div>
        <div class="gm-adjust-profile-row">
          <input type="text" id="gm-inline-hw-text" placeholder="Homework topic / exercises..." />
          <button type="button" class="gm-set-btn" id="gm-inline-send-hw-btn">✉️ Send HW</button>
        </div>
        <div class="gm-adjust-quick-row">
          <button type="button" class="gm-chip-btn" data-delta="-300000">-5m</button>
          <button type="button" class="gm-chip-btn" data-delta="-60000">-1m</button>
          <button type="button" class="gm-chip-btn" data-delta="60000">+1m</button>
          <button type="button" class="gm-chip-btn" data-delta="300000">+5m</button>
          <button type="button" class="gm-chip-btn" data-delta="900000">+15m</button>
        </div>
        <div class="gm-adjust-custom-row">
          <input type="number" id="gm-inline-hh" min="0" max="99" placeholder="HH" />
          <span>:</span>
          <input type="number" id="gm-inline-mm" min="0" max="59" placeholder="MM" />
          <span>:</span>
          <input type="number" id="gm-inline-ss" min="0" max="59" placeholder="SS" />
          <button type="button" class="gm-set-btn" id="gm-inline-set-btn">Set Time</button>
        </div>
      </div>
    `;

    document.body.appendChild(widget);
    applyPresetPosition(widget, settings.position || "top-center");

    widget.querySelector("#gm-timer-rec-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (isRecording) {
        stopLocalPresentationRecording();
      } else {
        startLocalPresentationRecording();
      }
    });

    widget.querySelector("#gm-rec-prompt-start").addEventListener("click", (e) => {
      e.stopPropagation();
      startLocalPresentationRecording();
    });

    widget.querySelector("#gm-rec-prompt-skip").addEventListener("click", (e) => {
      e.stopPropagation();
      autoRecPromptDismissed = true;
      widget.querySelector("#gm-timer-rec-prompt").style.display = "none";
    });

    widget.querySelector("#gm-timer-hw-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const hwInput = widget.querySelector("#gm-inline-hw-text");
      const hwVal = hwInput ? hwInput.value : "";
      window.open(buildHomeworkMailUrl(currentMeetingCode, hwVal), "_blank", "noopener,noreferrer");
    });

    widget.querySelector("#gm-inline-send-hw-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const hwInput = widget.querySelector("#gm-inline-hw-text");
      const hwVal = hwInput ? hwInput.value : "";
      window.open(buildHomeworkMailUrl(currentMeetingCode, hwVal), "_blank", "noopener,noreferrer");
    });

    widget.querySelector("#gm-timer-cal-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(buildQuickCalendarUrl(), "_blank", "noopener,noreferrer");
    });

    widget.querySelector("#gm-timer-pause-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      togglePause();
    });

    widget.querySelector("#gm-timer-reset-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      resetTimer();
    });

    widget.querySelector("#gm-timer-alert-dismiss").addEventListener("click", (e) => {
      e.stopPropagation();
      warningBannerDismissed = true;
      widget.querySelector("#gm-timer-alert-toast").style.display = "none";
    });

    const drawer = widget.querySelector("#gm-timer-adjust-drawer");
    widget.querySelector("#gm-timer-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = drawer.style.display === "none";
      if (isHidden) {
        const totalSec = Math.floor(getElapsedMs() / 1000);
        widget.querySelector("#gm-inline-hh").value = Math.floor(totalSec / 3600);
        widget.querySelector("#gm-inline-mm").value = Math.floor((totalSec % 3600) / 60);
        widget.querySelector("#gm-inline-ss").value = totalSec % 60;
        const prof = getCodeProfile(currentMeetingCode);
        widget.querySelector("#gm-inline-label").value = prof.label || "";
        widget.querySelector("#gm-inline-students").value = prof.students || "";
        widget.querySelector("#gm-inline-schedule").value = prof.schedule || "";
        widget.querySelector("#gm-inline-emails").value = prof.studentEmails || "";
        widget.querySelector("#gm-inline-hw-text").value = prof.defaultHomework || "";
        // Show the current/upcoming class # in the input box
        const currentEffective = getEffectiveMonthlyClassCountForCode(currentMeetingCode);
        const displayClassNum = isCurrentSessionQualifiedClass() ? Math.max(1, currentEffective) : currentEffective + 1;
        widget.querySelector("#gm-inline-class-num").value = displayClassNum;
        drawer.style.display = "flex";
      } else {
        drawer.style.display = "none";
      }
    });

    widget.querySelector("#gm-inline-save-profile-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!currentMeetingCode) return;
      const desiredClassNum = parseInt(widget.querySelector("#gm-inline-class-num").value, 10);
      let newInitialOffset = undefined;
      if (!isNaN(desiredClassNum) && desiredClassNum >= 1) {
        const recordedThisMonth = getRecordedMonthlyQualifiedClassesForCode(currentMeetingCode);
        const activeAdjustment = isCurrentSessionQualifiedClass() ? 0 : 1;
        newInitialOffset = Math.max(0, desiredClassNum - recordedThisMonth - activeAdjustment);
      }

      saveCodeProfileObject(currentMeetingCode, {
        label: widget.querySelector("#gm-inline-label").value.trim(),
        students: widget.querySelector("#gm-inline-students").value.trim(),
        schedule: widget.querySelector("#gm-inline-schedule").value.trim(),
        studentEmails: widget.querySelector("#gm-inline-emails").value.trim(),
        defaultHomework: widget.querySelector("#gm-inline-hw-text").value.trim(),
        initialClassOffset: newInitialOffset,
        offsetMonth: new Date().toISOString().slice(0, 7)
      });
      drawer.style.display = "none";
    });

    widget.querySelectorAll(".gm-chip-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const deltaMs = parseInt(btn.getAttribute("data-delta"), 10) || 0;
        adjustTimerByOffset(deltaMs);
      });
    });

    widget.querySelector("#gm-inline-set-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const hh = Math.max(0, parseInt(widget.querySelector("#gm-inline-hh").value, 10) || 0);
      const mm = Math.max(0, parseInt(widget.querySelector("#gm-inline-mm").value, 10) || 0);
      const ss = Math.max(0, parseInt(widget.querySelector("#gm-inline-ss").value, 10) || 0);
      const targetMs = ((hh * 3600) + (mm * 60) + ss) * 1000;
      setExactTimerMs(targetMs);
      drawer.style.display = "none";
    });

    const minBtn = widget.querySelector("#gm-timer-min-btn");
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      widget.classList.toggle("gm-timer-minimized");
      if (widget.classList.contains("gm-timer-minimized")) {
        drawer.style.display = "none";
        minBtn.textContent = "+";
      } else {
        minBtn.textContent = "–";
      }
    });

    makeDraggable(widget);
    return widget;
  }

  function saveCodeProfileObject(code, fields) {
    if (!code) return;
    safeStorageGet([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const existing = profiles[code] || {};
      const currentMonth = new Date().toISOString().slice(0, 7);

      profiles[code] = {
        ...existing,
        meetingCode: code,
        classLink: `https://meet.google.com/${code}`,
        label: fields.label !== undefined ? fields.label : (existing.label || ""),
        category: fields.category || existing.category || "Tuition / Class",
        students: fields.students !== undefined ? fields.students : (existing.students || ""),
        schedule: fields.schedule !== undefined ? fields.schedule : (existing.schedule || ""),
        studentEmails: fields.studentEmails !== undefined ? fields.studentEmails : (existing.studentEmails || ""),
        defaultHomework: fields.defaultHomework !== undefined ? fields.defaultHomework : (existing.defaultHomework || ""),
        initialClassOffset: fields.initialClassOffset !== undefined ? Math.max(0, parseInt(fields.initialClassOffset, 10) || 0) : (existing.initialClassOffset || 0),
        offsetMonth: fields.offsetMonth || existing.offsetMonth || currentMonth,
        updatedAt: new Date().toISOString()
      };
      codeProfiles = profiles;

      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      for (const item of history) {
        if (item && item.meetingCode === code) {
          item.label = profiles[code].label;
          item.category = profiles[code].category;
          item.students = profiles[code].students;
          item.schedule = profiles[code].schedule;
          item.studentEmails = profiles[code].studentEmails;
        }
      }
      callHistoryCache = history;
      safeStorageSet({
        [STORAGE_KEY_PROFILES]: profiles,
        [STORAGE_KEY_HISTORY]: history
      }, () => {
        safeSendRuntimeMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "profile_updated" });
        updateWidgetUI();
      });
    });
  }

  function makeDraggable(el) {
    let isDragging = false;
    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, select, .gm-timer-adjust-drawer, .gm-timer-alert-toast, .gm-timer-rec-prompt")) return;

      isDragging = true;
      pointerId = e.pointerId;
      const rect = el.getBoundingClientRect();

      el.style.transform = "none";
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";

      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      el.classList.add("gm-timer-dragging");
      el.style.transition = "none";

      try {
        el.setPointerCapture(e.pointerId);
      } catch (_err) {}
      e.preventDefault();
    });

    el.addEventListener("pointermove", (e) => {
      if (!isDragging || e.pointerId !== pointerId) return;
      const maxX = Math.max(8, window.innerWidth - el.offsetWidth - 8);
      const maxY = Math.max(8, window.innerHeight - el.offsetHeight - 8);
      const nextX = Math.round(Math.max(8, Math.min(maxX, e.clientX - offsetX)));
      const nextY = Math.round(Math.max(8, Math.min(maxY, e.clientY - offsetY)));

      el.style.left = `${nextX}px`;
      el.style.top = `${nextY}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.transform = "none";
    });

    function finishDrag(e) {
      if (!isDragging) return;
      if (pointerId !== null && e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
      isDragging = false;
      el.classList.remove("gm-timer-dragging");
      el.style.transition = "";
      try {
        if (pointerId !== null) el.releasePointerCapture(pointerId);
      } catch (_err) {}
      pointerId = null;

      const rect = el.getBoundingClientRect();
      settings.position = "custom";
      settings.customX = Math.round(rect.left);
      settings.customY = Math.round(rect.top);
      safeStorageSet({ [STORAGE_KEY_SETTINGS]: settings });
    }

    el.addEventListener("pointerup", finishDrag);
    el.addEventListener("pointercancel", finishDrag);
  }

  function formatThresholdLabel(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h} hr ${m} min`;
    if (h > 0) return `${h} hr`;
    return `${mins} min`;
  }

  function updateWidgetUI() {
    const widget = createWidget();
    if (!widget) return;

    if (!settings.showOverlay || !isInCall) {
      widget.style.display = "none";
      return;
    }

    widget.style.display = "inline-flex";
    const elapsedMs = getElapsedMs();
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minClassMins = settings.minClassMinutes > 0 ? settings.minClassMinutes : 35;
    const warnMins = settings.warnMinutes > 0 ? settings.warnMinutes : 70;
    const isQualified = elapsedMs >= minClassMins * 60 * 1000;

    const displayEl = widget.querySelector("#gm-timer-display");
    const dotEl = widget.querySelector("#gm-timer-dot");
    const codeEl = widget.querySelector("#gm-timer-code");
    const classPillEl = widget.querySelector("#gm-timer-class-pill");
    const vuMeter = widget.querySelector("#gm-vu-meter");
    const recBtn = widget.querySelector("#gm-timer-rec-btn");
    const pauseBtn = widget.querySelector("#gm-timer-pause-btn");
    const alertToast = widget.querySelector("#gm-timer-alert-toast");
    const alertText = widget.querySelector("#gm-timer-alert-text");
    const recPrompt = widget.querySelector("#gm-timer-rec-prompt");

    const prof = getCodeProfile(currentMeetingCode);
    const displayName = prof.label ? `${prof.label} (${currentMeetingCode})` : (currentMeetingCode || "Meet");
    const effectiveMonthlyCount = getEffectiveMonthlyClassCountForCode(currentMeetingCode);

    if (displayEl) displayEl.textContent = formatDuration(totalSeconds);
    if (codeEl) {
      codeEl.textContent = displayName;
      codeEl.title = `${prof.category || "Tuition / Class"} • ${displayName}${prof.students ? " • Students: " + prof.students : ""}`;
    }

    if (vuMeter) {
      vuMeter.style.display = isRecording ? "inline-flex" : "none";
    }

    if (recBtn) {
      if (isRecording) {
        recBtn.textContent = "⏹";
        recBtn.classList.add("gm-btn-recording-active");
        recBtn.title = "Recording Active (Video + Your Mic + Participants' Voices) — Click to Stop & Save .webm";
      } else {
        recBtn.textContent = "⏺";
        recBtn.classList.remove("gm-btn-recording-active");
        recBtn.title = "Start Recording Class (Video + Your Mic + Participants' Voices .webm)";
      }
    }

    if (recPrompt) {
      if (settings.autoRecordClass !== false && !isRecording && !autoRecPromptDismissed) {
        recPrompt.style.display = "flex";
      } else {
        recPrompt.style.display = "none";
      }
    }

    if (classPillEl) {
      if (isQualified) {
        classPillEl.textContent = `🎓 Class #${Math.max(1, effectiveMonthlyCount)} ✓`;
        classPillEl.className = "gm-timer-class-pill gm-pill-qualified";
        classPillEl.title = `Qualified Class (≥ ${minClassMins} mins) • Class #${Math.max(1, effectiveMonthlyCount)} this month`;
      } else {
        const minsLeft = Math.max(1, Math.ceil((minClassMins * 60 - totalSeconds) / 60));
        classPillEl.textContent = `⏳ ${minsLeft}m to Class #${effectiveMonthlyCount + 1}`;
        classPillEl.className = "gm-timer-class-pill gm-pill-pending";
        classPillEl.title = `Counts as Class #${effectiveMonthlyCount + 1} this month once duration reaches ${minClassMins} mins`;
      }
    }

    if (dotEl) dotEl.className = "gm-timer-dot " + (isPaused ? "gm-dot-paused" : "gm-dot-active");
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? "▶" : "⏸";
      pauseBtn.title = isPaused ? "Resume Timer" : "Pause Timer";
    }

    if (isQualified && !classMilestoneNotified) {
      classMilestoneNotified = true;
      saveSessionState();
      upsertCallHistory(currentMeetingCode, elapsedMs, sessionHistoryId);
      if (settings.soundAlert) playAudioAlert("milestone");
      safeSendRuntimeMessage({
        type: "FIRE_NOTIFICATION",
        notifId: `gm-class-qualified-${sessionHistoryId}`,
        title: `🎓 Qualified as Class #${Math.max(1, effectiveMonthlyCount)}!`,
        message: `${displayName} reached ${minClassMins} mins and is now counted as Class #${Math.max(1, effectiveMonthlyCount)} this month.`
      });
    } else if (!isQualified && totalSeconds < minClassMins * 60) {
      classMilestoneNotified = false;
    }

    if (warnMins > 0 && totalSeconds >= warnMins * 60) {
      widget.classList.add("gm-timer-overtime");
      const warnLabel = formatThresholdLabel(warnMins);
      if (alertToast && alertText && !warningBannerDismissed) {
        alertText.textContent = `⚠️ ${warnLabel} Warning! Class has reached ${formatDuration(totalSeconds)}.`;
        alertToast.style.display = "flex";
      }
      if (!warningAlertNotified) {
        warningAlertNotified = true;
        saveSessionState();
        if (settings.soundAlert !== false) playAudioAlert("warning");
        safeSendRuntimeMessage({
          type: "FIRE_NOTIFICATION",
          notifId: `gm-overtime-warn-${sessionHistoryId}`,
          title: `⚠️ ${warnLabel} Warning Alert!`,
          message: `Your Google Meet class (${displayName}) has passed ${warnLabel} (${formatDuration(totalSeconds)}).`
        });
      }
    } else {
      widget.classList.remove("gm-timer-overtime");
      if (alertToast) alertToast.style.display = "none";
      if (warnMins > 0 && totalSeconds < warnMins * 60) {
        warningAlertNotified = false;
        warningBannerDismissed = false;
      }
    }
  }

  function ensureActiveSessionStarted() {
    if (!isInCall) {
      currentMeetingCode = getMeetingCode() || "manual-call";
      isInCall = true;
    }
    if (!firstStartedAtMs) {
      firstStartedAtMs = Date.now();
      totalPausedMs = 0;
      sessionHistoryId = `${currentMeetingCode}-${firstStartedAtMs}`;
    }
  }

  function adjustTimerByOffset(deltaMs) {
    ensureActiveSessionStarted();
    const currentElapsed = getElapsedMs();
    if (currentElapsed + deltaMs < 0) {
      manualOffsetMs -= currentElapsed;
    } else {
      manualOffsetMs += deltaMs;
    }
    saveSessionState();
    upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
    updateWidgetUI();
  }

  function setExactTimerMs(targetMs) {
    ensureActiveSessionStarted();
    const now = Date.now();
    const currentPauseDuration = isPaused && pausedAtMs ? Math.max(0, now - pausedAtMs) : 0;
    const baseElapsedWithoutManual = now - firstStartedAtMs - totalPausedMs - currentPauseDuration;
    manualOffsetMs = Math.max(0, targetMs) - baseElapsedWithoutManual;
    saveSessionState();
    upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
    updateWidgetUI();
  }

  function syncToMeetInternalStartTime() {
    ensureActiveSessionStarted();
    const detectedStart = detectMeetInternalStartTimeMs();
    firstStartedAtMs = detectedStart;
    totalPausedMs = 0;
    manualOffsetMs = 0;
    isPaused = false;
    pausedAtMs = null;
    saveSessionState();
    upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
    updateWidgetUI();
  }

  function startCallSession(meetingCode, wasAlreadyInCallOnBoot = false) {
    currentMeetingCode = meetingCode;
    isInCall = true;
    autoRecPromptDismissed = false;
    createWidget();

    safeStorageGet([STORAGE_KEY_ACTIVE, STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      if (res[STORAGE_KEY_PROFILES]) codeProfiles = res[STORAGE_KEY_PROFILES];
      if (Array.isArray(res[STORAGE_KEY_HISTORY])) callHistoryCache = res[STORAGE_KEY_HISTORY];

      const sessions = res[STORAGE_KEY_ACTIVE] || {};
      const prev = sessions[meetingCode];
      const now = Date.now();

      if (prev && prev.firstStartedAtMs && now - (prev.lastUpdated || 0) < SESSION_TTL_MS) {
        firstStartedAtMs = prev.firstStartedAtMs;
        totalPausedMs = prev.totalPausedMs || 0;
        manualOffsetMs = prev.manualOffsetMs || 0;
        isPaused = Boolean(prev.isPaused);
        pausedAtMs = isPaused ? (prev.pausedAtMs || now) : null;
        sessionHistoryId = prev.sessionHistoryId || `${meetingCode}-${firstStartedAtMs}`;
        classMilestoneNotified = Boolean(prev.classMilestoneNotified);
        warningAlertNotified = Boolean(prev.warningAlertNotified);
      } else {
        firstStartedAtMs = wasAlreadyInCallOnBoot ? detectMeetInternalStartTimeMs() : now;
        totalPausedMs = 0;
        manualOffsetMs = 0;
        isPaused = false;
        pausedAtMs = null;
        sessionHistoryId = `${meetingCode}-${firstStartedAtMs}`;
        classMilestoneNotified = false;
        warningAlertNotified = false;
        warningBannerDismissed = false;
      }

      focusPresentationInMeetDOM();
      saveSessionState();
      upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
      updateWidgetUI();
    });
  }

  function endCallSession() {
    if (!isInCall) return;
    const finalDurationMs = getElapsedMs();
    const endedCode = currentMeetingCode;

    if (isRecording) {
      stopLocalPresentationRecording();
    }
    document.body.classList.remove("gm-presentation-spotlight-active");

    isInCall = false;
    saveSessionState();
    upsertCallHistory(endedCode, finalDurationMs, sessionHistoryId, (savedEntry) => {
      safeSendRuntimeMessage({
        type: "SYNC_CLASS_TO_CALENDAR",
        session: savedEntry
      });
    });
    updateWidgetUI();
  }

  function togglePause() {
    const now = Date.now();
    if (!isInCall) {
      ensureActiveSessionStarted();
      isPaused = false;
      pausedAtMs = null;
    } else if (isPaused) {
      if (pausedAtMs) totalPausedMs += Math.max(0, now - pausedAtMs);
      pausedAtMs = null;
      isPaused = false;
    } else {
      pausedAtMs = now;
      isPaused = true;
    }
    saveSessionState();
    updateWidgetUI();
  }

  function resetTimer() {
    const now = Date.now();
    firstStartedAtMs = now;
    totalPausedMs = 0;
    manualOffsetMs = 0;
    classMilestoneNotified = false;
    warningAlertNotified = false;
    warningBannerDismissed = false;
    pausedAtMs = isPaused ? now : null;
    sessionHistoryId = `${currentMeetingCode || "meet"}-${now}`;
    saveSessionState();
    updateWidgetUI();
  }

  let tickCounter = 0;
  function checkCallState() {
    const activeNow = detectActiveCallInDOM();
    const code = getMeetingCode();
    const isFirstBootCheck = !initialBootCheckDone;
    initialBootCheckDone = true;

    if (activeNow && !isInCall && code) {
      startCallSession(code, isFirstBootCheck);
    } else if (!activeNow && isInCall) {
      endCallSession();
    } else if (isInCall && code && code !== currentMeetingCode) {
      endCallSession();
      startCallSession(code, false);
    }

    if (isInCall) {
      updateWidgetUI();
      saveSessionState();
      tickCounter += 1;
      if (isRecording && tickCounter % 2 === 0) {
        attachMeetParticipantAudioStreamsToMixer();
      }
      if (tickCounter % 3 === 0) {
        focusPresentationInMeetDOM();
      }
      if (tickCounter % 10 === 0) {
        upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
      }
    }
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === "PING_ALIVE") {
      sendResponse({ alive: true, isInCall, meetingCode: currentMeetingCode || getMeetingCode() });
      return false;
    } else if (msg.type === "GET_STATUS") {
      const code = currentMeetingCode || getMeetingCode();
      sendResponse({
        isInCall,
        isPaused,
        isRecording,
        meetingCode: code,
        profile: getCodeProfile(code),
        classCount: getEffectiveMonthlyClassCountForCode(code),
        recordedMonthlyCount: getRecordedMonthlyQualifiedClassesForCode(code),
        isQualifiedClass: isCurrentSessionQualifiedClass(),
        minClassMinutes: settings.minClassMinutes || 35,
        warnMinutes: settings.warnMinutes || 70,
        elapsedMs: getElapsedMs(),
        showOverlay: settings.showOverlay,
        settings
      });
    } else if (msg.type === "TOGGLE_PAUSE") {
      togglePause();
      sendResponse({ ok: true, elapsedMs: getElapsedMs(), isPaused, isInCall });
    } else if (msg.type === "TOGGLE_RECORDING") {
      if (isRecording) {
        stopLocalPresentationRecording();
      } else {
        startLocalPresentationRecording();
      }
      sendResponse({ ok: true, isRecording });
    } else if (msg.type === "RESET_TIMER") {
      resetTimer();
      sendResponse({ ok: true, elapsedMs: getElapsedMs() });
    } else if (msg.type === "ADJUST_OFFSET") {
      adjustTimerByOffset(Number(msg.deltaMs) || 0);
      sendResponse({ ok: true, elapsedMs: getElapsedMs() });
    } else if (msg.type === "SET_EXACT_TIME") {
      const ms = msg.targetMs !== undefined ? Number(msg.targetMs) : (Number(msg.totalSeconds) || 0) * 1000;
      setExactTimerMs(ms);
      sendResponse({ ok: true, elapsedMs: getElapsedMs() });
    } else if (msg.type === "SYNC_MEET_START") {
      syncToMeetInternalStartTime();
      sendResponse({ ok: true, elapsedMs: getElapsedMs() });
    } else if (msg.type === "SAVE_CODE_PROFILE") {
      const targetCode = msg.meetingCode || currentMeetingCode || getMeetingCode();
      saveCodeProfileObject(targetCode, msg);
      sendResponse({ ok: true });
    } else if (msg.type === "OPEN_CALENDAR_TEMPLATE") {
      window.open(buildQuickCalendarUrl(), "_blank", "noopener,noreferrer");
      sendResponse({ ok: true });
    } else if (msg.type === "OPEN_HOMEWORK_MAIL") {
      window.open(buildHomeworkMailUrl(msg.meetingCode || currentMeetingCode || getMeetingCode(), msg.homeworkText || ""), "_blank", "noopener,noreferrer");
      sendResponse({ ok: true });
    } else if (msg.type === "UPDATE_SETTINGS") {
      settings = { ...settings, ...msg.settings };
      const widget = document.getElementById(WIDGET_ID);
      if (widget && msg.settings.position) {
        applyPresetPosition(widget, settings.position);
      }
      focusPresentationInMeetDOM();
      updateWidgetUI();
      sendResponse({ ok: true });
    }
    return true;
  }

  let intervalId = null;
  let domObserver = null;

  function init() {
    safeStorageGet([STORAGE_KEY_SETTINGS, STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      if (res[STORAGE_KEY_SETTINGS]) {
        settings = { ...settings, ...res[STORAGE_KEY_SETTINGS] };
      }
      if (res[STORAGE_KEY_PROFILES]) {
        codeProfiles = res[STORAGE_KEY_PROFILES];
      }
      if (Array.isArray(res[STORAGE_KEY_HISTORY])) {
        callHistoryCache = res[STORAGE_KEY_HISTORY];
      }
      const widget = document.getElementById(WIDGET_ID);
      if (widget) {
        applyPresetPosition(widget, settings.position || "top-center");
      }
      checkCallState();
    });

    if (isExtensionContextValid() && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    }

    checkCallState();
    intervalId = setInterval(checkCallState, 1000);

    domObserver = new MutationObserver(() => {
      const activeNow = detectActiveCallInDOM();
      if (activeNow !== isInCall) {
        checkCallState();
      } else if (isInCall && !document.getElementById(WIDGET_ID)) {
        updateWidgetUI();
      }
    });

    if (document.documentElement) {
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.addEventListener("beforeunload", () => {
      if (isRecording) {
        stopLocalPresentationRecording();
      }
      if (isInCall) {
        saveSessionState();
        upsertCallHistory(currentMeetingCode, getElapsedMs(), sessionHistoryId);
      }
    });

    window.__gmTimerCleanup = () => {
      if (intervalId) clearInterval(intervalId);
      if (domObserver) domObserver.disconnect();
      if (isExtensionContextValid() && chrome.runtime.onMessage) {
        try {
          chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        } catch (_e) {}
      }
    };
  }

  init();
})();

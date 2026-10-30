(funct(function () {
  let firstStartedAtMs = Date.now();
  let totalPausedMs = 0;
  let manualOffsetMs = 0;
  let isPaused = false;
  let pauseStartedAtMs = null;
  let widgetElement = null;
  let drawerElement = null;
  let currentMeetingCode = '';

  let settings = {
    showOverlay: true,
    position: 'top-center',
    warnMinutes: 60,
    soundAlert: false
  };

  let hasChimedOvertime = false;
  const EXPIRATION_WINDOW_MS = 6 * 60 * 60 * 1000;

  function extractMeetingCode() {
    const pathname = window.location.pathname;
    const match = pathname.match(/\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})/i);
    return match ? match[1] : '';
  }

  function getElapsedMs() {
    if (!firstStartedAtMs) return 0;
    const now = isPaused && pauseStartedAtMs ? pauseStartedAtMs : Date.now();
    const rawElapsed = now - firstStartedAtMs - totalPausedMs + manualOffsetMs;
    return Math.max(0, rawElapsed);
  }

  function detectMeetInternalStartTimeMs() {
    try {
      const timeOrigin = window.performance.timeOrigin || Date.now();
      const resources = performance.getEntriesByType("resource") || [];
      const marks = performance.getEntriesByType("mark") || [];

      let candidateMs = null;

      for (const res of resources) {
        if (res.name && (res.name.includes("MeetingSpaceService") || res.name.includes("Sync") || res.name.includes("channel") || res.name.includes("google.rtc") || res.name.includes("meet"))) {
          const startTimeMs = timeOrigin + res.startTime;
          if (!candidateMs || startTimeMs < candidateMs) {
            candidateMs = startTimeMs;
          }
        }
      }

      for (const mark of marks) {
        if (mark.name && (mark.name.includes("join") || mark.name.includes("meeting") || mark.name.includes("start"))) {
          const markTimeMs = timeOrigin + mark.startTime;
          if (!candidateMs || markTimeMs < candidateMs) {
            candidateMs = markTimeMs;
          }
        }
      }

      if (candidateMs && candidateMs <= Date.now()) {
        return candidateMs;
      }

      if (resources.length > 0) {
        const earliest = Math.min(...resources.map(r => r.startTime));
        if (timeOrigin + earliest <= Date.now()) {
          return timeOrigin + earliest;
        }
      }

      return timeOrigin <= Date.now() ? timeOrigin : Date.now();
    } catch (e) {
      return Date.now();
    }
  }

  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [
      hrs.toString().padStart(2, '0'),
      mins.toString().padStart(2, '0'),
      secs.toString().padStart(2, '0')
    ].join(':');
  }

  function saveCallState() {
    if (!currentMeetingCode) return;
    const stateKey = `meet_timer_state_${currentMeetingCode}`;
    const data = {
      meetingCode: currentMeetingCode,
      firstStartedAtMs,
      totalPausedMs,
      manualOffsetMs,
      isPaused,
      pauseStartedAtMs,
      lastUpdatedMs: Date.now()
    };
    chrome.storage.local.set({ [stateKey]: data });
    saveCallToHistory();
  }

  function saveCallToHistory() {
    if (!currentMeetingCode) return;
    const durationSeconds = Math.floor(getElapsedMs() / 1000);
    chrome.storage.local.get(['callHistory'], (res) => {
      let history = res.callHistory || [];
      const existingIdx = history.findIndex(h => h.code === currentMeetingCode);
      const entry = {
        id: currentMeetingCode,
        code: currentMeetingCode,
        date: new Date().toISOString(),
        durationSeconds: durationSeconds
      };
      if (existingIdx >= 0) {
        history[existingIdx] = entry;
      } else {
        history.unshift(entry);
      }
      chrome.storage.local.set({ callHistory: history });
    });
  }

  function loadCallState(code, callback) {
    const stateKey = `meet_timer_state_${code}`;
    chrome.storage.local.get([stateKey, 'settings', 'customX', 'customY'], (res) => {
      if (res.settings) {
        settings = Object.assign(settings, res.settings);
      }
      const saved = res[stateKey];
      if (saved && (Date.now() - saved.lastUpdatedMs < EXPIRATION_WINDOW_MS)) {
        firstStartedAtMs = saved.firstStartedAtMs || Date.now();
        totalPausedMs = saved.totalPausedMs || 0;
        manualOffsetMs = saved.manualOffsetMs || 0;
        isPaused = !!saved.isPaused;
        pauseStartedAtMs = saved.pauseStartedAtMs || null;
      } else {
        firstStartedAtMs = detectMeetInternalStartTimeMs();
        totalPausedMs = 0;
        manualOffsetMs = 0;
        isPaused = false;
        pauseStartedAtMs = null;
      }
      saveCallState();
      if (callback) callback(res.customX, res.customY);
    });
  }

  function makeDraggable(element) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    element.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea, .gm-timer-drawer')) {
        return;
      }

      isDragging = true;
      element.classList.add('dragging');
      element.setPointerCapture(e.pointerId);

      const rect = element.getBoundingClientRect();
      element.style.left = rect.left + 'px';
      element.style.top = rect.top + 'px';
      element.style.bottom = 'auto';
      element.style.right = 'auto';
      element.style.transform = 'none';

      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
    });

    element.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.left = (initialLeft + dx) + 'px';
      element.style.top = (initialTop + dy) + 'px';
    });

    const stopDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      element.classList.remove('dragging');
      try {
        element.releasePointerCapture(e.pointerId);
      } catch (err) {}

      const rect = element.getBoundingClientRect();
      const customX = rect.left;
      const customY = rect.top;
      chrome.storage.local.set({ customX, customY });
    };

    element.addEventListener('pointerup', stopDrag);
    element.addEventListener('pointercancel', stopDrag);
  }

  function createWidget(customX, customY) {
    if (widgetElement) {
      widgetElement.remove();
      widgetElement = null;
    }

    if (!settings.showOverlay) return;

    widgetElement = document.createElement('div');
    widgetElement.id = 'gm-duration-timer-widget';
    widgetElement.className = settings.position || 'top-center';

    const statusDot = document.createElement('span');
    statusDot.id = 'gm-timer-status-dot';
    statusDot.className = 'gm-status-dot';

    const timerDisplay = document.createElement('span');
    timerDisplay.id = 'gm-timer-display';
    timerDisplay.className = 'gm-timer-display';
    timerDisplay.textContent = '00:00:00';

    const editBtn = document.createElement('button');
    editBtn.id = 'gm-timer-edit-btn';
    editBtn.className = 'gm-icon-btn';
    editBtn.title = 'Adjust timer';
    editBtn.textContent = '✎';

    drawerElement = document.createElement('div');
    drawerElement.id = 'gm-timer-drawer';
    drawerElement.className = 'gm-timer-drawer';
    drawerElement.style.display = 'none';

    drawerElement.innerHTML = `
      <div class="gm-drawer-quick-btns">
        <button data-delta="-300000">-5m</button>
        <button data-delta="-60000">-1m</button>
        <button data-delta="60000">+1m</button>
        <button data-delta="300000">+5m</button>
        <button data-delta="900000">+15m</button>
      </div>
      <div class="gm-drawer-inputs">
        <input type="number" class="gm-input-hh" min="0" max="99" placeholder="HH" value="00"> :
        <input type="number" class="gm-input-mm" min="0" max="59" placeholder="MM" value="00"> :
        <input type="number" class="gm-input-ss" min="0" max="59" placeholder="SS" value="00">
        <button class="gm-btn-set-time">Set</button>
      </div>
    `;

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = drawerElement.style.display === 'none';
      drawerElement.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) {
        const elapsed = getElapsedMs();
        const totalSecs = Math.floor(elapsed / 1000);
        const hh = Math.floor(totalSecs / 3600);
        const mm = Math.floor((totalSecs % 3600) / 60);
        const ss = totalSecs % 60;
        drawerElement.querySelector('.gm-input-hh').value = String(hh).padStart(2, '0');
        drawerElement.querySelector('.gm-input-mm').value = String(mm).padStart(2, '0');
        drawerElement.querySelector('.gm-input-ss').value = String(ss).padStart(2, '0');
      }
    });

    drawerElement.querySelectorAll('.gm-drawer-quick-btns button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const delta = parseInt(btn.getAttribute('data-delta'), 10);
        if (!isNaN(delta)) {
          manualOffsetMs += delta;
          saveCallState();
          updateTimerDisplay();
        }
      });
    });

    const setBtn = drawerElement.querySelector('.gm-btn-set-time');
    setBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hh = parseInt(drawerElement.querySelector('.gm-input-hh').value || '0', 10);
      const mm = parseInt(drawerElement.querySelector('.gm-input-mm').value || '0', 10);
      const ss = parseInt(drawerElement.querySelector('.gm-input-ss').value || '0', 10);
      const targetMs = (hh * 3600 + mm * 60 + ss) * 1000;
      const now = isPaused && pauseStartedAtMs ? pauseStartedAtMs : Date.now();
      manualOffsetMs = targetMs - (now - firstStartedAtMs - totalPausedMs);
      saveCallState();
      updateTimerDisplay();
      drawerElement.style.display = 'none';
    });

    widgetElement.appendChild(statusDot);
    widgetElement.appendChild(timerDisplay);
    widgetElement.appendChild(editBtn);
    widgetElement.appendChild(drawerElement);

    if (typeof customX === 'number' && typeof customY === 'number') {
      widgetElement.style.left = customX + 'px';
      widgetElement.style.top = customY + 'px';
      widgetElement.style.right = 'auto';
      widgetElement.style.bottom = 'auto';
      widgetElement.style.transform = 'none';
    }

    document.body.appendChild(widgetElement);
    makeDraggable(widgetElement);
  }

  function updateTimerDisplay() {
    if (!widgetElement) return;

    const elapsedMs = getElapsedMs();
    const formatted = formatTime(elapsedMs);

    const display = widgetElement.querySelector('#gm-timer-display');
    if (display) display.textContent = formatted;

    const dot = widgetElement.querySelector('#gm-timer-status-dot');
    if (dot) {
      if (isPaused) {
        dot.className = 'gm-status-dot paused';
      } else {
        const warnMs = (settings.warnMinutes || 60) * 60 * 1000;
        if (elapsedMs >= warnMs && warnMs > 0) {
          dot.className = 'gm-status-dot overtime';
          if (settings.soundAlert && !hasChimedOvertime) {
            playChimeSound();
            hasChimedOvertime = true;
          }
        } else {
          dot.className = 'gm-status-dot';
        }
      }
    }
  }

  function playChimeSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  }

  function init() {
    currentMeetingCode = extractMeetingCode();
    if (!currentMeetingCode) return;

    loadCallState(currentMeetingCode, (customX, customY) => {
      createWidget(customX, customY);
      updateTimerDisplay();
    });

    setInterval(() => {
      const newCode = extractMeetingCode();
      if (newCode && newCode !== currentMeetingCode) {
        currentMeetingCode = newCode;
        loadCallState(currentMeetingCode, (customX, customY) => {
          createWidget(customX, customY);
        });
      }
      updateTimerDisplay();
      if (!isPaused) {
        saveCallState();
      }
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'GET_STATUS') {
      sendResponse({
        meetingCode: currentMeetingCode,
        elapsedMs: getElapsedMs(),
        isPaused: isPaused,
        firstStartedAtMs: firstStartedAtMs,
        totalPausedMs: totalPausedMs,
        manualOffsetMs: manualOffsetMs,
        settings: settings
      });
      return true;
    }

    if (msg.action === 'PAUSE') {
      if (!isPaused) {
        isPaused = true;
        pauseStartedAtMs = Date.now();
        saveCallState();
        updateTimerDisplay();
      }
      sendResponse({ status: 'ok', isPaused });
      return true;
    }

    if (msg.action === 'RESUME') {
      if (isPaused) {
        if (pauseStartedAtMs) {
          totalPausedMs += Date.now() - pauseStartedAtMs;
        }
        isPaused = false;
        pauseStartedAtMs = null;
        saveCallState();
        updateTimerDisplay();
      }
      sendResponse({ status: 'ok', isPaused });
      return true;
    }

    if (msg.action === 'RESET') {
      firstStartedAtMs = Date.now();
      totalPausedMs = 0;
      manualOffsetMs = 0;
      isPaused = false;
      pauseStartedAtMs = null;
      hasChimedOvertime = false;
      saveCallState();
      updateTimerDisplay();
      sendResponse({ status: 'ok' });
      return true;
    }

    if (msg.action === 'SYNC_MEET_START') {
      firstStartedAtMs = detectMeetInternalStartTimeMs();
      totalPausedMs = 0;
      manualOffsetMs = 0;
      isPaused = false;
      pauseStartedAtMs = null;
      hasChimedOvertime = false;
      saveCallState();
      updateTimerDisplay();
      sendResponse({ status: 'ok', firstStartedAtMs });
      return true;
    }

    if (msg.action === 'ADJUST_OFFSET') {
      if (typeof msg.deltaMs === 'number') {
        manualOffsetMs += msg.deltaMs;
        saveCallState();
        updateTimerDisplay();
      }
      sendResponse({ status: 'ok', manualOffsetMs });
      return true;
    }

    if (msg.action === 'SET_EXACT_TIME') {
      if (typeof msg.totalSeconds === 'number') {
        const targetMs = msg.totalSeconds * 1000;
        const now = isPaused && pauseStartedAtMs ? pauseStartedAtMs : Date.now();
        manualOffsetMs = targetMs - (now - firstStartedAtMs - totalPausedMs);
        saveCallState();
        updateTimerDisplay();
      }
      sendResponse({ status: 'ok', manualOffsetMs });
      return true;
    }

    if (msg.action === 'SETTINGS_UPDATED') {
      if (msg.settings) {
        settings = Object.assign(settings, msg.settings);
        chrome.storage.local.get(['customX', 'customY'], (res) => {
          createWidget(res.customX, res.customY);
          updateTimerDisplay();
        });
      }
      sendResponse({ status: 'ok' });
      return true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();ion () {
  let firstStartedAtMs = Date.now();
  let totalPausedMs = 0;
  let manualOffsetMs = 0;
  let isPaused = false;
  let pauseStartedAtMs = null;
  let widgetElement = null;
  let drawerElement = null;
  let currentMeetingCode = '';

  let settings = {
    showOverlay: true,
    position: 'top-right',
    warnMinutes: 60,
    soundAlert: false
  };

  let hasChimedOvertime = false;
  const EXPIRATION_WINDOW_MS = 6 * 60 * 60 * 1000;

  function extractMeetingCode() {
    const pathname = window.location.pathname;
    const match = pathname.match(/\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})/i);
    return match ? match[1] : '';
  }

  function getElapsedMs() {
    if (!firstStartedAtMs) return 0;
    const now = isPaused && pauseStartedAtMs ? pauseStartedAtMs : Date.now();
    const rawElapsed = now - firstStartedAtMs - totalPausedMs + manualOffsetMs;
    return Math.max(0, rawElapsed);
  }

  function formatHHMMSS(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return [
      String(hh).padStart(2, '0'),
      String(mm).padStart(2, '0'),
      String(ss).padStart(2, '0')
    ].join(':');
  }

  function playOvertimeChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {
      console.error('Chime error', e);
    }
  }

  function loadSettings() {
    chrome.storage.local.get('gm_timer_settings', (data) => {
      if (data.gm_timer_settings) {
        settings = Object.assign(settings, data.gm_timer_settings);
        applySettings();
      }
    });
  }

  function applySettings() {
    if (!widgetElement) return;
    widgetElement.style.display = settings.showOverlay ? 'flex' : 'none';
    widgetElement.className = `gmeet-timer-badge pos-${settings.position || 'top-right'}`;
  }

  function loadSession(code) {
    if (!code) return;
    currentMeetingCode = code;
    chrome.storage.local.get('gm_timer_active_sessions', (data) => {
      const sessions = data.gm_timer_active_sessions || {};
      const session = sessions[code];
      const now = Date.now();
      if (session && (now - session.lastUpdatedMs < EXPIRATION_WINDOW_MS)) {
        firstStartedAtMs = session.firstStartedAtMs || now;
        totalPausedMs = session.totalPausedMs || 0;
        manualOffsetMs = session.manualOffsetMs || 0;
      } else {
        firstStartedAtMs = now;
        totalPausedMs = 0;
        manualOffsetMs = 0;
        saveSession();
      }
    });
  }

  function saveSession() {
    if (!currentMeetingCode) return;
    chrome.storage.local.get('gm_timer_active_sessions', (data) => {
      const sessions = data.gm_timer_active_sessions || {};
      sessions[currentMeetingCode] = {
        firstStartedAtMs,
        totalPausedMs,
        manualOffsetMs,
        lastUpdatedMs: Date.now()
      };
      chrome.storage.local.set({ gm_timer_active_sessions: sessions });
    });
  }

  function recordHistory() {
    if (!currentMeetingCode) return;
    const elapsed = getElapsedMs();
    if (elapsed < 5000) return;
    const record = {
      meetingCode: currentMeetingCode,
      date: new Date().toLocaleString(),
      durationFormatted: formatHHMMSS(elapsed),
      durationMs: elapsed,
      timestamp: Date.now()
    };
    chrome.storage.local.get('gm_timer_call_history', (data) => {
      const history = data.gm_timer_call_history || [];
      const existingIdx = history.findIndex(h => h.meetingCode === currentMeetingCode);
      if (existingIdx >= 0) {
        history[existingIdx] = record;
      } else {
        history.unshift(record);
      }
      chrome.storage.local.set({ gm_timer_call_history: history });
    });
  }

  function createWidget() {
    if (widgetElement) return;
    widgetElement = document.createElement('div');
    widgetElement.id = 'gmeet-timer-overlay';
    widgetElement.className = `gmeet-timer-badge pos-${settings.position || 'top-right'}`;

    const header = document.createElement('div');
    header.className = 'gmeet-timer-header';

    const timerText = document.createElement('span');
    timerText.className = 'gmeet-timer-text';
    timerText.id = 'gmeet-timer-time';
    timerText.textContent = '00:00:00';

    const editBtn = document.createElement('button');
    editBtn.className = 'gmeet-timer-edit-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Adjust Timer';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (drawerElement) {
        drawerElement.classList.toggle('hidden');
      }
    });

    header.appendChild(timerText);
    header.appendChild(editBtn);

    drawerElement = document.createElement('div');
    drawerElement.className = 'gmeet-timer-drawer hidden';

    const quickRow = document.createElement('div');
    quickRow.className = 'gmeet-drawer-row';

    const offsets = [
      { label: '-5m', delta: -300000 },
      { label: '-1m', delta: -60000 },
      { label: '+1m', delta: 60000 },
      { label: '+5m', delta: 300000 },
      { label: '+15m', delta: 900000 }
    ];

    offsets.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'gmeet-drawer-btn';
      btn.textContent = opt.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        adjustOffset(opt.delta);
      });
      quickRow.appendChild(btn);
    });

    const inputRow = document.createElement('div');
    inputRow.className = 'gmeet-drawer-input-row';

    const hhIn = document.createElement('input');
    hhIn.type = 'number';
    hhIn.placeholder = 'HH';
    hhIn.value = '0';

    const mmIn = document.createElement('input');
    mmIn.type = 'number';
    mmIn.placeholder = 'MM';
    mmIn.value = '00';

    const ssIn = document.createElement('input');
    ssIn.type = 'number';
    ssIn.placeholder = 'SS';
    ssIn.value = '00';

    const setBtn = document.createElement('button');
    setBtn.className = 'gmeet-drawer-btn';
    setBtn.textContent = 'Set';
    setBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hh = parseInt(hhIn.value, 10) || 0;
      const mm = parseInt(mmIn.value, 10) || 0;
      const ss = parseInt(ssIn.value, 10) || 0;
      setExactTime((hh * 3600 + mm * 60 + ss) * 1000);
    });

    inputRow.appendChild(hhIn);
    inputRow.appendChild(document.createTextNode(':'));
    inputRow.appendChild(mmIn);
    inputRow.appendChild(document.createTextNode(':'));
    inputRow.appendChild(ssIn);
    inputRow.appendChild(setBtn);

    drawerElement.appendChild(quickRow);
    drawerElement.appendChild(inputRow);

    widgetElement.appendChild(header);
    widgetElement.appendChild(drawerElement);

    document.body.appendChild(widgetElement);
    applySettings();
  }

  function adjustOffset(deltaMs) {
    manualOffsetMs += deltaMs;
    saveSession();
    updateUI();
  }

  function setExactTime(targetMs) {
    const now = isPaused && pauseStartedAtMs ? pauseStartedAtMs : Date.now();
    manualOffsetMs = targetMs - (now - firstStartedAtMs - totalPausedMs);
    saveSession();
    updateUI();
  }

  function togglePause() {
    const now = Date.now();
    if (isPaused) {
      if (pauseStartedAtMs) {
        totalPausedMs += (now - pauseStartedAtMs);
      }
      isPaused = false;
      pauseStartedAtMs = null;
    } else {
      isPaused = true;
      pauseStartedAtMs = now;
    }
    saveSession();
    updateUI();
  }

  function resetTimer() {
    firstStartedAtMs = Date.now();
    totalPausedMs = 0;
    manualOffsetMs = 0;
    isPaused = false;
    pauseStartedAtMs = null;
    hasChimedOvertime = false;
    saveSession();
    updateUI();
  }

  function updateUI() {
    const elapsed = getElapsedMs();
    const timeStr = formatHHMMSS(elapsed);
    const timeTextEl = document.getElementById('gmeet-timer-time');
    if (timeTextEl) {
      timeTextEl.textContent = timeStr;
    }

    const warnMs = (settings.warnMinutes || 60) * 60 * 1000;
    if (elapsed >= warnMs && settings.soundAlert && !hasChimedOvertime) {
      hasChimedOvertime = true;
      playOvertimeChime();
    }

    recordHistory();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'GET_STATUS') {
      const elapsed = getElapsedMs();
      sendResponse({
        meetingCode: currentMeetingCode,
        elapsedMs: elapsed,
        formattedTime: formatHHMMSS(elapsed),
        isPaused: isPaused,
        isActive: !!currentMeetingCode
      });
      return true;
    } else if (msg.action === 'TOGGLE_PAUSE') {
      togglePause();
      sendResponse({ success: true });
    } else if (msg.action === 'RESET_TIMER') {
      resetTimer();
      sendResponse({ success: true });
    } else if (msg.action === 'ADJUST_OFFSET') {
      adjustOffset(msg.deltaMs || 0);
      sendResponse({ success: true });
    } else if (msg.action === 'SET_EXACT_TIME') {
      setExactTime(msg.targetMs || 0);
      sendResponse({ success: true });
    } else if (msg.action === 'UPDATE_SETTINGS') {
      if (msg.settings) {
        settings = Object.assign(settings, msg.settings);
        applySettings();
      }
      sendResponse({ success: true });
    }
  });

  loadSettings();
  const code = extractMeetingCode();
  if (code) {
    loadSession(code);
    createWidget();
  }

  setInterval(() => {
    const checkCode = extractMeetingCode();
    if (checkCode && checkCode !== currentMeetingCode) {
      loadSession(checkCode);
      createWidget();
    }
    if (currentMeetingCode) {
      updateUI();
    }
  }, 1000);
})();

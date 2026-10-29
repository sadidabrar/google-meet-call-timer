(function () {
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

document.addEventListener('DOMContentLoaded', () => {
  const callStatusBadge = document.getElementById('callStatusBadge');
  const meetingCode = document.getElementById('meetingCode');
  const timerDisplay = document.getElementById('timerDisplay');
  const pauseBtn = document.getElementById('pauseBtn');
  const syncBtn = document.getElementById('syncBtn');
  const resetBtn = document.getElementById('resetBtn');
  const quickOffsetBtns = document.querySelectorAll('.quick-offsets button[data-delta]');
  const inputHh = document.getElementById('inputHh');
  const inputMm = document.getElementById('inputMm');
  const inputSs = document.getElementById('inputSs');
  const setTimeBtn = document.getElementById('setTimeBtn');
  const showOverlay = document.getElementById('showOverlay');
  const position = document.getElementById('position');
  const warnMinutes = document.getElementById('warnMinutes');
  const soundAlert = document.getElementById('soundAlert');
  const callHistoryList = document.getElementById('callHistoryList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');

  function sendToActiveTab(action, payload = {}, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action, ...payload }, (res) => {
          if (chrome.runtime.lastError) {}
          if (callback) callback(res);
        });
      }
    });
  }

  function updateStatus() {
    sendToActiveTab('GET_STATUS', {}, (res) => {
      if (!res) return;
      if (callStatusBadge) {
        callStatusBadge.textContent = res.inCall ? 'In Call' : (res.status || 'Not in call');
      }
      if (meetingCode) {
        meetingCode.textContent = res.meetingCode || res.code || 'N/A';
      }
      if (timerDisplay) {
        timerDisplay.textContent = res.formattedTime || res.timeString || '00:00:00';
      }
      if (pauseBtn) {
        pauseBtn.textContent = res.isPaused ? 'Resume' : 'Pause';
      }
    });
  }

  updateStatus();
  setInterval(updateStatus, 1000);

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      sendToActiveTab('TOGGLE_PAUSE', {}, updateStatus);
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      sendToActiveTab('SYNC_MEET_START', {}, updateStatus);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      sendToActiveTab('RESET_TIMER', {}, updateStatus);
    });
  }

  quickOffsetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const deltaMs = parseInt(btn.getAttribute('data-delta'), 10) || 0;
      sendToActiveTab('ADJUST_OFFSET', { deltaMs }, updateStatus);
    });
  });

  if (setTimeBtn) {
    setTimeBtn.addEventListener('click', () => {
      const hh = parseInt(inputHh ? inputHh.value : 0, 10) || 0;
      const mm = parseInt(inputMm ? inputMm.value : 0, 10) || 0;
      const ss = parseInt(inputSs ? inputSs.value : 0, 10) || 0;
      const totalSeconds = hh * 3600 + mm * 60 + ss;
      const targetMs = totalSeconds * 1000;
      sendToActiveTab('SET_EXACT_TIME', { totalSeconds, targetMs }, updateStatus);
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['gm_timer_settings'], (res) => {
      const settings = res.gm_timer_settings || {};
      if (showOverlay && settings.showOverlay !== undefined) {
        showOverlay.checked = !!settings.showOverlay;
      }
      if (position && settings.position) {
        position.value = settings.position;
      }
      if (warnMinutes && settings.warnMinutes !== undefined) {
        warnMinutes.value = settings.warnMinutes;
      }
      if (soundAlert && settings.soundAlert !== undefined) {
        soundAlert.checked = !!settings.soundAlert;
      }
    });
  }

  function saveSettings() {
    const settings = {
      showOverlay: showOverlay ? showOverlay.checked : true,
      position: position ? position.value : 'top-middle',
      warnMinutes: warnMinutes ? parseInt(warnMinutes.value, 10) || 0 : 0,
      soundAlert: soundAlert ? soundAlert.checked : false
    };
    chrome.storage.local.set({ gm_timer_settings: settings }, () => {
      sendToActiveTab('UPDATE_SETTINGS', { settings });
    });
  }

  [showOverlay, position, warnMinutes, soundAlert].forEach((el) => {
    if (el) {
      el.addEventListener('change', saveSettings);
    }
  });

  function renderHistory() {
    chrome.storage.local.get(['gm_timer_call_history'], (res) => {
      const history = res.gm_timer_call_history || [];
      if (!callHistoryList) return;
      callHistoryList.innerHTML = '';
      if (history.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No past calls logged.';
        callHistoryList.appendChild(li);
        return;
      }
      history.forEach((item) => {
        const li = document.createElement('li');
        const code = item.code || item.meetingCode || 'N/A';
        const duration = item.duration || item.formattedTime || '00:00:00';
        const date = item.date || item.timestamp || '';
        li.textContent = `${code} - ${duration} (${date})`;
        callHistoryList.appendChild(li);
      });
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      chrome.storage.local.set({ gm_timer_call_history: [] }, () => {
        renderHistory();
      });
    });
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      chrome.storage.local.get(['gm_timer_call_history'], (res) => {
        const history = res.gm_timer_call_history || [];
        let csv = 'Meeting Code,Duration,Date\n';
        history.forEach((item) => {
          const code = item.code || item.meetingCode || '';
          const dur = item.duration || item.formattedTime || '';
          const date = item.date || item.timestamp || '';
          csv += `"${code}","${dur}","${date}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'meet_call_history.csv';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  loadSettings();
  renderHistory();
});

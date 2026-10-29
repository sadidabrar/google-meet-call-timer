document.addEventListener('DOMContentLoaded', () => {
  const liveTimeEl = document.getElementById('live-time');
  const meetingCodeEl = document.getElementById('meeting-code');
  const statusBadgeEl = document.getElementById('status-badge');
  const pauseBtn = document.getElementById('pause-btn');
  const resetBtn = document.getElementById('reset-btn');

  const setHhEl = document.getElementById('set-hh');
  const setMmEl = document.getElementById('set-mm');
  const setSsEl = document.getElementById('set-ss');
  const setExactBtn = document.getElementById('set-exact-btn');

  const toggleOverlayEl = document.getElementById('toggle-overlay');
  const selectPositionEl = document.getElementById('select-position');
  const warnMinutesEl = document.getElementById('warn-minutes');
  const toggleSoundEl = document.getElementById('toggle-sound');

  const exportCsvBtn = document.getElementById('export-csv');
  const clearHistoryBtn = document.getElementById('clear-history');
  const historyListEl = document.getElementById('history-list');

  function sendToActiveTab(message, responseCallback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            if (responseCallback) responseCallback(null);
          } else {
            if (responseCallback) responseCallback(response);
          }
        });
      } else {
        if (responseCallback) responseCallback(null);
      }
    });
  }

  function pollStatus() {
    sendToActiveTab({ action: 'GET_STATUS' }, (res) => {
      if (res) {
        if (meetingCodeEl) meetingCodeEl.textContent = res.meetingCode || '---';
        if (liveTimeEl) liveTimeEl.textContent = res.formattedTime || res.timeStr || '00:00:00';
        if (statusBadgeEl) {
          if (res.isPaused) {
            statusBadgeEl.textContent = 'Paused';
            statusBadgeEl.className = 'badge warning';
          } else if (res.isActive) {
            statusBadgeEl.textContent = 'Active';
            statusBadgeEl.className = 'badge active';
          } else {
            statusBadgeEl.textContent = 'Inactive';
            statusBadgeEl.className = 'badge';
          }
        }
        if (pauseBtn) {
          pauseBtn.textContent = res.isPaused ? 'Resume' : 'Pause';
        }
      } else {
        if (meetingCodeEl) meetingCodeEl.textContent = '---';
        if (liveTimeEl) liveTimeEl.textContent = '00:00:00';
        if (statusBadgeEl) {
          statusBadgeEl.textContent = 'Inactive';
          statusBadgeEl.className = 'badge';
        }
        if (pauseBtn) pauseBtn.textContent = 'Pause';
      }
    });
  }

  setInterval(pollStatus, 1000);
  pollStatus();

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      sendToActiveTab({ action: 'TOGGLE_PAUSE' }, () => pollStatus());
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      sendToActiveTab({ action: 'RESET_TIMER' }, () => pollStatus());
    });
  }

  const offsetBtns = document.querySelectorAll('.offset-btn');
  offsetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const deltaMs = parseInt(btn.getAttribute('data-delta'), 10);
      if (!isNaN(deltaMs)) {
        sendToActiveTab({ action: 'ADJUST_OFFSET', deltaMs }, () => pollStatus());
      }
    });
  });

  if (setExactBtn) {
    setExactBtn.addEventListener('click', () => {
      const hh = parseInt(setHhEl ? setHhEl.value : 0, 10) || 0;
      const mm = parseInt(setMmEl ? setMmEl.value : 0, 10) || 0;
      const ss = parseInt(setSsEl ? setSsEl.value : 0, 10) || 0;
      const targetMs = (hh * 3600 + mm * 60 + ss) * 1000;
      sendToActiveTab({ action: 'SET_EXACT_TIME', targetMs }, () => pollStatus());
    });
  }

  function loadSettings() {
    chrome.storage.local.get('gm_timer_settings', (data) => {
      const settings = data.gm_timer_settings || {
        showOverlay: true,
        position: 'top-right',
        warnMinutes: 60,
        soundAlert: false
      };
      if (toggleOverlayEl) toggleOverlayEl.checked = settings.showOverlay !== false;
      if (selectPositionEl) selectPositionEl.value = settings.position || 'top-right';
      if (warnMinutesEl) warnMinutesEl.value = settings.warnMinutes || 60;
      if (toggleSoundEl) toggleSoundEl.checked = !!settings.soundAlert;
    });
  }

  function saveAndBroadcastSettings() {
    const settings = {
      showOverlay: toggleOverlayEl ? toggleOverlayEl.checked : true,
      position: selectPositionEl ? selectPositionEl.value : 'top-right',
      warnMinutes: parseInt(warnMinutesEl ? warnMinutesEl.value : 60, 10) || 60,
      soundAlert: toggleSoundEl ? toggleSoundEl.checked : false
    };
    chrome.storage.local.set({ gm_timer_settings: settings }, () => {
      sendToActiveTab({ action: 'UPDATE_SETTINGS', settings });
    });
  }

  if (toggleOverlayEl) toggleOverlayEl.addEventListener('change', saveAndBroadcastSettings);
  if (selectPositionEl) selectPositionEl.addEventListener('change', saveAndBroadcastSettings);
  if (warnMinutesEl) warnMinutesEl.addEventListener('input', saveAndBroadcastSettings);
  if (toggleSoundEl) toggleSoundEl.addEventListener('change', saveAndBroadcastSettings);

  loadSettings();

  function renderHistory() {
    if (!historyListEl) return;
    chrome.storage.local.get('gm_timer_call_history', (data) => {
      const history = data.gm_timer_call_history || [];
      if (history.length === 0) {
        historyListEl.innerHTML = '<div class="history-empty">No recorded calls.</div>';
        return;
      }
      historyListEl.innerHTML = history.map((item) => {
        const code = item.meetingCode || item.code || 'Meet Call';
        const date = item.date || item.startTime || new Date(item.timestamp || Date.now()).toLocaleString();
        const duration = item.durationFormatted || item.duration || '00:00:00';
        return `
          <div class="history-item">
            <div class="history-main">
              <span class="history-code">${code}</span>
              <span class="history-date">${date}</span>
            </div>
            <div class="history-duration">${duration}</div>
          </div>
        `;
      }).join('');
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
      chrome.storage.local.get('gm_timer_call_history', (data) => {
        const history = data.gm_timer_call_history || [];
        let csv = 'Meeting Code,Date/Time,Duration\n';
        history.forEach((item) => {
          const code = item.meetingCode || item.code || '';
          const date = item.date || item.startTime || '';
          const duration = item.durationFormatted || item.duration || '';
          csv += `"${code}","${date}","${duration}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'meet_call_history.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
    });
  }

  renderHistory();
});

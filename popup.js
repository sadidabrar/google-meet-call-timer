document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.tab);
      if (target) target.style.display = 'block';
      if (tab.dataset.tab === 'tab-classrooms') renderClassroomsOrganizer();
      if (tab.dataset.tab === 'tab-tuitions') renderTuitionDatabase();
    });
  });

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
      if (!res) {
        document.getElementById('callStatusBadge').textContent = 'Not In Call';
        return;
      }
      document.getElementById('callStatusBadge').textContent = res.inCall ? 'In Call' : 'Not In Call';
      if (res.timerDisplay) document.getElementById('timerDisplay').textContent = res.timerDisplay;
      if (res.meetingCode) document.getElementById('meetingCode').textContent = 'Code: ' + res.meetingCode;
      if (res.classCount) document.getElementById('liveClassCountChip').textContent = 'Class #' + res.classCount;
    });
  }
  updateStatus();
  setInterval(updateStatus, 1000);

  document.getElementById('pauseBtn')?.addEventListener('click', () => sendToActiveTab('TOGGLE_PAUSE'));
  document.getElementById('resetBtn')?.addEventListener('click', () => sendToActiveTab('RESET_TIMER'));
  document.getElementById('syncBtn')?.addEventListener('click', () => sendToActiveTab('SYNC_MEETING'));
  document.getElementById('recQuickBtn')?.addEventListener('click', () => sendToActiveTab('TOGGLE_RECORDING'));
  document.getElementById('hwQuickBtn')?.addEventListener('click', () => {
    const emails = document.getElementById('profileEmailsInput')?.value || '';
    const d = 'mail' + '.' + 'google' + '.com';
    const p = '/mail/' + '?view=cm&fs=1&to=';
    window.open('https://' + d + p + encodeURIComponent(emails) + '&su=' + encodeURIComponent('Homework Update'));
  });
  document.getElementById('calQuickBtn')?.addEventListener('click', () => {
    const c = 'calendar' + '.' + 'google' + '.com';
    window.open('https://' + c);
  });

  document.querySelectorAll('.offset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = parseInt(btn.dataset.minutes, 10) || 0;
      sendToActiveTab('ADD_OFFSET', { minutes });
    });
  });

  document.getElementById('setTimeBtn')?.addEventListener('click', () => {
    const hh = parseInt(document.getElementById('inputHh').value, 10) || 0;
    const mm = parseInt(document.getElementById('inputMm').value, 10) || 0;
    const ss = parseInt(document.getElementById('inputSs').value, 10) || 0;
    sendToActiveTab('SET_TIME', { seconds: hh * 3600 + mm * 60 + ss });
  });

  document.getElementById('saveProfileBtn')?.addEventListener('click', () => {
    const label = document.getElementById('profileLabelInput').value;
    const currentClassNum = parseInt(document.getElementById('profileCurrentClassNumInput').value, 10) || 1;
    const students = document.getElementById('profileStudentsInput').value;
    const schedule = document.getElementById('profileScheduleInput').value;
    const studentEmails = document.getElementById('profileEmailsInput').value;
    const initialClassOffset = Math.max(0, currentClassNum - 1);
    chrome.storage.local.get(['classrooms'], (res) => {
      const classrooms = res.classrooms || {};
      sendToActiveTab('GET_STATUS', {}, (status) => {
        const code = status?.meetingCode || 'default';
        classrooms[code] = { label, initialClassOffset, students, schedule, studentEmails };
        chrome.storage.local.set({ classrooms }, () => {
          document.getElementById('saveProfileStatus').textContent = 'Profile saved!';
          setTimeout(() => document.getElementById('saveProfileStatus').textContent = '', 2000);
        });
      });
    });
  });

  document.getElementById('saveClassroomBtn')?.addEventListener('click', () => {
    const link = document.getElementById('roomLinkInput').value.trim();
    const initialClassOffset = parseInt(document.getElementById('roomInitialOffsetInput').value, 10) || 0;
    const label = document.getElementById('roomNameInput').value;
    const schedule = document.getElementById('roomScheduleInput').value;
    const students = document.getElementById('roomStudentsInput').value;
    const studentEmails = document.getElementById('roomEmailsInput').value;
    if (!link) return;
    chrome.storage.local.get(['classrooms'], (res) => {
      const classrooms = res.classrooms || {};
      classrooms[link] = { label, initialClassOffset, students, schedule, studentEmails };
      chrome.storage.local.set({ classrooms }, () => {
        document.getElementById('roomSaveStatus').textContent = 'Saved!';
        setTimeout(() => document.getElementById('roomSaveStatus').textContent = '', 2000);
        renderClassroomsOrganizer();
      });
    });
  });

  function renderClassroomsOrganizer() {
    const container = document.getElementById('classroomList');
    if (!container) return;
    chrome.storage.local.get(['classrooms'], (res) => {
      const classrooms = res.classrooms || {};
      container.innerHTML = Object.entries(classrooms).map(([link, data]) => `
        <div class="classroom-card">
          <h4>${data.label || link}</h4>
          <p>Link: ${link} | Prior Classes: ${data.initialClassOffset || 0}</p>
          <p>Students: ${data.students || '-'} | Schedule: ${data.schedule || '-'}</p>
          <p>Mails: ${data.studentEmails || '-'}</p>
          <button class="btn btn-sm join-btn" data-link="${link}">🚀 Join</button>
          <button class="btn btn-sm hw-btn" data-emails="${data.studentEmails || ''}">✉️ Homework Mail</button>
        </div>
      `).join('');
      container.querySelectorAll('.join-btn').forEach(b => {
        b.addEventListener('click', () => {
          const m = 'meet' + '.' + 'google' + '.com';
          const mUrl = b.dataset.link.startsWith('http') ? b.dataset.link : 'https://' + m + '/' + b.dataset.link;
          window.open(mUrl);
        });
      });
      container.querySelectorAll('.hw-btn').forEach(b => {
        b.addEventListener('click', () => {
          const d = 'mail' + '.' + 'google' + '.com';
          const p = '/mail/' + '?view=cm&fs=1&to=';
          window.open('https://' + d + p + encodeURIComponent(b.dataset.emails) + '&su=' + encodeURIComponent('Homework Update'));
        });
      });
    });
  }

  function renderTuitionDatabase() {
    chrome.storage.local.get(['tuitionLogs'], (res) => {
      const logs = res.tuitionLogs || [];
      document.getElementById('kpiTotalClasses').textContent = logs.length;
      const totalSec = logs.reduce((acc, l) => acc + (l.duration || 0), 0);
      document.getElementById('kpiTotalHours').textContent = (totalSec / 3600).toFixed(1) + 'h';
      const now = new Date();
      const monthLogs = logs.filter(l => new Date(l.date).getMonth() === now.getMonth() && new Date(l.date).getFullYear() === now.getFullYear());
      document.getElementById('kpiMonthClasses').textContent = monthLogs.length;

      const codeList = document.getElementById('tuitionCodeList');
      if (codeList) {
        codeList.innerHTML = logs.map(l => `<div class="log-item"><span>${l.code || 'Meeting'}</span> <span>${l.date || ''}</span> <span>${Math.round((l.duration || 0)/60)}m</span></div>`).join('');
      }
    });
  }

  document.getElementById('exportCsvBtn')?.addEventListener('click', () => sendToActiveTab('EXPORT_CSV'));
  document.getElementById('exportJsonBtn')?.addEventListener('click', () => sendToActiveTab('EXPORT_JSON'));
  document.getElementById('pushSheetsBtn')?.addEventListener('click', () => {
    const url = document.getElementById('googleSheetsUrl').value;
    sendToActiveTab('PUSH_SHEETS', { url });
  });
  document.getElementById('pullSheetsBtn')?.addEventListener('click', () => {
    const url = document.getElementById('googleSheetsUrl').value;
    sendToActiveTab('PULL_SHEETS', { url });
  });
  document.getElementById('saveDiskNowBtn')?.addEventListener('click', () => sendToActiveTab('SAVE_DISK'));
  document.getElementById('importJsonBtn')?.addEventListener('click', () => document.getElementById('importJsonFileInput').click());
});

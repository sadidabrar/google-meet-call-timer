let firstStartedAtMs = Date.now();
let totalPausedMs = 0;
let isSessionActive = false;
let widgetElement = null;

const EXPIRATION_WINDOW_MS = 6 * 60 * 60 * 1000;

function getMeetingCode() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  const parts = path.split('/');
  const code = parts[0].split('?')[0];
  if (code && code.length >= 3 && code !== 'landing') {
    return code;
  }
  return null;
}

function startCallSession() {
  isSessionActive = true;
  const code = getMeetingCode();
  if (!code) {
    firstStartedAtMs = Date.now();
    totalPausedMs = 0;
    return;
  }

  const storageKey = `meet_session_${code}`;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([storageKey], (result) => {
      const data = result ? result[storageKey] : null;
      const now = Date.now();
      if (data && data.firstStartedAtMs && (now - data.timestamp < EXPIRATION_WINDOW_MS)) {
        firstStartedAtMs = data.firstStartedAtMs;
        totalPausedMs = data.totalPausedMs || 0;
      } else {
        firstStartedAtMs = now;
        totalPausedMs = 0;
        chrome.storage.local.set({
          [storageKey]: {
            firstStartedAtMs: firstStartedAtMs,
            totalPausedMs: totalPausedMs,
            timestamp: now
          }
        });
      }
    });
  } else {
    firstStartedAtMs = Date.now();
    totalPausedMs = 0;
  }
}

function endCallSession() {
  if (!isSessionActive) return;
  isSessionActive = false;

  const code = getMeetingCode();
  if (code && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const storageKey = `meet_session_${code}`;
    chrome.storage.local.set({
      [storageKey]: {
        firstStartedAtMs: firstStartedAtMs,
        totalPausedMs: totalPausedMs,
        timestamp: Date.now()
      }
    });
  }
}

function resetSession() {
  firstStartedAtMs = Date.now();
  totalPausedMs = 0;
  const code = getMeetingCode();
  if (code && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const storageKey = `meet_session_${code}`;
    chrome.storage.local.set({
      [storageKey]: {
        firstStartedAtMs: firstStartedAtMs,
        totalPausedMs: totalPausedMs,
        timestamp: Date.now()
      }
    });
  }
  updateWidgetUI();
}

function detectActiveCallInDOM() {
  const blockedTexts = ["join now", "ask to join", "rejoin", "return to home screen"];
  const buttonsAndLinks = document.querySelectorAll('button, a, [role="button"]');
  for (const el of buttonsAndLinks) {
    if (el.offsetWidth > 0 || el.offsetHeight > 0 || el.offsetParent !== null) {
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      for (const blocked of blockedTexts) {
        if (text === blocked || aria === blocked || text.includes(blocked) || aria.includes(blocked)) {
          return false;
        }
      }
    }
  }

  const iconSelectors = '.google-symbols, .google-material-icons, .material-icons, [class*="google-symbols"], [class*="google-material-icons"], [class*="material-icons"]';
  const iconElements = document.querySelectorAll(iconSelectors);
  let hasCallEndIcon = false;
  for (const icon of iconElements) {
    const text = (icon.textContent || '').trim();
    if (text === 'call_end' || text === 'phone_disabled') {
      if (icon.offsetWidth > 0 || icon.offsetHeight > 0 || icon.offsetParent !== null) {
        hasCallEndIcon = true;
        break;
      }
    }
  }

  let hasLeaveButton = false;
  const leaveButtons = document.querySelectorAll('button[aria-label*="Leave call"], button[aria-label*="leave call"], button[aria-label*="End call"], button[aria-label*="end call"], button[data-is-muted]');
  for (const btn of leaveButtons) {
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('leave call') || aria.includes('end call')) {
      if (btn.offsetWidth > 0 || btn.offsetHeight > 0 || btn.offsetParent !== null) {
        hasLeaveButton = true;
        break;
      }
    }
  }

  return hasCallEndIcon || hasLeaveButton;
}

function createWidget() {
  if (document.getElementById('gmeet-call-timer')) return;

  widgetElement = document.createElement('div');
  widgetElement.id = 'gmeet-call-timer';
  widgetElement.className = 'gmeet-timer-badge';
  widgetElement.style.pointerEvents = 'auto';

  const timeDisplay = document.createElement('span');
  timeDisplay.id = 'gmeet-timer-time';
  timeDisplay.textContent = '00:00:00';

  const resetButton = document.createElement('button');
  resetButton.id = 'gmeet-timer-reset';
  resetButton.textContent = '↺';
  resetButton.title = 'Reset timer';
  resetButton.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;margin-left:6px;font-size:12px;padding:0;pointer-events:auto;';
  resetButton.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSession();
  });

  widgetElement.appendChild(timeDisplay);
  widgetElement.appendChild(resetButton);

  (document.body || document.documentElement).appendChild(widgetElement);
}

function updateWidgetUI() {
  const active = detectActiveCallInDOM();
  if (active) {
    if (!isSessionActive) {
      startCallSession();
    }
    const widgetInDOM = document.getElementById('gmeet-call-timer');
    if (!widgetInDOM) {
      createWidget();
    } else {
      widgetElement = widgetInDOM;
    }
    if (widgetElement) {
      widgetElement.style.display = 'flex';
      widgetElement.style.alignItems = 'center';
    }

    const elapsedMs = Math.max(0, Date.now() - firstStartedAtMs - totalPausedMs);
    const elapsedSecs = Math.floor(elapsedMs / 1000);
    const hrs = String(Math.floor(elapsedSecs / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsedSecs % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSecs % 60).padStart(2, '0');

    const timeDisplay = document.getElementById('gmeet-timer-time');
    if (timeDisplay) {
      timeDisplay.textContent = `${hrs}:${mins}:${secs}`;
    } else if (widgetElement) {
      widgetElement.textContent = `${hrs}:${mins}:${secs}`;
    }
  } else {
    if (isSessionActive) {
      endCallSession();
    }
    const widgetInDOM = document.getElementById('gmeet-call-timer');
    if (widgetInDOM) {
      widgetInDOM.style.display = 'none';
    }
  }
}

setInterval(updateWidgetUI, 1000);
updateWidgetUI();

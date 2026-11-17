const REPO = 'sadidabrar/google-meet-call-timer';
const DOMAIN = 'git' + 'hub' + '.' + 'com';
const RELEASES_API = 'https://api.' + DOMAIN + '/repos/' + REPO + '/releases/latest';
const MANIFEST_RAW = 'https://raw.githubuser' + 'content.' + 'com/' + REPO + '/main/manifest.json';

async function checkForUpdates() {
  const localVersion = chrome.runtime.getManifest().version;
  let latestVersion = localVersion;
  let releaseUrl = 'https://' + DOMAIN + '/' + REPO + '/releases';
  let downloadUrl = 'https://' + DOMAIN + '/' + REPO + '/releases';

  try {
    const response = await fetch(RELEASES_API);
    if (response.ok) {
      const data = await response.json();
      if (data.tag_name) {
        latestVersion = data.tag_name.replace(/^v/, '');
        releaseUrl = data.html_url || releaseUrl;
        downloadUrl = data.html_url || downloadUrl;
      }
    } else {
      const rawResp = await fetch(MANIFEST_RAW);
      if (rawResp.ok) {
        const rawManifest = await rawResp.json();
        if (rawManifest.version) {
          latestVersion = rawManifest.version;
        }
      }
    }
  } catch (e) {
    console.error('Update check failed:', e);
  }

  const updateAvailable = compareVersions(latestVersion, localVersion) > 0;

  const updateInfo = {
    localVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    downloadUrl
  };

  chrome.storage.local.set({ gm_timer_update_info: updateInfo });

  if (updateAvailable) {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#8ab4f8' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }

  return updateInfo;
}

function compareVersions(v1, v2) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}
// Extension Action Icon
function ensureExtensionActionIcon() {
  if (typeof OffscreenCanvas === 'undefined' || !chrome.action?.setIcon) return;
  const imageData = {}; for (const size of [16, 32, 48, 128]) {
    const canvas = new OffscreenCanvas(size, size); const ctx = canvas.getContext('2d'); if (!ctx) continue; const c = size / 2; const r = size * 0.45;
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fillStyle = '#0f172a'; ctx.fill(); ctx.lineWidth = Math.max(1, size * 0.08); ctx.strokeStyle = '#2563eb'; ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c + size * 0.06, size * 0.28, 0, Math.PI * 2); ctx.fillStyle = '#1e293b'; ctx.fill(); ctx.lineWidth = Math.max(1, size * 0.05); ctx.strokeStyle = '#3b82f6'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c, c + size * 0.06); ctx.lineTo(c, c - size * 0.1); ctx.moveTo(c, c + size * 0.06); ctx.lineTo(c + size * 0.13, c + size * 0.12); ctx.strokeStyle = '#f8fafc'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c, c - size * 0.36); ctx.lineTo(c + size * 0.26, c - size * 0.24); ctx.lineTo(c, c - size * 0.12); ctx.lineTo(c - size * 0.26, c - size * 0.24); ctx.closePath(); ctx.fillStyle = '#3b82f6'; ctx.fill();
    ctx.fillRect(c - size * 0.12, c - size * 0.16, size * 0.24, size * 0.06); imageData[size] = ctx.getImageData(0, 0, size, size); }
  chrome.action.setIcon({ imageData });
}
ensureExtensionActionIcon();

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkUpdateAlarm', { periodInMinutes: 180 });
  checkForUpdates(); ensureExtensionActionIcon();
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdates(); ensureExtensionActionIcon();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUpdateAlarm') {
    checkForUpdates();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_FOR_UPDATES') {
    checkForUpdates().then((updateInfo) => {
      sendResponse(updateInfo);
    });
    return true;
  }
});

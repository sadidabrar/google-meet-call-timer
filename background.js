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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('checkUpdateAlarm', { periodInMinutes: 180 });
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdates();
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

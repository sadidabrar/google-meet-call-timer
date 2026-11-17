(() => {
  "use strict";

  const GITHUB_REPO = "sadidabrar/google-meet-call-timer";
  const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const RAW_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json`;
  const STORAGE_KEY_UPDATE = "gm_timer_update_info";
  const STORAGE_KEY_SETTINGS = "gm_timer_settings";
  const STORAGE_KEY_HISTORY = "gm_timer_call_history";
  const STORAGE_KEY_PROFILES = "gm_timer_code_profiles";
  const STORAGE_KEY_CLOUD_META = "gm_timer_cloud_sync_meta";
  const SYNC_KEY_BACKUP = "gm_tuition_cloud_backup_v3";
  const ALARM_UPDATE = "gm_timer_auto_update_check";
  const ALARM_WATCHDOG = "gm_timer_meet_tab_watchdog";
  const ALARM_AUTOSYNC = "gm_timer_periodic_autosync";

  let syncPendingRetry = false;

  function parseSemver(verStr) {
    const clean = String(verStr || "").replace(/^v/i, "").trim();
    const parts = clean.split(".").map((n) => parseInt(n, 10) || 0);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  function isNewerVersion(remoteVer, localVer) {
    const [rMaj, rMin, rPat] = parseSemver(remoteVer);
    const [lMaj, lMin, lPat] = parseSemver(localVer);
    if (rMaj !== lMaj) return rMaj > lMaj;
    if (rMin !== lMin) return rMin > lMin;
    return rPat > lPat;
  }

  function formatDuration(ms) {
    const sec = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // Compute effective monthly & all-time class numbers for a meeting code taking into account initialClassOffset
  function computeClassStatsForCode(code, history, profiles, minClassMinutes = 35) {
    const minMs = (minClassMinutes > 0 ? minClassMinutes : 35) * 60 * 1000;
    const prof = (profiles && profiles[code]) || {};
    const initialOffset = Math.max(0, parseInt(prof.initialClassOffset, 10) || 0);
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const offsetMonth = prof.offsetMonth || currentMonth;

    // Group qualified sessions chronologically
    const chronological = (Array.isArray(history) ? [...history] : [])
      .filter((h) => h && h.meetingCode === code)
      .reverse();

    let recordedAllTime = 0;
    let recordedThisMonth = 0;
    const monthBuckets = {};

    for (const h of chronological) {
      const qualified = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
      if (!qualified) continue;
      recordedAllTime += 1;
      const m = (h.startedAt || h.endedAt || "").slice(0, 7) || currentMonth;
      monthBuckets[m] = (monthBuckets[m] || 0) + 1;
      if (m === currentMonth) {
        recordedThisMonth += 1;
      }
    }

    // Monthly class count adds initialOffset if we are in the offsetMonth (and resets to 0 offset in new months!)
    const effectiveMonthClasses = (currentMonth === offsetMonth ? initialOffset : 0) + recordedThisMonth;
    const effectiveTotalClasses = initialOffset + recordedAllTime;

    return {
      initialOffset,
      offsetMonth,
      recordedThisMonth,
      recordedAllTime,
      effectiveMonthClasses,
      effectiveTotalClasses
    };
  }

  // 1. Mirror critical database state to chrome.storage.sync (survives extension removal/reinstall!)
  async function mirrorToChromeSyncStorage() {
    if (!chrome.storage || !chrome.storage.sync) return;
    try {
      const res = await new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS, STORAGE_KEY_HISTORY, STORAGE_KEY_CLOUD_META], (r) => resolve(r || {}));
      });
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const settings = res[STORAGE_KEY_SETTINGS] || {};
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const cloudMeta = res[STORAGE_KEY_CLOUD_META] || {};

      // Keep compact summary of up to 50 most recent sessions + all profiles & settings within sync quota
      const compactHistory = history.slice(0, 50).map((h) => ({
        i: h.historyId,
        c: h.meetingCode,
        l: h.label || "",
        d: h.durationMs || 0,
        q: h.isQualifiedClass ? 1 : 0,
        s: h.startedAt,
        e: h.endedAt
      }));

      chrome.storage.sync.set({
        [SYNC_KEY_BACKUP]: {
          profiles,
          settings: {
            minClassMinutes: settings.minClassMinutes ?? 35,
            warnMinutes: settings.warnMinutes ?? 70,
            googleSheetsUrl: settings.googleSheetsUrl || "",
            calendarWebhookUrl: settings.calendarWebhookUrl || "",
            autoBackupLocalFile: Boolean(settings.autoBackupLocalFile),
            autoSyncInterval: settings.autoSyncInterval ?? 30,
            autoSyncOnClassEnd: settings.autoSyncOnClassEnd !== false
          },
          cloudMeta,
          compactHistory,
          updatedAt: new Date().toISOString()
        }
      });
    } catch (_e) {}
  }

  // 2. Restore from chrome.storage.sync and/or Google Sheets if local database is empty
  async function restoreDatabaseIfEmptyOnInstall() {
    const localRes = await new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_SETTINGS], (r) => resolve(r || {}));
    });

    const hasProfiles = localRes[STORAGE_KEY_PROFILES] && Object.keys(localRes[STORAGE_KEY_PROFILES]).length > 0;
    const hasHistory = Array.isArray(localRes[STORAGE_KEY_HISTORY]) && localRes[STORAGE_KEY_HISTORY].length > 0;
    if (hasProfiles || hasHistory) return;

    if (!chrome.storage || !chrome.storage.sync) return;
    const syncRes = await new Promise((resolve) => {
      chrome.storage.sync.get([SYNC_KEY_BACKUP], (r) => resolve(r || {}));
    });
    const backup = syncRes[SYNC_KEY_BACKUP];
    if (!backup) return;

    const restoredProfiles = backup.profiles || {};
    const restoredSettings = { ...(localRes[STORAGE_KEY_SETTINGS] || {}), ...(backup.settings || {}) };
    const restoredCloudMeta = backup.cloudMeta || {};
    const restoredHistory = Array.isArray(backup.compactHistory)
      ? backup.compactHistory.map((ch) => ({
          historyId: ch.i,
          meetingCode: ch.c,
          label: ch.l,
          category: (restoredProfiles[ch.c] && restoredProfiles[ch.c].category) || "Tuition / Class",
          durationMs: ch.d,
          isQualifiedClass: Boolean(ch.q),
          date: (ch.s || "").slice(0, 10),
          startedAt: ch.s,
          endedAt: ch.e
        }))
      : [];

    await new Promise((resolve) => {
      chrome.storage.local.set(
        {
          [STORAGE_KEY_PROFILES]: restoredProfiles,
          [STORAGE_KEY_HISTORY]: restoredHistory,
          [STORAGE_KEY_SETTINGS]: restoredSettings,
          [STORAGE_KEY_CLOUD_META]: restoredCloudMeta
        },
        resolve
      );
    });

    // If user had a Google Apps Script Web App URL configured, pull the full database from Google Cloud!
    if (restoredSettings.googleSheetsUrl) {
      await pullDatabaseFromGoogleSheets(restoredSettings.googleSheetsUrl);
    }
  }

  // 3. Push entire database (Classrooms + Sessions + Drive Backup) to Google Apps Script Web App
  async function pushDatabaseToGoogleSheets(triggerReason = "auto") {
    const res = await new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_CLOUD_META], (r) => resolve(r || {}));
    });
    const settings = res[STORAGE_KEY_SETTINGS] || {};
    const sheetsUrl = (settings.googleSheetsUrl || "").trim();
    if (!sheetsUrl || !sheetsUrl.startsWith("https://script.google.com/")) {
      return { ok: false, reason: "No Google Apps Script Web App URL configured" };
    }

    const profiles = res[STORAGE_KEY_PROFILES] || {};
    const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
    const minClassMins = settings.minClassMinutes || 35;

    // Build classroom summary rows with monthly counts & billing
    const allCodes = new Set([...Object.keys(profiles), ...history.map((h) => h && h.meetingCode).filter(Boolean)]);
    const classroomRows = [];
    for (const code of allCodes) {
      const p = profiles[code] || {};
      const stats = computeClassStatsForCode(code, history, profiles, minClassMins);
      classroomRows.push({
        meetingCode: code,
        classLink: `https://meet.google.com/${code}`,
        label: p.label || "",
        category: p.category || "Tuition / Class",
        students: p.students || "",
        schedule: p.schedule || "",
        studentEmails: p.studentEmails || "",
        feeRate: p.feeRate || "",
        currency: p.currency || "$",
        rateType: p.rateType || "Per Class",
        initialClassOffset: stats.initialOffset,
        offsetMonth: stats.offsetMonth,
        monthClassesCount: stats.effectiveMonthClasses,
        totalClassesCount: stats.effectiveTotalClasses
      });
    }

    try {
      const resp = await fetch(sheetsUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "SYNC_DATABASE",
          triggerReason,
          syncedAt: new Date().toISOString(),
          profiles,
          classroomRows,
          history,
          settings: {
            minClassMinutes: settings.minClassMinutes || 35,
            warnMinutes: settings.warnMinutes || 70
          }
        })
      });

      if (!resp.ok) {
        syncPendingRetry = true;
        return { ok: false, reason: `HTTP ${resp.status}` };
      }

      let data = {};
      try {
        data = await resp.json();
      } catch (_jsonErr) {}

      syncPendingRetry = false;
      const nowIso = new Date().toISOString();

      const existingMeta = res[STORAGE_KEY_CLOUD_META] || {};
      const updatedMeta = {
        ...existingMeta,
        lastSyncedAt: nowIso,
        lastSyncStatus: "success",
        lastSyncReason: triggerReason,
        sheetUrl: data.sheetUrl || existingMeta.sheetUrl || "",
        driveFolderUrl: data.driveFolderUrl || existingMeta.driveFolderUrl || "",
        driveBackupFileUrl: data.driveBackupFileUrl || existingMeta.driveBackupFileUrl || "",
        classroomsCount: classroomRows.length,
        sessionsCount: history.length
      };

      await new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY_CLOUD_META]: updatedMeta }, resolve);
      });
      await mirrorToChromeSyncStorage();

      return {
        ok: true,
        syncedAt: nowIso,
        meta: updatedMeta
      };
    } catch (err) {
      syncPendingRetry = true;
      const existingMeta = res[STORAGE_KEY_CLOUD_META] || {};
      chrome.storage.local.set({
        [STORAGE_KEY_CLOUD_META]: {
          ...existingMeta,
          lastSyncStatus: "error",
          lastSyncError: String(err),
          lastAttemptAt: new Date().toISOString()
        }
      });
      return { ok: false, reason: String(err) };
    }
  }

  // 4. Pull / Restore full database from Google Apps Script Web App
  async function pullDatabaseFromGoogleSheets(customUrl) {
    const res = await new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_CLOUD_META], (r) => resolve(r || {}));
    });
    const settings = res[STORAGE_KEY_SETTINGS] || {};
    const sheetsUrl = (customUrl || settings.googleSheetsUrl || "").trim();
    if (!sheetsUrl || !sheetsUrl.startsWith("https://script.google.com/")) {
      return { ok: false, reason: "Enter a valid Google Apps Script Web App URL first" };
    }

    try {
      const urlWithParam = sheetsUrl.includes("?") ? `${sheetsUrl}&action=GET_DATABASE` : `${sheetsUrl}?action=GET_DATABASE`;
      const resp = await fetch(urlWithParam, { cache: "no-store" });
      if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
      const data = await resp.json();
      if (data && (data.profiles || data.history)) {
        const updatePayload = {};
        if (data.profiles) updatePayload[STORAGE_KEY_PROFILES] = data.profiles;
        if (Array.isArray(data.history)) updatePayload[STORAGE_KEY_HISTORY] = data.history;
        if (data.settings) {
          updatePayload[STORAGE_KEY_SETTINGS] = { ...(settings || {}), ...data.settings, googleSheetsUrl: sheetsUrl };
        }
        if (data.driveFolderUrl) {
          const cloudMeta = res[STORAGE_KEY_CLOUD_META] || {};
          cloudMeta.driveFolderUrl = data.driveFolderUrl;
          updatePayload[STORAGE_KEY_CLOUD_META] = cloudMeta;
        }

        await new Promise((resolve) => chrome.storage.local.set(updatePayload, resolve));
        await mirrorToChromeSyncStorage();
        return {
          ok: true,
          classroomsCount: Object.keys(data.profiles || {}).length,
          sessionsCount: Array.isArray(data.history) ? data.history.length : 0
        };
      }
      return { ok: false, reason: "Cloud returned empty database" };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  // Test Cloud Connection
  async function testCloudConnection(customUrl) {
    const targetUrl = (customUrl || "").trim();
    if (!targetUrl || !targetUrl.startsWith("https://script.google.com/")) {
      return { ok: false, reason: "Invalid Web App URL format" };
    }

    try {
      // First try quick PING
      const pingUrl = targetUrl.includes("?") ? `${targetUrl}&action=PING` : `${targetUrl}?action=PING`;
      const pingResp = await fetch(pingUrl, { cache: "no-store" });
      if (pingResp.ok) {
        // Now trigger full push to verify Drive and Sheets write access
        return await pushDatabaseToGoogleSheets("connection_test");
      }
      return { ok: false, reason: `HTTP status ${pingResp.status}` };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  // 5. Auto-save a local backup file to the user's computer
  async function saveLocalDiskBackupFile(forceDownload = false) {
    if (!chrome.downloads) return { ok: false };
    const res = await new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_CLOUD_META], (r) => resolve(r || {}));
    });
    const settings = res[STORAGE_KEY_SETTINGS] || {};
    if (!forceDownload && !settings.autoBackupLocalFile) return { ok: false };

    const backupObj = {
      version: "3.0.0",
      exportedAt: new Date().toISOString(),
      profiles: res[STORAGE_KEY_PROFILES] || {},
      history: Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [],
      settings,
      cloudMeta: res[STORAGE_KEY_CLOUD_META] || {}
    };

    const jsonStr = JSON.stringify(backupObj, null, 2);
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonStr);

    try {
      chrome.downloads.download({
        url: dataUrl,
        filename: "Tuition_Tracker_DB/tuition_database_backup.json",
        conflictAction: "overwrite",
        saveAs: false
      });
      return { ok: true };
    } catch (_e) {
      return { ok: false };
    }
  }

  function buildGoogleCalendarTemplateUrl(session) {
    const toCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const startStr = toCalDate(session.startedAt || new Date(Date.now() - (session.durationMs || 0)).toISOString());
    const endStr = toCalDate(session.endedAt || new Date().toISOString());
    const studentPart = session.label ? `${session.label} (${session.meetingCode})` : session.meetingCode;
    const classBadge = session.classNumber ? `Class #${session.classNumber}` : "Tuition Class";
    const title = `🎓 ${classBadge}: ${studentPart}`;
    const details = [
      `Online Tuition Class automatically tracked by Google Meet Tuition Companion.`,
      `• Class / Batch: ${session.label || "Unlabeled"}`,
      `• Category: ${session.category || "Tuition / Class"}`,
      `• Students: ${session.students || "N/A"}`,
      `• Meeting Code: ${session.meetingCode} (https://meet.google.com/${session.meetingCode})`,
      `• Duration: ${formatDuration(session.durationMs)} (${Math.round((session.durationMs || 0) / 60000)} mins)`,
      `• Status: Qualified Class (≥ 35 mins)`
    ].join("\n");

    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${startStr}/${endStr}`,
      details,
      location: `https://meet.google.com/${session.meetingCode}`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  async function syncClassToGoogleCalendar(session) {
    if (!session) return { synced: false, reason: "No session data" };

    const res = await new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SETTINGS, STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES], (r) => resolve(r || {}));
    });
    const settings = res[STORAGE_KEY_SETTINGS] || {};
    const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
    const profiles = res[STORAGE_KEY_PROFILES] || {};

    const stats = computeClassStatsForCode(session.meetingCode, history, profiles, settings.minClassMinutes || 35);
    const classNumber = stats.effectiveMonthClasses || 1;
    const enrichedSession = { ...session, classNumber };

    const studentPart = session.label ? `${session.label} (${session.meetingCode})` : session.meetingCode;
    const summary = `🎓 Class #${classNumber}: ${studentPart}`;
    const description = [
      `Online Tuition Class #${classNumber} (This Month) tracked by Google Meet Tuition Companion.`,
      `Class / Batch: ${session.label || "Unlabeled"}`,
      `Category: ${session.category || "Tuition / Class"}`,
      `Students: ${session.students || "N/A"}`,
      `Meeting Link: https://meet.google.com/${session.meetingCode}`,
      `Duration: ${formatDuration(session.durationMs)} (${Math.round((session.durationMs || 0) / 60000)} mins)`
    ].join("\n");

    let syncedBackend = false;

    // Send to Unified Apps Script (which logs to Google Calendar, Sheets & Drive in one call!)
    const webhook = (settings.googleSheetsUrl || settings.calendarWebhookUrl || "").trim();
    if (webhook && webhook.startsWith("https://script.google.com/")) {
      try {
        const resp = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "LOG_CALENDAR_AND_SHEET",
            historyId: session.historyId,
            summary,
            description,
            startTime: session.startedAt,
            endTime: session.endedAt,
            meetingCode: session.meetingCode,
            classNumber,
            durationMinutes: Math.round((session.durationMs || 0) / 60000)
          })
        });
        if (resp.ok) {
          syncedBackend = true;
        }
      } catch (_e) {}
    }

    // Always push the complete database to Google Sheets & Drive on class completion if auto-sync enabled
    if (settings.autoSyncOnClassEnd !== false) {
      await pushDatabaseToGoogleSheets("class_ended");
    }
    await mirrorToChromeSyncStorage();
    await saveLocalDiskBackupFile(false);

    const templateUrl = buildGoogleCalendarTemplateUrl(enrichedSession);
    if (!syncedBackend && settings.autoOpenCalendarTab && !session.calendarSynced && session.isQualifiedClass) {
      chrome.tabs.create({ url: templateUrl });
      syncedBackend = true;
    }

    if (syncedBackend) {
      const targetIdx = history.findIndex((h) => h && h.historyId === session.historyId);
      if (targetIdx !== -1) {
        history[targetIdx].calendarSynced = true;
        chrome.storage.local.set({ [STORAGE_KEY_HISTORY]: history });
      }
    }

    return { synced: syncedBackend, templateUrl, classNumber };
  }

  async function ensureContentScriptInMeetTab(tabId, tabUrl) {
    if (!tabId || !tabUrl || !tabUrl.startsWith("https://meet.google.com/")) return;

    try {
      const pingResponse = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "PING_ALIVE" }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      });

      if (pingResponse && pingResponse.alive) return;
    } catch (_e) {}

    try {
      if (chrome.scripting) {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ["styles.css"] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      }
    } catch (_injectErr) {}
  }

  function scanAndInjectAllMeetTabs() {
    try {
      chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        for (const tab of tabs) {
          ensureContentScriptInMeetTab(tab.id, tab.url);
        }
      });
    } catch (_e) {}
  }

  async function checkForUpdates() {
    const localVersion = chrome.runtime.getManifest().version;
    let latestVersion = localVersion;
    let releaseUrl = `https://github.com/${GITHUB_REPO}/releases/latest`;
    let downloadUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
    let releaseNotes = "";

    try {
      const res = await fetch(RELEASES_API, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.tag_name) {
          latestVersion = String(data.tag_name).replace(/^v/i, "");
          releaseUrl = data.html_url || releaseUrl;
          downloadUrl = data.zipball_url || downloadUrl;
          releaseNotes = data.name || "";
        }
      }

      const rawRes = await fetch(RAW_MANIFEST_URL, { cache: "no-store" });
      if (rawRes.ok) {
        const rawManifest = await rawRes.json();
        if (rawManifest && rawManifest.version && isNewerVersion(rawManifest.version, latestVersion)) {
          latestVersion = rawManifest.version;
          downloadUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
        }
      }
    } catch (_err) {}

    const updateAvailable = isNewerVersion(latestVersion, localVersion);
    const updateInfo = {
      localVersion,
      latestVersion,
      updateAvailable,
      releaseUrl,
      downloadUrl,
      releaseNotes,
      lastCheckedAt: new Date().toISOString()
    };

    chrome.storage.local.set({ [STORAGE_KEY_UPDATE]: updateInfo });

    if (updateAvailable) {
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setBadgeBackgroundColor({ color: "#8ab4f8" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }

    return updateInfo;
  }

  function triggerDesktopNotification(title, message, notifId) {
    if (!chrome.notifications) return;
    try {
      chrome.notifications.create(notifId || `gm-alert-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message,
        priority: 2
      });
    } catch (_e) {}
  }

  function setupAlarms() {
    if (!chrome.alarms) return;
    chrome.alarms.create(ALARM_UPDATE, { periodInMinutes: 180 });
    chrome.alarms.create(ALARM_WATCHDOG, { periodInMinutes: 1 });

    chrome.storage.local.get([STORAGE_KEY_SETTINGS], (res) => {
      const settings = (res && res[STORAGE_KEY_SETTINGS]) || {};
      const interval = parseInt(settings.autoSyncInterval, 10);
      if (interval && interval > 0) {
        chrome.alarms.create(ALARM_AUTOSYNC, { periodInMinutes: interval });
      } else {
        chrome.alarms.clear(ALARM_AUTOSYNC);
      }
    });
  }

  setupAlarms();
  scanAndInjectAllMeetTabs();

  chrome.runtime.onInstalled.addListener(() => {
    setupAlarms();
    restoreDatabaseIfEmptyOnInstall().then(() => {
      scanAndInjectAllMeetTabs();
    });
    checkForUpdates();
  });

  chrome.runtime.onStartup.addListener(() => {
    setupAlarms();
    scanAndInjectAllMeetTabs();
    checkForUpdates();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || (tab && tab.url) || "";
    if (url.startsWith("https://meet.google.com/") && (changeInfo.status === "complete" || changeInfo.url)) {
      ensureContentScriptInMeetTab(tabId, url);
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.url && tab.url.startsWith("https://meet.google.com/")) {
        ensureContentScriptInMeetTab(tab.id, tab.url);
      }
    });
  });

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_UPDATE) {
        checkForUpdates();
      } else if (alarm.name === ALARM_WATCHDOG) {
        scanAndInjectAllMeetTabs();
        if (syncPendingRetry) {
          pushDatabaseToGoogleSheets("retry_watchdog");
        }
      } else if (alarm.name === ALARM_AUTOSYNC) {
        pushDatabaseToGoogleSheets("periodic_alarm");
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === "CHECK_FOR_UPDATES") {
      checkForUpdates().then((info) => sendResponse(info));
      return true;
    } else if (msg.type === "ENSURE_MEET_TABS") {
      scanAndInjectAllMeetTabs();
      sendResponse({ ok: true });
      return false;
    } else if (msg.type === "FIRE_NOTIFICATION") {
      triggerDesktopNotification(msg.title, msg.message, msg.notifId);
      sendResponse({ ok: true });
      return false;
    } else if (msg.type === "SYNC_CLASS_TO_CALENDAR") {
      syncClassToGoogleCalendar(msg.session).then((res) => sendResponse(res));
      return true;
    } else if (msg.type === "PUSH_TO_GOOGLE_SHEETS") {
      mirrorToChromeSyncStorage();
      pushDatabaseToGoogleSheets(msg.reason || "manual").then((res) => sendResponse(res));
      return true;
    } else if (msg.type === "PULL_FROM_GOOGLE_SHEETS") {
      pullDatabaseFromGoogleSheets(msg.url).then((res) => sendResponse(res));
      return true;
    } else if (msg.type === "TEST_CLOUD_CONNECTION") {
      testCloudConnection(msg.url).then((res) => sendResponse(res));
      return true;
    } else if (msg.type === "GET_CLOUD_SYNC_STATUS") {
      chrome.storage.local.get([STORAGE_KEY_CLOUD_META], (r) => {
        sendResponse((r && r[STORAGE_KEY_CLOUD_META]) || {});
      });
      return true;
    } else if (msg.type === "RELOAD_SYNC_ALARMS") {
      setupAlarms();
      sendResponse({ ok: true });
      return false;
    } else if (msg.type === "BACKUP_TO_LOCAL_DISK") {
      mirrorToChromeSyncStorage();
      saveLocalDiskBackupFile(true).then((res) => sendResponse(res));
      return true;
    } else if (msg.type === "MIRROR_CLOUD_SYNC") {
      mirrorToChromeSyncStorage().then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });
})();

(() => {
  "use strict";

  const STORAGE_KEY_HISTORY = "gm_timer_call_history";
  const STORAGE_KEY_PROFILES = "gm_timer_code_profiles";
  const STORAGE_KEY_SETTINGS = "gm_timer_settings";
  const STORAGE_KEY_UPDATE = "gm_timer_update_info";
  const STORAGE_KEY_CLOUD_META = "gm_timer_cloud_sync_meta";

  const UNIFIED_APPS_SCRIPT_CODE = `// ============================================================================
// GOOGLE MEET TUITION COMPANION — UNIFIED GOOGLE DRIVE, SHEETS & CALENDAR SYNC
// ============================================================================
// Business & Enterprise Edition (v3.0.0)
//
// 1-Minute Setup:
// 1. Open Google Sheets (https://sheets.new) or your existing Tuition database sheet.
// 2. Click Extensions -> Apps Script.
// 3. Delete any code in Code.gs and paste this entire script.
// 4. Click Save (floppy icon).
// 5. Click Deploy -> New deployment -> Select type: Web app.
//    - Description: "Google Meet Tuition Companion v3.0"
//    - Execute as: "Me" (your Google account)
//    - Who has access: "Anyone"
// 6. Click Deploy, Authorize access, and copy the Web App URL.
// 7. Paste the Web App URL into the extension's "Cloud Sync & Rules" tab.
//
// What this script does automatically:
// ✓ Google Drive: Creates "Google Meet Tuition Companion Backups" folder & saves rolling JSON snapshots
// ✓ Google Sheets: Formats & updates "Classrooms_Summary", "Class_Sessions_Log", and "_Raw_DB"
// ✓ Google Calendar: Auto-logs qualified classes (≥35m) to your calendar with Meet links & notes
// ✓ Restore: 1-Click recovery of your full database from Google Cloud
// ============================================================================

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(15000);
  try {
    var payload = JSON.parse(e.postData.contents || "{}");
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetUrl = ss.getUrl();
    var timestamp = new Date().toISOString();
    var dateString = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT", "yyyy-MM-dd");

    // =========================================================================
    // 1. GOOGLE DRIVE BACKUP: Automatically manage dedicated backup folder & files
    // =========================================================================
    var driveFolderUrl = "";
    var driveBackupFileUrl = "";
    try {
      var folderName = "Google Meet Tuition Companion Backups";
      var folders = DriveApp.getFoldersByName(folderName);
      var backupFolder;
      if (folders.hasNext()) {
        backupFolder = folders.next();
      } else {
        backupFolder = DriveApp.createFolder(folderName);
      }
      driveFolderUrl = backupFolder.getUrl();

      // Create or update rolling "tuition_database_latest.json"
      var fullSnapshot = JSON.stringify({
        version: "3.0.0",
        profiles: payload.profiles || {},
        history: payload.history || [],
        settings: payload.settings || {},
        updatedAt: timestamp
      }, null, 2);

      var latestFiles = backupFolder.getFilesByName("tuition_database_latest.json");
      if (latestFiles.hasNext()) {
        var existingFile = latestFiles.next();
        existingFile.setContent(fullSnapshot);
        driveBackupFileUrl = existingFile.getUrl();
      } else {
        var newFile = backupFolder.createFile("tuition_database_latest.json", fullSnapshot, MimeType.PLAIN_TEXT);
        driveBackupFileUrl = newFile.getUrl();
      }

      // Create daily snapshot archive if not already created today
      var dailyFilename = "tuition_backup_" + dateString + ".json";
      var dailyFiles = backupFolder.getFilesByName(dailyFilename);
      if (!dailyFiles.hasNext()) {
        backupFolder.createFile(dailyFilename, fullSnapshot, MimeType.PLAIN_TEXT);
      }
    } catch (driveErr) {}

    // =========================================================================
    // 2. RAW DB SHEET (Hidden snapshot for 1-click restore)
    // =========================================================================
    var rawSheet = ss.getSheetByName("_Raw_DB") || ss.insertSheet("_Raw_DB");
    rawSheet.clear();
    rawSheet.getRange(1, 1).setValue(JSON.stringify({
      version: "3.0.0",
      profiles: payload.profiles || {},
      history: payload.history || [],
      settings: payload.settings || {},
      driveFolderUrl: driveFolderUrl,
      updatedAt: timestamp
    }));

    // =========================================================================
    // 3. CLASSROOMS SUMMARY SHEET
    // =========================================================================
    if (Array.isArray(payload.classroomRows)) {
      var roomSheet = ss.getSheetByName("Classrooms_Summary") || ss.insertSheet("Classrooms_Summary");
      roomSheet.clear();
      var roomHeaders = [
        "Meeting Code",
        "Class / Subject",
        "Category",
        "Students",
        "Schedule",
        "Student Emails",
        "Fee / Rate",
        "Prior Offset (Mo)",
        "Offset Month",
        "Classes This Month",
        "All-Time Classes",
        "Est. Monthly Billing",
        "Meet Link",
        "Last Synced"
      ];
      roomSheet.appendRow(roomHeaders);
      var headerRange = roomSheet.getRange(1, 1, 1, roomHeaders.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#1a73e8");
      headerRange.setFontColor("#ffffff");
      roomSheet.setFrozenRows(1);

      payload.classroomRows.forEach(function(r) {
        var estBilling = "";
        var fee = parseFloat(r.feeRate || 0);
        if (fee > 0) {
          var curr = r.currency || "$";
          estBilling = curr + (fee * (r.monthClassesCount || 0)).toFixed(2);
        }
        roomSheet.appendRow([
          r.meetingCode || "",
          r.label || "",
          r.category || "",
          r.students || "",
          r.schedule || "",
          r.studentEmails || "",
          r.feeRate ? ((r.currency || "$") + r.feeRate + (r.rateType ? " (" + r.rateType + ")" : "")) : "-",
          r.initialClassOffset || 0,
          r.offsetMonth || "",
          r.monthClassesCount || 0,
          r.totalClassesCount || 0,
          estBilling || "-",
          r.classLink || "",
          timestamp.slice(0, 19).replace("T", " ")
        ]);
      });
      try { roomSheet.autoResizeColumns(1, roomHeaders.length); } catch(_e) {}
    }

    // =========================================================================
    // 4. CLASS SESSIONS LOG SHEET
    // =========================================================================
    if (Array.isArray(payload.history)) {
      var logSheet = ss.getSheetByName("Class_Sessions_Log") || ss.insertSheet("Class_Sessions_Log");
      logSheet.clear();
      var logHeaders = [
        "Date",
        "Meeting Code",
        "Class Name",
        "Students",
        "Qualified Class (>=35m)",
        "Duration (Mins)",
        "Started At",
        "Ended At",
        "Calendar Status",
        "Session ID"
      ];
      logSheet.appendRow(logHeaders);
      var logHeaderRange = logSheet.getRange(1, 1, 1, logHeaders.length);
      logHeaderRange.setFontWeight("bold");
      logHeaderRange.setBackground("#34a853");
      logHeaderRange.setFontColor("#ffffff");
      logSheet.setFrozenRows(1);

      payload.history.forEach(function(h) {
        logSheet.appendRow([
          h.date || (h.startedAt || "").slice(0, 10),
          h.meetingCode || "",
          h.label || "",
          h.students || "",
          h.isQualifiedClass ? "YES (Class)" : "Short (<35m)",
          Math.round((h.durationMs || 0) / 60000),
          h.startedAt ? h.startedAt.slice(0, 19).replace("T", " ") : "",
          h.endedAt ? h.endedAt.slice(0, 19).replace("T", " ") : "",
          h.calendarSynced ? "Synced in Calendar" : (h.isQualifiedClass ? "Eligible" : "N/A"),
          h.historyId || ""
        ]);
      });
      try { logSheet.autoResizeColumns(1, logHeaders.length); } catch(_e) {}
    }

    // =========================================================================
    // 5. GOOGLE CALENDAR: Automatic event logging for qualified classes
    // =========================================================================
    var calendarLogged = false;
    if (payload.summary && payload.startTime && payload.endTime) {
      try {
        var cal = CalendarApp.getDefaultCalendar();
        var startTime = new Date(payload.startTime);
        var endTime = new Date(payload.endTime);
        
        var existingEvents = cal.getEvents(startTime, endTime);
        var isDuplicate = false;
        var tag = payload.historyId ? "[Session: " + payload.historyId + "]" : payload.summary;
        for (var i = 0; i < existingEvents.length; i++) {
          if (existingEvents[i].getDescription().indexOf(tag) !== -1 || existingEvents[i].getTitle() === payload.summary) {
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          var desc = (payload.description || "") + "\\n\\n" + (payload.historyId ? "[Session: " + payload.historyId + "]" : "");
          cal.createEvent(payload.summary, startTime, endTime, {
            description: desc,
            location: payload.meetingCode ? "https://meet.google.com/" + payload.meetingCode : ""
          });
          calendarLogged = true;
        }
      } catch (_calErr) {}
    }

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      syncedAt: timestamp,
      sheetUrl: sheetUrl,
      driveFolderUrl: driveFolderUrl,
      driveBackupFileUrl: driveBackupFileUrl,
      calendarLogged: calendarLogged,
      classroomsCount: Array.isArray(payload.classroomRows) ? payload.classroomRows.length : 0,
      sessionsCount: Array.isArray(payload.history) ? payload.history.length : 0
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: String(err)
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var action = (e && e.parameter && e.parameter.action) || "GET_DATABASE";

  if (action === "PING") {
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      version: "3.0.0",
      sheetName: ss.getName(),
      sheetUrl: ss.getUrl()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var rawSheet = ss.getSheetByName("_Raw_DB");
  if (!rawSheet) {
    return ContentService.createTextOutput(JSON.stringify({
      profiles: {},
      history: [],
      settings: {}
    })).setMimeType(ContentService.MimeType.JSON);
  }
  var rawJson = rawSheet.getRange(1, 1).getValue() || "{}";
  return ContentService.createTextOutput(rawJson).setMimeType(ContentService.MimeType.JSON);
}`;

  const statusBadge = document.getElementById("callStatusBadge");
  const meetingCodeEl = document.getElementById("meetingCode");
  const liveClassCountChip = document.getElementById("liveClassCountChip");
  const liveTimeEl = document.getElementById("timerDisplay");
  const pauseBtn = document.getElementById("pauseBtn");
  const recQuickBtn = document.getElementById("recQuickBtn");
  const hwQuickBtn = document.getElementById("hwQuickBtn");
  const calQuickBtn = document.getElementById("calQuickBtn");
  const syncMeetBtn = document.getElementById("syncBtn");
  const resetBtn = document.getElementById("resetBtn");

  const profileLabelInput = document.getElementById("profileLabelInput");
  const profileCurrentClassNumInput = document.getElementById("profileCurrentClassNumInput");
  const profileStudentsInput = document.getElementById("profileStudentsInput");
  const profileScheduleInput = document.getElementById("profileScheduleInput");
  const profileEmailsInput = document.getElementById("profileEmailsInput");
  const profileFeeRateInput = document.getElementById("profileFeeRateInput");
  const saveProfileBtn = document.getElementById("saveProfileBtn");
  const saveProfileStatus = document.getElementById("saveProfileStatus");

  const roomLinkInput = document.getElementById("roomLinkInput");
  const roomInitialOffsetInput = document.getElementById("roomInitialOffsetInput");
  const roomNameInput = document.getElementById("roomNameInput");
  const roomScheduleInput = document.getElementById("roomScheduleInput");
  const roomStudentsInput = document.getElementById("roomStudentsInput");
  const roomEmailsInput = document.getElementById("roomEmailsInput");
  const roomFeeRateInput = document.getElementById("roomFeeRateInput");
  const roomCurrencySelect = document.getElementById("roomCurrencySelect");
  const roomRateTypeSelect = document.getElementById("roomRateTypeSelect");
  const saveClassroomBtn = document.getElementById("saveClassroomBtn");
  const roomSaveStatus = document.getElementById("roomSaveStatus");
  const classroomList = document.getElementById("classroomList");
  const openDashboardRoomsBtn = document.getElementById("openDashboardRoomsBtn");

  const setHhInput = document.getElementById("inputHh");
  const setMmInput = document.getElementById("inputMm");
  const setSsInput = document.getElementById("inputSs");
  const setExactBtn = document.getElementById("setTimeBtn");

  const kpiTotalClasses = document.getElementById("kpiTotalClasses");
  const kpiMonthClasses = document.getElementById("kpiMonthClasses");
  const kpiTotalHours = document.getElementById("kpiTotalHours");
  const kpiEstBilling = document.getElementById("kpiEstBilling");
  const filterCategory = document.getElementById("filterCategory");
  const searchCodeInput = document.getElementById("searchCodeInput");
  const tuitionCodeList = document.getElementById("tuitionCodeList");
  const openDashboardBtn = document.getElementById("openDashboardBtn");
  const exportIcsBtn = document.getElementById("exportIcsBtn");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const exportJsonBtn = document.getElementById("exportJsonBtn");

  const googleSheetsUrl = document.getElementById("googleSheetsUrl");
  const copySheetsScriptBtn = document.getElementById("copySheetsScriptBtn");
  const testConnectionBtn = document.getElementById("testConnectionBtn");
  const pushSheetsBtn = document.getElementById("pushSheetsBtn");
  const pullSheetsBtn = document.getElementById("pullSheetsBtn");
  const sheetsSyncStatus = document.getElementById("sheetsSyncStatus");
  const cloudStatusDot = document.getElementById("cloudStatusDot");
  const cloudStatusText = document.getElementById("cloudStatusText");
  const lastSyncedTimeText = document.getElementById("lastSyncedTimeText");
  const cloudLinksRow = document.getElementById("cloudLinksRow");
  const driveFolderPill = document.getElementById("driveFolderPill");
  const sheetsDocPill = document.getElementById("sheetsDocPill");
  const autoSyncOnClassEnd = document.getElementById("autoSyncOnClassEnd");
  const autoSyncIntervalSelect = document.getElementById("autoSyncIntervalSelect");
  const autoBackupLocalFile = document.getElementById("autoBackupLocalFile");
  const saveDiskNowBtn = document.getElementById("saveDiskNowBtn");
  const importJsonBtn = document.getElementById("importJsonBtn");
  const importJsonFileInput = document.getElementById("importJsonFileInput");

  const autoRecordClass = document.getElementById("autoRecordClass");
  const autoFocusPresentation = document.getElementById("autoFocusPresentation");
  const minClassMinutesInput = document.getElementById("minClassMinutes");
  const warnMinutes = document.getElementById("warnMinutes");
  const selectPosition = document.getElementById("position");
  const autoOpenCalendarTab = document.getElementById("autoOpenCalendarTab");

  const updateBanner = document.getElementById("updateBanner");
  const updateBannerText = document.getElementById("updateBannerText");
  const updateDownloadLink = document.getElementById("updateDownloadLink");
  const versionStatusText = document.getElementById("versionStatusText");
  const checkUpdateBtn = document.getElementById("checkUpdateBtn");

  // Invoice Modal Elements
  const invoiceModalOverlay = document.getElementById("invoiceModalOverlay");
  const invoiceModalTitle = document.getElementById("invoiceModalTitle");
  const invoiceModalContent = document.getElementById("invoiceModalContent");
  const closeInvoiceModalBtn = document.getElementById("closeInvoiceModalBtn");
  const copyInvoiceTextBtn = document.getElementById("copyInvoiceTextBtn");
  const printInvoiceBtn = document.getElementById("printInvoiceBtn");

  let currentDetectedCode = null;
  let currentRecordedMonthlyCount = 0;
  let currentIsQualified = false;
  let inputsInitialized = false;
  let profileInputsInitializedForCode = null;
  let currentInvoiceData = null;

  document.querySelectorAll(".nav-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      tabBtn.classList.add("active");
      const targetId = tabBtn.getAttribute("data-tab");
      const pane = document.getElementById(targetId);
      if (pane) pane.classList.add("active");
      if (targetId === "tab-tuitions") {
        renderTuitionDatabase();
      } else if (targetId === "tab-classrooms") {
        renderClassroomsOrganizer();
      } else if (targetId === "tab-settings") {
        renderCloudSyncUI();
      }
    });
  });

  function extractMeetCodeFromInput(raw) {
    const str = String(raw || "").trim();
    if (!str) return null;
    const std = str.match(/\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    if (std) return std[1].toLowerCase();
    const cleaned = str.replace(/^https?:\/\/(meet\.google\.com\/)?(meet\/)?/i, "").replace(/^\/+|\/+$/g, "");
    return cleaned ? cleaned.toLowerCase() : null;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function formatShortHours(ms) {
    const totalMin = Math.floor(Math.max(0, ms) / 60000);
    return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  }

  function buildHomeworkGmailUrl(prof, classCount, hwText = "") {
    const code = prof.meetingCode || "";
    const className = prof.label || `Class (${code})`;
    const students = prof.students || "Students";
    const emails = (prof.studentEmails || "").trim();
    const schedule = prof.schedule || "Regular Schedule";
    const dateStr = new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const hwTask = (hwText || "").trim() || prof.defaultHomework || "[Enter homework tasks / exercises here]";

    const subject = `📚 Homework: ${className} — Class #${Math.max(1, classCount)} (${dateStr})`;
    const body = [
      `Hi ${students},`,
      ``,
      `Here is the homework assignment and class summary for ${className} (Class #${Math.max(1, classCount)} on ${dateStr}):`,
      ``,
      `📝 Homework Assignment:`,
      `${hwTask}`,
      ``,
      `📌 Classroom Details:`,
      `• Class Name: ${className}`,
      `• Typical Schedule: ${schedule}`,
      `• Class Link: https://meet.google.com/${code}`,
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

  function buildSessionCalendarUrl(session, classNumber) {
    const toCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const startStr = toCalDate(session.startedAt || new Date(Date.now() - (session.durationMs || 0)).toISOString());
    const endStr = toCalDate(session.endedAt || new Date().toISOString());
    const studentPart = session.label ? `${session.label} (${session.meetingCode})` : session.meetingCode;
    const title = classNumber ? `🎓 Class #${classNumber}: ${studentPart}` : `Meet Call: ${studentPart}`;
    const details = `Online Tuition Class tracked by Google Meet Tuition Companion.\nClass: ${session.label || "Unlabeled"}\nStudents: ${session.students || "N/A"}\nMeeting Code: ${session.meetingCode}\nDuration: ${formatDuration(session.durationMs)}`;
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${startStr}/${endStr}`,
      details,
      location: `https://meet.google.com/${session.meetingCode}`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function findMeetTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const activeTab = activeTabs && activeTabs[0];
      if (activeTab && activeTab.url && activeTab.url.includes("meet.google.com")) {
        callback(activeTab.id);
        return;
      }
      chrome.tabs.query({ url: "https://meet.google.com/*" }, (meetTabs) => {
        if (meetTabs && meetTabs.length > 0) {
          callback(meetTabs[0].id);
        } else {
          callback(null);
        }
      });
    });
  }

  function refreshLiveStatus() {
    findMeetTab((tabId) => {
      if (!tabId) {
        statusBadge.textContent = "Not on Meet";
        statusBadge.className = "badge inactive";
        meetingCodeEl.textContent = "Open a Google Meet tab or join from Classrooms";
        liveClassCountChip.textContent = "≥35m = 1 Class • Alert at 1h 10m";
        liveTimeEl.textContent = "00:00:00";
        return;
      }

      chrome.tabs.sendMessage(tabId, { type: "GET_STATUS" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          chrome.runtime.sendMessage({ type: "ENSURE_MEET_TABS" });
          statusBadge.textContent = "Connecting...";
          statusBadge.className = "badge inactive";
          meetingCodeEl.textContent = "Auto-activating tracker on Meet tab...";
          return;
        }

        const code = res.meetingCode;
        currentDetectedCode = code;
        currentRecordedMonthlyCount = res.recordedMonthlyCount || 0;
        currentIsQualified = Boolean(res.isQualifiedClass);

        const prof = res.profile || {};
        const displayLabel = prof.label ? `${prof.label} (${code})` : (code ? `Code: ${code}` : "Google Meet Lobby");
        meetingCodeEl.textContent = displayLabel;

        const classCount = res.classCount || 0;
        const minMins = res.minClassMinutes || 35;
        const feeInfo = prof.feeRate ? ` • Rate: ${prof.currency || "$"}${prof.feeRate}` : "";
        const statusText = res.isQualifiedClass
          ? `🎓 Qualified as Class #${Math.max(1, classCount)} this month (≥${minMins}m)${feeInfo}`
          : `${classCount} Classes This Month • Next is #${classCount + 1} at ${minMins}m${feeInfo}`;
        liveClassCountChip.textContent = statusText;

        if (recQuickBtn) {
          recQuickBtn.textContent = res.isRecording ? "⏹ Stop Rec" : "⏺ Record";
        }

        if (code && profileInputsInitializedForCode !== code) {
          profileLabelInput.value = prof.label || "";
          profileStudentsInput.value = prof.students || "";
          profileScheduleInput.value = prof.schedule || "";
          profileEmailsInput.value = prof.studentEmails || "";
          if (profileFeeRateInput) profileFeeRateInput.value = prof.feeRate || "";
          const activeNum = res.isQualifiedClass ? Math.max(1, classCount) : classCount + 1;
          profileCurrentClassNumInput.value = activeNum;
          profileInputsInitializedForCode = code;
        }

        const elapsedMs = res.elapsedMs || 0;
        liveTimeEl.textContent = formatDuration(elapsedMs);

        if (!inputsInitialized && elapsedMs > 0) {
          const totalSec = Math.floor(elapsedMs / 1000);
          setHhInput.value = Math.floor(totalSec / 3600);
          setMmInput.value = Math.floor((totalSec % 3600) / 60);
          setSsInput.value = totalSec % 60;
          inputsInitialized = true;
        }

        if (res.isInCall) {
          statusBadge.textContent = res.isRecording ? "🔴 REC" : (res.isPaused ? "Paused" : "In Call");
          statusBadge.className = res.isPaused ? "badge paused" : "badge";
          pauseBtn.textContent = res.isPaused ? "▶ Resume" : "⏸ Pause";
        } else {
          statusBadge.textContent = "Lobby";
          statusBadge.className = "badge inactive";
          pauseBtn.textContent = "▶ Start";
        }
      });
    });
  }

  function renderClassroomsOrganizer() {
    chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_SETTINGS], (res) => {
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const minMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
      const currentMonth = new Date().toISOString().slice(0, 7);

      const recordedMonthByCode = {};
      const recordedTotalByCode = {};
      for (const h of history) {
        if (!h || !h.meetingCode) continue;
        const q = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
        if (!q) continue;
        recordedTotalByCode[h.meetingCode] = (recordedTotalByCode[h.meetingCode] || 0) + 1;
        const m = (h.startedAt || h.endedAt || "").slice(0, 7) || currentMonth;
        if (m === currentMonth) {
          recordedMonthByCode[h.meetingCode] = (recordedMonthByCode[h.meetingCode] || 0) + 1;
        }
      }

      const rooms = Object.values(profiles).filter((r) => r && r.meetingCode);
      if (rooms.length === 0) {
        classroomList.innerHTML = '<div class="empty-msg">No classrooms saved yet. Paste a Meet link or code above to organize your classes!</div>';
        return;
      }

      classroomList.innerHTML = rooms
        .map((r, idx) => {
          const code = r.meetingCode;
          const link = `https://meet.google.com/${code}`;
          const initOffset = (r.offsetMonth || currentMonth) === currentMonth ? (parseInt(r.initialClassOffset, 10) || 0) : 0;
          const monthCount = initOffset + (recordedMonthByCode[code] || 0);
          const fee = parseFloat(r.feeRate || 0);
          const curr = r.currency || "$";
          const billingStr = fee > 0 ? ` • <strong>Billing:</strong> ${curr}${(fee * monthCount).toFixed(0)}` : "";
          return `
            <div class="classroom-card">
              <div class="classroom-head">
                <div>
                  <div class="classroom-name">${r.label || `Classroom (${code})`}</div>
                  <a class="classroom-link" href="${link}" target="_blank" rel="noopener noreferrer">${link}</a>
                </div>
                <div style="display: flex; gap: 4px; align-items: center;">
                  <span class="cat-badge" title="Prior Offset: ${initOffset} + Recorded This Month: ${recordedMonthByCode[code] || 0}">🎓 ${monthCount} this mo</span>
                  <button type="button" class="tonal-blue join-room-btn" data-url="${link}" style="padding: 3px 8px; font-size: 10px;">🚀 Join</button>
                  <button type="button" class="text-btn edit-room-btn" data-code="${code}" title="Edit Classroom & Starting Class #">✎</button>
                </div>
              </div>
              <div class="classroom-meta">
                <div><strong>Students:</strong> ${r.students || "Not set"}${fee > 0 ? " • <strong>Rate:</strong> " + curr + r.feeRate + " (" + (r.rateType || "Per Class") + ")" : ""}${billingStr}</div>
                <div><strong>Schedule:</strong> ${r.schedule || "Not set"} • <strong>Prior Offset:</strong> ${initOffset} classes</div>
                <div><strong>Student Mails:</strong> ${r.studentEmails || "Not set"}</div>
              </div>
              <div class="classroom-hw-row">
                <input type="text" id="hw-input-${idx}" placeholder="Quick homework note for ${r.label || code}..." value="${r.defaultHomework || ""}" />
                <button type="button" class="tonal-green send-hw-btn" data-code="${code}" data-input="hw-input-${idx}">✉️ Homework Mail</button>
              </div>
            </div>
          `;
        })
        .join("");

      classroomList.querySelectorAll(".join-room-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          chrome.tabs.create({ url: btn.getAttribute("data-url") });
        });
      });

      classroomList.querySelectorAll(".edit-room-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          const r = profiles[code];
          if (!r) return;
          roomLinkInput.value = `https://meet.google.com/${code}`;
          roomInitialOffsetInput.value = r.initialClassOffset || 0;
          roomNameInput.value = r.label || "";
          roomScheduleInput.value = r.schedule || "";
          roomStudentsInput.value = r.students || "";
          roomEmailsInput.value = r.studentEmails || "";
          if (roomFeeRateInput) roomFeeRateInput.value = r.feeRate || "";
          if (roomCurrencySelect) roomCurrencySelect.value = r.currency || "$";
          if (roomRateTypeSelect) roomRateTypeSelect.value = r.rateType || "Per Class";
          roomNameInput.focus();
        });
      });

      classroomList.querySelectorAll(".send-hw-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          const inputEl = document.getElementById(btn.getAttribute("data-input"));
          const hwText = inputEl ? inputEl.value.trim() : "";
          const prof = profiles[code] || { meetingCode: code };
          const initOffset = (prof.offsetMonth || currentMonth) === currentMonth ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
          const count = initOffset + (recordedMonthByCode[code] || 0);
          if (hwText) {
            prof.defaultHomework = hwText;
            profiles[code] = prof;
            chrome.storage.local.set({ [STORAGE_KEY_PROFILES]: profiles });
          }
          const gmailUrl = buildHomeworkGmailUrl(prof, count, hwText);
          chrome.tabs.create({ url: gmailUrl });
        });
      });
    });
  }

  saveClassroomBtn.addEventListener("click", () => {
    const code = extractMeetCodeFromInput(roomLinkInput.value) || currentDetectedCode;
    if (!code) {
      roomSaveStatus.textContent = "Enter a valid Meet link/code";
      return;
    }
    const label = roomNameInput.value.trim();
    const initialClassOffset = Math.max(0, parseInt(roomInitialOffsetInput.value, 10) || 0);
    const schedule = roomScheduleInput.value.trim();
    const students = roomStudentsInput.value.trim();
    const studentEmails = roomEmailsInput.value.trim();
    const feeRate = roomFeeRateInput ? roomFeeRateInput.value.trim() : "";
    const currency = roomCurrencySelect ? roomCurrencySelect.value : "$";
    const rateType = roomRateTypeSelect ? roomRateTypeSelect.value : "Per Class";
    const currentMonth = new Date().toISOString().slice(0, 7);

    chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const existing = profiles[code] || {};
      profiles[code] = {
        ...existing,
        meetingCode: code,
        classLink: `https://meet.google.com/${code}`,
        label: label || existing.label || "",
        category: existing.category || "Tuition / Class",
        initialClassOffset,
        offsetMonth: currentMonth,
        schedule,
        students,
        studentEmails,
        feeRate,
        currency,
        rateType,
        updatedAt: new Date().toISOString()
      };

      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      for (const h of history) {
        if (h && h.meetingCode === code) {
          h.label = profiles[code].label;
          h.students = students;
          h.schedule = schedule;
          h.studentEmails = studentEmails;
        }
      }

      chrome.storage.local.set({ [STORAGE_KEY_PROFILES]: profiles, [STORAGE_KEY_HISTORY]: history }, () => {
        chrome.runtime.sendMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "classroom_saved" });
        roomSaveStatus.textContent = "✓ Saved & Synced!";
        setTimeout(() => { roomSaveStatus.textContent = ""; }, 2000);
        roomLinkInput.value = "";
        roomInitialOffsetInput.value = 0;
        roomNameInput.value = "";
        roomScheduleInput.value = "";
        roomStudentsInput.value = "";
        roomEmailsInput.value = "";
        if (roomFeeRateInput) roomFeeRateInput.value = "";
        renderClassroomsOrganizer();
      });
    });
  });

  function renderTuitionDatabase() {
    chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const minClassMs = ((s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000);

      const selectedCat = filterCategory ? filterCategory.value : "ALL";
      const query = (searchCodeInput ? searchCodeInput.value : "").trim().toLowerCase();
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);

      const chronological = [...history].reverse();
      const codeMonthCounter = {};
      const annotatedChronological = chronological.map((item) => {
        if (!item || !item.meetingCode) return null;
        const code = item.meetingCode;
        const prof = profiles[code] || {};
        const itemMonth = (item.startedAt || item.endedAt || "").slice(0, 7) || currentMonthPrefix;
        const baseOffset = (prof.offsetMonth || currentMonthPrefix) === itemMonth ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;

        const isQualified = item.isQualifiedClass !== undefined
          ? Boolean(item.isQualifiedClass)
          : (item.durationMs || 0) >= minClassMs;
        let classNumber = null;
        if (isQualified) {
          const key = `${code}_${itemMonth}`;
          codeMonthCounter[key] = (codeMonthCounter[key] || baseOffset) + 1;
          classNumber = codeMonthCounter[key];
        }
        return { ...item, isQualified, classNumber, itemMonth };
      }).filter(Boolean).reverse();

      const grouped = {};
      let totalClassesCount = 0;
      let monthClassesCount = 0;
      let grandTotalClassMs = 0;
      let grandTotalEstBilling = 0;

      for (const [code, prof] of Object.entries(profiles)) {
        const initOff = (prof.offsetMonth || currentMonthPrefix) === currentMonthPrefix ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
        if (initOff > 0) {
          grouped[code] = {
            meetingCode: code,
            label: prof.label || "",
            category: prof.category || "Tuition / Class",
            students: prof.students || "",
            feeRate: prof.feeRate || "",
            currency: prof.currency || "$",
            rateType: prof.rateType || "Per Class",
            initialOffset: initOff,
            qualifiedClasses: initOff,
            monthClasses: initOff,
            totalClassMs: 0,
            sessions: []
          };
          totalClassesCount += initOff;
          monthClassesCount += initOff;
          const fee = parseFloat(prof.feeRate || 0);
          if (fee > 0) grandTotalEstBilling += fee * initOff;
        }
      }

      for (const item of annotatedChronological) {
        const code = item.meetingCode;
        const prof = profiles[code] || {};
        const label = prof.label || item.label || "";
        const category = prof.category || item.category || "Tuition / Class";
        const students = prof.students || item.students || "";
        const feeRate = prof.feeRate || "";
        const currency = prof.currency || "$";
        const rateType = prof.rateType || "Per Class";
        const initOff = (prof.offsetMonth || currentMonthPrefix) === currentMonthPrefix ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;

        if (selectedCat !== "ALL" && category !== selectedCat) continue;
        if (
          query &&
          !code.toLowerCase().includes(query) &&
          !label.toLowerCase().includes(query) &&
          !students.toLowerCase().includes(query) &&
          !category.toLowerCase().includes(query)
        ) {
          continue;
        }

        if (!grouped[code]) {
          grouped[code] = {
            meetingCode: code,
            label,
            category,
            students,
            feeRate,
            currency,
            rateType,
            initialOffset: initOff,
            qualifiedClasses: initOff,
            monthClasses: initOff,
            totalClassMs: 0,
            sessions: []
          };
        }

        grouped[code].sessions.push({ ...item, label, category, students });
        if (item.isQualified) {
          grouped[code].qualifiedClasses += 1;
          grouped[code].totalClassMs += item.durationMs || 0;
          totalClassesCount += 1;
          grandTotalClassMs += item.durationMs || 0;

          if (item.itemMonth === currentMonthPrefix) {
            grouped[code].monthClasses += 1;
            monthClassesCount += 1;
            const fee = parseFloat(feeRate || 0);
            if (fee > 0) grandTotalEstBilling += fee;
          }
        }
      }

      kpiMonthClasses.textContent = String(monthClassesCount);
      kpiTotalClasses.textContent = String(totalClassesCount);
      kpiTotalHours.textContent = formatShortHours(grandTotalClassMs);
      if (kpiEstBilling) {
        kpiEstBilling.textContent = `$${Math.round(grandTotalEstBilling)}`;
      }

      const codesArray = Object.values(grouped);
      if (codesArray.length === 0) {
        tuitionCodeList.innerHTML = '<div class="empty-msg">No tuition sessions recorded yet. Meetings lasting 35+ mins are automatically counted as a Class!</div>';
        return;
      }

      tuitionCodeList.innerHTML = codesArray
        .map((group, idx) => {
          const title = group.label ? group.label : `Meeting: ${group.meetingCode}`;
          const fee = parseFloat(group.feeRate || 0);
          const curr = group.currency || "$";
          const billingBadge = fee > 0 ? ` • Est: ${curr}${(fee * group.monthClasses).toFixed(0)}` : "";
          const sessionRows = group.sessions
            .map((s) => {
              const startDt = new Date(s.startedAt || s.endedAt);
              const dateFormatted = startDt.toLocaleDateString([], { month: "short", day: "numeric" });
              const timeFormatted = startDt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              const badgeHtml = s.isQualified
                ? `<strong style="color: #81c995;">🎓 Class #${s.classNumber}</strong>`
                : `<span style="color: #9aa0a6;">Short (&lt;35m)</span>`;
              const calUrl = buildSessionCalendarUrl(s, s.classNumber);
              return `
                <div class="session-row">
                  <span>${badgeHtml} • ${dateFormatted} (${timeFormatted})</span>
                  <span>
                    <span style="font-family: 'Google Sans Mono', monospace; color: ${s.isQualified ? "#81c995" : "#9aa0a6"};">${formatDuration(s.durationMs)}</span>
                    <a class="cal-mini-link" href="${calUrl}" target="_blank" rel="noopener noreferrer" title="Add to Google Calendar">📅</a>
                  </span>
                </div>
              `;
            })
            .join("");

          return `
            <div class="tuition-code-card">
              <div class="tuition-card-top">
                <div>
                  <div class="tuition-title">${title}</div>
                  <div class="tuition-subcode">Code: ${group.meetingCode}${group.initialOffset > 0 ? " • Prior Offset: " + group.initialOffset : ""}</div>
                </div>
                <div style="display: flex; gap: 4px; align-items: center;">
                  <button type="button" class="tonal-blue gen-invoice-btn" data-code="${group.meetingCode}" style="padding: 2px 7px; font-size: 10px;">🧾 Statement</button>
                  <span class="cat-badge">${group.category}</span>
                </div>
              </div>
              <div class="tuition-stats-row">
                <span class="classes-pill">🎓 ${group.monthClasses} this mo (${group.qualifiedClasses} total)${billingBadge}</span>
                <span>Hours: <strong>${formatShortHours(group.totalClassMs)}</strong></span>
                <button type="button" class="text-btn toggle-sessions-btn" data-target="sublist-${idx}">Log (${group.sessions.length}) ▾</button>
              </div>
              <div class="session-sublist" id="sublist-${idx}">
                ${sessionRows || '<div class="session-row"><span>Prior classes initialized: ' + group.initialOffset + '</span></div>'}
              </div>
            </div>
          `;
        })
        .join("");

      tuitionCodeList.querySelectorAll(".toggle-sessions-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = document.getElementById(btn.getAttribute("data-target"));
          if (target) {
            target.classList.toggle("open");
            btn.textContent = target.classList.contains("open") ? "Hide ▴" : `Log ▾`;
          }
        });
      });

      tuitionCodeList.querySelectorAll(".gen-invoice-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          openInvoiceModalForCode(code, grouped[code]);
        });
      });
    });
  }

  function openInvoiceModalForCode(code, groupData) {
    if (!groupData) return;
    const currentMonth = new Date().toLocaleString([], { month: "long", year: "numeric" });
    const fee = parseFloat(groupData.feeRate || 0);
    const curr = groupData.currency || "$";
    const totalDue = fee > 0 ? (fee * groupData.monthClasses).toFixed(2) : "0.00";

    currentInvoiceData = {
      code,
      className: groupData.label || code,
      students: groupData.students || "Student",
      month: currentMonth,
      monthClasses: groupData.monthClasses,
      totalClasses: groupData.qualifiedClasses,
      feeRate: fee,
      currency: curr,
      totalDue,
      sessions: groupData.sessions.filter((s) => s.isQualified)
    };

    invoiceModalTitle.textContent = `🎓 Tuition Statement: ${groupData.label || code}`;
    invoiceModalContent.innerHTML = `
      <div style="font-size: 11.5px; line-height: 1.6; background: var(--gm-surface-elevated); padding: 10px; border-radius: 10px;">
        <div><strong>Student / Batch:</strong> ${groupData.students || "N/A"}</div>
        <div><strong>Class / Subject:</strong> ${groupData.label || code}</div>
        <div><strong>Billing Period:</strong> ${currentMonth}</div>
        <div><strong>Rate:</strong> ${fee > 0 ? curr + fee + " per class" : "Rate not specified"}</div>
      </div>
      <table class="invoice-table">
        <thead>
          <tr>
            <th>Class #</th>
            <th>Date</th>
            <th>Duration</th>
            <th style="text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${currentInvoiceData.sessions.map((s) => `
            <tr>
              <td>Class #${s.classNumber}</td>
              <td>${new Date(s.startedAt || s.endedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</td>
              <td>${Math.round((s.durationMs || 0) / 60000)}m</td>
              <td style="text-align: right;">${fee > 0 ? curr + fee.toFixed(2) : "-"}</td>
            </tr>
          `).join("") || '<tr><td colspan="4" style="text-align:center; color: var(--gm-text-secondary);">Prior offset classes: ' + groupData.monthClasses + '</td></tr>'}
        </tbody>
      </table>
      <div class="invoice-total-box">
        <span>Total (${groupData.monthClasses} Qualified Classes):</span>
        <span style="color: var(--gm-green); font-size: 14px;">${curr}${totalDue}</span>
      </div>
    `;

    invoiceModalOverlay.classList.add("open");
  }

  if (closeInvoiceModalBtn) {
    closeInvoiceModalBtn.addEventListener("click", () => {
      invoiceModalOverlay.classList.remove("open");
    });
  }

  if (copyInvoiceTextBtn) {
    copyInvoiceTextBtn.addEventListener("click", () => {
      if (!currentInvoiceData) return;
      const d = currentInvoiceData;
      const text = [
        `🎓 Tuition Statement — ${d.className}`,
        `• Student: ${d.students}`,
        `• Billing Period: ${d.month}`,
        `• Classes Completed: ${d.monthClasses} classes`,
        `• Fee Rate: ${d.feeRate > 0 ? d.currency + d.feeRate + " / class" : "N/A"}`,
        `• Total Amount Due: ${d.currency}${d.totalDue}`,
        ``,
        `Thank you!`
      ].join("\n");

      navigator.clipboard.writeText(text).then(() => {
        copyInvoiceTextBtn.textContent = "✓ Copied WhatsApp Text!";
        setTimeout(() => { copyInvoiceTextBtn.textContent = "📋 Copy WhatsApp Summary"; }, 2500);
      });
    });
  }

  if (printInvoiceBtn) {
    printInvoiceBtn.addEventListener("click", () => {
      window.print();
    });
  }

  saveProfileBtn.addEventListener("click", () => {
    const code = currentDetectedCode;
    if (!code) {
      saveProfileStatus.textContent = "Use Classrooms tab or join Meet";
      return;
    }
    const label = profileLabelInput.value.trim();
    const students = profileStudentsInput.value.trim();
    const schedule = profileScheduleInput.value.trim();
    const studentEmails = profileEmailsInput.value.trim();
    const feeRate = profileFeeRateInput ? profileFeeRateInput.value.trim() : "";
    const desiredClassNum = Math.max(1, parseInt(profileCurrentClassNumInput.value, 10) || 1);
    const activeAdjust = currentIsQualified ? 0 : 1;
    const calculatedInitialOffset = Math.max(0, desiredClassNum - currentRecordedMonthlyCount - activeAdjust);
    const currentMonth = new Date().toISOString().slice(0, 7);

    chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      profiles[code] = {
        ...(profiles[code] || {}),
        meetingCode: code,
        classLink: `https://meet.google.com/${code}`,
        label,
        students,
        schedule,
        studentEmails,
        feeRate,
        initialClassOffset: calculatedInitialOffset,
        offsetMonth: currentMonth,
        updatedAt: new Date().toISOString()
      };
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      for (const item of history) {
        if (item && item.meetingCode === code) {
          item.label = label;
          item.students = students;
          item.schedule = schedule;
          item.studentEmails = studentEmails;
        }
      }
      chrome.storage.local.set({ [STORAGE_KEY_PROFILES]: profiles, [STORAGE_KEY_HISTORY]: history }, () => {
        saveProfileStatus.textContent = `✓ Set to Class #${desiredClassNum}!`;
        setTimeout(() => { saveProfileStatus.textContent = ""; }, 2200);
        findMeetTab((tabId) => {
          if (tabId) {
            chrome.tabs.sendMessage(tabId, {
              type: "SAVE_CODE_PROFILE",
              meetingCode: code,
              label,
              students,
              schedule,
              studentEmails,
              feeRate,
              initialClassOffset: calculatedInitialOffset,
              offsetMonth: currentMonth
            });
          }
        });
        chrome.runtime.sendMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "live_profile_saved" });
        refreshLiveStatus();
      });
    });
  });

  // Render Cloud Sync Hub UI
  function renderCloudSyncUI() {
    chrome.runtime.sendMessage({ type: "GET_CLOUD_SYNC_STATUS" }, (meta) => {
      const m = meta || {};
      if (m.lastSyncStatus === "success") {
        cloudStatusDot.className = "status-dot active";
        cloudStatusText.textContent = "Auto-Sync Active (Drive, Sheets & Calendar)";
        if (m.lastSyncedAt) {
          const dt = new Date(m.lastSyncedAt);
          lastSyncedTimeText.textContent = `Synced: ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        }
        if (m.driveFolderUrl) {
          driveFolderPill.href = m.driveFolderUrl;
          driveFolderPill.style.display = "inline-flex";
        }
        if (m.sheetUrl) {
          sheetsDocPill.href = m.sheetUrl;
          sheetsDocPill.style.display = "inline-flex";
        }
        cloudLinksRow.style.display = "flex";
      } else if (m.lastSyncStatus === "error") {
        cloudStatusDot.className = "status-dot syncing";
        cloudStatusText.textContent = "Sync Error: Check Connection";
        lastSyncedTimeText.textContent = m.lastSyncError ? m.lastSyncError.slice(0, 25) : "";
      } else {
        cloudStatusDot.className = "status-dot";
        cloudStatusText.textContent = "Cloud Sync: Not Configured";
        lastSyncedTimeText.textContent = "";
        cloudLinksRow.style.display = "none";
      }
    });
  }

  if (copySheetsScriptBtn) {
    copySheetsScriptBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(UNIFIED_APPS_SCRIPT_CODE).then(() => {
        sheetsSyncStatus.textContent = "✓ Unified Script Copied! Paste in Apps Script";
        setTimeout(() => { sheetsSyncStatus.textContent = ""; }, 3500);
      });
    });
  }

  if (testConnectionBtn) {
    testConnectionBtn.addEventListener("click", () => {
      const url = googleSheetsUrl.value.trim();
      if (!url) {
        sheetsSyncStatus.textContent = "Paste Web App URL first";
        return;
      }
      saveSettings();
      sheetsSyncStatus.textContent = "Testing connection...";
      cloudStatusDot.className = "status-dot syncing";
      chrome.runtime.sendMessage({ type: "TEST_CLOUD_CONNECTION", url }, (res) => {
        if (res && res.ok) {
          sheetsSyncStatus.textContent = "✓ Connected to Google Cloud!";
          renderCloudSyncUI();
        } else {
          sheetsSyncStatus.textContent = (res && res.reason) || "Connection failed";
          renderCloudSyncUI();
        }
        setTimeout(() => { sheetsSyncStatus.textContent = ""; }, 3500);
      });
    });
  }

  if (pushSheetsBtn) {
    pushSheetsBtn.addEventListener("click", () => {
      saveSettings();
      sheetsSyncStatus.textContent = "Syncing to Google Cloud...";
      chrome.runtime.sendMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "manual_button" }, (res) => {
        sheetsSyncStatus.textContent = res && res.ok ? "✓ Synced to Drive, Sheets & Calendar!" : (res && res.reason) || "Set URL first";
        renderCloudSyncUI();
        setTimeout(() => { sheetsSyncStatus.textContent = ""; }, 3500);
      });
    });
  }

  if (pullSheetsBtn) {
    pullSheetsBtn.addEventListener("click", () => {
      const url = googleSheetsUrl.value.trim();
      sheetsSyncStatus.textContent = "Restoring from Google Cloud...";
      chrome.runtime.sendMessage({ type: "PULL_FROM_GOOGLE_SHEETS", url }, (res) => {
        if (res && res.ok) {
          sheetsSyncStatus.textContent = `✓ Restored ${res.classroomsCount} rooms!`;
          renderClassroomsOrganizer();
          renderTuitionDatabase();
          renderCloudSyncUI();
        } else {
          sheetsSyncStatus.textContent = (res && res.reason) || "Restore failed";
        }
        setTimeout(() => { sheetsSyncStatus.textContent = ""; }, 3500);
      });
    });
  }

  if (saveDiskNowBtn) {
    saveDiskNowBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "BACKUP_TO_LOCAL_DISK" }, () => {
        sheetsSyncStatus.textContent = "✓ Saved to Tuition_Tracker_DB/!";
        setTimeout(() => { sheetsSyncStatus.textContent = ""; }, 2500);
      });
    });
  }

  if (importJsonBtn && importJsonFileInput) {
    importJsonBtn.addEventListener("click", () => importJsonFileInput.click());
    importJsonFileInput.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          const payload = {};
          if (data.profiles) payload[STORAGE_KEY_PROFILES] = data.profiles;
          if (Array.isArray(data.history)) payload[STORAGE_KEY_HISTORY] = data.history;
          if (data.settings) payload[STORAGE_KEY_SETTINGS] = data.settings;
          chrome.storage.local.set(payload, () => {
            chrome.runtime.sendMessage({ type: "MIRROR_CLOUD_SYNC" });
            sheetsSyncStatus.textContent = "✓ Database Restored from File!";
            renderClassroomsOrganizer();
            renderTuitionDatabase();
          });
        } catch (_e) {
          sheetsSyncStatus.textContent = "Invalid JSON file";
        }
      };
      reader.readAsText(file);
    });
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener("click", () => {
      chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_SETTINGS], (res) => {
        const backup = {
          version: "3.0.0",
          exportedAt: new Date().toISOString(),
          profiles: res[STORAGE_KEY_PROFILES] || {},
          history: res[STORAGE_KEY_HISTORY] || [],
          settings: res[STORAGE_KEY_SETTINGS] || {}
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tuition_database_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  if (recQuickBtn) {
    recQuickBtn.addEventListener("click", () => {
      findMeetTab((tabId) => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "TOGGLE_RECORDING" }, () => refreshLiveStatus());
        }
      });
    });
  }

  if (hwQuickBtn) {
    hwQuickBtn.addEventListener("click", () => {
      findMeetTab((tabId) => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "OPEN_HOMEWORK_MAIL" });
        }
      });
    });
  }

  if (calQuickBtn) {
    calQuickBtn.addEventListener("click", () => {
      findMeetTab((tabId) => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "OPEN_CALENDAR_TEMPLATE" });
        }
      });
    });
  }

  if (filterCategory) filterCategory.addEventListener("change", renderTuitionDatabase);
  if (searchCodeInput) searchCodeInput.addEventListener("input", renderTuitionDatabase);

  if (openDashboardBtn) {
    openDashboardBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    });
  }
  if (openDashboardRoomsBtn) {
    openDashboardRoomsBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    });
  }

  function loadSettings() {
    chrome.storage.local.get([STORAGE_KEY_SETTINGS], (res) => {
      const s = res[STORAGE_KEY_SETTINGS] || {
        autoRecordClass: true,
        autoFocusPresentation: true,
        autoBackupLocalFile: true,
        minClassMinutes: 35,
        warnMinutes: 70,
        autoOpenCalendarTab: true,
        googleSheetsUrl: "",
        autoSyncOnClassEnd: true,
        autoSyncInterval: 30,
        position: "top-center"
      };
      autoRecordClass.checked = s.autoRecordClass !== false;
      autoFocusPresentation.checked = s.autoFocusPresentation !== false;
      autoBackupLocalFile.checked = s.autoBackupLocalFile !== false;
      minClassMinutesInput.value = s.minClassMinutes ?? 35;
      warnMinutes.value = s.warnMinutes ?? 70;
      selectPosition.value = s.position || "top-center";
      autoOpenCalendarTab.checked = s.autoOpenCalendarTab !== false;
      googleSheetsUrl.value = s.googleSheetsUrl || "";
      if (autoSyncOnClassEnd) autoSyncOnClassEnd.checked = s.autoSyncOnClassEnd !== false;
      if (autoSyncIntervalSelect) autoSyncIntervalSelect.value = String(s.autoSyncInterval ?? 30);
      renderCloudSyncUI();
    });
  }

  function saveSettings() {
    chrome.storage.local.get([STORAGE_KEY_SETTINGS], (res) => {
      const prev = res[STORAGE_KEY_SETTINGS] || {};
      const newSettings = {
        ...prev,
        autoRecordClass: autoRecordClass.checked,
        autoFocusPresentation: autoFocusPresentation.checked,
        autoBackupLocalFile: autoBackupLocalFile.checked,
        minClassMinutes: Math.max(1, parseInt(minClassMinutesInput.value, 10) || 35),
        warnMinutes: Math.max(0, parseInt(warnMinutes.value, 10) || 70),
        position: selectPosition.value,
        autoOpenCalendarTab: autoOpenCalendarTab.checked,
        googleSheetsUrl: googleSheetsUrl.value.trim(),
        autoSyncOnClassEnd: autoSyncOnClassEnd ? autoSyncOnClassEnd.checked : true,
        autoSyncInterval: autoSyncIntervalSelect ? parseInt(autoSyncIntervalSelect.value, 10) : 30
      };
      chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: newSettings }, () => {
        chrome.runtime.sendMessage({ type: "MIRROR_CLOUD_SYNC" });
        chrome.runtime.sendMessage({ type: "RELOAD_SYNC_ALARMS" });
      });
      findMeetTab((tabId) => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "UPDATE_SETTINGS", settings: newSettings });
        }
      });
    });
  }

  function renderUpdateStatus(info) {
    const manifestVer = chrome.runtime.getManifest().version;
    if (!info) {
      versionStatusText.textContent = `v${manifestVer} • Business Edition (Drive, Sheets & Calendar Sync)`;
      return;
    }
    if (info.updateAvailable) {
      updateBanner.style.display = "flex";
      updateBannerText.textContent = `New version v${info.latestVersion} available!`;
      updateDownloadLink.href = info.releaseUrl || info.downloadUrl;
      versionStatusText.textContent = `Update available: v${info.latestVersion}`;
    } else {
      updateBanner.style.display = "none";
      versionStatusText.textContent = `v${manifestVer} • Business Edition (Up to date)`;
    }
  }

  function initAutoUpdateUI() {
    chrome.storage.local.get([STORAGE_KEY_UPDATE], (res) => {
      renderUpdateStatus(res ? res[STORAGE_KEY_UPDATE] : null);
    });
    checkUpdateBtn.addEventListener("click", () => {
      versionStatusText.textContent = "Checking GitHub for updates...";
      chrome.runtime.sendMessage({ type: "CHECK_FOR_UPDATES" }, (info) => {
        renderUpdateStatus(info);
      });
    });
  }

  pauseBtn.addEventListener("click", () => {
    findMeetTab((tabId) => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "TOGGLE_PAUSE" }, () => refreshLiveStatus());
      }
    });
  });

  syncMeetBtn.addEventListener("click", () => {
    findMeetTab((tabId) => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "SYNC_MEET_START" }, () => {
          inputsInitialized = false;
          refreshLiveStatus();
        });
      }
    });
  });

  resetBtn.addEventListener("click", () => {
    findMeetTab((tabId) => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "RESET_TIMER" }, () => {
          setHhInput.value = 0;
          setMmInput.value = 0;
          setSsInput.value = 0;
          refreshLiveStatus();
        });
      }
    });
  });

  document.querySelectorAll(".offset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const deltaMs = parseInt(btn.getAttribute("data-delta"), 10) || 0;
      findMeetTab((tabId) => {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "ADJUST_OFFSET", deltaMs }, () => {
            inputsInitialized = false;
            refreshLiveStatus();
          });
        }
      });
    });
  });

  setExactBtn.addEventListener("click", () => {
    const hh = Math.max(0, parseInt(setHhInput.value, 10) || 0);
    const mm = Math.max(0, parseInt(setMmInput.value, 10) || 0);
    const ss = Math.max(0, parseInt(setSsInput.value, 10) || 0);
    const totalSeconds = (hh * 3600) + (mm * 60) + ss;
    const targetMs = totalSeconds * 1000;
    findMeetTab((tabId) => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "SET_EXACT_TIME", targetMs, totalSeconds }, () => {
          refreshLiveStatus();
        });
      }
    });
  });

  autoRecordClass.addEventListener("change", saveSettings);
  autoFocusPresentation.addEventListener("change", saveSettings);
  autoBackupLocalFile.addEventListener("change", saveSettings);
  minClassMinutesInput.addEventListener("change", saveSettings);
  warnMinutes.addEventListener("change", saveSettings);
  selectPosition.addEventListener("change", saveSettings);
  autoOpenCalendarTab.addEventListener("change", saveSettings);
  googleSheetsUrl.addEventListener("change", saveSettings);
  if (autoSyncOnClassEnd) autoSyncOnClassEnd.addEventListener("change", saveSettings);
  if (autoSyncIntervalSelect) autoSyncIntervalSelect.addEventListener("change", saveSettings);

  if (exportIcsBtn) {
    exportIcsBtn.addEventListener("click", () => {
      chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS], (res) => {
        const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
        const profiles = res[STORAGE_KEY_PROFILES] || {};
        const s = res[STORAGE_KEY_SETTINGS] || {};
        const minMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
        const currentMonthPrefix = new Date().toISOString().slice(0, 7);
        const chronological = [...history].reverse();
        const counts = {};
        const events = [];
        const toIcsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

        for (const h of chronological) {
          if (!h || !h.meetingCode) continue;
          const qualified = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
          if (!qualified) continue;
          const code = h.meetingCode;
          const prof = profiles[code] || {};
          const m = (h.startedAt || h.endedAt || "").slice(0, 7) || currentMonthPrefix;
          const initOff = (prof.offsetMonth || currentMonthPrefix) === m ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
          const key = `${code}_${m}`;
          counts[key] = (counts[key] || initOff) + 1;
          const classNum = counts[key];
          const label = prof.label || h.label || code;
          events.push([
            "BEGIN:VEVENT",
            `UID:${h.historyId || code + "-" + classNum}@google-meet-tuition-companion`,
            `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
            `DTSTART:${toIcsDate(h.startedAt || h.endedAt)}`,
            `DTEND:${toIcsDate(h.endedAt || new Date().toISOString())}`,
            `SUMMARY:🎓 Class #${classNum}: ${label} (${code})`,
            `DESCRIPTION:Online Tuition Class #${classNum} (${formatDuration(h.durationMs)})`,
            `LOCATION:https://meet.google.com/${code}`,
            "END:VEVENT"
          ].join("\r\n"));
        }
        if (events.length === 0) return;
        const icsContent = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Meet Tuition Companion//EN", ...events, "END:VCALENDAR"].join("\r\n");
        const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tuition-classes-calendar-${new Date().toISOString().slice(0, 10)}.ics`;
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  exportCsvBtn.addEventListener("click", () => {
    chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const minMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);
      if (history.length === 0) return;

      const chronological = [...history].reverse();
      const codeMonthCounts = {};
      const annotated = chronological.map((h) => {
        const code = h.meetingCode || "unknown";
        const prof = profiles[code] || {};
        const m = (h.startedAt || h.endedAt || "").slice(0, 7) || currentMonthPrefix;
        const initOff = (prof.offsetMonth || currentMonthPrefix) === m ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
        const qualified = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
        let classLabel = "Short (<35m)";
        if (qualified) {
          const key = `${code}_${m}`;
          codeMonthCounts[key] = (codeMonthCounts[key] || initOff) + 1;
          classLabel = `Class #${codeMonthCounts[key]}`;
        }
        return {
          ...h,
          qualified,
          classLabel,
          studentLabel: prof.label || h.label || "",
          students: prof.students || h.students || "",
          schedule: prof.schedule || h.schedule || "",
          studentEmails: prof.studentEmails || h.studentEmails || "",
          feeRate: prof.feeRate || "",
          currency: prof.currency || "$",
          initialOffset: initOff,
          category: prof.category || h.category || "Tuition / Class"
        };
      }).reverse();

      const rows = [
        ["Meeting Code", "Class Name", "Students", "Typical Schedule", "Student Mails", "Fee / Rate", "Prior Offset (Mo)", "Category", "Qualification Status", "Monthly Class #", "Date", "Started At", "Ended At", "Duration (HH:MM:SS)", "Duration (Minutes)"],
        ...annotated.map((h) => [
          h.meetingCode,
          h.studentLabel,
          h.students,
          h.schedule,
          h.studentEmails,
          h.feeRate ? (h.currency + h.feeRate) : "-",
          h.initialOffset,
          h.category,
          h.qualified ? "Qualified Class (≥35m)" : "Short Call (<35m)",
          h.classLabel,
          (h.startedAt || h.endedAt || "").slice(0, 10),
          h.startedAt ? new Date(h.startedAt).toLocaleString() : "",
          h.endedAt ? new Date(h.endedAt).toLocaleString() : "",
          formatDuration(h.durationMs),
          ((h.durationMs || 0) / 60000).toFixed(1)
        ])
      ];
      const csvContent = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tuition-classes-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  loadSettings();
  renderClassroomsOrganizer();
  renderTuitionDatabase();
  initAutoUpdateUI();
  refreshLiveStatus();
  setInterval(refreshLiveStatus, 1000);
})();

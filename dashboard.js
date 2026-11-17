(() => {
  "use strict";

  const STORAGE_KEY_HISTORY = "gm_timer_call_history";
  const STORAGE_KEY_PROFILES = "gm_timer_code_profiles";
  const STORAGE_KEY_SETTINGS = "gm_timer_settings";
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

  const dashTotalClasses = document.getElementById("dashTotalClasses");
  const dashMonthClasses = document.getElementById("dashMonthClasses");
  const dashActiveStudents = document.getElementById("dashActiveStudents");
  const dashTotalHours = document.getElementById("dashTotalHours");
  const dashEstBilling = document.getElementById("dashEstBilling");
  const dashCategoryFilter = document.getElementById("dashCategoryFilter");
  const dashMonthFilter = document.getElementById("dashMonthFilter");
  const dashSearchInput = document.getElementById("dashSearchInput");
  const dashCodeGrid = document.getElementById("dashCodeGrid");
  const dashExportIcsBtn = document.getElementById("dashExportIcsBtn");
  const dashExportCsvBtn = document.getElementById("dashExportCsvBtn");

  const dashDriveLinkBtn = document.getElementById("dashDriveLinkBtn");
  const dashSheetLinkBtn = document.getElementById("dashSheetLinkBtn");
  const dashLinkDocsFileBtn = document.getElementById("dashLinkDocsFileBtn");
  const dashImportJsonBtn = document.getElementById("dashImportJsonBtn");
  const dashImportFileInput = document.getElementById("dashImportFileInput");
  const dashSheetsUrl = document.getElementById("dashSheetsUrl");
  const dashCopyScriptBtn = document.getElementById("dashCopyScriptBtn");
  const dashTestConnBtn = document.getElementById("dashTestConnBtn");
  const dashPushSheetsBtn = document.getElementById("dashPushSheetsBtn");
  const dashPullSheetsBtn = document.getElementById("dashPullSheetsBtn");
  const dashSyncStatus = document.getElementById("dashSyncStatus");

  const orgLink = document.getElementById("orgLink");
  const orgName = document.getElementById("orgName");
  const orgInitialOffset = document.getElementById("orgInitialOffset");
  const orgStudents = document.getElementById("orgStudents");
  const orgSchedule = document.getElementById("orgSchedule");
  const orgFeeRate = document.getElementById("orgFeeRate");
  const orgEmails = document.getElementById("orgEmails");
  const orgSaveBtn = document.getElementById("orgSaveBtn");

  // Invoice Modal
  const dashInvoiceModal = document.getElementById("dashInvoiceModal");
  const dashInvoiceTitle = document.getElementById("dashInvoiceTitle");
  const dashInvoiceBody = document.getElementById("dashInvoiceBody");
  const dashCloseInvoiceBtn = document.getElementById("dashCloseInvoiceBtn");
  const dashCopyInvoiceBtn = document.getElementById("dashCopyInvoiceBtn");

  let activeInvoiceData = null;

  function extractMeetCode(raw) {
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

  function buildHomeworkGmailUrl(g, hwText = "") {
    const code = g.meetingCode;
    const className = g.label || `Class (${code})`;
    const students = g.students || "Students";
    const emails = (g.studentEmails || "").trim();
    const schedule = g.schedule || "Regular Schedule";
    const classCount = Math.max(1, g.monthCount || 1);
    const dateStr = new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const hwTask = (hwText || "").trim() || g.defaultHomework || "[Enter today's homework tasks & exercises here]";

    const subject = `📚 Homework: ${className} — Class #${classCount} (${dateStr})`;
    const body = [
      `Hi ${students},`,
      ``,
      `Here is the homework assignment and class summary for ${className} (Class #${classCount} on ${dateStr}):`,
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

  function buildCalLink(s, classNumber) {
    const toCalDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const startStr = toCalDate(s.startedAt || s.endedAt);
    const endStr = toCalDate(s.endedAt || new Date().toISOString());
    const studentPart = s.label ? `${s.label} (${s.meetingCode})` : s.meetingCode;
    const title = classNumber ? `🎓 Class #${classNumber}: ${studentPart}` : `Meet Call: ${studentPart}`;
    const details = `Online Tuition Class tracked by Google Meet Tuition Companion.\nClass: ${s.label || "Unlabeled"}\nStudents: ${s.students || "N/A"}\nMeeting Code: ${s.meetingCode}\nDuration: ${formatDuration(s.durationMs)}`;
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${startStr}/${endStr}`,
      details,
      location: `https://meet.google.com/${s.meetingCode}`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  // Save directly to user's Documents folder using File System Access API
  dashLinkDocsFileBtn.addEventListener("click", async () => {
    chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY, STORAGE_KEY_SETTINGS, STORAGE_KEY_CLOUD_META], async (res) => {
      const backupObj = {
        version: "3.0.0",
        exportedAt: new Date().toISOString(),
        profiles: res[STORAGE_KEY_PROFILES] || {},
        history: res[STORAGE_KEY_HISTORY] || [],
        settings: res[STORAGE_KEY_SETTINGS] || {},
        cloudMeta: res[STORAGE_KEY_CLOUD_META] || {}
      };
      const jsonStr = JSON.stringify(backupObj, null, 2);

      if (typeof window.showSaveFilePicker === "function") {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: "tuition_classes_database.json",
            startIn: "documents",
            types: [{ description: "Tuition Database JSON", accept: { "application/json": [".json"] } }]
          });
          const writable = await handle.createWritable();
          await writable.write(jsonStr);
          await writable.close();
          dashSyncStatus.textContent = "✓ Saved directly to Documents folder!";
          return;
        } catch (_err) {}
      }
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tuition_classes_database.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  dashImportJsonBtn.addEventListener("click", () => dashImportFileInput.click());
  dashImportFileInput.addEventListener("change", (ev) => {
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
          dashSyncStatus.textContent = "✓ Database Restored from File!";
          renderDashboard();
        });
      } catch (_e) {
        dashSyncStatus.textContent = "Invalid JSON file";
      }
    };
    reader.readAsText(file);
  });

  dashCopyScriptBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(UNIFIED_APPS_SCRIPT_CODE).then(() => {
      dashSyncStatus.textContent = "✓ Copied Unified Script! Paste in Sheet -> Extensions -> Apps Script";
      setTimeout(() => { dashSyncStatus.textContent = ""; }, 3500);
    });
  });

  if (dashTestConnBtn) {
    dashTestConnBtn.addEventListener("click", () => {
      const url = dashSheetsUrl.value.trim();
      if (!url) {
        dashSyncStatus.textContent = "Paste Web App URL first";
        return;
      }
      dashSyncStatus.textContent = "Testing connection...";
      chrome.runtime.sendMessage({ type: "TEST_CLOUD_CONNECTION", url }, (resp) => {
        if (resp && resp.ok) {
          dashSyncStatus.textContent = "✓ Cloud Connected (Drive & Sheets Active)!";
          renderDashboard();
        } else {
          dashSyncStatus.textContent = (resp && resp.reason) || "Connection failed";
        }
        setTimeout(() => { dashSyncStatus.textContent = ""; }, 3500);
      });
    });
  }

  dashPushSheetsBtn.addEventListener("click", () => {
    const url = dashSheetsUrl.value.trim();
    chrome.storage.local.get([STORAGE_KEY_SETTINGS], (res) => {
      const s = { ...(res[STORAGE_KEY_SETTINGS] || {}), googleSheetsUrl: url };
      chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: s }, () => {
        dashSyncStatus.textContent = "Syncing to Google Cloud...";
        chrome.runtime.sendMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "dashboard_manual" }, (resp) => {
          dashSyncStatus.textContent = resp && resp.ok ? "✓ Synced to Drive, Sheets & Calendar!" : (resp && resp.reason) || "Sync failed";
          renderDashboard();
          setTimeout(() => { dashSyncStatus.textContent = ""; }, 3500);
        });
      });
    });
  });

  dashPullSheetsBtn.addEventListener("click", () => {
    const url = dashSheetsUrl.value.trim();
    dashSyncStatus.textContent = "Restoring from Google Cloud...";
    chrome.runtime.sendMessage({ type: "PULL_FROM_GOOGLE_SHEETS", url }, (resp) => {
      if (resp && resp.ok) {
        dashSyncStatus.textContent = `✓ Restored ${resp.classroomsCount} classrooms & ${resp.sessionsCount} sessions from Cloud!`;
        renderDashboard();
      } else {
        dashSyncStatus.textContent = (resp && resp.reason) || "Restore failed";
      }
      setTimeout(() => { dashSyncStatus.textContent = ""; }, 3500);
    });
  });

  orgSaveBtn.addEventListener("click", () => {
    const code = extractMeetCode(orgLink.value);
    if (!code) return;
    const currentMonth = new Date().toISOString().slice(0, 7);
    const initOffset = Math.max(0, parseInt(orgInitialOffset.value, 10) || 0);
    const feeRate = orgFeeRate ? orgFeeRate.value.trim() : "";

    chrome.storage.local.get([STORAGE_KEY_PROFILES, STORAGE_KEY_HISTORY], (res) => {
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const existing = profiles[code] || {};
      profiles[code] = {
        ...existing,
        meetingCode: code,
        classLink: `https://meet.google.com/${code}`,
        label: orgName.value.trim() || existing.label || "",
        category: existing.category || "Tuition / Class",
        initialClassOffset: initOffset,
        offsetMonth: currentMonth,
        students: orgStudents.value.trim(),
        schedule: orgSchedule.value.trim(),
        feeRate,
        studentEmails: orgEmails.value.trim(),
        updatedAt: new Date().toISOString()
      };
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      for (const h of history) {
        if (h && h.meetingCode === code) {
          h.label = profiles[code].label;
          h.students = profiles[code].students;
          h.schedule = profiles[code].schedule;
          h.studentEmails = profiles[code].studentEmails;
        }
      }
      chrome.storage.local.set({ [STORAGE_KEY_PROFILES]: profiles, [STORAGE_KEY_HISTORY]: history }, () => {
        chrome.runtime.sendMessage({ type: "PUSH_TO_GOOGLE_SHEETS", reason: "dashboard_classroom_saved" });
        orgLink.value = "";
        orgName.value = "";
        orgInitialOffset.value = "";
        orgStudents.value = "";
        orgSchedule.value = "";
        if (orgFeeRate) orgFeeRate.value = "";
        orgEmails.value = "";
        renderDashboard();
      });
    });
  });

  function openInvoiceModal(group) {
    if (!group) return;
    const currentMonth = new Date().toLocaleString([], { month: "long", year: "numeric" });
    const fee = parseFloat(group.feeRate || 0);
    const curr = group.currency || "$";
    const totalDue = fee > 0 ? (fee * group.monthCount).toFixed(2) : "0.00";

    activeInvoiceData = {
      className: group.label || group.meetingCode,
      students: group.students || "Student",
      month: currentMonth,
      monthCount: group.monthCount,
      feeRate: fee,
      currency: curr,
      totalDue,
      sessions: group.sessions.filter((s) => s.isQualified)
    };

    dashInvoiceTitle.textContent = `🎓 Tuition Statement: ${group.label || group.meetingCode}`;
    dashInvoiceBody.innerHTML = `
      <div style="font-size: 12px; line-height: 1.6; background: var(--elevated); padding: 12px; border-radius: 12px;">
        <div><strong>Student / Batch:</strong> ${group.students || "N/A"}</div>
        <div><strong>Class / Subject:</strong> ${group.label || group.meetingCode}</div>
        <div><strong>Billing Period:</strong> ${currentMonth}</div>
        <div><strong>Rate:</strong> ${fee > 0 ? curr + fee + " per class" : "Rate not specified"}</div>
      </div>
      <table style="margin-top: 10px;">
        <thead>
          <tr>
            <th>Class #</th>
            <th>Date</th>
            <th>Duration</th>
            <th style="text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${activeInvoiceData.sessions.map((s) => `
            <tr>
              <td>Class #${s.classNumber}</td>
              <td>${new Date(s.startedAt || s.endedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</td>
              <td>${Math.round((s.durationMs || 0) / 60000)}m</td>
              <td style="text-align: right;">${fee > 0 ? curr + fee.toFixed(2) : "-"}</td>
            </tr>
          `).join("") || '<tr><td colspan="4" style="text-align:center; color: var(--muted);">Prior offset classes: ' + group.monthCount + '</td></tr>'}
        </tbody>
      </table>
      <div style="display: flex; justify-content: space-between; background: var(--elevated); padding: 10px 14px; border-radius: 12px; font-weight: 600;">
        <span>Total (${group.monthCount} Qualified Classes):</span>
        <span style="color: var(--green); font-size: 16px;">${curr}${totalDue}</span>
      </div>
    `;

    dashInvoiceModal.classList.add("open");
  }

  if (dashCloseInvoiceBtn) {
    dashCloseInvoiceBtn.addEventListener("click", () => {
      dashInvoiceModal.classList.remove("open");
    });
  }

  if (dashCopyInvoiceBtn) {
    dashCopyInvoiceBtn.addEventListener("click", () => {
      if (!activeInvoiceData) return;
      const d = activeInvoiceData;
      const text = [
        `🎓 Tuition Statement — ${d.className}`,
        `• Student: ${d.students}`,
        `• Billing Period: ${d.month}`,
        `• Classes Completed: ${d.monthCount} classes`,
        `• Fee Rate: ${d.feeRate > 0 ? d.currency + d.feeRate + " / class" : "N/A"}`,
        `• Total Amount Due: ${d.currency}${d.totalDue}`,
        ``,
        `Thank you!`
      ].join("\n");

      navigator.clipboard.writeText(text).then(() => {
        dashCopyInvoiceBtn.textContent = "✓ Copied!";
        setTimeout(() => { dashCopyInvoiceBtn.textContent = "📋 Copy WhatsApp Text"; }, 2000);
      });
    });
  }

  function renderDashboard() {
    chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS, STORAGE_KEY_CLOUD_META], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const cloudMeta = res[STORAGE_KEY_CLOUD_META] || {};

      if (s.googleSheetsUrl && !dashSheetsUrl.value) {
        dashSheetsUrl.value = s.googleSheetsUrl;
      }

      if (cloudMeta.driveFolderUrl) {
        dashDriveLinkBtn.href = cloudMeta.driveFolderUrl;
        dashDriveLinkBtn.style.display = "inline-flex";
      }
      if (cloudMeta.sheetUrl) {
        dashSheetLinkBtn.href = cloudMeta.sheetUrl;
        dashSheetLinkBtn.style.display = "inline-flex";
      }

      const minClassMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
      const catFilter = dashCategoryFilter.value;
      const monthFilter = dashMonthFilter.value;
      const query = dashSearchInput.value.trim().toLowerCase();
      const thisMonthPrefix = new Date().toISOString().slice(0, 7);

      const chronological = [...history].reverse();
      const counts = {};
      const annotated = chronological.map((item) => {
        if (!item || !item.meetingCode) return null;
        const code = item.meetingCode;
        const prof = profiles[code] || {};
        const itemMonth = (item.startedAt || item.endedAt || "").slice(0, 7) || thisMonthPrefix;
        const baseOffset = (prof.offsetMonth || thisMonthPrefix) === itemMonth ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
        const isQualified = item.isQualifiedClass !== undefined ? Boolean(item.isQualifiedClass) : (item.durationMs || 0) >= minClassMs;
        let classNumber = null;
        if (isQualified) {
          const key = `${code}_${itemMonth}`;
          counts[key] = (counts[key] || baseOffset) + 1;
          classNumber = counts[key];
        }
        return { ...item, isQualified, classNumber, itemMonth };
      }).filter(Boolean).reverse();

      const grouped = {};
      let totalClasses = 0;
      let thisMonthClasses = 0;
      let totalMs = 0;
      let grandTotalBilling = 0;

      for (const [code, prof] of Object.entries(profiles)) {
        if (!code) continue;
        const category = prof.category || "Tuition / Class";
        if (catFilter !== "ALL" && category !== catFilter) continue;
        const initOff = (prof.offsetMonth || thisMonthPrefix) === thisMonthPrefix ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
        grouped[code] = {
          meetingCode: code,
          label: prof.label || "",
          category,
          students: prof.students || "",
          schedule: prof.schedule || "",
          studentEmails: prof.studentEmails || "",
          feeRate: prof.feeRate || "",
          currency: prof.currency || "$",
          defaultHomework: prof.defaultHomework || "",
          initialOffset: initOff,
          qualifiedClasses: initOff,
          monthCount: initOff,
          totalClassMs: 0,
          sessions: []
        };
        totalClasses += initOff;
        thisMonthClasses += initOff;
        const fee = parseFloat(prof.feeRate || 0);
        if (fee > 0) grandTotalBilling += fee * initOff;
      }

      for (const item of annotated) {
        const code = item.meetingCode;
        const prof = profiles[code] || {};
        const label = prof.label || item.label || "";
        const category = prof.category || item.category || "Tuition / Class";
        const itemMonth = item.itemMonth;

        if (catFilter !== "ALL" && category !== catFilter) continue;
        if (monthFilter && itemMonth !== monthFilter) continue;

        if (!grouped[code]) {
          const initOff = (prof.offsetMonth || thisMonthPrefix) === thisMonthPrefix ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
          grouped[code] = {
            meetingCode: code,
            label,
            category,
            students: prof.students || item.students || "",
            schedule: prof.schedule || item.schedule || "",
            studentEmails: prof.studentEmails || item.studentEmails || "",
            feeRate: prof.feeRate || "",
            currency: prof.currency || "$",
            defaultHomework: prof.defaultHomework || "",
            initialOffset: initOff,
            qualifiedClasses: initOff,
            monthCount: initOff,
            totalClassMs: 0,
            sessions: []
          };
        }

        grouped[code].sessions.push({ ...item, label, category });
        if (item.isQualified) {
          grouped[code].qualifiedClasses += 1;
          grouped[code].totalClassMs += item.durationMs || 0;
          totalClasses += 1;
          totalMs += item.durationMs || 0;
          if (itemMonth === thisMonthPrefix) {
            grouped[code].monthCount += 1;
            thisMonthClasses += 1;
            const fee = parseFloat(prof.feeRate || 0);
            if (fee > 0) grandTotalBilling += fee;
          }
        }
      }

      const groups = Object.values(grouped).filter((g) => {
        if (!query) return true;
        return (
          g.meetingCode.toLowerCase().includes(query) ||
          (g.label || "").toLowerCase().includes(query) ||
          (g.students || "").toLowerCase().includes(query) ||
          (g.schedule || "").toLowerCase().includes(query) ||
          (g.studentEmails || "").toLowerCase().includes(query)
        );
      });

      dashMonthClasses.textContent = String(thisMonthClasses);
      dashTotalClasses.textContent = String(totalClasses);
      dashActiveStudents.textContent = String(groups.length);
      dashTotalHours.textContent = formatShortHours(totalMs);
      if (dashEstBilling) {
        dashEstBilling.textContent = `$${Math.round(grandTotalBilling)}`;
      }

      if (groups.length === 0) {
        dashCodeGrid.innerHTML = '<div style="color: #9aa0a6; padding: 24px;">No classrooms or recorded tuition classes match your filter.</div>';
        return;
      }

      dashCodeGrid.innerHTML = groups
        .map((g, idx) => {
          const fee = parseFloat(g.feeRate || 0);
          const curr = g.currency || "$";
          const billingStr = fee > 0 ? ` • Est. Billing: <strong>${curr}${(fee * g.monthCount).toFixed(0)}</strong>` : "";
          const rowsHtml = g.sessions
            .map((sess) => {
              const dt = new Date(sess.startedAt || sess.endedAt);
              const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
              const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              const badge = sess.isQualified
                ? `<strong style="color: #81c995;">🎓 Class #${sess.classNumber}</strong>`
                : `<span style="color: #9aa0a6;">Short (&lt;35m)</span>`;
              const calUrl = buildCalLink(sess, sess.classNumber);
              return `
                <tr>
                  <td>${badge}</td>
                  <td>${dateStr} • ${timeStr}</td>
                  <td style="text-align: right; font-family: 'Google Sans Mono', monospace; color: ${sess.isQualified ? "#81c995" : "#9aa0a6"};">${formatDuration(sess.durationMs)}</td>
                  <td style="text-align: right;"><a class="cal-link" href="${calUrl}" target="_blank" rel="noopener noreferrer">📅 Save</a></td>
                </tr>
              `;
            })
            .join("");

          const meetUrl = `https://meet.google.com/${g.meetingCode}`;
          return `
            <div class="code-card">
              <div class="code-header">
                <div>
                  <div class="student-name">${g.label || `Classroom (${g.meetingCode})`}</div>
                  <a class="meet-code" href="${meetUrl}" target="_blank" rel="noopener noreferrer">${meetUrl}</a>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                  <button type="button" class="primary dash-invoice-btn" data-code="${g.meetingCode}" style="padding: 3px 8px; font-size: 10.5px;">🧾 Statement</button>
                  <span class="cat-pill">${g.category}</span>
                  <button type="button" class="edit-card-btn" data-code="${g.meetingCode}" style="padding: 3px 8px; font-size: 10.5px;">✎ Edit</button>
                </div>
              </div>
              <div class="meta-box">
                <div><strong>Students:</strong> ${g.students || "Not set"}${fee > 0 ? " • <strong>Rate:</strong> " + curr + g.feeRate : ""}${billingStr}</div>
                <div><strong>Typical Schedule:</strong> ${g.schedule || "Not set"} • <strong>Prior Offset:</strong> ${g.initialOffset || 0} classes</div>
                <div><strong>Student Mails:</strong> ${g.studentEmails || "Not set"}</div>
              </div>
              <div class="hw-bar">
                <input type="text" id="dash-hw-${idx}" placeholder="Homework assignment for ${g.label || g.meetingCode}..." value="${g.defaultHomework || ""}" />
                <button type="button" class="green-btn dash-send-hw-btn" data-code="${g.meetingCode}" data-input="dash-hw-${idx}">✉️ Send Homework</button>
              </div>
              <div class="stats-strip">
                <span>This Month: <strong>${g.monthCount} Classes</strong> (${g.qualifiedClasses} total)</span>
                <span>Recorded Hours: <strong>${formatShortHours(g.totalClassMs)}</strong></span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Monthly Class #</th>
                    <th>Date & Time</th>
                    <th style="text-align: right;">Duration</th>
                    <th style="text-align: right;">Calendar</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml || '<tr><td colspan="4" style="color: #9aa0a6; text-align: center; padding: 10px;">Prior classes initialized (' + (g.initialOffset || 0) + ' this month) — next recorded session will be Class #' + ((g.initialOffset || 0) + 1) + '</td></tr>'}
                </tbody>
              </table>
            </div>
          `;
        })
        .join("");

      dashCodeGrid.querySelectorAll(".edit-card-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          const p = profiles[code] || {};
          orgLink.value = `https://meet.google.com/${code}`;
          orgName.value = p.label || "";
          orgInitialOffset.value = p.initialClassOffset || 0;
          orgStudents.value = p.students || "";
          orgSchedule.value = p.schedule || "";
          if (orgFeeRate) orgFeeRate.value = p.feeRate || "";
          orgEmails.value = p.studentEmails || "";
          orgInitialOffset.focus();
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      });

      dashCodeGrid.querySelectorAll(".dash-invoice-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          const g = groups.find((x) => x.meetingCode === code);
          openInvoiceModal(g);
        });
      });

      dashCodeGrid.querySelectorAll(".dash-send-hw-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = btn.getAttribute("data-code");
          const inputEl = document.getElementById(btn.getAttribute("data-input"));
          const hwVal = inputEl ? inputEl.value.trim() : "";
          const g = groups.find((x) => x.meetingCode === code) || { meetingCode: code };
          window.open(buildHomeworkGmailUrl(g, hwVal), "_blank", "noopener,noreferrer");
        });
      });
    });
  }

  dashCategoryFilter.addEventListener("change", renderDashboard);
  dashMonthFilter.addEventListener("change", renderDashboard);
  dashSearchInput.addEventListener("input", renderDashboard);

  dashExportIcsBtn.addEventListener("click", () => {
    chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const minMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
      const thisMonthPrefix = new Date().toISOString().slice(0, 7);
      const toIcsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

      const chronological = [...history].reverse();
      const counts = {};
      const events = [];

      for (const h of chronological) {
        if (!h || !h.meetingCode) continue;
        const qualified = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
        if (!qualified) continue;
        const code = h.meetingCode;
        const prof = profiles[code] || {};
        const m = (h.startedAt || h.endedAt || "").slice(0, 7) || thisMonthPrefix;
        const initOff = (prof.offsetMonth || thisMonthPrefix) === m ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
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
      const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Meet Tuition Companion//EN", ...events, "END:VCALENDAR"].join("\r\n");
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tuition-classes-calendar-${new Date().toISOString().slice(0, 10)}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  dashExportCsvBtn.addEventListener("click", () => {
    chrome.storage.local.get([STORAGE_KEY_HISTORY, STORAGE_KEY_PROFILES, STORAGE_KEY_SETTINGS], (res) => {
      const history = Array.isArray(res[STORAGE_KEY_HISTORY]) ? res[STORAGE_KEY_HISTORY] : [];
      const profiles = res[STORAGE_KEY_PROFILES] || {};
      const s = res[STORAGE_KEY_SETTINGS] || {};
      const minMs = (s.minClassMinutes > 0 ? s.minClassMinutes : 35) * 60 * 1000;
      const thisMonthPrefix = new Date().toISOString().slice(0, 7);
      if (history.length === 0) return;

      const chronological = [...history].reverse();
      const counts = {};
      const annotated = chronological.map((h) => {
        const code = h.meetingCode || "unknown";
        const prof = profiles[code] || {};
        const m = (h.startedAt || h.endedAt || "").slice(0, 7) || thisMonthPrefix;
        const initOff = (prof.offsetMonth || thisMonthPrefix) === m ? (parseInt(prof.initialClassOffset, 10) || 0) : 0;
        const qualified = h.isQualifiedClass !== undefined ? Boolean(h.isQualifiedClass) : (h.durationMs || 0) >= minMs;
        let classLabel = "Short (<35m)";
        if (qualified) {
          const key = `${code}_${m}`;
          counts[key] = (counts[key] || initOff) + 1;
          classLabel = `Class #${counts[key]}`;
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
          initialOffset: initOff,
          category: prof.category || h.category || "Tuition / Class"
        };
      }).reverse();

      const rows = [
        ["Meeting Code", "Class Name", "Students", "Typical Schedule", "Student Mails", "Fee / Rate", "Prior Offset (Mo)", "Category", "Qualification Status", "Monthly Class #", "Date", "Start Time", "End Time", "Duration (HH:MM:SS)", "Duration (Minutes)"],
        ...annotated.map((h) => [
          h.meetingCode,
          h.studentLabel,
          h.students,
          h.schedule,
          h.studentEmails,
          h.feeRate ? `$${h.feeRate}` : "-",
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
      const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `online-tuition-classes-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  renderDashboard();
})();

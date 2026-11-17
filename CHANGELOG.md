# Changelog

All notable changes to **Google Meet Tuition Companion** are documented in this file.

## [3.0.0] - 2026-11-18 — Major Enterprise & Business Release
### Added
- **Unified Cloud Auto-Sync (Google Drive + Google Sheets + Google Calendar)**:
  - Zero-config Google Apps Script coordinating Google Drive, Google Sheets, and Google Calendar via a single Web App URL.
  - **Google Drive Auto-Archive**: Automatic creation and management of `"Google Meet Tuition Companion Backups"` folder with rolling `tuition_database_latest.json` and daily timestamped snapshots.
  - **Google Sheets Two-Way Database**: Automated tab formatting for `Classrooms_Summary` (with fee rates, monthly billing calculations, student contacts, offset history) and `Class_Sessions_Log`.
  - **Google Calendar Automatic Event Logging**: Idempotent logging of qualified classes (≥35m) to primary Google Calendar with duration, student list, and Meet links.
  - **Live Cloud Hub UI**: Real-time status badge with one-click direct access pills: `[📂 Open Drive Backups ↗]`, `[📊 Open Google Sheet ↗]`, and `[📅 Open Google Calendar ↗]`.
  - **Periodic Background Auto-Sync**: Background alarms (15m, 30m, 60m, or on class end) with offline queueing and automatic retry upon network reconnection.
- **Business Tuition Management & Invoicing**:
  - Tuition fee / rate tracking per student/batch (`Fee Rate`, `Currency`, `Rate Type`).
  - Real-time **Estimated Monthly Billing** KPI in popup and dashboard.
  - Built-in **Tuition Statement & Invoice Generator**: Produce clean, itemized billing statements for any student/batch with date breakdown, duration, fee calculation, and total balance due.
  - WhatsApp & Parent Sharing: 1-click **Copy WhatsApp Summary** to send professional monthly reports directly to parents/students, plus print-friendly PDF view.
- **Reference Codebase Reconciliation**:
  - Full synchronization between GitHub repository and Chromium-verified reference bundle (`google_meet_timer_extension_2`).
  - High-resolution antialiased PNG icons (`16x16`, `48x48`, `128x128`) and full Manifest V3 compliance.

## [2.3.7] - 2026-11-18
### Fixed
- Fixed web-editor paste syntax error in `content.js`.
- Restored Material 3 flex layout and tab grid in popup.

## [2.3.0] - 2026-11-09 — Google Meet Tuition Companion Edition
### Added
- **Project Renamed to Google Meet Tuition Companion**: Updated branding across manifest, popup, full-screen dashboard, and documentation.
- **Custom Class Number Initialization (`This Class #` & `Prior Classes Offset`)**: Set which class number you are currently on for any classroom; auto-increments for the rest of the month and resets to `Class #1` each new calendar month.
- **External Database Sync (Google Sheets + Local `Documents` Folder + Chrome Cloud Sync)**:
  - Two-way Google Sheets Web App database sync with 1-click restore.
  - Direct `Documents` folder file save (`showSaveFilePicker`) and automatic background disk backup.
  - Automatic `chrome.storage.sync` cloud backup that auto-restores classrooms and settings on extension reinstall.

## [2.2.1] - 2026-11-08
### Added & Fixed
- **Classrooms Organizer Panel**: Dedicated sections for each Class Link, Class Name, Students list, Typical Schedule, and Student Mails.
- **1-Click Homework Mail Shortcut (`✉️`)**: Opens Gmail Compose pre-addressed to all students of a classroom with homework assignment and class details.
- **Presentation-Focused Dual-Audio Recorder (`.webm`)**: Auto-pins active presentations and mixes both your microphone and all remote participants' WebRTC audio streams with a live 4-bar VU meter on the pill.

## [2.1.0] - 2026-11-08
### Added
- **35-Minute Tuition Class Rule**: Calls reaching 35+ minutes are automatically promoted to an official Qualified Class (`🎓 Class #N ✓`).
- **1 Hour 10 Minute (`70m`) Warning Alert**: Visual red pill, in-call toast banner, 4-tone chime, and desktop notification at `01:10:00`.
- **Google Calendar Integration**: Auto-detects Calendar event titles from Meet, syncs completed classes to Google Calendar, and exports `.ics` files.

## [2.0.0] - 2026-11-08
### Added & Fixed
- **Browser Restart Auto-Activation**: Programmatic `chrome.scripting` injection on startup and tab restore.
- **Per-Meeting-Code Tuition Database & Full-Screen Dashboard (`dashboard.html`)**.

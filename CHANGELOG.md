# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog format, and this project adheres to Semantic Versioning.

## [1.0.1] - 2026-10-29

### Fixed
- Fixed call session persistence so active meeting duration is preserved across call leaves and rejoins within a 6-hour window instead of resetting.
- Fixed Google Meet active-call DOM detection to support google-symbols icons and prevent lobby/post-call false positives, and enabled widget re-mounting when SPA re-renders DOM.

## [1.0.0] - 2026-10-22

### Added
- Initial open-source release of Google Meet Call Timer Chrome Extension.
- Live, draggable HUD overlay timer displayed inside Google Meet calls.
- Meeting call history duration logging via Chrome extension popup interface.
- Complete Manifest V3 migration and compatibility support.
- MIT License, SVG preview screenshot asset, contributing guidelines, and comprehensive documentation.

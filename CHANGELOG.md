# Changelog

All notable changes to Codex Usage Bar will be documented in this file.

## 0.1.1

- Improve Visual Studio Marketplace categories and search keywords.

## 0.1.0

- Initial public release.
- Display Codex 5-hour and weekly quota windows in the VS Code status bar.
- Show progress bars, reset countdowns, warning colors, and used or remaining percentages.
- Read quota metadata through the official local `codex app-server` without reading credential files.
- Discover the standalone Codex CLI and the executable bundled with the official OpenAI extension.
- Support left or right alignment, optional far-left placement, and an optional provider label.
- Persist the latest successful quota snapshot and keep it visible during transient refresh failures.
- Add parser, fake app-server, and live smoke-test coverage.

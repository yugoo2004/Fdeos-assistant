# Changelog

All notable public product and engineering changes are recorded here.

## Initial Public Snapshot

### Added

- Added the FastAPI Gateway for local interview sessions, audio persistence, ASR orchestration, analysis, exports, and FDE OS bundle generation.
- Added the React/Vite workbench shell for MVP validation.
- Added main-control recording, full-session audio evidence review, transcript review, requirement analysis, PRD export, and FDE OS bundle export surfaces.
- Added FDE/customer display modes for dual-screen interview presentation.
- Added TTS/FDE question delivery controls, including next-question display, read/pause/resume/stop/skip actions, and auxiliary question-event logging.
- Added local-only ASR integration hooks for `sherpa-onnx`.
- Added FDE OS import adapter and migration documentation.

### Privacy Boundary

- Interview sessions, raw recordings, generated transcripts, generated PRDs, local templates, local models, logs, packaged artifacts, and local screenshots are intentionally excluded from Git.
- Scenario-specific templates and correction glossaries are expected to live in the local ignored `templates/` directory.

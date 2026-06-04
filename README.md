# FDE Interview Assistant

MVP prototype for a mac desktop-first FDE requirements interview assistant. The product direction is to internalize this capability into FDE OS as a project workflow node for customer interview, requirements analysis, PRD generation, evidence review, and downstream delivery tasks.

Current P0 scope:

- Local FastAPI Gateway
- Template registry
- Session creation and local persistence
- React/Vite workbench shell
- Browser mic recording to `data/sessions/<session_id>/audio/raw.wav`
- Offline ASR to `transcript.json` through local `sherpa-onnx`

Confirmed MVP decisions:

- First client: mac desktop app
- Voice output: required
- LLM: API provider
- Raw recording: saved
- Export: Markdown first
- Product direction: internalize into FDE OS business workflows

## Run P0

Start both services with one command:

```bash
./scripts/start-demo.sh
```

It builds the workbench and serves the preview at `http://127.0.0.1:5173/`. Local templates and interview sessions are intentionally not committed to this repository.

Start the Gateway:

```bash
./scripts/start-gateway.sh
```

Start the web workbench shell:

```bash
cd desktop
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Local Data Boundary

This repository contains the platform code, integration adapters, product documents, and configuration examples. It does not contain local business assets:

- interview sessions and audio recordings under `data/`
- exported requirements analysis or PRD artifacts generated from real interviews
- local ASR models under `models/`
- local business / industry templates under `templates/`
- local logs, screenshots, Playwright captures, and packaged app artifacts

To run a real workflow, create a local `templates/` directory with your private scenario YAML files and record sessions into the local `data/` directory.
If `FDE_DEMO_SESSION_ID` points to an existing local session, the app treats it as read-only: viewing and Markdown export remain enabled, while recording, ASR regeneration, correction saves, and analysis reruns require creating a new session first.
The workbench also includes a presentation mode panel that keeps status, PRD summary, export, customer-facing content, and FDE-only follow-up questions visible in one screen.
Dedicated presentation windows are available with `?view=customer` and `?view=fde`; both side displays read the same `STANDBY` / `ON AIR` / `PROCESSING` status from the active session and show prominent side rails, while the customer view hides FDE-only prompts.

## FDE OS Bundle

The MVP can export a machine-readable FDE OS bundle for the later Electron integration path:

```text
GET  /api/sessions/{session_id}/fde-os/bundle
GET  /api/sessions/{session_id}/fde-os/bundle/validation
POST /api/sessions/{session_id}/exports/fde-os-bundle
GET  /api/sessions/{session_id}/exports/fde-os-bundle
GET  /api/sessions/{session_id}/fde-os/store-patch
POST /api/sessions/{session_id}/exports/fde-os-store-patch
GET  /api/sessions/{session_id}/exports/fde-os-store-patch
```

The validation endpoint returns `ready`, `review_required`, or `blocked`. Use `blocked` to stop import into FDE OS, and turn `review_required` warnings into project QA tasks.

The store patch endpoint emits `fde_os_interview_import_patch.v1`, a preview of the JSON objects that FDE OS `src/main/store.js` should upsert. It includes project QA tasks for unconfirmed evidence and pending transcript corrections.

A runnable reference importer is available:

```bash
node integrations/fde-os/import-interview-bundle.mjs \
  data/sessions/<session_id>/exports/fde_os_bundle.json \
  --out data/sessions/<session_id>/exports/fde_os_store_patch.preview.json
```

## Local ASR

Speech-to-text is local-only in this product. The Gateway does not call Ark, OpenAI, or any other external ASR service for transcription. External LLM providers are only allowed to enhance requirement analysis after local transcription and local correction have already produced usable artifacts.

The current local ASR model is:

```text
models/asr/sherpa-onnx-streaming-paraformer-bilingual-zh-en
```

The Gateway reads `SHERPA_ONNX_MODEL_DIR`. If the variable is not set, `scripts/start-gateway.sh` uses the model above. The model is a local `sherpa-onnx` streaming paraformer bilingual Chinese/English package and is used by:

```text
POST /api/sessions/{session_id}/asr/offline
GET  /api/sessions/{session_id}/transcript
```

Long recordings are split locally before ASR. The default chunking target is 20-35 seconds per transcript turn, using local energy-based silence detection. Tunables:

```bash
export FDE_ASR_MIN_SEGMENT_MS=20000
export FDE_ASR_MAX_SEGMENT_MS=35000
export FDE_ASR_SPLIT_SILENCE_MS=700
```

Context-aware transcript correction is also local-first:

```text
POST /api/sessions/{session_id}/transcript/normalize
GET  /api/sessions/{session_id}/transcript/corrected
PUT  /api/sessions/{session_id}/transcript/corrected
```

The corrected transcript is saved as `data/sessions/<session_id>/corrected_transcript.json` and is the preferred input for downstream requirement analysis.

Scenario-specific correction rules live in local template YAML files under `glossary`, for example:

```yaml
glossary:
  wrong_term: corrected_term
```

## LLM Analysis

The Gateway can extract structured requirements from `transcript.json`:

```text
POST /api/sessions/{session_id}/analysis/extract
GET  /api/sessions/{session_id}/requirements
GET  /api/sessions/{session_id}/risks
GET  /api/sessions/{session_id}/open-questions
```

Configure an OpenAI-compatible LLM provider with:

```bash
export FDE_LLM_API_KEY=...
export FDE_LLM_BASE_URL=https://api.openai.com/v1
export FDE_LLM_MODEL=gpt-4.1-mini
```

If `FDE_LLM_API_KEY` is not set, the Gateway uses a local fallback generator based on the selected scenario template. That keeps the MVP workflow usable while API credentials are not configured.

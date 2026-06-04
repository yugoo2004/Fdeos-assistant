# FDE OS Import Adapter

This folder contains a runnable reference adapter for importing `fde_os_bundle.json` into the future FDE OS Electron JSON store.

It is intentionally plain Node.js ESM with no external dependencies, so the code can be moved into the FDE OS main-process layer near `src/main/store.js`.

## Run

```bash
node integrations/fde-os/import-interview-bundle.mjs \
  data/sessions/<session_id>/exports/fde_os_bundle.json \
  --out data/sessions/<session_id>/exports/fde_os_store_patch.preview.json
```

Optional:

```bash
node integrations/fde-os/import-interview-bundle.mjs <bundle> --project-id project:example
node integrations/fde-os/import-interview-bundle.mjs <bundle> --strict-ready
```

The Gateway can also build the same patch directly:

```text
GET  /api/sessions/{session_id}/fde-os/store-patch
POST /api/sessions/{session_id}/exports/fde-os-store-patch
GET  /api/sessions/{session_id}/exports/fde-os-store-patch
```

## Output

The adapter emits `fde_os_interview_import_patch.v1`. Its `store_patch` contains:

- `interviewSessions`
- `audioEvidence`
- `transcripts`
- `transcriptSegments`
- `transcriptCorrectionSuggestions`
- `requirements`
- `requirementEvidenceRefs`
- `risks`
- `openQuestions`
- `prdArtifacts`
- `importWarnings`

It also emits `qa_tasks` for:

- bundle warnings
- requirements without confirmed evidence
- pending transcript correction suggestions

## Import Rule

- `ready`: import normally.
- `review_required`: import, then show `qa_tasks` in FDE OS project QA.
- `blocked`: do not import unless a developer explicitly passes `--allow-blocked` for diagnostics.

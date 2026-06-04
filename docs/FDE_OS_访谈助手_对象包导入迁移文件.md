# FDE OS 访谈助手对象包导入迁移文件

## 1. 迁移目标

把 `fde-interview-assistant` MVP 产出的 `fde_os_bundle.json` 导入 FDE OS Electron 应用，形成 FDE OS 项目内的正式业务对象。

目标不是把当前 React/Vite workbench 搬进 FDE OS，而是把已验证的业务能力接入 FDE OS 现有结构:

- 主进程: `src/main.js`
- Renderer: `src/renderer/index.html`、`src/renderer/app.js`
- 本地 JSON store: `src/main/store.js`
- 打包脚本: `scripts/package-macos.mjs`

## 2. 对象包来源

MVP Gateway 已提供:

- 预览: `GET /api/sessions/{session_id}/fde-os/bundle`
- 校验: `GET /api/sessions/{session_id}/fde-os/bundle/validation`
- 导出: `POST /api/sessions/{session_id}/exports/fde-os-bundle`
- 下载: `GET /api/sessions/{session_id}/exports/fde-os-bundle`
- 落库补丁预览: `GET /api/sessions/{session_id}/fde-os/store-patch`
- 落库补丁导出: `POST /api/sessions/{session_id}/exports/fde-os-store-patch`
- 落库补丁下载: `GET /api/sessions/{session_id}/exports/fde-os-store-patch`

文件位置:

```text
data/sessions/{session_id}/exports/fde_os_bundle.json
data/sessions/{session_id}/exports/fde_os_store_patch.preview.json
```

当前 schema:

```text
schema_version = fde_interview_bundle.v1
integration_target = fde-os-electron
store_patch_schema_version = fde_os_interview_import_patch.v1
```

## 3. 导入前置校验

FDE OS 导入器必须先检查对象包校验结果。建议规则:

- `readiness_label = ready`: 允许导入，并标记为可进入研发任务流。
- `readiness_label = review_required`: 允许导入，但把 warning 写入项目质检待办。
- `readiness_label = blocked`: 禁止导入，提示 FDE 先回到访谈助手补齐阻塞项。

阻塞项通常包括:

- schema 或 target 不匹配。
- 缺少整段录音 `raw.wav`。
- 录音缺少 SHA256。
- 缺少需求分析或 PRD Markdown artifact。
- 对象 ID 重复。
- 对象包疑似包含 API key 或访问令牌。

提醒项通常包括:

- 仍有待确认错词。
- 需求证据未全部绑定录音片段。
- 需求证据尚未人工确认。
- 当前分析仍是本地草稿。

## 4. Store 对象建议

`src/main/store.js` 建议新增或扩展以下集合:

```js
{
  interviewSessions: [],
  audioEvidence: [],
  transcripts: [],
  transcriptSegments: [],
  transcriptCorrectionSuggestions: [],
  requirements: [],
  requirementEvidenceRefs: [],
  risks: [],
  openQuestions: [],
  prdArtifacts: [],
  importWarnings: [],
  qa_tasks: []
}
```

MVP 仓库已提供可运行的参考导入器:

```bash
node integrations/fde-os/import-interview-bundle.mjs \
  data/sessions/<session_id>/exports/fde_os_bundle.json \
  --out data/sessions/<session_id>/exports/fde_os_store_patch.preview.json
```

该参考导入器会输出 `fde_os_interview_import_patch.v1`，包含 `store_patch` 和 `qa_tasks`。Gateway 也已经提供同 schema 的落库补丁 API。FDE OS 仓库落地时，可以把其中的映射逻辑迁移到 `src/main/store.js`，把 CLI 入口或 Gateway 入口替换为 Electron IPC。

导入器入口建议:

```js
async function importInterviewBundle(bundle, options = {}) {
  validateInterviewBundle(bundle)
  const now = new Date().toISOString()
  const projectId = options.projectId || createProjectFromBundle(bundle)
  const sessionObjectId = `interview:${bundle.session.id}`

  upsertInterviewSession(projectId, bundle.session, bundle.template, now)
  upsertAudioEvidence(projectId, bundle.audio, bundle.artifacts, now)
  upsertTranscript(projectId, bundle.transcript, bundle.corrected_transcript, now)
  upsertTranscriptSegments(projectId, bundle.transcript_segments, now)
  upsertCorrectionSuggestions(projectId, bundle.correction_suggestions, now)
  upsertRequirements(projectId, bundle.requirements, now)
  upsertRisks(projectId, bundle.risks, now)
  upsertOpenQuestions(projectId, bundle.open_questions, now)
  upsertPrdArtifacts(projectId, bundle.artifacts, bundle.analysis, now)

  return { projectId, sessionObjectId }
}
```

写入规则:

- `raw.wav` 不写入 JSON，只保存路径、文件名、时长、采样率、声道、大小和 SHA256。
- 需求证据 `evidence_refs` 拆入 `requirementEvidenceRefs`，保留 `start_ms`、`end_ms`、`transcript_segment_id`、`review_status`。
- `review_status = confirmed` 的需求证据可进入研发任务默认候选。
- 未确认、低置信、需重定位、待纠错的内容进入项目质检待办。
- `prd.markdown` 和 `requirements_analysis.markdown` 写入 `prdArtifacts`，保留文件路径，不复制内容也可。
- 当前参考导入器会把 `review_required` 中的 warning、未确认需求证据、待确认错词转换为 `qa_tasks`。
- `fde_os_store_patch.preview.json` 是导入前预览和调试文件，不应替代 FDE OS 内部 store 的正式写入事务。

## 5. IPC 建议

`src/main.js` 建议新增 IPC:

```text
interview:bundle:validate
interview:bundle:import
interview:storePatch:preview
interview:storePatch:apply
interview:session:list
interview:session:get
interview:audio:open
interview:audio:verifyHash
interview:requirement:updateEvidenceReview
interview:artifact:open
```

主进程职责:

- 读取本地对象包文件。
- 调用 store 导入器。
- 做路径安全检查，禁止导入目录外任意文件引用。
- 对 `raw.wav` 重新计算 SHA256，与 bundle 内记录比对。
- 把导入结果和 warning 返回 renderer。

Renderer 职责:

- 显示导入前校验状态。
- 展示导入后的访谈、录音、需求项、PRD artifact。
- 将 warning 展示为项目质检待办。
- 不直接读取任意本地路径。

## 6. Renderer 最小视图

FDE OS 内嵌后的最小视图应包含:

- 项目顶部: 当前客户、项目、访谈 session、分析质量、对象包状态。
- 录音证据: 播放、暂停、时长、文件大小、SHA256、打开文件。
- 需求列表: 标题、优先级、模块、证据状态、是否可进入研发任务。
- 当前需求详情: 描述、用户故事、业务规则、验收标准、证据片段。
- 质检待办: 待确认错词、未确认需求证据、需重定位证据、fallback 分析。
- Artifact: 需求分析 Markdown、PRD Markdown、对象包 JSON。

## 7. 打包注意事项

`scripts/package-macos.mjs` 后续需要确认:

- gateway sidecar 是否随 FDE OS 包分发。
- sherpa-onnx 模型目录是否随包分发或首次启动下载。
- 模板 YAML 是否进入 app resource。
- macOS 麦克风权限说明是否完整。
- 多窗口客户屏/FDE 屏是否使用 Electron display ID 和 bounds 恢复。
- 导入对象包时是否能访问 `raw.wav` 原路径；若不能，需要复制到 FDE OS 项目数据目录。

## 8. 验收标准

- FDE OS 可选择一个 `fde_os_bundle.json` 并完成校验。
- FDE OS 可读取 `fde_os_store_patch.preview.json` 或通过同 schema 生成 store patch 预览。
- blocked 对象包不能导入。
- review_required 对象包导入后生成项目质检待办。
- ready 对象包导入后生成访谈 session、整段录音证据、需求项、PRD artifact。
- 录音 SHA256 可重新校验。
- 需求项能播放对应证据片段。
- 已确认需求证据可进入后续研发任务候选。
- FDE OS 打包后不依赖 Vite dev server。

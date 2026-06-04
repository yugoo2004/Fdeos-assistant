# FDE OS Electron 内嵌适配方案

## 1. 目标

把当前 FDE 需求访谈助手 MVP 迁入 FDE OS 桌面端，成为项目工作台内的需求访谈模块。当前 MVP 的 React/Vite 页面只作为验证壳，迁移时应保留业务能力、数据模型和本地网关能力，不把 React 作为 FDE OS renderer 的新依赖。

FDE OS 当前结构:

- 主进程: `src/main.js`
- 渲染层: `src/renderer/index.html`、`src/renderer/app.js`
- 本地 JSON store: `src/main/store.js`
- macOS 打包: `scripts/package-macos.mjs`

## 2. MVP 可迁移能力

- 本地 session、客户、项目和模板元数据。
- 整段访谈录音 `raw.wav`、时长、SHA256、采样率。
- 本地 sherpa-onnx ASR 转写。
- 转写分段、说话人标注、片段边界编辑。
- 转写纠错建议和人工确认状态。
- 需求分析、风险、未决问题、PRD 摘要。
- 需求项证据定位、raw.wav 片段播放、复核状态。
- 客户屏 / FDE 屏 / ON AIR 双屏模式。
- Markdown 导出和 FDE OS 对象包导出。

## 3. 新增对象包

MVP 已提供机器可读对象包:

- 预览: `GET /api/sessions/{session_id}/fde-os/bundle`
- 校验: `GET /api/sessions/{session_id}/fde-os/bundle/validation`
- 导出: `POST /api/sessions/{session_id}/exports/fde-os-bundle`
- 下载: `GET /api/sessions/{session_id}/exports/fde-os-bundle`
- 落库补丁预览: `GET /api/sessions/{session_id}/fde-os/store-patch`
- 落库补丁导出: `POST /api/sessions/{session_id}/exports/fde-os-store-patch`
- 落库补丁下载: `GET /api/sessions/{session_id}/exports/fde-os-store-patch`
- 文件: `data/sessions/{session_id}/exports/fde_os_bundle.json`
- 落库补丁文件: `data/sessions/{session_id}/exports/fde_os_store_patch.preview.json`

对象包 `schema_version` 为 `fde_interview_bundle.v1`，包含:

- `session`
- `template`
- `audio`
- `transcript`
- `transcript_segments`
- `corrected_transcript`
- `correction_suggestions`
- `analysis`
- `requirements`
- `risks`
- `open_questions`
- `agent_question_events`
- `artifacts`
- `fde_os_objects`

对象包校验返回:

- `readiness_label = ready`: 可导入 FDE OS。
- `readiness_label = review_required`: 可导入，但 warning 应进入项目质检待办。
- `readiness_label = blocked`: 不允许导入，需回到访谈助手补齐阻塞项。

`fde_os_objects` 是给 `src/main/store.js` 的初始映射层，包含:

- `InterviewSession`
- `AudioEvidence`
- `RequirementItem`
- `Risk`
- `OpenQuestion`
- `Artifact`

落库补丁 `fde_os_interview_import_patch.v1` 是更接近 FDE OS store 的写入预览，包含 `store_patch` 和 `qa_tasks`。FDE OS 可以先复用该 schema 做导入预览，再在 `src/main/store.js` 内实现正式 upsert。

## 4. 主进程适配

`src/main.js` 需要负责:

- 启动和监控本地 gateway sidecar。
- 检查 sherpa-onnx 模型路径和可用性。
- 提供 IPC:
  - 创建访谈
  - 开始 / 停止 / 放弃录音
  - 运行本地 ASR
  - 扫描纠错建议
  - 抽取分析
  - 导出 PRD / FDE OS 对象包
  - 预览 / 导入 FDE OS 落库补丁
  - 打开 FDE 屏 / 客户屏窗口
- 处理本地文件路径、录音文件打开和诊断包收集。

建议先保留 FastAPI gateway 作为 sidecar，主进程只做生命周期管理。等 FDE OS 内嵌稳定后，再评估是否把部分 API 改写为 Node service。

## 5. Renderer 适配

`src/renderer/app.js` 需要实现三个视图:

- 主控屏: 录音、ASR、纠错、分析、导出、复核。
- FDE 私有屏: 补问、风险、纠错建议、发问模式、转写片段。
- 客户屏: ON AIR、项目共识、核心模块、成功指标。

迁移原则:

- 复用 FDE OS 现有原生 HTML/CSS/JS 风格。
- 不新增 React/Vue runtime 作为硬依赖。
- 将当前 React state 拆成可序列化 view model，由 IPC 或 store 推送更新。
- 主控屏优先聚焦当前访谈，不恢复旧的“大最近访谈列表”。

## 6. Store 适配

`src/main/store.js` 应新增或扩展以下对象:

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
- `qa_tasks`

建议 store 写入规则:

- `raw.wav` 不内嵌到 JSON，只保存路径、哈希和元数据。
- `transcript_correction_suggestions` 保留 `pending`、`auto_applied`、`applied`、`ignored` 状态。
- 需求项只有证据状态为 `confirmed` 时，才进入后续研发任务的默认候选。
- 低置信证据和待确认错词进入 FDE OS 项目质检待办。

## 7. 打包适配

`scripts/package-macos.mjs` 需要纳入:

- gateway sidecar 文件。
- Python/uv 运行依赖或打包后的可执行 gateway。
- sherpa-onnx 模型路径配置。
- 模板目录。
- 本地数据目录初始化。
- 麦克风权限说明。
- 多窗口和显示器布局配置迁移。

第一阶段建议不做完整二进制内嵌，先让 FDE OS 包内附带 sidecar 启动脚本和模型路径检查，降低打包风险。

## 8. 迁移顺序

1. 在 FDE OS 中新增 `InterviewSession` store 对象、对象包校验器和对象包导入器。
2. 主进程接入 gateway lifecycle 和 health check。
3. renderer 实现主控屏最小闭环: 选择项目、录音、ASR、纠错建议、导出对象包。
4. 接入需求分析、PRD、证据复核。
5. 接入 FDE 屏 / 客户屏多窗口。
6. 用 Electron 显示器 ID 替换浏览器 `localStorage` 副屏布局。
7. 接入 FDE OS 需求池和研发任务流。
8. 打包验证和诊断包输出。

## 9. 验收标准

- FDE OS 中可从项目打开需求访谈模块。
- 可完成一场访谈的录音、ASR、纠错建议、需求分析和 PRD 导出。
- `raw.wav` 可在项目对象中回放并校验 SHA256。
- 需求项可查看证据片段、复核状态和错词确认状态。
- 客户屏不暴露 FDE 私有补问。
- FDE OS 打包后不依赖开发环境的 Vite 服务。
- `fde_os_bundle.json` 能被 `src/main/store.js` 导入并生成项目对象。

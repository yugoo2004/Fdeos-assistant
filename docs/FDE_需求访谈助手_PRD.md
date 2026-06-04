# FDE 需求访谈助手 PRD

## 1. 文档信息

- 产品名称: FDE 需求访谈助手
- 目标形态: mac 桌面端优先，并内化为 FDE OS 的需求访谈业务流程能力
- 当前版本: MVP P0
- 最近同步: 2026-05-25
- 默认演示场景: 由本地模板配置提供
- 默认演示 session: 由本地 `FDE_DEMO_SESSION_ID` 指定
- FDE OS 集成目标: 作为现有 Electron 桌面端模块接入，主进程对接 `src/main.js`，渲染层对接原生 `src/renderer/index.html` / `src/renderer/app.js`，本地对象持久化对接 `src/main/store.js`，打包复用 `scripts/package-macos.mjs`。

## 2. 产品定位

FDE 需求访谈助手是面向前沿部署工程师的实时语音访谈与需求分析能力。它不是长期独立存在的单点工具，而应内化到 FDE OS 的项目交付流程中，成为“客户访谈 -> 需求分析 -> PRD -> 研发任务/交付对象”的业务工作流节点。它在客户访谈现场保存整段录音，使用本地 ASR 转写和场景模板纠错，辅助 FDE 挖掘需求、形成结构化需求分析和 PRD，并支持事后复核需求来源。

## 3. 核心用户

- FDE 前沿部署工程师: 主持或旁听客户访谈，控制录音、查看补问、导出交付物。
- 客户/业务负责人: 在客户屏看到访谈共识、核心模块和成功指标，不暴露 FDE 私有补问。
- 交付/研发团队: 根据需求分析和 PRD 进入方案设计、排期和开发。
- 项目负责人: 事后复核需求来源、录音证据和交付物质量。

## 4. 已确认产品决策

- 第一版客户端做 mac 桌面端优先。
- 第一版需要语音输出能力。
- LLM 分析使用 API provider。
- ASR 转写必须本地实现，不依赖外部 ASR。
- 原始录音必须保存。
- 导出格式先做 Markdown。
- 审计口径以整段访谈录音为主，不做逐句实时审计。
- TTS 发问和 FDE 本人发问都要支持，可由现场切换。
- 该能力要内化到 FDE OS 业务流程中，作为项目/客户/需求对象的工作流环节。
- FDE OS 现有桌面端是 Electron + 原生 HTML/CSS/JavaScript，不是 Tauri、SwiftUI、React 或 Vue；当前浏览器/React MVP 只是能力验证壳，后续迁移时应抽取业务 API、数据模型和 UI 状态，而不是把 React 壳整体嵌入。

## 5. MVP 范围

### 5.1 P0 已纳入

- 本地 session 创建与持久化。
- 浏览器麦克风录制整段 `raw.wav`。
- 本地 `sherpa-onnx` 离线 ASR。
- 场景模板与本地术语纠错。
- 人工校对转写稿。
- 结构化需求分析抽取。
- 需求分析 Markdown 导出。
- PRD Markdown 导出。
- FDE OS 对象包 `fde_os_bundle.json` 导出与导入前校验。
- 本地场景模板加载能力。
- 本地只读演示 session 支持。
- 客户屏与 FDE 私有屏双屏展示。
- 大型 `ON AIR` 左右侧栏。
- TTS/FDE 发问方式开关。
- FDE 私有补问、风险提醒、发问记录。
- 整段访谈录音复核视图。
- 需求条目与访谈依据同屏复核。
- FDE OS 业务对象集成设计: session、录音、转写、需求项、PRD 都应可成为 FDE OS 项目工作台中的对象。

### 5.2 P0 不做

- Word/PDF 导出。
- 多人说话人分离。
- 真正流式实时转写。
- 逐句审计。
- 团队权限与账号系统。
- 云端协同。
- Electron 桌面端系统音频确定性混入。

## 6. 功能模块

### 6.1 访谈工作区

- 展示当前项目、客户、模板和 session。
- 支持从只读演示 session 创建可录音副本。
- 将“最近访谈”压缩为工作区选择器，避免占用主控屏主要空间。

### 6.2 整段录音证据

- 开始/结束访谈录音。
- 保存 `data/sessions/<session_id>/audio/raw.wav`。
- 显示文件名、大小、时长、采样率、更新时间和 SHA256。
- 支持播放、暂停、打开原始文件。
- 整段 `raw.wav` 是事后复核主证据，用于复原双方访谈内容。

### 6.3 本地 ASR 与转写校对

- 使用本地 `sherpa-onnx` 生成 `transcript.json`。
- 长录音支持本地 VAD 分段。
- 按模板 glossary 做术语纠错。
- 在证据覆盖和复核过程中扫描转写稿，生成错词建议清单。
- 高置信错词可自动进入校对稿，低置信候选必须等待 FDE 确认或忽略。
- 支持人工校对保存到 `corrected_transcript.json`。
- 保存 `transcript_correction_suggestions.json`，记录原词、建议词、出现次数、证据片段、置信度、来源和状态。
- 下游分析优先使用校对稿。

### 6.4 需求分析与 PRD 导出

- 从转写或校对稿抽取 PRD 摘要、功能模块、需求项、风险和未决问题。
- 支持 API LLM 增强；API 失败时保留本地 fallback 可用结果。
- 分开导出“需求分析”和“PRD”两个 Markdown 文件。

### 6.5 双屏演示

- 主控屏: FDE 操作录音、转写、分析、导出和复核。
- 客户屏: 只展示客户可确认共识、核心模块、成功指标和交付状态。
- FDE 屏: 展示补问、风险、转写校对稿、发问记录。
- 客户/FDE 屏保留醒目的左右 `ON AIR` 状态侧栏。
- MVP 阶段以手动副屏校准为主: 主控屏打开 FDE 屏和客户屏两个桌面窗口，FDE 手动拖到双面外接屏对应方向后保存本机布局。
- 支持交换 FDE/客户显示角色，避免现场把窗口拖反后客户看到 FDE 私有补问。

### 6.6 发问方式

- 支持 `TTS 发问` 和 `FDE 本人发问` 两种模式。
- TTS 模式使用浏览器本地 `speechSynthesis` 朗读补问。
- FDE 模式由 FDE 本人发问，并可标记已问。
- 主控录音区显示下一问，支持朗读、暂停、继续、停止、跳过。
- 开始录音后可自动朗读第一问；若还没有分析补问，则使用当前场景模板的必问问题开场。
- 发问记录只作为辅助时间线，不替代整段录音证据。
- 浏览器 MVP 中 TTS 是否进入录音取决于外放、麦克风和回声消除；FDE OS Electron 桌面端可做系统音频混入。

### 6.7 访谈复核

- 同屏展示整段录音、SHA256、转写校对稿、需求列表和当前需求依据。
- 点击需求项后显示该需求的描述、访谈依据和验收标准。
- 当前复核粒度是“需求项 -> 访谈依据文本 -> 整段录音”。
- 下一步升级为“需求项 -> 转写片段 -> raw.wav 时间点 -> 一键播放”。

### 6.8 FDE OS 业务流程内化

- 访谈 session 应挂接到 FDE OS 的项目、客户、现场任务或交付对象。
- 录音、转写、纠错稿、需求项、风险、未决问题、PRD 都应作为项目对象沉淀。
- 访谈完成后，需求项可进入 FDE OS 的研发任务、方案设计、报价评估或实施计划流程。
- 复核视图可作为 FDE OS 项目质检、交付复盘和需求变更追踪入口。
- 客户屏/FDE 屏可作为 FDE OS 桌面端的多窗口/外接屏工作模式。
- FDE OS 嵌入方式:
  - Electron 主进程负责启动/监控本地 ASR、LLM gateway 或后续 Node sidecar。
  - 原生渲染层负责主控屏、FDE 屏、客户屏的视图状态，不新增 React/Vue 运行时作为硬依赖。
  - `src/main/store.js` 负责把访谈 session、录音证据、转写、纠错建议、需求项和 PRD artifact 映射为 FDE OS 本地 JSON 对象。
  - macOS 打包继续复用现有 Electron runtime 和 `scripts/package-macos.mjs`。

### 6.9 FDE OS 对象包导出

- 提供机器可读 `fde_os_bundle.json`，用于 FDE OS `src/main/store.js` 导入或后续打包迁移。
- 对象包包含 session、template、audio、transcript、transcript_segments、corrected_transcript、correction_suggestions、analysis、requirements、risks、open_questions、agent_question_events、artifacts 和 fde_os_objects。
- `fde_os_objects` 提供 InterviewSession、AudioEvidence、RequirementItem、Risk、OpenQuestion、Artifact 的初始对象映射。
- 提供对象包校验 API，输出 `ready`、`review_required`、`blocked` 三种导入状态。
- `review_required` 应在 FDE OS 中变成项目质检待办；`blocked` 不允许导入。

### 6.10 FDE OS 落库补丁导出

- 提供 `fde_os_store_patch.preview.json`，用于预览 FDE OS `src/main/store.js` 将要 upsert 的对象集合。
- 落库补丁 schema 为 `fde_os_interview_import_patch.v1`，包含 `store_patch`、`qa_tasks`、导入校验结果和来源 bundle 信息。
- `qa_tasks` 应覆盖对象包 warning、未确认需求证据、待确认错词，导入 FDE OS 后进入项目质检待办。
- 当前补丁是导入前预览和迁移契约，正式写入事务仍应在 FDE OS 仓库的 `src/main/store.js` 实现。

## 7. 关键需求

### REQ-FDE-001 整段录音保存与回放

- 优先级: P0 must
- 描述: 系统必须保存整段访谈录音，并支持在复核视图回放。
- 验收:
  - 结束录音后生成 `raw.wav`。
  - 页面展示录音时长、大小、采样率和 SHA256。
  - 用户可播放、暂停并打开原始文件。
  - 开始录音时有声音提示并朗读“开始录音”。
  - 录音中可选择“放弃不保存”，不写入本次 raw.wav。
  - 不需要的可写访谈 session 可删除；只读 demo 不允许删除。

### REQ-FDE-002 本地 ASR

- 优先级: P0 must
- 描述: 录音转写必须在本地完成。
- 验收:
  - `/api/health` 显示 local-only ASR ready。
  - 转写不调用外部 ASR 服务。
  - 生成 `transcript.json`。

### REQ-FDE-002A ASR 源头分段与说话人边界

- 优先级: P0 should
- 描述: 系统应把长录音拆成可复核的 turn/segment，并允许 FDE 标注 FDE、客户、AI 或未知说话人。
- 当前状态: 已把本地 VAD 默认切片调整到 8-18 秒，并支持在转写 turn 和复核 segment 上人工标注说话人；还没有自动说话人分离。
- 验收:
  - ASR 完成后生成多条带时间范围的 turn。
  - `transcript_segments.json` 在 ASR 保存后立即落地。
  - FDE 可修改 turn 或 segment 的说话人标注。
  - 已标注的 segment 在分段重建后尽量保留。

### REQ-FDE-003 术语纠错与校对

- 优先级: P0 must
- 描述: 系统应根据场景模板修正常见 ASR 错词，并允许人工校对。
- 验收:
  - 模板 glossary 能修正“生屠 -> 生图”等领域错词。
  - 人工保存后分析优先使用校对稿。

### REQ-FDE-003A 转写纠错建议与人工确认

- 优先级: P0 should
- 描述: 证据覆盖时，Agent 应顺读转写访谈稿，列出更多需要纠正的词语，并区分自动纠正和待人工确认。
- 当前状态: 已新增 `transcript_correction_suggestions.json` 和复核 UI；安全词可自动应用，疑似词保留为待确认。
- 验收:
  - 系统能列出原词、建议词、出现次数、置信度、来源和出现片段。
  - `glossary` 或高置信领域规则可自动应用到校对稿。
  - 低置信候选必须显示为 `待确认`，FDE 可选择应用或忽略。
  - 自动应用、人工应用、忽略状态都要保存，不能伪装为已人工确认。
  - 人工校对稿不被后续自动扫描覆盖。

### REQ-FDE-004 需求分析导出

- 优先级: P0 must
- 描述: 系统应生成结构化需求分析 Markdown。
- 验收:
  - 导出包含 PRD 摘要、需求项、风险、未决问题和访谈转写。

### REQ-FDE-005 PRD 导出

- 优先级: P0 must
- 描述: 系统应生成面向研发交付的 PRD Markdown。
- 验收:
  - PRD 包含产品概述、范围、用户旅程、功能模块、详细需求、风险和待确认问题。

### REQ-FDE-006 双屏展示

- 优先级: P0 should
- 描述: 系统应支持客户屏和 FDE 私有屏。
- 验收:
  - 客户屏不显示 FDE 私有补问。
  - FDE 屏显示补问、风险、转写校对稿和发问记录。
  - 两个屏都保留 `ON AIR` 状态提示。

### REQ-FDE-006A 副屏 MVP 校准

- 优先级: P0 should
- 描述: MVP 阶段不自动猜测物理屏朝向，采用人工校准和本机偏好保存。
- 验收:
  - 主控屏提供“打开 FDE 屏”“打开客户屏”“进入校准模式”“交换 FDE/客户屏”“保存布局”。
  - 校准模式下两个副屏窗口显示醒目的 `FDE 私有屏` / `客户共识屏` 标识。
  - 交换后两个已打开副屏窗口的显示角色同步切换。
  - 保存布局后记录本机副屏偏好和窗口位置，后续再次打开时优先恢复。
  - 浏览器 MVP 只保存窗口位置和角色偏好；mac 桌面端后续用原生窗口管理和显示器 ID 替代。

### REQ-FDE-007 发问方式切换

- 优先级: P0 should
- 描述: FDE 可选择 TTS 发问或本人发问。
- 验收:
  - FDE 屏有 `TTS` / `FDE` 开关。
  - TTS 模式可在 FDE 屏和主控录音区朗读下一问。
  - FDE 模式可标记已问。
  - 主控录音区同步显示当前发问方式、下一问、自动开场朗读开关和跳过入口。

### REQ-FDE-008 访谈复核视图

- 优先级: P0 should
- 描述: 系统应支持事后复核需求来源。
- 验收:
  - 复核视图同屏显示整段录音、转写时间片段和需求依据。
  - 点击需求项后切换当前复核项。
  - 当前需求显示访谈依据、证据片段、验收标准和复核状态。
  - FDE 可将证据标记为 `未复核` / `已确认` / `需重定位`，并写入复核备注。

### REQ-FDE-009 证据定位

- 优先级: P1 must
- 描述: 系统应支持从需求项定位到相关转写片段和 raw.wav 时间点。
- 当前状态: 已实现第一版自动定位和人工复核状态，需求项可生成 `evidence_refs`，复核视图可跳转播放对应 raw.wav 片段，导出文档可写入证据时间点、片段 ID 和复核状态。
- 验收:
  - 需求项可关联一个或多个转写片段。
  - 每个片段有开始/结束时间。
  - 点击“播放此处”后音频跳到对应时间点。
  - 每条证据可保存复核状态和备注。
  - FDE 可从转写片段列表中选择新片段，并人工覆盖当前需求的证据定位。

### REQ-FDE-009A 转写片段边界编辑

- 优先级: P1 should
- 描述: FDE 应能在复核时修正片段开始/结束时间、片段文本，并对片段执行拆分或合并。
- 当前状态: 已在复核视图支持选中片段后编辑开始/结束毫秒、文本、拆分点，并可与下一片段合并；同时支持播放当前边界和 500ms 快速微调。
- 验收:
  - 修改片段边界后保存为人工片段，不被后续普通刷新覆盖。
  - 拆分片段后原片段保留原 ID，新片段生成新 ID。
  - 合并片段后相邻两段变成一段，引用后一段的证据同步指向合并后片段。
  - 修改已有证据关联片段时，需求证据时间点和摘录同步更新。
  - FDE 可试听当前片段边界，并快速微调起点、终点和拆分点。

### REQ-FDE-010 FDE OS 项目对象挂接

- 优先级: P1 must
- 描述: 访谈能力应内化到 FDE OS 业务流程中，与项目、客户、需求、任务等对象关联。
- 验收:
  - 新建访谈时可关联 FDE OS 项目或客户对象。
  - 访谈产物可回写为 FDE OS 需求对象。
  - PRD 导出后可进入 FDE OS 的交付/研发任务流程。
  - 复核证据可在项目工作台中查看。
  - Electron 主进程、原生渲染层和 `src/main/store.js` 有明确集成边界。

### REQ-FDE-011 FDE OS 对象包导出

- 优先级: P1 must
- 描述: MVP 应能导出可供 FDE OS 导入的机器可读对象包。
- 当前状态: 已新增 `GET /api/sessions/{session_id}/fde-os/bundle`、`GET /api/sessions/{session_id}/fde-os/bundle/validation`、`POST /api/sessions/{session_id}/exports/fde-os-bundle` 和 `fde_os_bundle.json`。
- 验收:
  - 对象包包含访谈、录音证据、转写、纠错建议、需求项、PRD 和导出 artifact。
  - 对象包提供 `fde_os_objects` 映射，便于 `src/main/store.js` 落库。
  - 主控屏可一键导出 FDE OS 包。
  - 导出的包不包含 API key。

### REQ-FDE-011A FDE OS 对象包导入前校验

- 优先级: P1 must
- 描述: MVP 应在导入 FDE OS 前给出对象包结构与证据就绪度判断。
- 当前状态: 已新增对象包校验服务和主控屏对象包状态面板。
- 验收:
  - 校验返回 artifact、object、需求证据、已确认证据、错误和警告数量。
  - schema/target 不匹配、缺少 raw.wav、缺少 SHA256、缺少必需 artifact、重复 object_id 或疑似 secret token 时返回 `blocked`。
  - 未确认需求证据、待确认错词、本地 fallback 分析等返回 `review_required`。
  - 无阻塞和提醒时返回 `ready`。

### REQ-FDE-011B FDE OS 落库补丁导出

- 优先级: P1 must
- 描述: MVP 应能把对象包转换为 FDE OS JSON store 形态的落库补丁预览。
- 当前状态: 已新增 `GET /api/sessions/{session_id}/fde-os/store-patch`、`POST /api/sessions/{session_id}/exports/fde-os-store-patch`、`GET /api/sessions/{session_id}/exports/fde-os-store-patch` 和主控屏 `导出落库补丁` 入口。
- 验收:
  - 生成 `fde_os_store_patch.preview.json`，schema 为 `fde_os_interview_import_patch.v1`。
  - 补丁包含 `interviewSessions`、`audioEvidence`、`transcripts`、`transcriptSegments`、`transcriptCorrectionSuggestions`、`requirements`、`requirementEvidenceRefs`、`risks`、`openQuestions`、`prdArtifacts`、`importWarnings`。
  - 补丁包含可进入 FDE OS 项目质检待办的 `qa_tasks`。
  - 导出前复用对象包校验，`blocked` 不应作为正常导入候选。
  - 导出的补丁不包含 API key。

## 8. 数据与文件

- `session.json`: session 元数据。
- `audio/raw.wav`: 整段访谈录音证据。
- `transcript.json`: 本地 ASR 转写结果，包含 turn 时间范围和说话人标注。
- `transcript_segments.json`: 由 ASR 源头 turn 或校对稿生成的稳定时间片段，用于需求证据定位、说话人边界修正和复核。
- `corrected_transcript.json`: 校对稿。
- `transcript_correction_suggestions.json`: 转写纠错建议，包含候选错词、建议词、出现片段、置信度、来源和确认状态。
- `requirements.json`: 结构化需求项，`evidence_refs` 记录需求项关联的转写片段、raw.wav 时间点、证据摘录、匹配置信度、复核状态和复核备注。
- `risks.json`: 风险。
- `open_questions.json`: 未决问题。
- `agent_question_events.json`: 发问记录辅助时间线。
- `exports/fde_os_bundle.json`: FDE OS 对象包，供 Electron 主进程或 `src/main/store.js` 导入。
- `exports/fde_os_store_patch.preview.json`: FDE OS 落库补丁预览，供 Electron 主进程或 `src/main/store.js` 导入器调试。
- 对象包校验结果: 由 `GET /api/sessions/{session_id}/fde-os/bundle/validation` 动态生成，不单独落盘。
- 本机副屏布局偏好: MVP 暂存到浏览器 `localStorage`；mac 桌面端后续迁移为原生配置。
- `exports/requirements_analysis.md`: 需求分析导出。
- `exports/prd.md`: PRD 导出。
- FDE OS 对象映射:
  - Project / Customer
  - Interview Session
  - Audio Evidence
  - Transcript / Corrected Transcript
  - Requirement Item
  - Risk / Open Question
  - PRD Artifact

## 9. 成功指标

- FDE 可以在 1 分钟内创建访谈并开始录音。
- 录音结束后可生成可回放、可哈希校验的整段 `raw.wav`。
- 本地演示 session 可稳定导出需求分析和 PRD。
- 客户屏和 FDE 屏可在现场减少解释成本。
- FDE 能在 30 秒内完成双面外接屏手动校准并进入访谈状态。
- 至少 80% 的需求项具备可读的访谈依据。
- 至少 80% 的需求项可定位到转写片段和音频时间点。
- FDE 可在复核视图中完成需求证据确认或标记重定位。
- FDE 可在复核视图中处理转写纠错建议，关键术语进入 PRD 前有自动/人工状态记录。
- FDE OS 包可通过导入前校验，并被后续 Electron 集成会话直接导入生成项目工作台对象。
- FDE OS 落库补丁可直接展示将要写入的 store 对象和项目质检待办。
- 访谈产物可被 FDE OS 项目工作台检索、复核和推进到后续任务。

## 10. 当前风险

- 浏览器 MVP 录音不能保证系统 TTS 音频被确定性混入 `raw.wav`。
- 新增本地 VAD 源头切片和人工说话人标注，但还不是自动说话人分离；多人访谈仍需 FDE 复核 FDE/客户/AI 边界。
- 当前证据定位为自动匹配，低置信片段可先标记 `需重定位`，并由 FDE 人工选择正确转写片段覆盖定位。
- 没有多人说话人分离，客户/FDE 说话边界需要后续补强。
- API LLM 的稳定性和成本需要在真实项目中继续评估。
- 当前仍是独立浏览器/React MVP 形态，尚未接入 FDE OS Electron 主进程、原生渲染层、JSON store、项目对象、权限、任务流和对象画布。
- 浏览器 MVP 无法可靠识别外接屏物理朝向；副屏分配以人工校准和本机偏好保存解决。

## 11. 下一步

1. 在真实访谈样本上验证 8-18 秒 VAD 切片是否适合需求访谈节奏。
2. 在 FDE OS 仓库实现 `fde_os_interview_import_patch.v1` 的正式导入事务。
3. 将副屏 MVP 校准能力迁移到 Electron 多窗口和显示器 ID 管理。
4. 为 Electron 桌面端设计 TTS 系统音频混入方案。
5. 设计并实现 FDE OS 项目对象挂接和需求对象回写。
6. 扩展 Word/PDF 导出。

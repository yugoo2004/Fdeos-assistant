# FDE 需求访谈助手 需求分析

## 1. 背景

FDE 在客户现场需要快速理解业务目标、约束、隐性需求和交付边界。传统访谈依赖人工笔记，容易遗漏关键上下文，也难以在事后证明某个需求来自哪段访谈。当前 MVP 的目标是把访谈过程沉淀为“整段录音证据 + 本地转写 + 结构化需求分析 + 可复核 PRD”，并最终内化为 FDE OS 项目交付流程中的需求访谈节点。

## 2. 问题定义

- 访谈现场信息密度高，FDE 难以同时主持、追问、记录和整理。
- 客户可见内容与 FDE 私有补问需要分离。
- 生成的需求分析如果没有证据链，很难指导后续开发和责任复核。
- 语音转写必须本地化，避免外部 ASR 依赖和数据出境风险。
- ASR 会产生行业错词，证据覆盖时需要同步发现、纠正或排队等待人工确认，否则 PRD 可能引用错误术语。
- 现场发问既可能由 AI/TTS 发出，也可能由 FDE 本人发出，需要可切换。
- 如果访谈助手长期作为孤立工具存在，需求、PRD、复核证据和后续开发任务会割裂，无法进入 FDE OS 的业务闭环。

## 3. 目标

- 让 FDE 可以完成一场真实可录音的需求访谈。
- 让整段 `raw.wav` 成为事后复核主证据。
- 让 ASR、纠错、需求分析和 PRD 形成闭环。
- 让客户屏聚焦共识，FDE 屏聚焦补问和风险。
- 让需求项能够回到访谈依据，后续进一步定位到音频时间点。
- 让访谈产物进入 FDE OS 的项目、客户、需求、任务和交付对象体系。

## 4. 用户流程

### 4.1 现场访谈

1. FDE 选择模板或创建访谈 session。
2. FDE 选择发问方式: `TTS 发问` 或 `FDE 本人发问`。
3. FDE 开始整段录音。
4. 客户屏显示 `ON AIR` 和客户可确认共识。
5. FDE 屏显示下一轮补问、风险提醒和发问记录。
6. 访谈结束后保存 `raw.wav`。

### 4.2 访谈后处理

1. 使用本地 ASR 生成 `transcript.json`。
2. 使用场景 glossary 生成纠错稿。
3. FDE 人工校对关键错词。
4. 抽取需求分析。
5. 导出需求分析和 PRD。
6. 在“访谈复核”中核对录音、转写、需求依据和验收标准。
7. 校验并导出 FDE OS 对象包，供后续嵌入 `src/main/store.js` 或项目工作台使用。

### 4.3 FDE OS 内化流程

1. FDE 在 FDE OS 项目工作台中创建或打开客户项目。
2. 从项目对象发起需求访谈 session。
3. 访谈过程中录音、转写、补问和风险自动挂接到该项目。
4. 访谈结束后，结构化需求项进入项目需求池。
5. FDE 复核证据并确认需求项。
6. 确认后的需求项进入方案设计、研发任务、报价评估或交付计划。
7. 后续需求变更可回溯到原始访谈证据。

FDE OS 当前桌面端是 Electron 架构，集成边界如下:

- 主进程: Node.js / Electron，入口 `src/main.js`，负责启动和监控本地网关、ASR、CLI/toolchain 等本机能力。
- 渲染层: 原生 HTML/CSS/JavaScript，入口 `src/renderer/index.html` 和 `src/renderer/app.js`，后续不应强制引入 React/Vue 作为访谈助手运行时依赖。
- 本地数据: JSON 本地数据库，逻辑在 `src/main/store.js`，访谈 session、音频证据、转写、纠错建议、需求项、PRD artifact 应映射为 store 对象。
- 打包: 复用 Electron runtime 和 `scripts/package-macos.mjs`。

## 5. 已确认需求

### D1. 整段录音复核

- 需求: 保存整段访谈 `raw.wav`，用于事后回放和需求复核。
- 理由: 审计不是逐句实时审计，而是要能复原双方访谈内容。
- 当前状态: 已实现录音回放、元数据、SHA256、复核视图展示。

### D2. 本地 ASR

- 需求: 转写在本地完成。
- 理由: 用户明确要求文本转写本地实现。
- 当前状态: 已接入本地 `sherpa-onnx`，health 可显示模型 ready。

### D3. 上下文纠错

- 需求: 结合行业模板纠正 ASR 错词。
- 理由: 文旅场景中“生图、文宣、游客、玄武湖”等词容易被识别错误。
- 当前状态: 已实现 glossary 纠错和人工校对。

### D3A. 证据覆盖时的错词建议

- 需求: Agent 在证据覆盖过程中应顺读转写稿，列出更多需要纠正的词语，并支持安全自动纠正或人工确认。
- 理由: 真实访谈中出现“保维码、牲兔模型、铝派馆、文旅垂泪 AI、a s u 偏”等错词，若不显式处理，会污染需求依据和 PRD。
- 当前状态: 已新增 `transcript_correction_suggestions.json`、扫描接口和主控 UI。
- 边界:
  - 高置信词可自动进入校对稿，并标记为 `已自动纠正`。
  - 低置信词只进入 `待确认`，FDE 可应用或忽略。
  - 人工校对稿不能被后续自动扫描覆盖。

### D4. 需求分析可用于 PRD

- 需求: 需求分析不能只是晦涩摘要，要能指导 PRD 和研发开发。
- 理由: 用户反馈早期需求分析不够可用于生产 PRD。
- 当前状态: 已将需求项扩展为描述、用户故事、业务规则、数据对象、依赖、验收标准和访谈依据。

### D5. 需求分析与 PRD 分离导出

- 需求: 导出不能只是一份需求分析，要区分需求分析和 PRD。
- 当前状态: 已提供 `requirements-analysis` 和 `prd` 两个导出口。

### D6. 演示讲解模式

- 需求: 减少现场滚动和解释成本。
- 当前状态: 已增加主控演示区、客户屏、FDE 屏和 `ON AIR` 状态。

### D7. 双面副屏

- 需求: 面向客户和面向 FDE 的两个方向同时显示不同内容。
- 当前状态: 已用 `?view=customer` 和 `?view=fde` 实现双屏浏览器形态；MVP 补充手动校准、交换角色和保存本机布局，后续迁移到桌面外接屏原生窗口管理。
- MVP 边界:
  - 不自动判断哪块物理屏朝向 FDE 或客户。
  - 由 FDE 首次手动拖动窗口到正确外接屏。
  - 如果拖反，可在主控屏一键交换 FDE/客户显示角色。
  - 保存布局后下次打开时优先恢复窗口位置和角色偏好。

### D8. 发问方式开关

- 需求: 可选 TTS 发问或 FDE 本人发问。
- 理由: TTS 发问声音如果现场外放，会被整段录音收录；但 FDE 本人发问也应被支持。
- 当前状态: 已在 FDE 屏和主控录音区加入发问方式开关；主控录音区已显示下一问、朗读、暂停、继续、停止、跳过和自动开场朗读开关。
- MVP 兜底: 若尚未生成分析补问，TTS 发问使用当前场景模板的必问问题作为开场脚本。

### D9. 发问记录

- 需求: 记录哪类问题被问过，作为辅助时间线。
- 边界: 发问记录不是主审计证据，主证据仍是整段 `raw.wav`。
- 当前状态: 已实现 `agent_question_events.json`。

### D10. 访谈复核视图

- 需求: 事后能同屏复核录音、转写、需求依据。
- 当前状态: 已实现整段录音、转写时间片段、需求依据、证据播放和复核状态。

### D11. 证据定位

- 需求: 下一步把需求项定位到转写片段和音频时间点。
- 当前状态: 已实现第一版自动证据定位和人工证据复核。
- 说明:
  - 需求项新增 `evidence_refs`，包含转写片段、开始/结束时间、匹配来源和置信度。
  - 复核视图可从当前需求直接播放 raw.wav 对应片段。
  - 复核视图支持 `未复核` / `已确认` / `需重定位` 和复核备注。
  - FDE 可从转写片段列表中选择新片段，人工覆盖当前需求的证据定位。
  - 需求分析和 PRD 导出会附带证据定位与复核状态。

### D11A. 稳定转写时间片段

- 需求: 长转写需要拆成稳定时间片段，便于证据复核和后续手动重定位。
- 当前状态: 已生成 `transcript_segments.json`，文旅 demo 从一条长 turn 生成 40 个时间片段。
- 边界: 文旅 demo 是基于校对稿和时间比例生成的稳定片段；新录音会优先从 ASR 源头 VAD 切片生成 turn/segment。

### D11B. 说话人边界复核

- 需求: FDE 需要区分客户、FDE 本人和 AI 发问内容，否则后续 PRD 依据容易混淆。
- 当前状态: 已支持在转写 turn 和复核 segment 上人工标注 `FDE` / `客户` / `AI` / `未知`。
- 说明:
  - 说话人标注通过本地 API 保存，不调用外部 ASR 或云端说话人分离服务。
  - ASR 分段重建时会尽量保留已有人工标注。
  - 当前不是自动 diarization；多人重叠说话和边界细调仍依赖 FDE 复核。

### D11C. 转写片段边界编辑

- 需求: 自动切片不可能完全贴合真实语义边界，FDE 需要能人工修正片段边界，保证需求证据可以准确回放和引用。
- 当前状态: 已支持在复核视图编辑片段开始/结束时间和文本，并支持拆分片段、合并下一片段、播放当前边界和 500ms 快速微调。
- 说明:
  - 被人工编辑的片段标记为 `manual`，后续普通读取不会被自动重建覆盖。
  - 已经绑定到需求证据的片段被编辑后，证据时间点和摘录会同步更新。
  - 当前支持毫秒值输入、快捷微调和试听，后续可升级为音频波形拖拽。

### D12. FDE OS 业务流程内化

- 需求: 将访谈能力内化为 FDE OS 的业务流程，而不是作为独立工具割裂存在。
- 理由: 访谈产物需要继续进入项目、需求、任务、交付和复核流程。
- 当前状态: 已确认 FDE OS 为 Electron + 原生渲染 + JSON store 架构，待设计对象模型、IPC 边界和集成接口。

### D13. FDE OS 对象包

- 需求: 当前 MVP 应能把访谈产物导出为 FDE OS 可导入的机器可读对象包。
- 理由: FDE OS 研发会话需要明确对象边界，不能只拿 Markdown 文档或 React 页面。
- 当前状态: 已新增 `fde_os_bundle.json` 导出和导入前校验。
- 内容:
  - session、template、audio、transcript、transcript_segments
  - corrected_transcript、correction_suggestions
  - analysis、requirements、risks、open_questions
  - agent_question_events、artifacts、fde_os_objects

### D13A. FDE OS 对象包导入校验

- 需求: FDE OS 在导入对象包前需要知道当前包是可直接导入、需复核后导入，还是阻塞不可导入。
- 理由: 商业化和 FDE OS 内化不能只依赖人工判断文件是否完整，必须把录音证据、PRD artifact、需求证据、错词状态和 secret 泄漏风险前置检查。
- 当前状态: 已新增 `GET /api/sessions/{session_id}/fde-os/bundle/validation` 和主控屏对象包状态面板。
- 规则:
  - `ready`: 可导入。
  - `review_required`: 可导入，但 warning 应进入 FDE OS 项目质检待办。
  - `blocked`: 不允许导入，应回到访谈助手补齐。

### D13B. FDE OS 落库补丁

- 需求: MVP 应把对象包转换成接近 FDE OS `src/main/store.js` 的落库补丁预览。
- 理由: FDE OS 研发会话需要看到导入后会生成哪些 store 对象、哪些需求证据引用和哪些项目质检待办，不能只停留在原始 bundle。
- 当前状态: 已新增 `GET /api/sessions/{session_id}/fde-os/store-patch`、`POST /api/sessions/{session_id}/exports/fde-os-store-patch`、`GET /api/sessions/{session_id}/exports/fde-os-store-patch` 和主控屏 `导出落库补丁`。
- 内容:
  - `store_patch`: interviewSessions、audioEvidence、transcripts、transcriptSegments、transcriptCorrectionSuggestions、requirements、requirementEvidenceRefs、risks、openQuestions、prdArtifacts、importWarnings。
  - `qa_tasks`: 对象包 warning、未确认需求证据、待确认错词。

## 6. MVP 能力边界

### 已实现

- session 本地持久化。
- 整段录音保存。
- 本地 ASR。
- 本地术语纠错。
- 证据覆盖时的转写错词建议。
- 人工校对。
- 需求分析抽取。
- PRD 导出。
- 客户/FDE 双屏。
- 副屏手动校准、交换角色和本机布局偏好。
- TTS/FDE 发问方式切换、主控下一问和自动开场朗读。
- 整段录音复核视图。
- 转写时间片段列表。
- 转写片段边界编辑、拆分和合并。
- 需求项到 raw.wav 时间点的第一版证据定位。
- 证据人工确认状态。
- 导出文档中的证据片段引用。
- FDE OS 内化方向已进入 PRD。
- FDE OS 对象包导出。
- FDE OS 对象包导入前校验。
- FDE OS 落库补丁预览与导出。

### 未实现

- ASR 源头更精确的转写时间片段化。
- 说话人分离。
- 流式实时转写。
- FDE OS Electron 内嵌模块。
- FDE OS `src/main/store.js` 真实对象包导入器。
- FDE OS `fde_os_interview_import_patch.v1` 正式 upsert 事务。
- Electron 多显示器 ID 绑定和自动恢复。
- TTS 系统音频确定性混入。
- Word/PDF 导出。
- 团队权限。
- FDE OS 项目对象挂接。
- 需求项回写 FDE OS 需求池。
- 与 FDE OS 任务/交付流程联动。

## 7. 证据链模型

当前证据链:

`raw.wav -> transcript.json -> corrected_transcript.json + transcript_correction_suggestions.json -> requirements.json -> requirements_analysis.md / prd.md -> fde_os_bundle.json -> fde_os_store_patch.preview.json`

当前复核方式:

`需求项 -> 访谈依据文本 -> 证据片段 -> raw.wav 起止时间 -> 一键播放复核`

下一步目标:

`需求项 -> 更细粒度转写片段 -> 证据确认状态 + 术语确认状态 -> FDE OS 需求对象`

FDE OS 内化后的目标:

`FDE OS 项目 -> 访谈 session -> 录音/转写/纠错建议/需求项 -> fde_os_bundle.json -> 导入校验 -> store patch -> 质检待办 -> 复核确认 -> 研发任务/交付对象`

副屏 MVP 现场使用目标:

`笔记本主控屏 -> 打开 FDE/客户两个副屏窗口 -> 手动拖到双面外接屏 -> 校准/交换 -> 保存本机布局`

## 8. 风险与处理

- 风险: 浏览器录音不能保证 TTS 音频进入 `raw.wav`。
  - 处理: MVP 明确提示依赖外放和麦克风；FDE OS Electron 桌面端做系统音频混入。
- 风险: 长录音只有一条长转写时，需求定位不精确。
  - 处理: 已生成稳定转写时间片段，支持证据复核状态和人工重定位；下一步从 ASR 源头改善分段。
- 风险: LLM 生成需求可能超出访谈事实。
  - 处理: 复核视图要求每条需求显示访谈依据，并支持标记 `已确认` 或 `需重定位`。
- 风险: ASR 错词进入证据片段后，PRD 可能引用错误术语。
  - 处理: 证据覆盖时生成纠错建议，高置信自动应用，低置信由 FDE 确认或忽略。
- 风险: 客户屏暴露 FDE 私有问题。
  - 处理: 客户屏只展示共识、模块、指标和交付状态；副屏 MVP 增加校准大字和交换角色，降低窗口拖反风险。
- 风险: 浏览器 MVP 不能准确知道外接双面屏哪一面朝向客户。
  - 处理: 先做人工校准、本机布局保存和一键交换；mac 桌面端后续用原生窗口管理和显示器 ID 固化。
- 风险: 独立工具形态导致访谈产物无法进入 FDE OS 项目闭环。
  - 处理: 将项目、客户、需求项、PRD、录音证据、纠错建议设计为 FDE OS 可引用对象，并按 Electron 主进程 / 原生渲染层 / JSON store 三层接入。

## 9. 下一轮开发建议

1. 从 ASR 源头改善分段和说话人边界。
2. 在 FDE OS 仓库实现 `fde_os_interview_import_patch.v1` 的正式导入事务、IPC 和导入视图。
3. 做 FDE OS Electron 内嵌适配层设计。
4. 设计 FDE OS 对象挂接和需求项回写。
5. 将副屏 MVP 迁移到 Electron 多窗口和显示器 ID。
6. 设计 Electron 桌面端音频采集和 TTS 混入方案。
7. 最后扩展 Word/PDF 和权限体系。

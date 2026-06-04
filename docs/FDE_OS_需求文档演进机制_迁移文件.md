# FDE OS 需求文档演进机制迁移文件

## 1. 迁移目标

将“需求文档演进机制”内置到 FDE OS 的核心提示词或 harness 中，使 FDE OS 在 AI 原生项目开发过程中自动维护需求分析、PRD、开发日记和 changelog 的一致性。

该机制解决的问题:

- 原始需求分析和 PRD 只是项目基线，不应被视为开发全过程中不可变的静态文档。
- FDE 非人类 Agent 与 FDE 人类领航者在开发中会不断确认新需求、实现取舍、交互调整和验收口径。
- 这些变化必须先被记录到 changelog / 开发日记。
- 到阶段或里程碑时，累计变化必须同步进入新版需求分析和 PRD，形成 v2 / v3 等版本。
- 不能只改代码、只改界面、只改实现，而让产品文档长期停留在原始版本。

## 2. 建议接入位置

### 2.1 核心提示词

放入短规则，只强调原则，避免污染所有任务的上下文。

### 2.2 Harness / Agent Runtime Gate

放入完整可执行规则，用于在以下时机触发检查:

- 用户确认新产品需求。
- 用户确认范围变化。
- 用户确认交互调整。
- Agent 实现产品可见功能。
- Agent 修改验收口径、数据模型、集成协议或业务流程。
- 项目进入阶段验收或里程碑。

### 2.3 项目模板

放入文档模板和文件约定:

- `CHANGELOG.md`
- `docs/开发日记.md`
- `docs/需求分析_vN.md`
- `docs/PRD_vN.md`
- `docs/文档演进记录.md`

## 3. 核心提示词短规则

建议加入 FDE OS 核心提示词:

```text
需求文档演进规则：
原始需求分析和 PRD 是项目基线文档，不是开发全过程中的静态真理。任何经 FDE 人类领航者确认的新增需求、范围变化、实现取舍、交互调整、验收口径变化、数据模型变化或集成流程变化，都必须先记录到 changelog/开发日记。到阶段或里程碑时，应将累计变更同步进新版需求分析和 PRD，形成 v2/v3 等版本。不得只修改代码而长期不同步产品文档。
```

## 4. Harness Gate 规则

建议加入 FDE OS harness:

```text
Document Evolution Gate:

When implementing, reviewing, or confirming any project change, classify whether it changes:
- product requirements
- PRD scope
- user flow
- interaction behavior
- acceptance criteria
- data model
- integration contract
- workflow/process
- non-functional requirement
- milestone or delivery boundary

If yes:
1. Append a concise entry to CHANGELOG.md or the project development diary.
2. Mark affected baseline documents: requirements analysis, PRD, technical plan, runbook, or user guide.
3. If the change is part of a milestone, update or generate the next versioned requirements analysis and PRD.
4. Preserve the previous version. Do not overwrite historical baselines without trace.
5. In the final response, report which documents were updated, or explicitly state why no document update was needed.

The agent must not treat original PRD/requirements as immutable after implementation begins.
```

## 5. 触发条件

### 5.1 必须触发文档演进记录

- 用户说“同意实施”“按这个做”“这个可以”“以后就这样”并涉及产品行为。
- 新增、删除、合并或拆分功能。
- 改变某个用户角色的操作流程。
- 改变客户可见界面、FDE 私有界面或交付物。
- 改变需求分析、PRD、导出文档、证据链或复核方式。
- 改变验收标准、成功指标、风险、约束。
- 改变数据对象、文件结构、API、事件、任务流。
- 改变部署形态、商业化边界、合规或开源协议判断。
- 将独立功能内化为 FDE OS 工作流。

### 5.2 可以不触发文档演进记录

- 纯代码格式化。
- 不改变行为的内部重构。
- 修复明显 typo 且不影响产品语义。
- 只补测试、不改变功能。
- 修复构建配置但不改变交付行为。

### 5.3 需要人工判断

- UI 文案调整是否改变用户承诺。
- 后端字段重命名是否影响外部集成。
- 性能优化是否改变 SLA 或容量承诺。
- Demo 数据调整是否改变产品说明。

## 6. 文档版本机制

### 6.1 基线版本

项目启动时生成:

- `docs/需求分析_v1.md`
- `docs/PRD_v1.md`

或者已有文档作为 v1 基线。

### 6.2 持续变更记录

每次被确认的产品变化进入:

- `CHANGELOG.md`: 面向版本和发布的变化记录。
- `docs/开发日记.md`: 面向产品/工程推演过程的迭代记录。

### 6.3 里程碑同步

当出现以下情况时，应生成新版文档:

- MVP 收口。
- 演示版本冻结。
- 进入开发阶段。
- 进入交付阶段。
- 需求范围发生连续多次变化。
- 用户明确要求“同步 PRD / 需求分析”。
- Agent 判断 changelog 中累计变化已明显偏离当前 PRD。

生成方式:

- 保留旧版: `PRD_v1.md`
- 生成新版: `PRD_v2.md`
- 新版文档顶部增加“相对上一版变化摘要”。
- 将 changelog 中相关条目映射到新版需求章节。

## 7. 建议文件结构

```text
docs/
  requirements/
    需求分析_v1.md
    需求分析_v2.md
  prd/
    PRD_v1.md
    PRD_v2.md
  decisions/
    文档演进记录.md
  开发日记.md
CHANGELOG.md
```

对于小项目，也可以先使用当前轻量结构:

```text
docs/FDE_需求访谈助手_需求分析.md
docs/FDE_需求访谈助手_PRD.md
docs/开发日记.md
CHANGELOG.md
```

## 8. Changelog 条目模板

```md
## YYYY-MM-DD

### Added

- 新增了什么能力。

### Changed

- 修改了什么需求、流程、界面或验收口径。

### Deprecated

- 哪些旧能力或旧假设不再推荐。

### Removed

- 删除了什么。

### Fixed

- 修复了什么产品或工程问题。

### Docs

- 同步了哪些需求分析、PRD 或说明文档。

### Evidence

- 变更来源: 用户确认 / 访谈记录 / 会议 / issue / commit / 录音片段。
- 影响范围: 需求 / PRD / UI / API / 数据模型 / 部署 / 验收。
```

## 9. 开发日记条目模板

```md
## 迭代 N: 标题

- 触发来源:
  - 用户确认:
  - Agent 发现:
- 产品决策:
  - ...
- 实现内容:
  - ...
- 文档同步:
  - CHANGELOG:
  - 需求分析:
  - PRD:
- 遗留问题:
  - ...
```

## 10. 新版 PRD 同步模板

```md
# 产品 PRD vN

## 版本信息

- 当前版本: vN
- 上一版本: vN-1
- 同步日期:
- 同步依据:
  - CHANGELOG 条目:
  - 开发日记迭代:
  - 用户确认:

## 相对上一版的变化

- 新增:
- 修改:
- 移除:
- 延后:

## 当前 PRD 正文

...
```

## 11. Agent 最终回复要求

当本次任务涉及产品变化时，Agent 最终回复必须包含:

- 代码/实现改了什么。
- 文档是否同步。
- 同步到了哪些文件。
- 如果没有同步文档，明确原因。
- 是否需要在下个里程碑生成新版 PRD / 需求分析。

示例:

```text
已实现 TTS/FDE 发问方式切换，并同步:
- CHANGELOG.md
- docs/开发日记.md
- docs/FDE_需求访谈助手_PRD.md
- docs/FDE_需求访谈助手_需求分析.md

该变化影响用户流程和验收口径，下一次 MVP 收口时应进入 PRD v2。
```

## 12. FDE OS 内化后的推荐对象模型

```text
Project
  Customer
  InterviewSession
    AudioEvidence
    Transcript
    CorrectedTranscript
    QuestionEvent
    RequirementItem
    RiskItem
    OpenQuestion
    PRDArtifact
    RequirementsAnalysisArtifact
  ChangeLogEntry
  DocumentVersion
```

核心关系:

- `InterviewSession` 属于 `Project`。
- `RequirementItem` 由 `InterviewSession` 产生。
- `RequirementItem` 可进入研发任务、方案设计、报价或交付计划。
- `DocumentVersion` 由一组 `ChangeLogEntry` 汇总生成。
- `AudioEvidence` 和 `Transcript` 为需求项提供证据链。

## 13. 打包前检查清单

在 FDE OS 重新打包安装包前检查:

- 核心提示词已加入短规则。
- Harness 已加入 Document Evolution Gate。
- 项目模板包含 `CHANGELOG.md` 和 `docs/开发日记.md`。
- Agent 最终回复模板包含“文档是否同步”字段。
- 里程碑流程支持生成 v2/v3 文档。
- FDE OS 项目对象模型预留 `ChangeLogEntry` 和 `DocumentVersion`。
- 独立功能变更能被回写到需求/PRD。

## 14. 验收标准

- 当用户确认一个产品变化时，Agent 会主动判断是否需要记录 changelog。
- 当实现产品可见功能时，Agent 不会只改代码而完全忽略文档。
- 当进入里程碑时，Agent 会汇总 changelog 并生成新版需求分析/PRD。
- 旧版需求分析/PRD 会被保留，新版文档能说明相对上一版变化。
- 最终回复会明确“文档已同步”或“无需同步的原因”。

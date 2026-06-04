from __future__ import annotations

import re
from hashlib import sha256
from pathlib import Path
from typing import Any

from app.core.settings import Settings
from app.models.analysis import AnalysisResult, OpenQuestionItem, PrdOutline, RequirementItem, RiskItem
from app.models.audit import AgentQuestionEvent, AudioAsset
from app.models.export import (
    FdeOsArtifact,
    FdeOsBundleValidationIssue,
    FdeOsBundleValidationResult,
    FdeOsBundleValidationSummary,
    FdeOsExportBundle,
    FdeOsObjectRef,
    FdeOsStorePatch,
)
from app.models.session import InterviewSession
from app.models.template import ScenarioTemplate
from app.models.transcript import (
    CorrectedTranscript,
    TranscriptCorrectionSuggestion,
    TranscriptSegment,
    TranscriptTurn,
)
from app.services.storage import session_dir, utc_now, write_json

FDE_OS_BUNDLE_SCHEMA_VERSION = "fde_interview_bundle.v1"
FDE_OS_INTEGRATION_TARGET = "fde-os-electron"
FDE_OS_REQUIRED_ARTIFACTS = {"audio.raw_wav", "requirements_analysis.markdown", "prd.markdown"}
SECRET_TOKEN_PATTERN = re.compile(r"\b(?:sk|ark)-[A-Za-z0-9_-]{12,}\b")


def export_markdown(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    prd: PrdOutline | None = None,
) -> Path:
    export_path = session_dir(settings, session.id) / "exports" / "requirements_analysis.md"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    export_path.write_text(
        build_markdown(session, template, transcript, requirements, risks, open_questions, prd),
        encoding="utf-8",
    )
    return export_path


def export_prd_markdown(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    prd: PrdOutline | None,
) -> Path:
    export_path = session_dir(settings, session.id) / "exports" / "prd.md"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    export_path.write_text(
        build_prd_markdown(session, template, requirements, risks, open_questions, prd),
        encoding="utf-8",
    )
    return export_path


def export_fde_os_bundle(
    settings: Settings,
    bundle: FdeOsExportBundle,
) -> Path:
    export_path = session_dir(settings, bundle.session.id) / "exports" / "fde_os_bundle.json"
    for artifact in bundle.artifacts:
        if artifact.kind == "fde_os_bundle.json":
            artifact.exists = True
            artifact.path = str(export_path.relative_to(settings.root_dir))
    write_json(export_path, bundle.model_dump(mode="json"))
    return export_path


def export_fde_os_store_patch(settings: Settings, patch: FdeOsStorePatch) -> Path:
    session_id = patch.source["session_id"]
    export_path = session_dir(settings, session_id) / "exports" / "fde_os_store_patch.preview.json"
    write_json(export_path, patch.model_dump(mode="json"))
    return export_path


def build_fde_os_bundle(
    *,
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    audio: AudioAsset,
    transcript: list[TranscriptTurn],
    transcript_segments: list[TranscriptSegment],
    corrected_transcript: CorrectedTranscript,
    correction_suggestions: list[TranscriptCorrectionSuggestion],
    analysis: AnalysisResult,
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    agent_question_events: list[AgentQuestionEvent],
) -> FdeOsExportBundle:
    artifacts = _fde_os_artifacts(settings, session.id)
    return FdeOsExportBundle(
        exported_at=utc_now(),
        integration_notes=[
            "FDE OS 当前目标为 Electron 主进程 + 原生 renderer + JSON store，不直接依赖当前 React/Vite workbench。",
            "主进程 src/main.js 负责启动本地 gateway/ASR sidecar，并通过 IPC 暴露访谈动作。",
            "渲染层 src/renderer/app.js 负责主控屏、FDE 屏、客户屏状态与交互。",
            "本地数据 src/main/store.js 应把本 bundle 映射为项目、访谈、音频证据、转写、纠错建议、需求项和 PRD artifact。",
        ],
        session=session,
        template=template,
        audio=audio,
        transcript=transcript,
        transcript_segments=transcript_segments,
        corrected_transcript=corrected_transcript,
        correction_suggestions=correction_suggestions,
        analysis=analysis,
        requirements=requirements,
        risks=risks,
        open_questions=open_questions,
        agent_question_events=agent_question_events,
        artifacts=artifacts,
        fde_os_objects=_fde_os_object_refs(session, audio, requirements, risks, open_questions, artifacts),
    )


def build_fde_os_store_patch(
    bundle: FdeOsExportBundle,
    *,
    project_id: str | None = None,
) -> FdeOsStorePatch:
    validation = validate_fde_os_bundle(bundle)
    if not validation.import_ready:
        error_codes = ", ".join(issue.code for issue in validation.issues if issue.severity == "error")
        raise ValueError(f"FDE OS object bundle is blocked: {error_codes}")

    created_at = utc_now()
    session = bundle.session
    session_id = session.id
    target_project_id = project_id or f"project:{session_id}"
    interview_session_id = f"interview:{session_id}"
    import_id = _stable_id("interview-import", f"{target_project_id}:{session_id}:{bundle.exported_at.isoformat()}")
    artifacts = bundle.artifacts
    requirements = bundle.requirements
    correction_suggestions = bundle.correction_suggestions
    store_patch: dict[str, list[dict[str, Any]]] = {
        "interviewSessions": [
            {
                "id": interview_session_id,
                "project_id": target_project_id,
                "source_session_id": session_id,
                "project_name": session.project_name,
                "customer_name": session.customer_name,
                "template_id": session.template_id,
                "template_name": bundle.template.name,
                "mode": session.mode,
                "status": session.status,
                "display_status": session.display_status,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "started_at": session.started_at,
                "ended_at": session.ended_at,
                "imported_at": created_at,
                "import_id": import_id,
                "analysis_engine": bundle.analysis.engine,
                "analysis_status": bundle.analysis.status,
                "readiness_label": validation.readiness_label,
            }
        ],
        "audioEvidence": [],
        "transcripts": [
            {
                "id": f"transcript:{session_id}:raw",
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "source_session_id": session_id,
                "kind": "raw_asr",
                "turn_count": len(bundle.transcript),
                "turns": [turn.model_dump(mode="json") for turn in bundle.transcript],
                "imported_at": created_at,
            },
            {
                "id": f"transcript:{session_id}:corrected",
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "source_session_id": session_id,
                "kind": "corrected",
                "corrected_text": bundle.corrected_transcript.corrected_text,
                "original_text": bundle.corrected_transcript.original_text,
                "corrections": bundle.corrected_transcript.corrections,
                "uncertain_segments": bundle.corrected_transcript.uncertain_segments,
                "source": bundle.corrected_transcript.source,
                "updated_at": bundle.corrected_transcript.updated_at,
                "imported_at": created_at,
            },
        ],
        "transcriptSegments": [
            {
                **segment.model_dump(mode="json"),
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "source_session_id": session_id,
                "fde_os_id": f"transcript_segment:{session_id}:{segment.id}",
                "imported_at": created_at,
            }
            for segment in bundle.transcript_segments
        ],
        "transcriptCorrectionSuggestions": [
            {
                **suggestion.model_dump(mode="json"),
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "source_session_id": session_id,
                "fde_os_id": f"correction:{session_id}:{suggestion.id}",
                "qa_state": "action_required" if suggestion.status == "pending" else "resolved",
                "imported_at": created_at,
            }
            for suggestion in correction_suggestions
        ],
        "requirements": [],
        "requirementEvidenceRefs": [],
        "risks": [
            {
                **risk.model_dump(mode="json"),
                "id": f"risk:{risk.id}",
                "source_risk_id": risk.id,
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "imported_at": created_at,
            }
            for risk in bundle.risks
        ],
        "openQuestions": [
            {
                **question.model_dump(mode="json"),
                "id": f"open_question:{question.id}",
                "source_open_question_id": question.id,
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "qa_state": "open",
                "imported_at": created_at,
            }
            for question in bundle.open_questions
        ],
        "prdArtifacts": [
            {
                "id": f"artifact:{session_id}:{artifact.kind}",
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "kind": artifact.kind,
                "title": artifact.filename,
                "path": artifact.path,
                "filename": artifact.filename,
                "media_type": artifact.media_type,
                "imported_at": created_at,
            }
            for artifact in artifacts
            if artifact.exists
        ],
        "importWarnings": [
            {
                "id": _stable_id("interview-import-issue", f"{import_id}:{issue.code}:{issue.path}:{issue.message}"),
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "import_id": import_id,
                "severity": issue.severity,
                "code": issue.code,
                "message": issue.message,
                "path": issue.path,
                "status": "blocked" if issue.severity == "error" else "open",
                "created_at": created_at,
            }
            for issue in validation.issues
        ],
    }

    if bundle.audio.exists:
        store_patch["audioEvidence"].append(
            {
                "id": f"audio:{session_id}:raw_wav",
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "source_session_id": session_id,
                "title": "整段访谈录音",
                "path": bundle.audio.path,
                "filename": bundle.audio.filename,
                "size_bytes": bundle.audio.size_bytes,
                "duration_ms": bundle.audio.duration_ms,
                "sample_rate": bundle.audio.sample_rate,
                "channels": bundle.audio.channels,
                "sha256": bundle.audio.sha256,
                "updated_at": bundle.audio.updated_at,
                "imported_at": created_at,
                "audit_role": "primary_interview_evidence",
            }
        )

    for requirement in requirements:
        evidence_refs = requirement.evidence_refs
        has_confirmed_evidence = any(evidence.review_status == "confirmed" for evidence in evidence_refs)
        store_patch["requirements"].append(
            {
                "id": f"requirement:{requirement.id}",
                "source_requirement_id": requirement.id,
                "project_id": target_project_id,
                "interview_session_id": interview_session_id,
                "title": requirement.title,
                "description": requirement.description,
                "type": requirement.type,
                "priority": requirement.priority,
                "module": requirement.module,
                "user_story": requirement.user_story,
                "business_rules": requirement.business_rules,
                "data_entities": requirement.data_entities,
                "dependencies": requirement.dependencies,
                "acceptance_criteria": requirement.acceptance_criteria,
                "confidence": requirement.confidence,
                "created_at": requirement.created_at,
                "imported_at": created_at,
                "evidence_count": len(evidence_refs),
                "has_confirmed_evidence": has_confirmed_evidence,
                "can_create_delivery_task": has_confirmed_evidence,
                "qa_state": "ready"
                if has_confirmed_evidence
                else "needs_evidence_review"
                if evidence_refs
                else "missing_evidence",
            }
        )
        for evidence in evidence_refs:
            store_patch["requirementEvidenceRefs"].append(
                {
                    "id": f"requirement_evidence:{requirement.id}:{evidence.id}",
                    "source_evidence_id": evidence.id,
                    "project_id": target_project_id,
                    "interview_session_id": interview_session_id,
                    "requirement_id": f"requirement:{requirement.id}",
                    "source_requirement_id": requirement.id,
                    "transcript_segment_id": f"transcript_segment:{session_id}:{evidence.transcript_segment_id}"
                    if evidence.transcript_segment_id
                    else "",
                    "source_transcript_segment_id": evidence.transcript_segment_id,
                    "transcript_turn_id": evidence.transcript_turn_id,
                    "transcript_excerpt": evidence.transcript_excerpt,
                    "corrected_excerpt": evidence.corrected_excerpt,
                    "start_ms": evidence.start_ms,
                    "end_ms": evidence.end_ms,
                    "source": evidence.source,
                    "confidence": evidence.confidence,
                    "review_status": evidence.review_status,
                    "review_note": evidence.review_note,
                    "reviewed_at": evidence.reviewed_at,
                    "audio_evidence_id": f"audio:{session_id}:raw_wav" if bundle.audio.exists else "",
                    "imported_at": created_at,
                }
            )

    qa_tasks = _fde_os_qa_tasks(
        project_id=target_project_id,
        interview_session_id=interview_session_id,
        import_id=import_id,
        created_at=created_at,
        validation=validation,
        requirements=requirements,
        correction_suggestions=correction_suggestions,
    )

    return FdeOsStorePatch(
        created_at=created_at,
        import_id=import_id,
        project_id=target_project_id,
        interview_session_id=interview_session_id,
        source={
            "schema_version": bundle.schema_version,
            "exported_at": bundle.exported_at,
            "source_app": bundle.source_app,
            "integration_target": bundle.integration_target,
            "session_id": session_id,
        },
        validation=validation,
        qa_tasks=qa_tasks,
        store_patch=store_patch,
    )


def validate_fde_os_bundle(bundle: FdeOsExportBundle) -> FdeOsBundleValidationResult:
    issues: list[FdeOsBundleValidationIssue] = []

    def add_issue(severity: str, code: str, message: str, path: str = "") -> None:
        issues.append(
            FdeOsBundleValidationIssue(
                severity=severity,
                code=code,
                message=message,
                path=path,
            )
        )

    session_id = bundle.session.id
    artifact_by_kind = {artifact.kind: artifact for artifact in bundle.artifacts}
    object_ids = [item.object_id for item in bundle.fde_os_objects]
    duplicate_object_ids = sorted({object_id for object_id in object_ids if object_ids.count(object_id) > 1})
    requirement_with_evidence = sum(1 for item in bundle.requirements if item.evidence_refs)
    confirmed_evidence = sum(
        1 for item in bundle.requirements if any(evidence.review_status == "confirmed" for evidence in item.evidence_refs)
    )
    pending_corrections = sum(1 for item in bundle.correction_suggestions if item.status == "pending")
    summary = FdeOsBundleValidationSummary(
        artifact_total=len(bundle.artifacts),
        artifact_ready=sum(1 for artifact in bundle.artifacts if artifact.exists),
        object_ref_total=len(bundle.fde_os_objects),
        requirement_total=len(bundle.requirements),
        requirement_with_evidence=requirement_with_evidence,
        confirmed_evidence=confirmed_evidence,
        transcript_turn_total=len(bundle.transcript),
        transcript_segment_total=len(bundle.transcript_segments),
        correction_suggestion_total=len(bundle.correction_suggestions),
        pending_correction_suggestion=pending_corrections,
    )

    if bundle.schema_version != FDE_OS_BUNDLE_SCHEMA_VERSION:
        add_issue(
            "error",
            "schema_version_mismatch",
            f"对象包版本应为 {FDE_OS_BUNDLE_SCHEMA_VERSION}，当前为 {bundle.schema_version}。",
            "schema_version",
        )
    if bundle.integration_target != FDE_OS_INTEGRATION_TARGET:
        add_issue(
            "error",
            "integration_target_mismatch",
            f"目标集成端应为 {FDE_OS_INTEGRATION_TARGET}，当前为 {bundle.integration_target}。",
            "integration_target",
        )
    if bundle.template.id != bundle.session.template_id:
        add_issue(
            "error",
            "template_session_mismatch",
            "session.template_id 与 template.id 不一致。",
            "template.id",
        )
    if bundle.audio.session_id != session_id:
        add_issue("error", "audio_session_mismatch", "audio.session_id 与 session.id 不一致。", "audio.session_id")
    if bundle.corrected_transcript.session_id != session_id:
        add_issue(
            "error",
            "corrected_transcript_session_mismatch",
            "corrected_transcript.session_id 与 session.id 不一致。",
            "corrected_transcript.session_id",
        )
    if bundle.analysis.session_id != session_id:
        add_issue("error", "analysis_session_mismatch", "analysis.session_id 与 session.id 不一致。", "analysis.session_id")

    for artifact_kind in sorted(FDE_OS_REQUIRED_ARTIFACTS):
        artifact = artifact_by_kind.get(artifact_kind)
        if artifact is None:
            add_issue("error", "required_artifact_missing", f"缺少必需 artifact: {artifact_kind}。", "artifacts")
        elif not artifact.exists:
            add_issue(
                "error",
                "required_artifact_not_ready",
                f"必需 artifact 尚未生成: {artifact_kind}。",
                f"artifacts.{artifact_kind}",
            )
    bundle_artifact = artifact_by_kind.get("fde_os_bundle.json")
    if bundle_artifact is None or not bundle_artifact.exists:
        add_issue(
            "warning",
            "bundle_file_not_exported",
            "对象包预览已可构建，但 fde_os_bundle.json 文件尚未导出。",
            "artifacts.fde_os_bundle.json",
        )

    if not bundle.audio.exists:
        add_issue("error", "audio_evidence_missing", "整段访谈录音 raw.wav 不存在，无法满足事后复核要求。", "audio")
    elif not bundle.audio.sha256:
        add_issue("error", "audio_hash_missing", "整段访谈录音缺少 SHA256，无法做审计校验。", "audio.sha256")

    if not bundle.transcript:
        add_issue("warning", "transcript_empty", "转写为空，导入后只能作为空访谈草稿。", "transcript")
    if not bundle.transcript_segments:
        add_issue("warning", "transcript_segments_empty", "转写片段为空，需求证据无法精确回放。", "transcript_segments")
    if not bundle.corrected_transcript.corrected_text.strip():
        add_issue("warning", "corrected_transcript_empty", "转写校对稿为空，后续 PRD 可能只依赖原始转写。", "corrected_transcript")
    if not bundle.requirements:
        add_issue("warning", "requirements_empty", "需求项为空，导入后不会生成可开发需求候选。", "requirements")
    elif requirement_with_evidence < len(bundle.requirements):
        add_issue(
            "warning",
            "requirement_evidence_incomplete",
            f"{len(bundle.requirements) - requirement_with_evidence} 个需求项还没有绑定录音证据。",
            "requirements",
        )
    if bundle.requirements and confirmed_evidence == 0:
        add_issue(
            "warning",
            "no_confirmed_evidence",
            "当前需求证据均未人工确认；导入 FDE OS 后应进入质检待办。",
            "requirements.evidence_refs",
        )
    if pending_corrections:
        add_issue(
            "warning",
            "pending_corrections",
            f"仍有 {pending_corrections} 条错词建议待确认。",
            "correction_suggestions",
        )
    if bundle.analysis.status == "fallback":
        add_issue(
            "warning",
            "analysis_is_local_draft",
            "当前分析为本地草稿，正式交付前建议运行 API 增强分析。",
            "analysis.status",
        )
    if duplicate_object_ids:
        add_issue(
            "error",
            "duplicate_object_ids",
            f"fde_os_objects 存在重复 object_id: {', '.join(duplicate_object_ids[:5])}。",
            "fde_os_objects",
        )
    if not any(item.object_type == "InterviewSession" for item in bundle.fde_os_objects):
        add_issue("error", "interview_object_missing", "fde_os_objects 缺少 InterviewSession 根对象。", "fde_os_objects")
    if bundle.audio.exists and not any(item.object_type == "AudioEvidence" for item in bundle.fde_os_objects):
        add_issue("warning", "audio_object_missing", "fde_os_objects 缺少 AudioEvidence 引用。", "fde_os_objects")

    secret_hits = SECRET_TOKEN_PATTERN.findall(bundle.model_dump_json())
    if secret_hits:
        add_issue(
            "error",
            "secret_token_leak",
            "对象包中疑似包含 API key 或访问令牌，禁止导入或分发。",
            "bundle",
        )

    error_count = sum(1 for issue in issues if issue.severity == "error")
    warning_count = sum(1 for issue in issues if issue.severity == "warning")
    readiness_label = "blocked" if error_count else "review_required" if warning_count else "ready"
    return FdeOsBundleValidationResult(
        session_id=session_id,
        schema_version=bundle.schema_version,
        valid=error_count == 0,
        import_ready=error_count == 0,
        readiness_label=readiness_label,
        summary=summary,
        issues=issues,
    )


def _fde_os_qa_tasks(
    *,
    project_id: str,
    interview_session_id: str,
    import_id: str,
    created_at,
    validation: FdeOsBundleValidationResult,
    requirements: list[RequirementItem],
    correction_suggestions: list[TranscriptCorrectionSuggestion],
) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for issue in validation.issues:
        if issue.severity != "warning":
            continue
        tasks.append(
            {
                "id": _stable_id("qa", f"{import_id}:issue:{issue.code}:{issue.path}"),
                "project_id": project_id,
                "interview_session_id": interview_session_id,
                "type": "bundle_warning",
                "title": issue.message,
                "source_code": issue.code,
                "status": "open",
                "created_at": created_at,
            }
        )
    for requirement in requirements:
        evidence_refs = requirement.evidence_refs
        if not evidence_refs:
            tasks.append(
                {
                    "id": _stable_id("qa", f"{import_id}:missing-evidence:{requirement.id}"),
                    "project_id": project_id,
                    "interview_session_id": interview_session_id,
                    "type": "requirement_evidence",
                    "title": f"需求缺少录音证据: {requirement.title}",
                    "requirement_id": f"requirement:{requirement.id}",
                    "status": "open",
                    "created_at": created_at,
                }
            )
            continue
        if not any(evidence.review_status == "confirmed" for evidence in evidence_refs):
            tasks.append(
                {
                    "id": _stable_id("qa", f"{import_id}:unconfirmed-evidence:{requirement.id}"),
                    "project_id": project_id,
                    "interview_session_id": interview_session_id,
                    "type": "requirement_evidence",
                    "title": f"需求证据待人工确认: {requirement.title}",
                    "requirement_id": f"requirement:{requirement.id}",
                    "status": "open",
                    "created_at": created_at,
                }
            )
    for suggestion in correction_suggestions:
        if suggestion.status != "pending":
            continue
        tasks.append(
            {
                "id": _stable_id("qa", f"{import_id}:pending-correction:{suggestion.id}"),
                "project_id": project_id,
                "interview_session_id": interview_session_id,
                "type": "transcript_correction",
                "title": f"待确认错词: {suggestion.wrong_text} -> {suggestion.suggested_text}",
                "correction_suggestion_id": f"correction:{suggestion.session_id}:{suggestion.id}",
                "status": "open",
                "created_at": created_at,
            }
        )
    return tasks


def _stable_id(prefix: str, value: str) -> str:
    return f"{prefix}:{sha256(value.encode('utf-8')).hexdigest()[:16]}"


def _fde_os_artifacts(settings: Settings, session_id: str) -> list[FdeOsArtifact]:
    base = session_dir(settings, session_id)
    candidates = [
        ("audio.raw_wav", base / "audio" / "raw.wav", "audio/wav"),
        ("requirements_analysis.markdown", base / "exports" / "requirements_analysis.md", "text/markdown; charset=utf-8"),
        ("prd.markdown", base / "exports" / "prd.md", "text/markdown; charset=utf-8"),
        ("fde_os_bundle.json", base / "exports" / "fde_os_bundle.json", "application/json"),
    ]
    artifacts: list[FdeOsArtifact] = []
    for kind, path, media_type in candidates:
        display_path = _display_artifact_path(settings, path)
        artifacts.append(
            FdeOsArtifact(
                kind=kind,
                path=display_path,
                filename=path.name,
                media_type=media_type,
                exists=path.exists(),
            )
        )
    return artifacts


def _display_artifact_path(settings: Settings, path: Path) -> str:
    for base in (settings.root_dir, settings.data_dir.parent):
        try:
            return str(path.relative_to(base))
        except ValueError:
            continue
    return str(path)


def _fde_os_object_refs(
    session: InterviewSession,
    audio: AudioAsset,
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    artifacts: list[FdeOsArtifact],
) -> list[FdeOsObjectRef]:
    session_object_id = f"interview:{session.id}"
    refs: list[FdeOsObjectRef] = [
        FdeOsObjectRef(
            object_type="InterviewSession",
            object_id=session_object_id,
            title=session.project_name,
            status=session.status,
            source_path="session.json",
            metadata={
                "session_id": session.id,
                "customer_name": session.customer_name,
                "template_id": session.template_id,
                "mode": session.mode,
            },
        )
    ]
    if audio.exists:
        refs.append(
            FdeOsObjectRef(
                object_type="AudioEvidence",
                object_id=f"audio:{session.id}:raw_wav",
                parent_object_id=session_object_id,
                title="整段访谈录音",
                status="ready",
                source_path=audio.path,
                metadata={
                    "duration_ms": audio.duration_ms,
                    "sha256": audio.sha256,
                    "sample_rate": audio.sample_rate,
                    "channels": audio.channels,
                },
            )
        )
    for item in requirements:
        refs.append(
            FdeOsObjectRef(
                object_type="RequirementItem",
                object_id=f"requirement:{item.id}",
                parent_object_id=session_object_id,
                title=item.title,
                status=item.priority,
                source_path="requirements.json",
                metadata={
                    "requirement_id": item.id,
                    "module": item.module,
                    "type": item.type,
                    "confidence": item.confidence,
                    "evidence_count": len(item.evidence_refs),
                    "confirmed_evidence": any(evidence.review_status == "confirmed" for evidence in item.evidence_refs),
                },
            )
        )
    for item in risks:
        refs.append(
            FdeOsObjectRef(
                object_type="Risk",
                object_id=f"risk:{item.id}",
                parent_object_id=session_object_id,
                title=item.title,
                status=item.severity,
                source_path="risks.json",
                metadata={"risk_id": item.id},
            )
        )
    for item in open_questions:
        refs.append(
            FdeOsObjectRef(
                object_type="OpenQuestion",
                object_id=f"open_question:{item.id}",
                parent_object_id=session_object_id,
                title=item.question,
                status="open",
                source_path="open_questions.json",
                metadata={"open_question_id": item.id, "owner_role": item.owner_role},
            )
        )
    for artifact in artifacts:
        if not artifact.exists:
            continue
        refs.append(
            FdeOsObjectRef(
                object_type="Artifact",
                object_id=f"artifact:{session.id}:{artifact.kind}",
                parent_object_id=session_object_id,
                title=artifact.filename,
                status="ready",
                source_path=artifact.path,
                metadata={"kind": artifact.kind, "media_type": artifact.media_type},
            )
        )
    return refs


def build_markdown(
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    prd: PrdOutline | None = None,
) -> str:
    lines: list[str] = [
        f"# {session.project_name} 需求分析草稿",
        "",
        "## 基本信息",
        "",
        f"- Session: `{session.id}`",
        f"- 客户: {session.customer_name or '未填写'}",
        f"- 场景模板: {template.name}",
        f"- 访谈模式: {session.mode}",
        f"- 录音文件: `{session.audio_path or '未保存'}`",
        "",
    ]
    if prd is not None:
        lines.extend(_prd_lines(prd))
    lines.extend(["## 可开发需求项", ""])
    if requirements:
        for index, item in enumerate(requirements, start=1):
            lines.extend(
                [
                    f"### R{index}. {item.title}",
                    "",
                    f"- 类型: {item.type}",
                    f"- 优先级: {item.priority}",
                    f"- 置信度: {item.confidence:.2f}",
                    f"- 模块: {item.module or '未归类'}",
                    f"- 描述: {item.description}",
                ]
            )
            if item.user_story:
                lines.append(f"- 用户故事: {item.user_story}")
            if item.business_rules:
                lines.append("- 业务规则:")
                lines.extend(f"  - {rule}" for rule in item.business_rules)
            if item.data_entities:
                lines.append("- 数据对象:")
                lines.extend(f"  - {entity}" for entity in item.data_entities)
            if item.dependencies:
                lines.append("- 依赖:")
                lines.extend(f"  - {dependency}" for dependency in item.dependencies)
            if item.evidence:
                lines.append(f"- 证据: {item.evidence}")
            evidence_lines = _evidence_reference_lines(item)
            if evidence_lines:
                lines.append("- 证据定位:")
                lines.extend(evidence_lines)
            if item.acceptance_criteria:
                lines.append("- 验收标准:")
                lines.extend(f"  - {criterion}" for criterion in item.acceptance_criteria)
            lines.append("")
    else:
        lines.extend(["暂无明确需求项。", ""])

    lines.extend(["## 风险", ""])
    if risks:
        for index, item in enumerate(risks, start=1):
            lines.extend(
                [
                    f"### Risk {index}. {item.title}",
                    "",
                    f"- 严重度: {item.severity}",
                    f"- 描述: {item.description}",
                ]
            )
            if item.mitigation:
                lines.append(f"- 缓解建议: {item.mitigation}")
            if item.evidence:
                lines.append(f"- 证据: {item.evidence}")
            lines.append("")
    else:
        lines.extend(["暂无风险项。", ""])

    lines.extend(["## 未决问题", ""])
    if open_questions:
        for index, item in enumerate(open_questions, start=1):
            lines.extend(
                [
                    f"{index}. {item.question}",
                    f"   - 原因: {item.reason or '未填写'}",
                    f"   - 建议询问对象: {item.owner_role or '未指定'}",
                ]
            )
        lines.append("")
    else:
        lines.extend(["暂无未决问题。", ""])

    lines.extend(["## 访谈转写", ""])
    if transcript:
        for turn in transcript:
            lines.append(f"- **{turn.speaker}** ({turn.source}): {turn.text}")
    else:
        lines.append("暂无转写。")
    lines.append("")

    return "\n".join(lines)


def build_prd_markdown(
    session: InterviewSession,
    template: ScenarioTemplate,
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
    prd: PrdOutline | None,
) -> str:
    if prd is None:
        return "\n".join(
            [
                f"# {session.project_name} PRD v0.1",
                "",
                "当前 session 还没有 PRD 结构化分析。请先完成转写和需求分析抽取。",
                "",
            ]
        )

    brief = prd.product_brief
    product_name = brief.name or session.project_name
    lines: list[str] = [
        f"# {product_name} PRD v0.1",
        "",
        "## 1. 文档信息",
        "",
        f"- 项目: {session.project_name}",
        f"- 客户: {session.customer_name or '未填写'}",
        f"- 场景模板: {template.name}",
        f"- Session: `{session.id}`",
        f"- 录音文件: `{session.audio_path or '未保存'}`",
        "",
        "## 2. 产品概述",
        "",
        f"- 产品定位: {brief.positioning or '未填写'}",
        f"- 目标用户: {', '.join(brief.target_users) if brief.target_users else '未填写'}",
        f"- 问题陈述: {brief.problem_statement or '未填写'}",
        f"- 核心价值: {brief.value_proposition or '未填写'}",
        "",
        "## 3. 范围",
        "",
        "### 3.1 本期范围",
        "",
    ]
    lines.extend(f"- {item}" for item in (brief.scope or ["未填写"]))
    lines.extend(["", "### 3.2 暂不做", ""])
    lines.extend(f"- {item}" for item in (brief.out_of_scope or ["未填写"]))

    lines.extend(["", "## 4. 用户与场景", ""])
    lines.extend(f"- {role}" for role in (prd.user_roles or ["未填写"]))
    if prd.user_journeys:
        lines.extend(["", "### 4.1 用户旅程", ""])
        for journey in prd.user_journeys:
            lines.extend([f"#### {journey.actor}", "", f"- 触发: {journey.trigger or '未填写'}", "- 步骤:"])
            lines.extend(f"  - {step}" for step in (journey.steps or ["未填写"]))
            lines.extend([f"- 期望结果: {journey.expected_outcome or '未填写'}", ""])

    lines.extend(["## 5. 功能模块", ""])
    if prd.feature_modules:
        for index, module in enumerate(prd.feature_modules, start=1):
            lines.extend([f"### 5.{index} {module.name}", "", f"- 目标: {module.goal or '未填写'}"])
            if module.core_capabilities:
                lines.append("- 核心能力:")
                lines.extend(f"  - {capability}" for capability in module.core_capabilities)
            module_requirements = [
                item for item in requirements if item.module == module.name or item.title in module.related_requirements
            ]
            if module_requirements:
                lines.append("- 需求条目:")
                lines.extend(f"  - {item.id}: {item.title}" for item in module_requirements)
            elif module.related_requirements:
                lines.append("- 关联需求:")
                lines.extend(f"  - {requirement}" for requirement in module.related_requirements)
            lines.append("")
    else:
        lines.extend(["暂无功能模块。", ""])

    lines.extend(["## 6. 详细需求规格", ""])
    if requirements:
        for index, item in enumerate(requirements, start=1):
            lines.extend(
                [
                    f"### 6.{index} {item.title}",
                    "",
                    f"- 编号: {item.id}",
                    f"- 类型: {item.type}",
                    f"- 优先级: {item.priority}",
                    f"- 模块: {item.module or '未归类'}",
                    f"- 需求描述: {item.description}",
                ]
            )
            if item.user_story:
                lines.append(f"- 用户故事: {item.user_story}")
            if item.business_rules:
                lines.append("- 业务规则:")
                lines.extend(f"  - {rule}" for rule in item.business_rules)
            if item.data_entities:
                lines.append("- 数据对象:")
                lines.extend(f"  - {entity}" for entity in item.data_entities)
            if item.dependencies:
                lines.append("- 外部依赖:")
                lines.extend(f"  - {dependency}" for dependency in item.dependencies)
            if item.acceptance_criteria:
                lines.append("- 验收标准:")
                lines.extend(f"  - {criterion}" for criterion in item.acceptance_criteria)
            if item.evidence:
                lines.append(f"- 访谈依据: {item.evidence}")
            evidence_lines = _evidence_reference_lines(item)
            if evidence_lines:
                lines.append("- 证据定位:")
                lines.extend(evidence_lines)
            lines.append("")
    else:
        lines.extend(["暂无可开发需求项。", ""])

    lines.extend(["## 7. 数据模型草案", ""])
    lines.extend(f"- {item}" for item in (prd.data_model or ["未填写"]))
    lines.extend(["", "## 8. 成功指标与验收口径", ""])
    lines.extend(f"- {item}" for item in (prd.success_metrics or ["未填写"]))

    lines.extend(["", "## 9. 风险与约束", ""])
    if risks:
        for item in risks:
            lines.extend(
                [
                    f"- {item.title}",
                    f"  - 严重度: {item.severity}",
                    f"  - 说明: {item.description}",
                    f"  - 缓解建议: {item.mitigation or '待补充'}",
                ]
            )
    else:
        lines.append("- 暂无风险项。")

    lines.extend(["", "## 10. 待确认问题", ""])
    if open_questions:
        for index, item in enumerate(open_questions, start=1):
            lines.extend(
                [
                    f"{index}. {item.question}",
                    f"   - 原因: {item.reason or '未填写'}",
                    f"   - 建议询问对象: {item.owner_role or '未指定'}",
                ]
            )
    else:
        lines.append("暂无待确认问题。")

    if prd.transcript_corrections:
        lines.extend(["", "## 11. 转写纠错记录", ""])
        lines.extend(f"- {item}" for item in prd.transcript_corrections)
    lines.append("")
    return "\n".join(lines)


def _prd_lines(prd: PrdOutline) -> list[str]:
    brief = prd.product_brief
    lines: list[str] = [
        "## PRD 摘要",
        "",
        f"- 产品定位: {brief.positioning or '未填写'}",
        f"- 目标用户: {', '.join(brief.target_users) if brief.target_users else '未填写'}",
        f"- 问题陈述: {brief.problem_statement or '未填写'}",
        f"- 核心价值: {brief.value_proposition or '未填写'}",
        "",
        "### 本期范围",
        "",
    ]
    lines.extend(f"- {item}" for item in (brief.scope or ["未填写"]))
    lines.extend(["", "### 暂不做", ""])
    lines.extend(f"- {item}" for item in (brief.out_of_scope or ["未填写"]))
    lines.extend(["", "## 用户角色", ""])
    lines.extend(f"- {role}" for role in (prd.user_roles or ["未填写"]))
    lines.extend(["", "## 用户旅程", ""])
    if prd.user_journeys:
        for journey in prd.user_journeys:
            lines.extend([f"### {journey.actor}", "", f"- 触发: {journey.trigger or '未填写'}", "- 步骤:"])
            lines.extend(f"  - {step}" for step in journey.steps)
            lines.extend([f"- 结果: {journey.expected_outcome or '未填写'}", ""])
    else:
        lines.extend(["暂无用户旅程。", ""])
    lines.extend(["## 功能模块", ""])
    if prd.feature_modules:
        for module in prd.feature_modules:
            lines.extend([f"### {module.name}", "", f"- 目标: {module.goal or '未填写'}"])
            if module.core_capabilities:
                lines.append("- 核心能力:")
                lines.extend(f"  - {capability}" for capability in module.core_capabilities)
            if module.related_requirements:
                lines.append("- 关联需求:")
                lines.extend(f"  - {requirement}" for requirement in module.related_requirements)
            lines.append("")
    else:
        lines.extend(["暂无功能模块。", ""])
    lines.extend(["## 数据模型草案", ""])
    lines.extend(f"- {item}" for item in (prd.data_model or ["未填写"]))
    lines.extend(["", "## 成功指标", ""])
    lines.extend(f"- {item}" for item in (prd.success_metrics or ["未填写"]))
    if prd.transcript_corrections:
        lines.extend(["", "## 转写纠错", ""])
        lines.extend(f"- {item}" for item in prd.transcript_corrections)
    lines.append("")
    return lines


def _evidence_reference_lines(item: RequirementItem) -> list[str]:
    lines: list[str] = []
    for evidence in item.evidence_refs:
        time_range = f"{_format_ms(evidence.start_ms)}-{_format_ms(evidence.end_ms)}"
        confidence = f"{evidence.confidence:.2f}"
        segment = f" · segment `{evidence.transcript_segment_id}`" if evidence.transcript_segment_id else ""
        review = _review_status_label(evidence.review_status)
        lines.append(f"  - raw.wav `{time_range}`{segment} · {evidence.source} · confidence {confidence} · 复核: {review}")
        if evidence.review_note:
            lines.append(f"    - 复核备注: {evidence.review_note}")
        excerpt = evidence.corrected_excerpt or evidence.transcript_excerpt
        if excerpt:
            lines.append(f"    - 片段: {' '.join(excerpt.split())}")
    return lines


def _review_status_label(value: str) -> str:
    return {
        "unreviewed": "未复核",
        "confirmed": "已确认",
        "needs_relocation": "需重定位",
    }.get(value, value)


def _format_ms(value: int) -> str:
    total_seconds = max(0, round(value / 1000))
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f"{minutes}:{seconds:02d}"

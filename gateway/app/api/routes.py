from __future__ import annotations

import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.settings import get_settings
from app.models.analysis import (
    AnalysisResult,
    EvidenceReference,
    OpenQuestionItem,
    RequirementItem,
    RiskItem,
    UpdateEvidenceRelocationRequest,
    UpdateEvidenceReviewRequest,
)
from app.models.audit import AgentQuestionEvent, AgentQuestionRequest, AudioAsset
from app.models.export import FdeOsBundleValidationResult, FdeOsExportBundle, FdeOsStorePatch, MarkdownExportResponse
from app.models.pipeline import AnalysisJobResponse, ProcessSessionResponse
from app.models.session import CreateSessionRequest, InterviewSession, UpdateDisplayStatusRequest
from app.models.template import ScenarioTemplate
from app.models.transcript import (
    ApplyTranscriptCorrectionSuggestionRequest,
    CorrectedTranscript,
    RunAsrResponse,
    SplitTranscriptSegmentRequest,
    TranscriptCorrectionSuggestion,
    TranscriptSegment,
    TranscriptTurn,
    UpdateCorrectedTranscriptRequest,
    UpdateTranscriptSegmentRequest,
    UpdateTranscriptSpeakerRequest,
)
from app.services.analysis import analyze_transcript
from app.services.analysis import normalize_transcript_text
from app.services.analysis_jobs import get_analysis_job, start_analysis_job
from app.services.asr import local_asr_status, transcribe_raw_wav
from app.services.evidence import attach_requirement_evidence, build_transcript_segments
from app.services.exporter import (
    build_fde_os_bundle,
    build_fde_os_store_patch,
    export_fde_os_bundle,
    export_fde_os_store_patch,
    export_markdown,
    export_prd_markdown,
    validate_fde_os_bundle,
)
from app.services.storage import (
    append_agent_question_event,
    audio_asset_path,
    create_session,
    delete_session,
    get_analysis_result,
    get_audio_asset,
    get_corrected_transcript,
    get_open_questions,
    get_requirements,
    get_risks,
    get_session,
    get_transcript,
    get_transcript_correction_suggestions,
    get_transcript_segments,
    list_agent_question_events,
    list_sessions,
    pause_session,
    save_analysis_result,
    save_analysis_items,
    save_corrected_transcript,
    save_raw_audio,
    save_transcript,
    save_transcript_segments,
    set_display_status,
    start_session,
    stop_session,
    utc_now,
)
from app.services.templates import get_template, list_templates
from app.services.transcript_corrections import (
    apply_transcript_correction_suggestion,
    refresh_transcript_correction_suggestions,
)

router = APIRouter()


@router.get("/health")
def health() -> dict[str, object]:
    settings = get_settings()
    return {
        "ok": True,
        "service": "fde-interview-gateway",
        "data_dir": str(settings.data_dir),
        "templates_dir": str(settings.templates_dir),
        "transcription": local_asr_status(),
        "demo": {
            "session_id": settings.demo_session_id,
            "readonly": bool(settings.demo_session_id),
        },
    }


@router.get("/templates", response_model=list[ScenarioTemplate])
def templates() -> list[ScenarioTemplate]:
    return list_templates(get_settings())


@router.get("/templates/{template_id}", response_model=ScenarioTemplate)
def template_detail(template_id: str) -> ScenarioTemplate:
    template = get_template(get_settings(), template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


@router.post("/sessions", response_model=InterviewSession)
def sessions_create(payload: CreateSessionRequest) -> InterviewSession:
    settings = get_settings()
    if get_template(settings, payload.template_id) is None:
        raise HTTPException(status_code=400, detail="Unknown template_id")
    return create_session(settings, payload)


@router.get("/sessions", response_model=list[InterviewSession])
def sessions_list() -> list[InterviewSession]:
    return list_sessions(get_settings())


@router.get("/sessions/{session_id}", response_model=InterviewSession)
def sessions_detail(session_id: str) -> InterviewSession:
    session = get_session(get_settings(), session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/sessions/{session_id}", status_code=204)
def sessions_delete(session_id: str) -> None:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    deleted = delete_session(settings, session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")


@router.patch("/sessions/{session_id}/display-status", response_model=InterviewSession)
def sessions_update_display_status(
    session_id: str,
    payload: UpdateDisplayStatusRequest,
) -> InterviewSession:
    session = set_display_status(get_settings(), session_id, payload.display_status)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/sessions/{session_id}/start", response_model=InterviewSession)
def sessions_start(session_id: str) -> InterviewSession:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = start_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/sessions/{session_id}/pause", response_model=InterviewSession)
def sessions_pause(session_id: str) -> InterviewSession:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = pause_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/sessions/{session_id}/stop", response_model=InterviewSession)
def sessions_stop(session_id: str) -> InterviewSession:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = stop_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/sessions/{session_id}/audio/raw-wav", response_model=InterviewSession)
async def sessions_upload_raw_wav(session_id: str, file: UploadFile = File(...)) -> InterviewSession:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    if file.content_type not in {"audio/wav", "audio/wave", "audio/x-wav", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Only WAV audio upload is supported")
    audio_bytes = await file.read()
    if len(audio_bytes) < 44 or not audio_bytes.startswith(b"RIFF"):
        raise HTTPException(status_code=400, detail="Invalid WAV file")
    session = save_raw_audio(settings, session_id, audio_bytes)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get("/sessions/{session_id}/audio", response_model=AudioAsset)
def sessions_audio_asset(session_id: str) -> AudioAsset:
    asset = get_audio_asset(get_settings(), session_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return asset


@router.get("/sessions/{session_id}/audio/raw-wav")
def sessions_download_raw_wav(session_id: str) -> FileResponse:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    path = audio_asset_path(settings, session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="raw.wav not found")
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@router.get("/sessions/{session_id}/agent/questions", response_model=list[AgentQuestionEvent])
def sessions_agent_question_events(session_id: str) -> list[AgentQuestionEvent]:
    events = list_agent_question_events(get_settings(), session_id)
    if events is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return events


@router.post("/sessions/{session_id}/agent/questions", response_model=AgentQuestionEvent)
def sessions_append_agent_question_event(
    session_id: str,
    payload: AgentQuestionRequest,
) -> AgentQuestionEvent:
    event = append_agent_question_event(get_settings(), session_id, payload)
    if event is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return event


@router.get("/sessions/{session_id}/transcript", response_model=list[TranscriptTurn])
def sessions_transcript(session_id: str) -> list[TranscriptTurn]:
    transcript = get_transcript(get_settings(), session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return transcript


@router.get("/sessions/{session_id}/transcript/segments", response_model=list[TranscriptSegment])
def sessions_transcript_segments(session_id: str) -> list[TranscriptSegment]:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return _ensure_transcript_segments(settings, session_id)


@router.patch("/sessions/{session_id}/transcript/turns/{turn_id}/speaker", response_model=TranscriptTurn)
def sessions_update_transcript_turn_speaker(
    session_id: str,
    turn_id: str,
    payload: UpdateTranscriptSpeakerRequest,
) -> TranscriptTurn:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    transcript = get_transcript(settings, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")

    updated_turn: TranscriptTurn | None = None
    next_transcript: list[TranscriptTurn] = []
    for turn in transcript:
        if turn.id == turn_id:
            updated_turn = turn.model_copy(update={"speaker": payload.speaker})
            next_transcript.append(updated_turn)
        else:
            next_transcript.append(turn)
    if updated_turn is None:
        raise HTTPException(status_code=404, detail="Transcript turn not found")

    saved = save_transcript(settings, session_id, next_transcript)
    if saved is None:
        raise HTTPException(status_code=404, detail="Session not found")

    segments = _ensure_transcript_segments(settings, session_id)
    next_segments = [
        segment.model_copy(update={"speaker": payload.speaker}) if segment.transcript_turn_id == turn_id else segment
        for segment in segments
    ]
    save_transcript_segments(settings, session_id, next_segments)
    return updated_turn


@router.patch("/sessions/{session_id}/transcript/segments/{segment_id}/speaker", response_model=TranscriptSegment)
def sessions_update_transcript_segment_speaker(
    session_id: str,
    segment_id: str,
    payload: UpdateTranscriptSpeakerRequest,
) -> TranscriptSegment:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    segments = _ensure_transcript_segments(settings, session_id)
    updated_segment: TranscriptSegment | None = None
    next_segments: list[TranscriptSegment] = []
    for segment in segments:
        if segment.id == segment_id:
            updated_segment = segment.model_copy(update={"speaker": payload.speaker})
            next_segments.append(updated_segment)
        else:
            next_segments.append(segment)
    if updated_segment is None:
        raise HTTPException(status_code=404, detail="Transcript segment not found")

    save_transcript_segments(settings, session_id, next_segments)
    _sync_single_segment_turn_speaker(settings, session_id, updated_segment)
    return updated_segment


@router.patch("/sessions/{session_id}/transcript/segments/{segment_id}", response_model=list[TranscriptSegment])
def sessions_update_transcript_segment(
    session_id: str,
    segment_id: str,
    payload: UpdateTranscriptSegmentRequest,
) -> list[TranscriptSegment]:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    segments = _editable_transcript_segments(settings, session_id)

    index = _segment_index(segments, segment_id)
    segment = segments[index]
    start_ms = segment.start_ms if payload.start_ms is None else payload.start_ms
    end_ms = segment.end_ms if payload.end_ms is None else payload.end_ms
    _validate_segment_range(start_ms, end_ms)

    updated = segment.model_copy(
        update={
            "speaker": segment.speaker if payload.speaker is None else payload.speaker,
            "text": segment.text if payload.text is None else payload.text.strip(),
            "corrected_text": segment.corrected_text if payload.corrected_text is None else payload.corrected_text.strip(),
            "start_ms": start_ms,
            "end_ms": end_ms,
            "source": "manual",
            "created_at": utc_now(),
        }
    )
    segments[index] = updated
    segments = _sequence_segments(segments)
    save_transcript_segments(settings, session_id, segments)
    _sync_evidence_refs_for_segments(settings, session_id, {segment.id: updated})
    _sync_single_segment_turn_speaker(settings, session_id, updated)
    return segments


@router.post("/sessions/{session_id}/transcript/segments/{segment_id}/split", response_model=list[TranscriptSegment])
def sessions_split_transcript_segment(
    session_id: str,
    segment_id: str,
    payload: SplitTranscriptSegmentRequest,
) -> list[TranscriptSegment]:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    segments = _editable_transcript_segments(settings, session_id)

    index = _segment_index(segments, segment_id)
    segment = segments[index]
    if payload.split_ms <= segment.start_ms or payload.split_ms >= segment.end_ms:
        raise HTTPException(status_code=400, detail="split_ms must be inside the selected segment time range")

    first_text, second_text = _split_text_at_ratio(
        segment.text,
        payload.split_ms,
        segment.start_ms,
        segment.end_ms,
        payload.first_text,
        payload.second_text,
    )
    first_corrected, second_corrected = _split_text_at_ratio(
        segment.corrected_text,
        payload.split_ms,
        segment.start_ms,
        segment.end_ms,
    )
    first = segment.model_copy(
        update={
            "text": first_text,
            "corrected_text": first_corrected,
            "end_ms": payload.split_ms,
            "source": "manual",
            "created_at": utc_now(),
        }
    )
    second = segment.model_copy(
        update={
            "id": f"seg_manual_{uuid.uuid4().hex[:8]}",
            "text": second_text,
            "corrected_text": second_corrected,
            "start_ms": payload.split_ms,
            "source": "manual",
            "created_at": utc_now(),
        }
    )

    segments[index : index + 1] = [first, second]
    segments = _sequence_segments(segments)
    save_transcript_segments(settings, session_id, segments)
    _sync_evidence_refs_for_segments(settings, session_id, {segment.id: first})
    return segments


@router.post("/sessions/{session_id}/transcript/segments/{segment_id}/merge-next", response_model=list[TranscriptSegment])
def sessions_merge_transcript_segment_next(session_id: str, segment_id: str) -> list[TranscriptSegment]:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    segments = _editable_transcript_segments(settings, session_id)

    index = _segment_index(segments, segment_id)
    if index >= len(segments) - 1:
        raise HTTPException(status_code=400, detail="Selected segment has no next segment to merge")

    segment = segments[index]
    next_segment = segments[index + 1]
    merged = segment.model_copy(
        update={
            "speaker": segment.speaker if segment.speaker == next_segment.speaker else "unknown",
            "text": _join_segment_text(segment.text, next_segment.text),
            "corrected_text": _join_segment_text(segment.corrected_text, next_segment.corrected_text),
            "start_ms": min(segment.start_ms, next_segment.start_ms),
            "end_ms": max(segment.end_ms, next_segment.end_ms),
            "source": "manual",
            "confidence": None,
            "created_at": utc_now(),
        }
    )

    segments[index : index + 2] = [merged]
    segments = _sequence_segments(segments)
    save_transcript_segments(settings, session_id, segments)
    _sync_evidence_refs_for_segments(settings, session_id, {segment.id: merged, next_segment.id: merged})
    _sync_single_segment_turn_speaker(settings, session_id, merged)
    return segments


@router.get("/sessions/{session_id}/transcript/corrected", response_model=CorrectedTranscript)
def sessions_corrected_transcript(session_id: str) -> CorrectedTranscript:
    corrected = get_corrected_transcript(get_settings(), session_id)
    if corrected is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return corrected


@router.post("/sessions/{session_id}/transcript/normalize", response_model=CorrectedTranscript)
def sessions_normalize_transcript(session_id: str) -> CorrectedTranscript:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    transcript = get_transcript(settings, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session = get_session(settings, session_id)
    template = get_template(settings, session.template_id) if session else None
    raw_text = "\n".join(turn.text for turn in transcript if turn.text.strip())
    corrected_text, corrections = normalize_transcript_text(raw_text, template.glossary if template else None)
    corrected = CorrectedTranscript(
        session_id=session_id,
        original_text=raw_text,
        corrected_text=corrected_text,
        corrections=corrections,
        uncertain_segments=[],
        source="local_glossary",
        updated_at=utc_now(),
    )
    saved = save_corrected_transcript(settings, session_id, corrected)
    if saved is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_transcript_segments(settings, session_id)
    _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    return saved


@router.put("/sessions/{session_id}/transcript/corrected", response_model=CorrectedTranscript)
def sessions_update_corrected_transcript(
    session_id: str,
    payload: UpdateCorrectedTranscriptRequest,
) -> CorrectedTranscript:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    existing = get_corrected_transcript(settings, session_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Session not found")
    transcript = get_transcript(settings, session_id) or []
    raw_text = existing.original_text or "\n".join(turn.text for turn in transcript if turn.text.strip())
    corrected = CorrectedTranscript(
        session_id=session_id,
        original_text=raw_text,
        corrected_text=payload.corrected_text,
        corrections=existing.corrections,
        uncertain_segments=existing.uncertain_segments,
        source="manual",
        updated_at=utc_now(),
    )
    saved = save_corrected_transcript(settings, session_id, corrected)
    if saved is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_transcript_segments(settings, session_id)
    _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    return saved


@router.get(
    "/sessions/{session_id}/transcript/correction-suggestions",
    response_model=list[TranscriptCorrectionSuggestion],
)
def sessions_transcript_correction_suggestions(session_id: str) -> list[TranscriptCorrectionSuggestion]:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    suggestions = get_transcript_correction_suggestions(settings, session_id)
    if suggestions:
        return suggestions
    refreshed = _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    return refreshed or []


@router.post(
    "/sessions/{session_id}/transcript/correction-suggestions/scan",
    response_model=list[TranscriptCorrectionSuggestion],
)
def sessions_scan_transcript_correction_suggestions(
    session_id: str,
    auto_apply: bool = True,
) -> list[TranscriptCorrectionSuggestion]:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    suggestions = _refresh_transcript_corrections(settings, session_id, apply_auto=auto_apply)
    if suggestions is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return suggestions


@router.post(
    "/sessions/{session_id}/transcript/correction-suggestions/{suggestion_id}",
    response_model=list[TranscriptCorrectionSuggestion],
)
def sessions_apply_transcript_correction_suggestion(
    session_id: str,
    suggestion_id: str,
    payload: ApplyTranscriptCorrectionSuggestionRequest,
) -> list[TranscriptCorrectionSuggestion]:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    suggestions = apply_transcript_correction_suggestion(
        settings,
        session_id,
        suggestion_id,
        payload.action,
        template.glossary if template else None,
    )
    if suggestions is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not any(item.id == suggestion_id for item in suggestions):
        raise HTTPException(status_code=404, detail="Correction suggestion not found")
    _ensure_transcript_segments(settings, session_id)
    return suggestions


@router.post("/sessions/{session_id}/asr/offline", response_model=RunAsrResponse)
def sessions_run_offline_asr(session_id: str) -> RunAsrResponse:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        result = transcribe_raw_wav(settings, session_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    saved = save_transcript(settings, session_id, result.turns)
    if saved is None:
        raise HTTPException(status_code=404, detail="Session not found")
    source_segments = build_transcript_segments(session_id, result.turns, None)
    save_transcript_segments(settings, session_id, source_segments)
    return RunAsrResponse(
        session_id=session_id,
        transcript=result.turns,
        engine=result.engine,
        status=result.status,
        message=result.message,
    )


@router.get("/sessions/{session_id}/requirements", response_model=list[RequirementItem])
def sessions_requirements(session_id: str) -> list[RequirementItem]:
    settings = get_settings()
    requirements = get_requirements(settings, session_id)
    if requirements is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    return attach_requirement_evidence(requirements, transcript, corrected, segments, session_id)


@router.patch(
    "/sessions/{session_id}/requirements/{requirement_id}/evidence/{evidence_id}/review",
    response_model=RequirementItem,
)
def sessions_update_evidence_review(
    session_id: str,
    requirement_id: str,
    evidence_id: str,
    payload: UpdateEvidenceReviewRequest,
) -> RequirementItem:
    settings = get_settings()
    requirements = get_requirements(settings, session_id)
    if requirements is None:
        raise HTTPException(status_code=404, detail="Session not found")
    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    requirements = attach_requirement_evidence(requirements, transcript, corrected, segments, session_id)

    updated_requirements: list[RequirementItem] = []
    updated_requirement: RequirementItem | None = None
    for requirement in requirements:
        if requirement.id != requirement_id:
            updated_requirements.append(requirement)
            continue
        updated_refs = []
        found_evidence = False
        for evidence in requirement.evidence_refs:
            if evidence.id != evidence_id:
                updated_refs.append(evidence)
                continue
            found_evidence = True
            updated_refs.append(
                evidence.model_copy(
                    update={
                        "review_status": payload.review_status,
                        "review_note": "" if payload.review_status == "unreviewed" else payload.review_note.strip(),
                        "reviewed_at": None if payload.review_status == "unreviewed" else utc_now(),
                    }
                )
            )
        if not found_evidence:
            raise HTTPException(status_code=404, detail="Evidence reference not found")
        updated_requirement = requirement.model_copy(update={"evidence_refs": updated_refs})
        updated_requirements.append(updated_requirement)

    if updated_requirement is None:
        raise HTTPException(status_code=404, detail="Requirement not found")

    _save_requirement_updates(settings, session_id, updated_requirements)
    return updated_requirement


@router.patch(
    "/sessions/{session_id}/requirements/{requirement_id}/evidence/{evidence_id}/relocate",
    response_model=RequirementItem,
)
def sessions_relocate_evidence(
    session_id: str,
    requirement_id: str,
    evidence_id: str,
    payload: UpdateEvidenceRelocationRequest,
) -> RequirementItem:
    settings = get_settings()
    requirements = get_requirements(settings, session_id)
    if requirements is None:
        raise HTTPException(status_code=404, detail="Session not found")
    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    target_segment = next((segment for segment in segments if segment.id == payload.transcript_segment_id), None)
    if target_segment is None:
        raise HTTPException(status_code=404, detail="Transcript segment not found")

    requirements = attach_requirement_evidence(requirements, transcript, corrected, segments, session_id)
    updated_requirements: list[RequirementItem] = []
    updated_requirement: RequirementItem | None = None
    for requirement in requirements:
        if requirement.id != requirement_id:
            updated_requirements.append(requirement)
            continue
        found_evidence = False
        updated_refs = []
        for evidence in requirement.evidence_refs:
            if evidence.id != evidence_id:
                updated_refs.append(evidence)
                continue
            found_evidence = True
            updated_refs.append(
                _evidence_from_segment(
                    evidence=evidence,
                    segment=target_segment,
                    review_status=payload.review_status,
                    review_note=payload.review_note,
                )
            )
        if not found_evidence:
            raise HTTPException(status_code=404, detail="Evidence reference not found")
        updated_requirement = requirement.model_copy(update={"evidence_refs": updated_refs})
        updated_requirements.append(updated_requirement)

    if updated_requirement is None:
        raise HTTPException(status_code=404, detail="Requirement not found")

    _save_requirement_updates(settings, session_id, updated_requirements)
    return updated_requirement


@router.get("/sessions/{session_id}/risks", response_model=list[RiskItem])
def sessions_risks(session_id: str) -> list[RiskItem]:
    risks = get_risks(get_settings(), session_id)
    if risks is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return risks


@router.get("/sessions/{session_id}/open-questions", response_model=list[OpenQuestionItem])
def sessions_open_questions(session_id: str) -> list[OpenQuestionItem]:
    questions = get_open_questions(get_settings(), session_id)
    if questions is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return questions


@router.get("/sessions/{session_id}/analysis", response_model=AnalysisResult)
def sessions_analysis(session_id: str) -> AnalysisResult:
    settings = get_settings()
    result = get_analysis_result(settings, session_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Session not found")
    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    result.requirements = attach_requirement_evidence(result.requirements, transcript, corrected, segments, session_id)
    return result


@router.post("/sessions/{session_id}/analysis/jobs", response_model=AnalysisJobResponse)
def sessions_start_analysis_job(session_id: str) -> AnalysisJobResponse:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")
    transcript = _analysis_transcript(settings, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")
    corrected = get_corrected_transcript(settings, session_id)
    return start_analysis_job(settings, session, template, transcript, corrected.corrections if corrected else [])


@router.get("/analysis/jobs/{job_id}", response_model=AnalysisJobResponse)
def analysis_job_detail(job_id: str) -> AnalysisJobResponse:
    job = get_analysis_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    return job


@router.post("/sessions/{session_id}/analysis/extract", response_model=AnalysisResult)
def sessions_extract_analysis(session_id: str) -> AnalysisResult:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")
    transcript = _analysis_transcript(settings, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")
    set_display_status(settings, session_id, "processing")
    try:
        _refresh_transcript_corrections(settings, session_id, apply_auto=True)
        transcript = _analysis_transcript(settings, session_id) or transcript
        result = analyze_transcript(settings, session, template, transcript)
        corrected = get_corrected_transcript(settings, session_id)
        if corrected and corrected.corrections and not result.prd.transcript_corrections:
            result.prd.transcript_corrections = corrected.corrections
        source_transcript = get_transcript(settings, session_id) or transcript
        segments = _ensure_transcript_segments(settings, session_id)
        result.requirements = attach_requirement_evidence(result.requirements, source_transcript, corrected, segments, session_id)
        saved = save_analysis_result(settings, session_id, result)
        if saved is None:
            raise HTTPException(status_code=404, detail="Session not found")
        return result
    finally:
        set_display_status(settings, session_id, "standby")


@router.post("/sessions/{session_id}/exports/markdown", response_model=MarkdownExportResponse)
def sessions_export_markdown(session_id: str) -> MarkdownExportResponse:
    return sessions_export_requirements_analysis(session_id)


@router.post("/sessions/{session_id}/exports/requirements-analysis", response_model=MarkdownExportResponse)
def sessions_export_requirements_analysis(session_id: str) -> MarkdownExportResponse:
    settings = get_settings()
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")
    transcript = _analysis_transcript(settings, session_id) or []
    requirements = get_requirements(settings, session_id) or []
    source_transcript = get_transcript(settings, session_id) or transcript
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    requirements = attach_requirement_evidence(requirements, source_transcript, corrected, segments, session_id)
    risks = get_risks(settings, session_id) or []
    open_questions = get_open_questions(settings, session_id) or []
    analysis = get_analysis_result(settings, session_id)
    if analysis:
        analysis.requirements = attach_requirement_evidence(analysis.requirements, source_transcript, corrected, segments, session_id)
    path = export_markdown(settings, session, template, transcript, requirements, risks, open_questions, analysis.prd if analysis else None)
    return MarkdownExportResponse(
        session_id=session_id,
        path=str(path.relative_to(settings.root_dir)),
        filename=path.name,
    )


@router.get("/sessions/{session_id}/exports/markdown")
def sessions_download_markdown(session_id: str) -> FileResponse:
    return sessions_download_requirements_analysis(session_id)


@router.get("/sessions/{session_id}/exports/requirements-analysis")
def sessions_download_requirements_analysis(session_id: str) -> FileResponse:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    path = settings.data_dir / "sessions" / session_id / "exports" / "requirements_analysis.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Markdown export not found")
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@router.post("/sessions/{session_id}/exports/prd", response_model=MarkdownExportResponse)
def sessions_export_prd(session_id: str) -> MarkdownExportResponse:
    settings = get_settings()
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")
    requirements = get_requirements(settings, session_id) or []
    transcript = _analysis_transcript(settings, session_id) or []
    source_transcript = get_transcript(settings, session_id) or transcript
    corrected = get_corrected_transcript(settings, session_id)
    segments = _ensure_transcript_segments(settings, session_id)
    requirements = attach_requirement_evidence(requirements, source_transcript, corrected, segments, session_id)
    risks = get_risks(settings, session_id) or []
    open_questions = get_open_questions(settings, session_id) or []
    analysis = get_analysis_result(settings, session_id)
    if analysis:
        analysis.requirements = attach_requirement_evidence(analysis.requirements, source_transcript, corrected, segments, session_id)
    path = export_prd_markdown(
        settings,
        session,
        template,
        requirements,
        risks,
        open_questions,
        analysis.prd if analysis else None,
    )
    return MarkdownExportResponse(
        session_id=session_id,
        path=str(path.relative_to(settings.root_dir)),
        filename=path.name,
    )


@router.get("/sessions/{session_id}/exports/prd")
def sessions_download_prd(session_id: str) -> FileResponse:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    path = settings.data_dir / "sessions" / session_id / "exports" / "prd.md"
    if not path.exists():
        sessions_export_prd(session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="PRD export not found")
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@router.get("/sessions/{session_id}/fde-os/bundle", response_model=FdeOsExportBundle)
def sessions_fde_os_bundle(session_id: str) -> FdeOsExportBundle:
    return _build_fde_os_bundle_for_session(session_id, ensure_exports=False)


@router.get("/sessions/{session_id}/fde-os/bundle/validation", response_model=FdeOsBundleValidationResult)
def sessions_validate_fde_os_bundle(session_id: str) -> FdeOsBundleValidationResult:
    bundle = _build_fde_os_bundle_for_session(session_id, ensure_exports=False)
    return validate_fde_os_bundle(bundle)


@router.get("/sessions/{session_id}/fde-os/store-patch", response_model=FdeOsStorePatch)
def sessions_fde_os_store_patch(session_id: str) -> FdeOsStorePatch:
    bundle = _build_fde_os_bundle_for_session(session_id, ensure_exports=False)
    try:
        return build_fde_os_store_patch(bundle)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post("/sessions/{session_id}/exports/fde-os-bundle", response_model=MarkdownExportResponse)
def sessions_export_fde_os_bundle(session_id: str) -> MarkdownExportResponse:
    settings = get_settings()
    bundle = _build_fde_os_bundle_for_session(session_id, ensure_exports=True)
    path = export_fde_os_bundle(settings, bundle)
    return MarkdownExportResponse(
        session_id=session_id,
        path=str(path.relative_to(settings.root_dir)),
        filename=path.name,
    )


@router.get("/sessions/{session_id}/exports/fde-os-bundle")
def sessions_download_fde_os_bundle(session_id: str) -> FileResponse:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    path = settings.data_dir / "sessions" / session_id / "exports" / "fde_os_bundle.json"
    if not path.exists():
        sessions_export_fde_os_bundle(session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="FDE OS bundle export not found")
    return FileResponse(path, media_type="application/json", filename=path.name)


@router.post("/sessions/{session_id}/exports/fde-os-store-patch", response_model=MarkdownExportResponse)
def sessions_export_fde_os_store_patch(session_id: str) -> MarkdownExportResponse:
    settings = get_settings()
    bundle = _build_fde_os_bundle_for_session(session_id, ensure_exports=True)
    try:
        patch = build_fde_os_store_patch(bundle)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    path = export_fde_os_store_patch(settings, patch)
    return MarkdownExportResponse(
        session_id=session_id,
        path=str(path.relative_to(settings.root_dir)),
        filename=path.name,
    )


@router.get("/sessions/{session_id}/exports/fde-os-store-patch")
def sessions_download_fde_os_store_patch(session_id: str) -> FileResponse:
    settings = get_settings()
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    path = settings.data_dir / "sessions" / session_id / "exports" / "fde_os_store_patch.preview.json"
    if not path.exists():
        sessions_export_fde_os_store_patch(session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="FDE OS store patch export not found")
    return FileResponse(path, media_type="application/json", filename=path.name)


@router.post("/sessions/{session_id}/process", response_model=ProcessSessionResponse)
def sessions_process(session_id: str) -> ProcessSessionResponse:
    settings = get_settings()
    _ensure_demo_writable(settings, session_id)
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")
    set_display_status(settings, session_id, "processing")
    try:
        try:
            asr_result = transcribe_raw_wav(settings, session_id)
        except FileNotFoundError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

        saved_transcript = save_transcript(settings, session_id, asr_result.turns)
        if saved_transcript is None:
            raise HTTPException(status_code=404, detail="Session not found")
        session = saved_transcript[0]
        asr_response = RunAsrResponse(
            session_id=session_id,
            transcript=asr_result.turns,
            engine=asr_result.engine,
            status=asr_result.status,
            message=asr_result.message,
        )

        corrected_text, corrections = normalize_transcript_text(
            "\n".join(turn.text for turn in asr_result.turns if turn.text.strip()),
            template.glossary,
        )
        corrected = CorrectedTranscript(
            session_id=session_id,
            original_text="\n".join(turn.text for turn in asr_result.turns if turn.text.strip()),
            corrected_text=corrected_text,
            corrections=corrections,
            uncertain_segments=[],
            source="local_glossary",
            updated_at=utc_now(),
        )
        save_corrected_transcript(settings, session_id, corrected)
        _refresh_transcript_corrections(settings, session_id, apply_auto=True)
        corrected = get_corrected_transcript(settings, session_id) or corrected
        analysis_turns = _turns_from_corrected(corrected) or asr_result.turns
        analysis = analyze_transcript(settings, session, template, analysis_turns)
        if corrected.corrections and not analysis.prd.transcript_corrections:
            analysis.prd.transcript_corrections = corrected.corrections
        segments = build_transcript_segments(session_id, asr_result.turns, corrected)
        save_transcript_segments(settings, session_id, segments)
        analysis.requirements = attach_requirement_evidence(analysis.requirements, asr_result.turns, corrected, segments, session_id)
        saved_analysis = save_analysis_result(settings, session_id, analysis)
        if saved_analysis is None:
            raise HTTPException(status_code=404, detail="Session not found")

        markdown_path = export_markdown(
            settings,
            saved_analysis,
            template,
            analysis_turns,
            analysis.requirements,
            analysis.risks,
            analysis.open_questions,
            analysis.prd,
        )
        markdown = MarkdownExportResponse(
            session_id=session_id,
            path=str(markdown_path.relative_to(settings.root_dir)),
            filename=markdown_path.name,
        )
        return ProcessSessionResponse(session_id=session_id, asr=asr_response, analysis=analysis, markdown=markdown)
    finally:
        set_display_status(settings, session_id, "standby")


def _ensure_transcript_segments(settings, session_id: str) -> list[TranscriptSegment]:
    transcript = get_transcript(settings, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not transcript:
        return get_transcript_segments(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    previous_segments = get_transcript_segments(settings, session_id) or []
    if any(segment.source == "manual" for segment in previous_segments):
        return previous_segments
    segments = build_transcript_segments(session_id, transcript, corrected)
    segments = _preserve_segment_speakers(segments, previous_segments)
    save_transcript_segments(settings, session_id, segments)
    return segments


def _build_fde_os_bundle_for_session(session_id: str, ensure_exports: bool) -> FdeOsExportBundle:
    settings = get_settings()
    session = get_session(settings, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    template = get_template(settings, session.template_id)
    if template is None:
        raise HTTPException(status_code=400, detail="Template not found")

    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    if corrected is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _refresh_transcript_corrections(settings, session_id, apply_auto=False)
    correction_suggestions = get_transcript_correction_suggestions(settings, session_id) or []
    segments = _ensure_transcript_segments(settings, session_id)
    requirements = get_requirements(settings, session_id) or []
    requirements = attach_requirement_evidence(requirements, transcript, corrected, segments, session_id)
    risks = get_risks(settings, session_id) or []
    open_questions = get_open_questions(settings, session_id) or []
    analysis = get_analysis_result(settings, session_id)
    if analysis is None:
        raise HTTPException(status_code=404, detail="Session not found")
    analysis.requirements = attach_requirement_evidence(analysis.requirements, transcript, corrected, segments, session_id)
    audio = get_audio_asset(settings, session_id)
    if audio is None:
        raise HTTPException(status_code=404, detail="Session not found")
    agent_question_events = list_agent_question_events(settings, session_id) or []

    if ensure_exports:
        export_transcript = _analysis_transcript(settings, session_id) or transcript
        export_markdown(
            settings,
            session,
            template,
            export_transcript,
            requirements,
            risks,
            open_questions,
            analysis.prd,
        )
        export_prd_markdown(
            settings,
            session,
            template,
            requirements,
            risks,
            open_questions,
            analysis.prd,
        )

    return build_fde_os_bundle(
        settings=settings,
        session=session,
        template=template,
        audio=audio,
        transcript=transcript,
        transcript_segments=segments,
        corrected_transcript=corrected,
        correction_suggestions=correction_suggestions,
        analysis=analysis,
        requirements=requirements,
        risks=risks,
        open_questions=open_questions,
        agent_question_events=agent_question_events,
    )


def _refresh_transcript_corrections(
    settings,
    session_id: str,
    apply_auto: bool,
) -> list[TranscriptCorrectionSuggestion] | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    template = get_template(settings, session.template_id)
    return refresh_transcript_correction_suggestions(
        settings,
        session_id,
        template.glossary if template else None,
        apply_auto=apply_auto,
    )


def _editable_transcript_segments(settings, session_id: str) -> list[TranscriptSegment]:
    if get_session(settings, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    segments = get_transcript_segments(settings, session_id)
    if segments is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return segments if segments else _ensure_transcript_segments(settings, session_id)


def _segment_index(segments: list[TranscriptSegment], segment_id: str) -> int:
    for index, segment in enumerate(segments):
        if segment.id == segment_id:
            return index
    raise HTTPException(status_code=404, detail="Transcript segment not found")


def _validate_segment_range(start_ms: int, end_ms: int) -> None:
    if end_ms <= start_ms:
        raise HTTPException(status_code=400, detail="Segment end_ms must be greater than start_ms")


def _sequence_segments(segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
    return [segment.model_copy(update={"sequence": index}) for index, segment in enumerate(segments, start=1)]


def _split_text_at_ratio(
    text: str,
    split_ms: int,
    start_ms: int,
    end_ms: int,
    first_override: str | None = None,
    second_override: str | None = None,
) -> tuple[str, str]:
    if first_override is not None and second_override is not None:
        return first_override.strip(), second_override.strip()
    text = text.strip()
    if not text:
        return "", ""
    if len(text) <= 1:
        return (
            first_override.strip() if first_override is not None else text,
            second_override.strip() if second_override is not None else text,
        )

    ratio = (split_ms - start_ms) / max(1, end_ms - start_ms)
    target = min(len(text) - 1, max(1, round(len(text) * ratio)))
    split_at = _nearest_split_text_index(text, target)
    first_text = text[:split_at].strip()
    second_text = text[split_at:].strip()
    return (
        first_override.strip() if first_override is not None else first_text,
        second_override.strip() if second_override is not None else second_text,
    )


def _nearest_split_text_index(text: str, target: int) -> int:
    lower = max(1, target - 40)
    upper = min(len(text) - 1, target + 40)
    candidates = [
        index + 1
        for index in range(lower, upper)
        if text[index] in {"。", "！", "？", "；", "\n", ".", "!", "?", ";"}
    ]
    if not candidates:
        candidates = [
            index + 1
            for index in range(lower, upper)
            if text[index] in {"，", "、", ",", " "}
        ]
    return min(candidates, key=lambda item: abs(item - target)) if candidates else target


def _join_segment_text(first: str, second: str) -> str:
    parts = [item.strip() for item in [first, second] if item.strip()]
    return "\n".join(parts)


def _sync_evidence_refs_for_segments(
    settings,
    session_id: str,
    segment_map: dict[str, TranscriptSegment],
) -> None:
    requirements = get_requirements(settings, session_id)
    if requirements is None:
        return

    changed = False
    updated_requirements: list[RequirementItem] = []
    for item in requirements:
        next_refs: list[EvidenceReference] = []
        item_changed = False
        for evidence in item.evidence_refs:
            segment = segment_map.get(evidence.transcript_segment_id)
            if segment is None:
                next_refs.append(evidence)
                continue
            next_refs.append(
                evidence.model_copy(
                    update={
                        "transcript_segment_id": segment.id,
                        "transcript_turn_id": segment.transcript_turn_id,
                        "transcript_excerpt": segment.text,
                        "corrected_excerpt": segment.corrected_text,
                        "start_ms": segment.start_ms,
                        "end_ms": segment.end_ms,
                        "source": "manual",
                    }
                )
            )
            item_changed = True
        if item_changed:
            changed = True
            updated_requirements.append(item.model_copy(update={"evidence_refs": next_refs}))
        else:
            updated_requirements.append(item)
    if changed:
        _save_requirement_updates(settings, session_id, updated_requirements)


def _preserve_segment_speakers(
    segments: list[TranscriptSegment],
    previous_segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    previous_by_id = {segment.id: segment for segment in previous_segments if segment.speaker != "unknown"}
    if not previous_by_id:
        return segments

    next_segments: list[TranscriptSegment] = []
    for segment in segments:
        previous = previous_by_id.get(segment.id)
        if previous and _can_preserve_segment_speaker(segment, previous):
            next_segments.append(segment.model_copy(update={"speaker": previous.speaker}))
        else:
            next_segments.append(segment)
    return next_segments


def _can_preserve_segment_speaker(segment: TranscriptSegment, previous: TranscriptSegment) -> bool:
    if segment.transcript_turn_id == previous.transcript_turn_id:
        return True
    if segment.start_ms == previous.start_ms and segment.end_ms == previous.end_ms:
        return True
    return min(segment.end_ms, previous.end_ms) - max(segment.start_ms, previous.start_ms) > 0


def _sync_single_segment_turn_speaker(
    settings,
    session_id: str,
    segment: TranscriptSegment,
) -> None:
    transcript = get_transcript(settings, session_id)
    if transcript is None or not segment.transcript_turn_id:
        return
    segments = get_transcript_segments(settings, session_id) or []
    sibling_segments = [item for item in segments if item.transcript_turn_id == segment.transcript_turn_id]
    if len(sibling_segments) != 1:
        return

    next_transcript: list[TranscriptTurn] = []
    changed = False
    for turn in transcript:
        if turn.id == segment.transcript_turn_id:
            next_transcript.append(turn.model_copy(update={"speaker": segment.speaker}))
            changed = True
        else:
            next_transcript.append(turn)
    if changed:
        save_transcript(settings, session_id, next_transcript)


def _evidence_from_segment(
    *,
    evidence: EvidenceReference,
    segment: TranscriptSegment,
    review_status: str,
    review_note: str,
) -> EvidenceReference:
    note = "" if review_status == "unreviewed" else review_note.strip()
    text = segment.text.strip()
    corrected_text = segment.corrected_text.strip()
    return evidence.model_copy(
        update={
            "transcript_segment_id": segment.id,
            "transcript_turn_id": segment.transcript_turn_id,
            "transcript_excerpt": text,
            "corrected_excerpt": corrected_text,
            "start_ms": segment.start_ms,
            "end_ms": segment.end_ms,
            "source": "manual",
            "confidence": 1.0,
            "review_status": review_status,
            "review_note": note,
            "reviewed_at": None if review_status == "unreviewed" else utc_now(),
        }
    )


def _save_requirement_updates(settings, session_id: str, requirements: list[RequirementItem]) -> None:
    analysis = get_analysis_result(settings, session_id)
    if analysis is not None:
        analysis.requirements = requirements
        save_analysis_result(settings, session_id, analysis)
        return
    save_analysis_items(
        settings,
        session_id,
        requirements,
        get_risks(settings, session_id) or [],
        get_open_questions(settings, session_id) or [],
    )


def _analysis_transcript(settings, session_id: str) -> list[TranscriptTurn] | None:
    corrected = get_corrected_transcript(settings, session_id)
    corrected_turns = _turns_from_corrected(corrected) if corrected else None
    if corrected_turns:
        return corrected_turns
    return get_transcript(settings, session_id)


def _turns_from_corrected(corrected: CorrectedTranscript | None) -> list[TranscriptTurn]:
    if corrected is None or not corrected.corrected_text.strip():
        return []
    return [
        TranscriptTurn(
            id=f"turn_corrected_{uuid.uuid4().hex[:10]}",
            speaker="unknown",
            text=corrected.corrected_text.strip(),
            start_ms=0,
            end_ms=0,
            confidence=None,
            source="manual" if corrected.source == "manual" else "asr",
            created_at=corrected.updated_at,
        )
    ]


def _is_demo_session(settings, session_id: str) -> bool:
    return bool(settings.demo_session_id and session_id == settings.demo_session_id)


def _ensure_demo_writable(settings, session_id: str) -> None:
    if _is_demo_session(settings, session_id):
        raise HTTPException(
            status_code=409,
            detail="Demo session is read-only. Create a new interview session before recording, ASR, correction, or analysis regeneration.",
        )

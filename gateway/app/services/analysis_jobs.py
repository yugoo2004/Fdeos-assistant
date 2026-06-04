from __future__ import annotations

import threading
import uuid

from app.core.settings import Settings
from app.models.export import MarkdownExportResponse
from app.models.pipeline import AnalysisJobResponse
from app.models.session import InterviewSession
from app.models.template import ScenarioTemplate
from app.models.transcript import TranscriptTurn
from app.services.analysis import analyze_transcript_llm, analyze_transcript_local
from app.services.evidence import attach_requirement_evidence, build_transcript_segments
from app.services.exporter import export_markdown
from app.services.storage import (
    get_corrected_transcript,
    get_transcript,
    save_analysis_result,
    save_transcript_segments,
    set_display_status,
    utc_now,
)


_jobs: dict[str, AnalysisJobResponse] = {}
_lock = threading.Lock()


def start_analysis_job(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    transcript_corrections: list[str] | None = None,
) -> AnalysisJobResponse:
    set_display_status(settings, session.id, "processing")
    now = utc_now()
    job = AnalysisJobResponse(
        job_id=f"analysis_{uuid.uuid4().hex[:12]}",
        session_id=session.id,
        status="queued",
        message="Analysis job queued.",
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _jobs[job.job_id] = job
    thread = threading.Thread(
        target=_run_analysis_job,
        args=(job.job_id, settings, session, template, transcript, transcript_corrections or []),
        daemon=True,
    )
    thread.start()
    return job


def get_analysis_job(job_id: str) -> AnalysisJobResponse | None:
    with _lock:
        return _jobs.get(job_id)


def _set_job(job_id: str, **changes: object) -> None:
    with _lock:
        job = _jobs[job_id]
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = utc_now()
        _jobs[job_id] = job


def _run_analysis_job(
    job_id: str,
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    transcript_corrections: list[str],
) -> None:
    _set_job(job_id, status="running", message="Analysis job running.")
    try:
        local_analysis = analyze_transcript_local(
            settings,
            session,
            template,
            transcript,
            message="Local PRD extractor completed; API enhancement may continue in background.",
        )
        if transcript_corrections and not local_analysis.prd.transcript_corrections:
            local_analysis.prd.transcript_corrections = transcript_corrections
        markdown = _save_analysis_and_export(settings, session, template, transcript, local_analysis)
        _set_job(
            job_id,
            status="enhancing",
            message=f"{local_analysis.message} ({local_analysis.engine})",
            analysis=local_analysis,
            markdown=markdown,
        )
        try:
            llm_analysis = analyze_transcript_llm(settings, session, template, transcript)
        except Exception as error:
            set_display_status(settings, session.id, "standby")
            _set_job(
                job_id,
                status="completed",
                message=f"API enhancement failed; kept local result: {error}",
                analysis=local_analysis,
                markdown=markdown,
            )
            return
        if transcript_corrections and not llm_analysis.prd.transcript_corrections:
            llm_analysis.prd.transcript_corrections = transcript_corrections
        enhanced_markdown = _save_analysis_and_export(settings, session, template, transcript, llm_analysis)
        _set_job(
            job_id,
            status="completed",
            message=f"API-enhanced analysis completed. ({llm_analysis.engine})",
            analysis=llm_analysis,
            markdown=enhanced_markdown,
        )
        set_display_status(settings, session.id, "standby")
    except Exception as error:
        set_display_status(settings, session.id, "standby")
        _set_job(job_id, status="failed", message=str(error))


def _save_analysis_and_export(
    settings: Settings,
    session: InterviewSession,
    template: ScenarioTemplate,
    transcript: list[TranscriptTurn],
    analysis,
) -> MarkdownExportResponse:
    source_transcript = get_transcript(settings, session.id) or transcript
    corrected = get_corrected_transcript(settings, session.id)
    segments = build_transcript_segments(session.id, source_transcript, corrected)
    save_transcript_segments(settings, session.id, segments)
    analysis.requirements = attach_requirement_evidence(analysis.requirements, source_transcript, corrected, segments, session.id)
    saved_session = save_analysis_result(settings, session.id, analysis)
    if saved_session is None:
        raise RuntimeError("Session not found while saving analysis.")
    markdown_path = export_markdown(
        settings,
        saved_session,
        template,
        transcript,
        analysis.requirements,
        analysis.risks,
        analysis.open_questions,
        analysis.prd,
    )
    return MarkdownExportResponse(
        session_id=session.id,
        path=str(markdown_path.relative_to(settings.root_dir)),
        filename=markdown_path.name,
    )

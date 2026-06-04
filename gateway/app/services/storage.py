from __future__ import annotations

import json
import shutil
import uuid
import wave
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from app.core.settings import Settings
from app.models.analysis import AnalysisResult, OpenQuestionItem, RequirementItem, RiskItem
from app.models.audit import AgentQuestionEvent, AgentQuestionRequest, AudioAsset
from app.models.session import CreateSessionRequest, DisplayStatus, InterviewSession
from app.models.transcript import (
    CorrectedTranscript,
    TranscriptCorrectionSuggestion,
    TranscriptSegment,
    TranscriptTurn,
)

_runtime_on_air_session_ids: set[str] = set()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_storage(settings: Settings) -> None:
    (settings.data_dir / "sessions").mkdir(parents=True, exist_ok=True)
    settings.templates_dir.mkdir(parents=True, exist_ok=True)


def session_dir(settings: Settings, session_id: str) -> Path:
    return settings.data_dir / "sessions" / session_id


def session_json_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "session.json"


def transcript_segments_json_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "transcript_segments.json"


def create_session(settings: Settings, payload: CreateSessionRequest) -> InterviewSession:
    now = utc_now()
    session_id = f"session_{uuid.uuid4().hex[:12]}"
    audio_path = f"data/sessions/{session_id}/audio/raw.wav"
    session = InterviewSession(
        id=session_id,
        project_name=payload.project_name,
        customer_name=payload.customer_name,
        template_id=payload.template_id,
        mode=payload.mode,
        status="draft",
        created_at=now,
        updated_at=now,
        audio_path=audio_path,
    )
    target_dir = session_dir(settings, session_id)
    (target_dir / "audio").mkdir(parents=True, exist_ok=True)
    (target_dir / "exports").mkdir(parents=True, exist_ok=True)
    write_json(session_json_path(settings, session_id), session.model_dump(mode="json"))
    write_json(target_dir / "transcript.json", [])
    write_json(target_dir / "transcript_segments.json", [])
    write_json(target_dir / "requirements.json", [])
    write_json(target_dir / "risks.json", [])
    write_json(target_dir / "open_questions.json", [])
    return session


def list_sessions(settings: Settings) -> list[InterviewSession]:
    sessions: list[InterviewSession] = []
    sessions_root = settings.data_dir / "sessions"
    if not sessions_root.exists():
        return sessions
    for path in sorted(sessions_root.glob("*/session.json"), reverse=True):
        sessions.append(_read_session(settings, path))
    return sessions


def get_session(settings: Settings, session_id: str) -> InterviewSession | None:
    path = session_json_path(settings, session_id)
    if not path.exists():
        return None
    return _read_session(settings, path)


def delete_session(settings: Settings, session_id: str) -> bool:
    target_dir = session_dir(settings, session_id)
    if not target_dir.exists() or not (target_dir / "session.json").exists():
        return False
    _runtime_on_air_session_ids.discard(session_id)
    shutil.rmtree(target_dir)
    return True


def _read_session(settings: Settings, path: Path) -> InterviewSession:
    payload = read_json(path)
    session = InterviewSession.model_validate(payload)
    if session.status == "active" and session.id not in _runtime_on_air_session_ids:
        session.status = "paused"
    if session.display_status == "on_air" and session.id not in _runtime_on_air_session_ids:
        session.display_status = "standby"
    return session


def save_session(settings: Settings, session: InterviewSession) -> InterviewSession:
    session.updated_at = utc_now()
    write_json(session_json_path(settings, session.id), session.model_dump(mode="json"))
    return session


def start_session(settings: Settings, session_id: str) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    now = utc_now()
    session.status = "active"
    session.display_status = "on_air"
    session.started_at = session.started_at or now
    _runtime_on_air_session_ids.add(session_id)
    return save_session(settings, session)


def pause_session(settings: Settings, session_id: str) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    _runtime_on_air_session_ids.discard(session_id)
    session.status = "paused"
    session.display_status = "standby"
    return save_session(settings, session)


def stop_session(settings: Settings, session_id: str) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    _runtime_on_air_session_ids.discard(session_id)
    session.status = "ended"
    session.display_status = "processing"
    session.ended_at = utc_now()
    return save_session(settings, session)


def set_display_status(
    settings: Settings,
    session_id: str,
    display_status: DisplayStatus,
) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    if display_status != "on_air":
        _runtime_on_air_session_ids.discard(session_id)
    session.display_status = display_status
    return save_session(settings, session)


def save_raw_audio(settings: Settings, session_id: str, audio_bytes: bytes) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    audio_target = session_dir(settings, session_id) / "audio" / "raw.wav"
    audio_target.parent.mkdir(parents=True, exist_ok=True)
    audio_target.write_bytes(audio_bytes)
    session.audio_path = display_path(settings, audio_target)
    return save_session(settings, session)


def audio_asset_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "audio" / "raw.wav"


def get_audio_asset(settings: Settings, session_id: str) -> AudioAsset | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    audio_path = audio_asset_path(settings, session_id)
    asset_display_path = session.audio_path or display_path(settings, audio_path)
    if not audio_path.exists():
        return AudioAsset(
            session_id=session_id,
            exists=False,
            path=asset_display_path,
            filename=audio_path.name,
        )

    duration_ms: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    try:
        with wave.open(str(audio_path), "rb") as wav:
            sample_rate = wav.getframerate()
            channels = wav.getnchannels()
            frames = wav.getnframes()
            duration_ms = int(frames / sample_rate * 1000) if sample_rate else None
    except wave.Error:
        pass

    stat = audio_path.stat()
    return AudioAsset(
        session_id=session_id,
        exists=True,
        path=asset_display_path,
        filename=audio_path.name,
        size_bytes=stat.st_size,
        duration_ms=duration_ms,
        sample_rate=sample_rate,
        channels=channels,
        sha256=sha256(audio_path.read_bytes()).hexdigest(),
        updated_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc),
    )


def display_path(settings: Settings, path: Path) -> str:
    for base in (settings.root_dir, settings.data_dir.parent):
        try:
            return str(path.relative_to(base))
        except ValueError:
            continue
    return str(path)


def agent_question_events_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "agent_question_events.json"


def list_agent_question_events(settings: Settings, session_id: str) -> list[AgentQuestionEvent] | None:
    if get_session(settings, session_id) is None:
        return None
    path = agent_question_events_path(settings, session_id)
    if not path.exists():
        return []
    return [AgentQuestionEvent.model_validate(item) for item in read_json(path)]


def append_agent_question_event(
    settings: Settings,
    session_id: str,
    payload: AgentQuestionRequest,
) -> AgentQuestionEvent | None:
    if get_session(settings, session_id) is None:
        return None
    events = list_agent_question_events(settings, session_id)
    if events is None:
        return None
    event = AgentQuestionEvent(
        id=f"agent_question_{uuid.uuid4().hex[:10]}",
        session_id=session_id,
        question_id=payload.question_id,
        question=payload.question,
        reason=payload.reason,
        owner_role=payload.owner_role,
        source=payload.source,
        created_at=utc_now(),
    )
    events.append(event)
    write_json(agent_question_events_path(settings, session_id), [item.model_dump(mode="json") for item in events])
    return event


def transcript_json_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "transcript.json"


def corrected_transcript_json_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "corrected_transcript.json"


def transcript_correction_suggestions_json_path(settings: Settings, session_id: str) -> Path:
    return session_dir(settings, session_id) / "transcript_correction_suggestions.json"


def get_transcript(settings: Settings, session_id: str) -> list[TranscriptTurn] | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    path = transcript_json_path(settings, session_id)
    if not path.exists():
        return []
    return [TranscriptTurn.model_validate(item) for item in read_json(path)]


def save_transcript(
    settings: Settings,
    session_id: str,
    turns: list[TranscriptTurn],
) -> tuple[InterviewSession, list[TranscriptTurn]] | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    write_json(transcript_json_path(settings, session_id), [turn.model_dump(mode="json") for turn in turns])
    session.transcript_count = len(turns)
    return save_session(settings, session), turns


def get_corrected_transcript(settings: Settings, session_id: str) -> CorrectedTranscript | None:
    if get_session(settings, session_id) is None:
        return None
    path = corrected_transcript_json_path(settings, session_id)
    if not path.exists():
        return CorrectedTranscript(session_id=session_id, updated_at=utc_now())
    return CorrectedTranscript.model_validate(read_json(path))


def save_corrected_transcript(
    settings: Settings,
    session_id: str,
    corrected: CorrectedTranscript,
) -> CorrectedTranscript | None:
    if get_session(settings, session_id) is None:
        return None
    corrected.session_id = session_id
    corrected.updated_at = utc_now()
    write_json(corrected_transcript_json_path(settings, session_id), corrected.model_dump(mode="json"))
    return corrected


def get_transcript_correction_suggestions(
    settings: Settings,
    session_id: str,
) -> list[TranscriptCorrectionSuggestion] | None:
    if get_session(settings, session_id) is None:
        return None
    path = transcript_correction_suggestions_json_path(settings, session_id)
    if not path.exists():
        return []
    return [TranscriptCorrectionSuggestion.model_validate(item) for item in read_json(path)]


def save_transcript_correction_suggestions(
    settings: Settings,
    session_id: str,
    suggestions: list[TranscriptCorrectionSuggestion],
) -> list[TranscriptCorrectionSuggestion] | None:
    if get_session(settings, session_id) is None:
        return None
    write_json(
        transcript_correction_suggestions_json_path(settings, session_id),
        [suggestion.model_dump(mode="json") for suggestion in suggestions],
    )
    return suggestions


def get_transcript_segments(settings: Settings, session_id: str) -> list[TranscriptSegment] | None:
    if get_session(settings, session_id) is None:
        return None
    path = transcript_segments_json_path(settings, session_id)
    if not path.exists():
        return []
    return [TranscriptSegment.model_validate(item) for item in read_json(path)]


def save_transcript_segments(
    settings: Settings,
    session_id: str,
    segments: list[TranscriptSegment],
) -> list[TranscriptSegment] | None:
    if get_session(settings, session_id) is None:
        return None
    write_json(transcript_segments_json_path(settings, session_id), [segment.model_dump(mode="json") for segment in segments])
    return segments


def get_requirements(settings: Settings, session_id: str) -> list[RequirementItem] | None:
    if get_session(settings, session_id) is None:
        return None
    path = session_dir(settings, session_id) / "requirements.json"
    if not path.exists():
        return []
    return [RequirementItem.model_validate(item) for item in read_json(path)]


def get_risks(settings: Settings, session_id: str) -> list[RiskItem] | None:
    if get_session(settings, session_id) is None:
        return None
    path = session_dir(settings, session_id) / "risks.json"
    if not path.exists():
        return []
    return [RiskItem.model_validate(item) for item in read_json(path)]


def get_open_questions(settings: Settings, session_id: str) -> list[OpenQuestionItem] | None:
    if get_session(settings, session_id) is None:
        return None
    path = session_dir(settings, session_id) / "open_questions.json"
    if not path.exists():
        return []
    return [OpenQuestionItem.model_validate(item) for item in read_json(path)]


def get_analysis_result(settings: Settings, session_id: str) -> AnalysisResult | None:
    if get_session(settings, session_id) is None:
        return None
    path = session_dir(settings, session_id) / "analysis.json"
    if not path.exists():
        return AnalysisResult(
            session_id=session_id,
            requirements=get_requirements(settings, session_id) or [],
            risks=get_risks(settings, session_id) or [],
            open_questions=get_open_questions(settings, session_id) or [],
            engine="legacy-files",
            status="completed",
            message="Loaded legacy analysis item files.",
        )
    return AnalysisResult.model_validate(read_json(path))


def save_analysis_items(
    settings: Settings,
    session_id: str,
    requirements: list[RequirementItem],
    risks: list[RiskItem],
    open_questions: list[OpenQuestionItem],
) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    target_dir = session_dir(settings, session_id)
    write_json(target_dir / "requirements.json", [item.model_dump(mode="json") for item in requirements])
    write_json(target_dir / "risks.json", [item.model_dump(mode="json") for item in risks])
    write_json(target_dir / "open_questions.json", [item.model_dump(mode="json") for item in open_questions])
    session.requirement_count = len(requirements)
    return save_session(settings, session)


def save_analysis_result(settings: Settings, session_id: str, result: AnalysisResult) -> InterviewSession | None:
    session = get_session(settings, session_id)
    if session is None:
        return None
    target_dir = session_dir(settings, session_id)
    write_json(target_dir / "analysis.json", result.model_dump(mode="json"))
    write_json(target_dir / "requirements.json", [item.model_dump(mode="json") for item in result.requirements])
    write_json(target_dir / "risks.json", [item.model_dump(mode="json") for item in result.risks])
    write_json(target_dir / "open_questions.json", [item.model_dump(mode="json") for item in result.open_questions])
    session.requirement_count = len(result.requirements)
    return save_session(settings, session)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))

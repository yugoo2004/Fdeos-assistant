from __future__ import annotations

import hashlib
from dataclasses import dataclass

from app.core.settings import Settings
from app.models.transcript import (
    CorrectedTranscript,
    TranscriptCorrectionOccurrence,
    TranscriptCorrectionSuggestion,
    TranscriptSegment,
    TranscriptTurn,
)
from app.services.analysis import DEFAULT_CORRECTIONS, is_transcript_replacement_rule
from app.services.evidence import build_transcript_segments
from app.services.storage import (
    get_corrected_transcript,
    get_session,
    get_transcript,
    get_transcript_correction_suggestions,
    get_transcript_segments,
    save_corrected_transcript,
    save_transcript_correction_suggestions,
    save_transcript_segments,
    utc_now,
)


@dataclass(frozen=True)
class CorrectionRule:
    wrong_text: str
    suggested_text: str
    source: str
    confidence: float
    safe_auto_apply: bool
    reason: str


DOMAIN_CORRECTION_RULES: tuple[CorrectionRule, ...] = ()


def refresh_transcript_correction_suggestions(
    settings: Settings,
    session_id: str,
    glossary: dict[str, str] | None = None,
    apply_auto: bool = False,
) -> list[TranscriptCorrectionSuggestion] | None:
    if get_session(settings, session_id) is None:
        return None

    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    segments = get_transcript_segments(settings, session_id) or []
    original_text = _original_text(transcript, corrected)
    if not original_text.strip():
        save_transcript_correction_suggestions(settings, session_id, [])
        return []

    if corrected is None:
        corrected = CorrectedTranscript(session_id=session_id, original_text=original_text, updated_at=utc_now())

    current_text = corrected.corrected_text or original_text
    rules = _rules(glossary)
    if apply_auto and corrected.source != "manual":
        current_text, applied = _apply_safe_rules(original_text, rules)
        if applied:
            next_corrections = _dedupe([*corrected.corrections, *applied])
            corrected = CorrectedTranscript(
                session_id=session_id,
                original_text=original_text,
                corrected_text=current_text,
                corrections=next_corrections,
                uncertain_segments=corrected.uncertain_segments,
                source="local_glossary",
                updated_at=utc_now(),
            )
            save_corrected_transcript(settings, session_id, corrected)
            _refresh_segments_after_correction(settings, session_id, transcript, corrected, segments)

    existing = {item.id: item for item in (get_transcript_correction_suggestions(settings, session_id) or [])}
    suggestions: list[TranscriptCorrectionSuggestion] = []
    combined_scan_text = f"{original_text}\n{current_text}"
    for rule in rules:
        if rule.wrong_text not in combined_scan_text:
            continue
        suggestion_id = _suggestion_id(rule)
        previous = existing.get(suggestion_id)
        occurrence_count = max(
            combined_scan_text.count(rule.wrong_text),
            original_text.count(rule.wrong_text),
            current_text.count(rule.wrong_text),
        )
        occurrences = _find_occurrences(rule.wrong_text, transcript, segments)
        status = _suggestion_status(rule, previous, original_text, current_text, corrected.source)
        now = utc_now()
        suggestions.append(
            TranscriptCorrectionSuggestion(
                id=suggestion_id,
                session_id=session_id,
                wrong_text=rule.wrong_text,
                suggested_text=rule.suggested_text,
                occurrence_count=occurrence_count,
                occurrences=occurrences,
                confidence=rule.confidence,
                source=rule.source,  # type: ignore[arg-type]
                status=status,
                safe_auto_apply=rule.safe_auto_apply,
                reason=rule.reason,
                created_at=previous.created_at if previous else now,
                updated_at=now,
            )
        )

    suggestions.sort(key=lambda item: _suggestion_sort_key(item))
    save_transcript_correction_suggestions(settings, session_id, suggestions)
    return suggestions


def apply_transcript_correction_suggestion(
    settings: Settings,
    session_id: str,
    suggestion_id: str,
    action: str,
    glossary: dict[str, str] | None = None,
) -> list[TranscriptCorrectionSuggestion] | None:
    if get_session(settings, session_id) is None:
        return None
    suggestions = get_transcript_correction_suggestions(settings, session_id) or []
    if not suggestions:
        suggestions = refresh_transcript_correction_suggestions(settings, session_id, glossary, apply_auto=False) or []

    target = next((item for item in suggestions if item.id == suggestion_id), None)
    if target is None:
        return suggestions

    now = utc_now()
    if action == "ignore":
        next_suggestions = [
            item.model_copy(update={"status": "ignored", "updated_at": now}) if item.id == suggestion_id else item
            for item in suggestions
        ]
        save_transcript_correction_suggestions(settings, session_id, next_suggestions)
        return next_suggestions

    transcript = get_transcript(settings, session_id) or []
    corrected = get_corrected_transcript(settings, session_id)
    original_text = _original_text(transcript, corrected)
    current_text = corrected.corrected_text if corrected and corrected.corrected_text else original_text
    next_text = current_text.replace(target.wrong_text, target.suggested_text)
    correction_label = f"{target.wrong_text} -> {target.suggested_text}"
    next_corrections = _dedupe([*(corrected.corrections if corrected else []), correction_label])
    next_corrected = CorrectedTranscript(
        session_id=session_id,
        original_text=original_text,
        corrected_text=next_text,
        corrections=next_corrections,
        uncertain_segments=corrected.uncertain_segments if corrected else [],
        source="manual",
        updated_at=now,
    )
    save_corrected_transcript(settings, session_id, next_corrected)
    _refresh_segments_after_correction(settings, session_id, transcript, next_corrected, get_transcript_segments(settings, session_id) or [])

    next_suggestions = [
        item.model_copy(update={"status": "applied", "updated_at": now}) if item.id == suggestion_id else item
        for item in suggestions
    ]
    save_transcript_correction_suggestions(settings, session_id, next_suggestions)
    return next_suggestions


def _rules(glossary: dict[str, str] | None) -> list[CorrectionRule]:
    glossary_rules = {
        **DEFAULT_CORRECTIONS,
        **(glossary or {}),
    }
    rules = [
        CorrectionRule(
            wrong_text=wrong,
            suggested_text=right,
            source="glossary",
            confidence=0.96,
            safe_auto_apply=True,
            reason="来自默认或场景模板 glossary，可自动进入校对稿。",
        )
        for wrong, right in glossary_rules.items()
        if is_transcript_replacement_rule(wrong, right)
    ]
    existing_wrong = {rule.wrong_text for rule in rules}
    rules.extend(rule for rule in DOMAIN_CORRECTION_RULES if rule.wrong_text not in existing_wrong)
    return rules


def _apply_safe_rules(text: str, rules: list[CorrectionRule]) -> tuple[str, list[str]]:
    applied: list[str] = []
    next_text = text
    for rule in rules:
        if not rule.safe_auto_apply or rule.wrong_text not in next_text:
            continue
        next_text = next_text.replace(rule.wrong_text, rule.suggested_text)
        applied.append(f"{rule.wrong_text} -> {rule.suggested_text}")
    return next_text, applied


def _refresh_segments_after_correction(
    settings: Settings,
    session_id: str,
    transcript: list[TranscriptTurn],
    corrected: CorrectedTranscript,
    previous_segments: list[TranscriptSegment],
) -> None:
    if not transcript or any(segment.source == "manual" for segment in previous_segments):
        return
    save_transcript_segments(settings, session_id, build_transcript_segments(session_id, transcript, corrected))


def _original_text(transcript: list[TranscriptTurn], corrected: CorrectedTranscript | None) -> str:
    if corrected and corrected.original_text.strip():
        return corrected.original_text
    return "\n".join(turn.text for turn in transcript if turn.text.strip())


def _find_occurrences(
    wrong_text: str,
    transcript: list[TranscriptTurn],
    segments: list[TranscriptSegment],
) -> list[TranscriptCorrectionOccurrence]:
    occurrences: list[TranscriptCorrectionOccurrence] = []
    seen_segments: set[str] = set()
    for segment in segments:
        haystack = "\n".join(value for value in [segment.text, segment.corrected_text] if value)
        if wrong_text not in haystack or segment.id in seen_segments:
            continue
        seen_segments.add(segment.id)
        occurrences.append(
            TranscriptCorrectionOccurrence(
                transcript_segment_id=segment.id,
                transcript_turn_id=segment.transcript_turn_id,
                start_ms=segment.start_ms,
                end_ms=segment.end_ms,
                excerpt=_excerpt(haystack, wrong_text),
            )
        )
        if len(occurrences) >= 4:
            return occurrences

    for turn in transcript:
        if wrong_text not in turn.text:
            continue
        occurrences.append(
            TranscriptCorrectionOccurrence(
                transcript_turn_id=turn.id,
                start_ms=turn.start_ms,
                end_ms=turn.end_ms,
                excerpt=_excerpt(turn.text, wrong_text),
            )
        )
        if len(occurrences) >= 4:
            break
    return occurrences


def _excerpt(text: str, term: str) -> str:
    index = text.find(term)
    if index < 0:
        return " ".join(text[:160].split())
    start = max(0, index - 55)
    end = min(len(text), index + len(term) + 75)
    prefix = "..." if start else ""
    suffix = "..." if end < len(text) else ""
    return " ".join(f"{prefix}{text[start:end].strip()}{suffix}".split())


def _suggestion_status(
    rule: CorrectionRule,
    previous: TranscriptCorrectionSuggestion | None,
    original_text: str,
    current_text: str,
    corrected_source: str,
) -> str:
    if previous and previous.status in {"applied", "ignored"}:
        return previous.status
    if rule.wrong_text in current_text:
        return "pending"
    if rule.wrong_text in original_text and rule.suggested_text in current_text:
        return "auto_applied" if rule.safe_auto_apply and corrected_source != "manual" else "applied"
    return previous.status if previous else "pending"


def _suggestion_id(rule: CorrectionRule) -> str:
    digest = hashlib.sha1(
        f"{rule.wrong_text}->{rule.suggested_text}:{rule.source}".encode("utf-8"),
    ).hexdigest()[:12]
    return f"corr_{digest}"


def _suggestion_sort_key(item: TranscriptCorrectionSuggestion) -> tuple[int, int, float, str]:
    status_order = {"pending": 0, "auto_applied": 1, "applied": 2, "ignored": 3}
    safe_order = 0 if item.safe_auto_apply and item.status == "pending" else 1
    return (status_order.get(item.status, 9), safe_order, -item.confidence, item.wrong_text)


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result

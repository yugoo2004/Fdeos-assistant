from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from math import ceil

from app.models.analysis import EvidenceReference, RequirementItem
from app.models.transcript import CorrectedTranscript, TranscriptSegment, TranscriptTurn


TARGET_SEGMENT_MS = 30_000
MAX_SEGMENT_MS = 40_000
TARGET_SEGMENT_CHARS = 180


@dataclass(frozen=True)
class CorpusSpan:
    start_index: int
    end_index: int
    segment: TranscriptSegment


@dataclass(frozen=True)
class MatchResult:
    start_index: int
    end_index: int
    confidence: float


def attach_requirement_evidence(
    requirements: list[RequirementItem],
    transcript: list[TranscriptTurn],
    corrected: CorrectedTranscript | None = None,
    segments: list[TranscriptSegment] | None = None,
    session_id: str = "",
) -> list[RequirementItem]:
    if not requirements or not transcript:
        return requirements

    source_segments = segments or build_transcript_segments(session_id, transcript, corrected)
    corpus, spans = _build_corpus(source_segments)
    if not corpus.strip() or not spans:
        return requirements

    normalized_corpus, index_map = _normalize_with_index(corpus)
    enriched: list[RequirementItem] = []
    for item in requirements:
        if _has_usable_reviewed_evidence(item):
            enriched.append(item)
            continue
        match = _match_requirement(item, corpus, normalized_corpus, index_map)
        if match is None:
            enriched.append(item)
            continue
        start_ms, end_ms, turn_id, segment_id = _time_range(match, len(corpus), spans)
        excerpt = _excerpt(corpus, match.start_index, match.end_index)
        enriched.append(
            item.model_copy(
                update={
                    "evidence_refs": [
                        EvidenceReference(
                            id=f"ev_{item.id}_1",
                            transcript_segment_id=segment_id,
                            transcript_turn_id=turn_id,
                            transcript_excerpt=excerpt,
                            corrected_excerpt=excerpt if _segment_source(spans, segment_id) == "corrected" else "",
                            start_ms=start_ms,
                            end_ms=end_ms,
                            source="auto_match",
                            confidence=match.confidence,
                        )
                    ]
                }
            )
        )
    return enriched


def build_transcript_segments(
    session_id: str,
    transcript: list[TranscriptTurn],
    corrected: CorrectedTranscript | None,
) -> list[TranscriptSegment]:
    if not transcript:
        return []

    corrected_text = corrected.corrected_text.strip() if corrected and corrected.corrected_text.strip() else ""
    if corrected_text:
        first_turn = transcript[0]
        last_turn = transcript[-1]
        return _segments_for_text(
            session_id=corrected.session_id or session_id,
            transcript_turn_id=first_turn.id,
            sequence_start=1,
            speaker="unknown",
            text=corrected_text,
            source="corrected",
            start_ms=first_turn.start_ms,
            end_ms=max(last_turn.end_ms, first_turn.end_ms),
            confidence=None,
            created_at=corrected.updated_at,
        )

    segments: list[TranscriptSegment] = []
    sequence = 1
    for turn in transcript:
        if not turn.text.strip():
            continue
        turn_segments = _segments_for_text(
            session_id=session_id,
            transcript_turn_id=turn.id,
            sequence_start=sequence,
            speaker=turn.speaker,
            text=turn.text.strip(),
            source="asr" if turn.source == "asr" else "manual",
            start_ms=turn.start_ms,
            end_ms=turn.end_ms,
            confidence=turn.confidence,
            created_at=turn.created_at,
        )
        segments.extend(turn_segments)
        sequence += len(turn_segments)
    return segments


def _segments_for_text(
    *,
    session_id: str,
    transcript_turn_id: str,
    sequence_start: int,
    speaker: str,
    text: str,
    source: str,
    start_ms: int,
    end_ms: int,
    confidence: float | None,
    created_at: datetime,
) -> list[TranscriptSegment]:
    duration_ms = max(0, end_ms - start_ms)
    chunk_count = max(1, ceil(duration_ms / TARGET_SEGMENT_MS), ceil(len(text) / TARGET_SEGMENT_CHARS))
    if duration_ms and duration_ms / chunk_count > MAX_SEGMENT_MS:
        chunk_count = ceil(duration_ms / MAX_SEGMENT_MS)
    chunks = _split_text_chunks(text, chunk_count)
    segments: list[TranscriptSegment] = []
    text_length = max(1, len(text))
    for offset, (chunk_start, chunk_end, chunk_text) in enumerate(chunks):
        local_start_ms = start_ms + int(duration_ms * (chunk_start / text_length)) if duration_ms else start_ms
        local_end_ms = start_ms + int(duration_ms * (chunk_end / text_length)) if duration_ms else end_ms
        if local_end_ms <= local_start_ms:
            local_end_ms = local_start_ms + 1000
        sequence = sequence_start + offset
        segments.append(
            TranscriptSegment(
                id=f"seg_{sequence:04d}",
                session_id=session_id,
                transcript_turn_id=transcript_turn_id,
                sequence=sequence,
                speaker=speaker,  # type: ignore[arg-type]
                text=chunk_text,
                corrected_text=chunk_text if source == "corrected" else "",
                start_ms=local_start_ms,
                end_ms=local_end_ms,
                source=source,  # type: ignore[arg-type]
                confidence=confidence,
                created_at=created_at or datetime.now(timezone.utc),
            )
        )
    return segments


def _split_text_chunks(text: str, chunk_count: int) -> list[tuple[int, int, str]]:
    if chunk_count <= 1 or len(text) <= TARGET_SEGMENT_CHARS:
        return [(0, len(text), text.strip())]

    chunks: list[tuple[int, int, str]] = []
    cursor = 0
    for index in range(chunk_count):
        if cursor >= len(text):
            break
        if index == chunk_count - 1:
            end = len(text)
        else:
            target_end = round(len(text) * (index + 1) / chunk_count)
            end = _nearest_sentence_boundary(text, cursor, target_end)
        chunk_text = text[cursor:end].strip()
        if chunk_text:
            chunks.append((cursor, end, chunk_text))
        cursor = end
    return chunks or [(0, len(text), text.strip())]


def _nearest_sentence_boundary(text: str, start: int, target_end: int) -> int:
    lower = max(start + 40, round(target_end - TARGET_SEGMENT_CHARS * 0.45))
    upper = min(len(text), round(target_end + TARGET_SEGMENT_CHARS * 0.45))
    if lower >= upper:
        return min(len(text), max(start + 1, target_end))
    candidates = [
        index + 1
        for index in range(lower, upper)
        if text[index] in {"。", "！", "？", "；", "\n", ".", "!", "?", ";"}
    ]
    if candidates:
        return min(candidates, key=lambda item: abs(item - target_end))
    soft_candidates = [index + 1 for index in range(lower, upper) if text[index] in {"，", "、", ",", " "}]
    if soft_candidates:
        return min(soft_candidates, key=lambda item: abs(item - target_end))
    return min(len(text), max(start + 1, target_end))


def _has_usable_reviewed_evidence(item: RequirementItem) -> bool:
    if not item.evidence_refs:
        return False
    evidence = item.evidence_refs[0]
    if evidence.review_status != "unreviewed":
        return True
    if evidence.transcript_segment_id and evidence.end_ms - evidence.start_ms <= MAX_SEGMENT_MS + 10_000:
        return True
    return False


def _build_corpus(segments: list[TranscriptSegment]) -> tuple[str, list[CorpusSpan]]:
    chunks: list[str] = []
    spans: list[CorpusSpan] = []
    cursor = 0
    for segment in segments:
        text = (segment.corrected_text or segment.text).strip()
        if not text:
            continue
        if chunks:
            chunks.append("\n\n")
            cursor += 2
        start = cursor
        chunks.append(text)
        cursor += len(text)
        spans.append(CorpusSpan(start, cursor, segment))
    return "".join(chunks), spans


def _segment_source(spans: list[CorpusSpan], segment_id: str) -> str:
    for span in spans:
        if span.segment.id == segment_id:
            return span.segment.source
    return ""


def _match_requirement(
    item: RequirementItem,
    corpus: str,
    normalized_corpus: str,
    index_map: list[int],
) -> MatchResult | None:
    for phrase in _candidate_phrases(item):
        normalized_phrase = _normalize_text(phrase)
        if len(normalized_phrase) < 6:
            continue
        offset = normalized_corpus.find(normalized_phrase)
        if offset >= 0:
            return MatchResult(
                start_index=index_map[offset],
                end_index=index_map[min(offset + len(normalized_phrase) - 1, len(index_map) - 1)] + 1,
                confidence=0.92,
            )

    terms = _match_terms(item)
    if not terms:
        terms = []
    match = _best_window_match(corpus, normalized_corpus, index_map, terms)
    if match is not None:
        return match

    hint_terms = _fallback_hint_terms(item)
    if hint_terms:
        return _best_window_match(corpus, normalized_corpus, index_map, hint_terms, minimum_score=2, low_confidence=True)
    return None


def _candidate_phrases(item: RequirementItem) -> list[str]:
    phrases = [item.evidence, item.description, item.user_story]
    phrases.extend(item.business_rules)
    phrases.extend(item.acceptance_criteria)
    return [phrase.strip() for phrase in phrases if phrase and len(_normalize_text(phrase)) >= 6]


def _match_terms(item: RequirementItem) -> list[str]:
    source_values: list[str] = [
        item.title,
        item.module,
        *item.data_entities,
        *item.dependencies,
        item.evidence,
        *item.business_rules,
        *item.acceptance_criteria,
        item.description,
        item.user_story,
    ]
    terms: list[str] = []
    for value in source_values:
        normalized = _normalize_text(value)
        if len(normalized) >= 2:
            terms.append(normalized)
        if len(normalized) >= 6:
            terms.extend(_meaningful_ngrams(normalized))
    unique_terms: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if term in seen or term in {"系统", "用户", "景区", "游客", "照片", "内容"}:
            continue
        seen.add(term)
        unique_terms.append(term)
    return unique_terms[:120]


def _fallback_hint_terms(item: RequirementItem) -> list[str]:
    text = _normalize_text(
        " ".join(
            [
                item.title,
                item.description,
                item.evidence,
                item.module,
                " ".join(item.business_rules),
                " ".join(item.acceptance_criteria),
            ]
        )
    )
    groups: list[list[str]] = []
    if any(marker in text for marker in ["上传", "质量", "预检", "符合要求"]):
        groups.append(["上传自拍照片", "上传照片", "自动修片", "照片", "满足", "要求", "小程序"])
    if any(marker in text for marker in ["玩法", "古装", "合影", "名人", "修图"]):
        groups.append(["一键拍同款", "服装", "风格", "套系", "ai修片", "普通修图", "小程序"])
    if any(marker in text for marker in ["素材", "专属模型", "幻觉", "本地"]):
        groups.append(["专有数据", "定向训练", "符合本地", "幻觉", "本地", "景点绑定"])
    if any(marker in text for marker in ["合规", "拦截", "敏感", "审核", "日本"]):
        groups.append(["避免", "幻觉", "符合本地", "景区", "审核", "规则", "绑定"])
    if any(marker in text for marker in ["成本", "性能", "一分钟", "一元", "并发", "分辨率"]):
        groups.append(["分分钟", "成本", "一张照片", "三元", "快速", "交付", "等待"])
    if any(marker in text for marker in ["可用率", "一致性", "返工", "本人", "验收"]):
        groups.append(["出片率", "免翻车", "保障", "普通", "用户", "保存", "分享"])

    terms: list[str] = []
    for group in groups:
        terms.extend(_normalize_text(value) for value in group if _normalize_text(value))
    return _dedupe_terms(terms)


def _meaningful_ngrams(value: str) -> list[str]:
    grams: list[str] = []
    for size in (3, 4, 6, 8):
        if len(value) < size:
            continue
        for index in range(0, len(value) - size + 1, max(2, size // 2)):
            grams.append(value[index : index + size])
    return grams


def _best_window_match(
    corpus: str,
    normalized_corpus: str,
    index_map: list[int],
    terms: list[str],
    minimum_score: int = 4,
    low_confidence: bool = False,
) -> MatchResult | None:
    if not normalized_corpus or not index_map:
        return None

    window_size = min(max(180, len(normalized_corpus) // 8), 420)
    step = max(50, window_size // 3)
    best_score = 0
    best_start = 0
    best_end = min(window_size, len(normalized_corpus))
    for start in range(0, len(normalized_corpus), step):
        end = min(len(normalized_corpus), start + window_size)
        window = normalized_corpus[start:end]
        score = 0
        for term in terms:
            if term in window:
                score += min(10, max(2, len(term) // 2))
        if score > best_score:
            best_score = score
            best_start = start
            best_end = end
        if end == len(normalized_corpus):
            break

    if best_score < minimum_score:
        return None
    confidence_base = 0.34 if low_confidence else 0.42
    confidence_cap = 0.58 if low_confidence else 0.82
    return MatchResult(
        start_index=index_map[best_start],
        end_index=index_map[min(best_end - 1, len(index_map) - 1)] + 1,
        confidence=min(confidence_cap, confidence_base + best_score / 100),
    )


def _dedupe_terms(terms: list[str]) -> list[str]:
    unique_terms: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if not term or term in seen:
            continue
        seen.add(term)
        unique_terms.append(term)
    return unique_terms


def _time_range(match: MatchResult, corpus_length: int, spans: list[CorpusSpan]) -> tuple[int, int, str, str]:
    matching_span = spans[0]
    for span in spans:
        if span.start_index <= match.start_index <= span.end_index:
            matching_span = span
            break

    segment = matching_span.segment
    span_length = max(1, matching_span.end_index - matching_span.start_index)
    duration = max(0, segment.end_ms - segment.start_ms)
    local_start = max(0, match.start_index - matching_span.start_index)
    local_end = min(span_length, max(local_start + 1, match.end_index - matching_span.start_index))

    if len(spans) == 1 and spans[0].start_index == 0 and spans[0].end_index == corpus_length:
        span_length = max(1, corpus_length)
        local_start = max(0, match.start_index)
        local_end = min(span_length, max(local_start + 1, match.end_index))

    start_ms = segment.start_ms + int(duration * (local_start / span_length)) if duration else segment.start_ms
    end_ms = segment.start_ms + int(duration * (local_end / span_length)) if duration else segment.end_ms
    if end_ms - start_ms < 8000:
        padding = 4000
        start_ms = max(segment.start_ms, start_ms - padding)
        end_ms = min(segment.end_ms or start_ms + 8000, end_ms + padding)
    return start_ms, max(end_ms, start_ms + 1000), segment.transcript_turn_id, segment.id


def _excerpt(corpus: str, start: int, end: int) -> str:
    excerpt_start = max(0, start - 55)
    excerpt_end = min(len(corpus), end + 85)
    prefix = "..." if excerpt_start > 0 else ""
    suffix = "..." if excerpt_end < len(corpus) else ""
    excerpt = " ".join(f"{prefix}{corpus[excerpt_start:excerpt_end].strip()}{suffix}".split())
    if len(excerpt) > 260:
        return f"{excerpt[:260]}..."
    return excerpt


def _normalize_with_index(value: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    indexes: list[int] = []
    for index, char in enumerate(value):
        normalized = _normalize_char(char)
        if normalized:
            chars.append(normalized)
            indexes.append(index)
    return "".join(chars), indexes


def _normalize_text(value: str) -> str:
    return "".join(_normalize_char(char) for char in value)


def _normalize_char(char: str) -> str:
    if re.match(r"[\u4e00-\u9fffA-Za-z0-9]", char):
        return char.lower()
    return ""

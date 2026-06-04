from __future__ import annotations

import json
import os
import subprocess
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path

from app.core.settings import Settings
from app.models.transcript import TranscriptTurn
from app.services.storage import utc_now


SHERPA_NODE_MODULE = Path(
    "/Users/aerfa/.npm-global/lib/node_modules/@getpaseo/cli/node_modules/sherpa-onnx-node/sherpa-onnx.js"
)


@dataclass(frozen=True)
class AsrResult:
    turns: list[TranscriptTurn]
    engine: str
    status: str
    message: str


def transcribe_raw_wav(settings: Settings, session_id: str) -> AsrResult:
    audio_path = settings.data_dir / "sessions" / session_id / "audio" / "raw.wav"
    if not audio_path.exists():
        raise FileNotFoundError(f"raw.wav not found: {audio_path}")

    model_dir = os.getenv("SHERPA_ONNX_MODEL_DIR", "").strip()
    if model_dir:
        return _transcribe_with_sherpa_node(audio_path, Path(model_dir))

    return _pending_model_result(audio_path)


def _pending_model_result(audio_path: Path) -> AsrResult:
    size_kb = audio_path.stat().st_size / 1024
    turn = TranscriptTurn(
        id=f"turn_{uuid.uuid4().hex[:12]}",
        speaker="unknown",
        text=(
            "已保存原始录音，等待配置 sherpa-onnx ASR 模型后生成真实转写。"
            f" 当前 raw.wav 大小 {size_kb:.1f} KB。"
        ),
        start_ms=0,
        end_ms=0,
        confidence=None,
        source="pending_asr",
        created_at=utc_now(),
    )
    return AsrResult(
        turns=[turn],
        engine="sherpa-onnx-node",
        status="pending_model",
        message="Local ASR model is not configured. Set SHERPA_ONNX_MODEL_DIR to a local sherpa-onnx model directory.",
    )


def _transcribe_with_sherpa_node(audio_path: Path, model_dir: Path) -> AsrResult:
    segments = _segment_wav(audio_path)
    if len(segments) > 1:
        return _transcribe_segments_with_sherpa_node(audio_path, model_dir, segments)
    return _transcribe_single_wav_with_sherpa_node(audio_path, model_dir, start_ms=0, end_ms=segments[0][1])


def _transcribe_segments_with_sherpa_node(
    audio_path: Path,
    model_dir: Path,
    segments: list[tuple[int, int]],
) -> AsrResult:
    chunk_dir = audio_path.parent / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for old_chunk in chunk_dir.glob("chunk_*.wav"):
        old_chunk.unlink()

    turns: list[TranscriptTurn] = []
    for index, (start_ms, end_ms) in enumerate(segments, start=1):
        chunk_path = chunk_dir / f"chunk_{index:04d}_{start_ms}_{end_ms}.wav"
        _write_wav_segment(audio_path, chunk_path, start_ms, end_ms)
        result = _transcribe_single_wav_with_sherpa_node(chunk_path, model_dir, start_ms=start_ms, end_ms=end_ms)
        turns.extend(turn for turn in result.turns if turn.text.strip() and turn.text != "ASR 未返回可用文本。")

    if not turns:
        turns.append(
            TranscriptTurn(
                id=f"turn_{uuid.uuid4().hex[:12]}",
                speaker="unknown",
                text="ASR 未返回可用文本。",
                start_ms=0,
                end_ms=segments[-1][1] if segments else 0,
                confidence=None,
                source="asr",
                created_at=utc_now(),
            )
        )
    return AsrResult(
        turns=turns,
        engine="sherpa-onnx-node-vad",
        status="completed",
        message=f"Local ASR completed with sherpa-onnx and local VAD chunking. segments={len(segments)}.",
    )


def _transcribe_single_wav_with_sherpa_node(audio_path: Path, model_dir: Path, start_ms: int, end_ms: int) -> AsrResult:
    script_path = Path(__file__).resolve().parent / "sherpa_asr_node.mjs"
    env = os.environ.copy()
    env["SHERPA_ONNX_NODE_MODULE"] = os.getenv("SHERPA_ONNX_NODE_MODULE", "").strip() or str(SHERPA_NODE_MODULE)
    env["SHERPA_ONNX_MODEL_DIR"] = str(model_dir)
    completed = subprocess.run(
        ["node", str(script_path), str(audio_path)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=int(os.getenv("FDE_ASR_CHUNK_TIMEOUT_SECONDS", "90")),
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "sherpa-onnx failed")

    payload = json.loads(completed.stdout)
    text = str(payload.get("text", "")).strip()
    if not text:
        text = "ASR 未返回可用文本。"
    turn = TranscriptTurn(
        id=f"turn_{uuid.uuid4().hex[:12]}",
        speaker="unknown",
        text=text,
        start_ms=start_ms,
        end_ms=end_ms or int(payload.get("duration_ms") or 0),
        confidence=None,
        source="asr",
        created_at=utc_now(),
    )
    return AsrResult(
        turns=[turn],
        engine="sherpa-onnx-node",
        status="completed",
        message="Local ASR completed with sherpa-onnx node adapter. No external transcription service was used.",
    )


def _segment_wav(audio_path: Path) -> list[tuple[int, int]]:
    with wave.open(str(audio_path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frame_count = wav.getnframes()
        if channels != 1 or sample_width != 2:
            duration_ms = int(frame_count / sample_rate * 1000)
            return [(0, duration_ms)]
        pcm = wav.readframes(frame_count)

    frame_ms = int(os.getenv("FDE_ASR_VAD_FRAME_MS", "30"))
    max_segment_ms = int(os.getenv("FDE_ASR_MAX_SEGMENT_MS", "18000"))
    min_segment_ms = int(os.getenv("FDE_ASR_MIN_SEGMENT_MS", "8000"))
    silence_ms = int(os.getenv("FDE_ASR_SPLIT_SILENCE_MS", "500"))
    samples_per_frame = max(1, int(sample_rate * frame_ms / 1000))
    bytes_per_frame = samples_per_frame * sample_width
    total_duration_ms = int(frame_count / sample_rate * 1000)
    if total_duration_ms <= max_segment_ms:
        return [(0, total_duration_ms)]

    rms_values: list[tuple[int, float]] = []
    for offset in range(0, len(pcm), bytes_per_frame):
        frame = pcm[offset : offset + bytes_per_frame]
        if len(frame) < 2:
            continue
        rms_values.append((int((offset / sample_width) / sample_rate * 1000), _pcm16_rms(frame)))
    if not rms_values:
        return [(0, total_duration_ms)]
    sorted_rms = sorted(value for _, value in rms_values)
    noise_floor = sorted_rms[max(0, int(len(sorted_rms) * 0.2) - 1)]
    threshold = max(350.0, noise_floor * 2.8)

    segments: list[tuple[int, int]] = []
    segment_start = 0
    silence_start: int | None = None
    for frame_start, rms in rms_values:
        elapsed = frame_start - segment_start
        is_silent = rms < threshold
        if is_silent:
            silence_start = frame_start if silence_start is None else silence_start
        else:
            silence_start = None

        can_split_on_silence = (
            silence_start is not None
            and frame_start - silence_start >= silence_ms
            and elapsed >= min_segment_ms
        )
        must_split = elapsed >= max_segment_ms
        if can_split_on_silence or must_split:
            split_at = silence_start if can_split_on_silence else frame_start
            split_at = max(segment_start + min_segment_ms, min(split_at, total_duration_ms))
            segments.append((segment_start, split_at))
            segment_start = split_at
            silence_start = None

    if total_duration_ms - segment_start >= 1000:
        segments.append((segment_start, total_duration_ms))
    elif segments:
        last_start, _ = segments[-1]
        segments[-1] = (last_start, total_duration_ms)

    return _merge_short_segments(segments, min_segment_ms, max_segment_ms)


def _pcm16_rms(frame: bytes) -> float:
    if len(frame) < 2:
        return 0.0
    total = 0
    count = len(frame) // 2
    for index in range(0, count * 2, 2):
        sample = int.from_bytes(frame[index : index + 2], byteorder="little", signed=True)
        total += sample * sample
    return (total / count) ** 0.5


def _merge_short_segments(segments: list[tuple[int, int]], min_segment_ms: int, max_segment_ms: int) -> list[tuple[int, int]]:
    if not segments:
        return []
    merged: list[tuple[int, int]] = []
    for start, end in segments:
        if merged and end - start < min_segment_ms and end - merged[-1][0] <= max_segment_ms:
            previous_start, _ = merged[-1]
            merged[-1] = (previous_start, end)
        else:
            merged.append((start, end))
    return merged


def _write_wav_segment(source_path: Path, target_path: Path, start_ms: int, end_ms: int) -> None:
    with wave.open(str(source_path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        start_frame = int(start_ms * sample_rate / 1000)
        end_frame = int(end_ms * sample_rate / 1000)
        source.setpos(max(0, start_frame))
        frames = source.readframes(max(0, end_frame - start_frame))

    with wave.open(str(target_path), "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(sample_width)
        target.setframerate(sample_rate)
        target.writeframes(frames)


def local_asr_status() -> dict[str, object]:
    model_dir = os.getenv("SHERPA_ONNX_MODEL_DIR", "").strip()
    model_path = Path(model_dir) if model_dir else None
    return {
        "mode": "local_only",
        "engine": "sherpa-onnx-node",
        "external_asr_enabled": False,
        "model_dir": model_dir,
        "model_ready": bool(model_path and model_path.exists()),
        "vad": {
            "min_segment_ms": int(os.getenv("FDE_ASR_MIN_SEGMENT_MS", "8000")),
            "max_segment_ms": int(os.getenv("FDE_ASR_MAX_SEGMENT_MS", "18000")),
            "split_silence_ms": int(os.getenv("FDE_ASR_SPLIT_SILENCE_MS", "500")),
        },
    }

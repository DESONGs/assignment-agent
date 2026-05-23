import hashlib
import json
import math
import time
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from mlx_qwen3_asr import Session


@dataclass
class Source:
    path: str
    basename: str
    type: str
    sizeBytes: int
    modifiedAt: str
    hashSha256: str
    source: str
    privacy: str
    durationSec: float
    sampleRate: int
    channels: int
    bitsPerSample: int
    chunkSeconds: float
    chunkCount: int


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def iso_mtime(path: Path) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(path.stat().st_mtime))


def media_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}:
        return "audio"
    if ext in {".mp4", ".mov", ".mkv", ".avi", ".webm"}:
        return "video"
    return "unknown"


def read_wav_float32(path: Path) -> tuple[np.ndarray, dict]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        sample_width = wf.getsampwidth()
        frames = wf.getnframes()
        raw = wf.readframes(frames)

    if sample_width != 2:
        raise ValueError(f"Only 16-bit PCM WAV is supported by the local ASR MVP: {path}")

    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    return np.ascontiguousarray(audio), {
        "channels": channels,
        "sampleRate": sample_rate,
        "bitsPerSample": sample_width * 8,
        "frames": frames,
        "durationSec": frames / sample_rate,
    }


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def source_metadata(path: Path, chunk_seconds: float, source_label: str, privacy: str) -> tuple[Source, np.ndarray]:
    audio, wav_meta = read_wav_float32(path)
    duration = float(wav_meta["durationSec"])
    return Source(
        path=str(path),
        basename=path.name,
        type=media_type(path),
        sizeBytes=path.stat().st_size,
        modifiedAt=iso_mtime(path),
        hashSha256=sha256_file(path),
        source=source_label,
        privacy=privacy,
        durationSec=round(duration, 3),
        sampleRate=int(wav_meta["sampleRate"]),
        channels=int(wav_meta["channels"]),
        bitsPerSample=int(wav_meta["bitsPerSample"]),
        chunkSeconds=chunk_seconds,
        chunkCount=math.ceil(duration / chunk_seconds),
    ), audio


def chunk_to_segment(chunk: dict) -> dict:
    return {
        "id": chunk["id"],
        "sourceFile": chunk["sourceFile"],
        "sourceHashSha256": chunk["sourceHashSha256"],
        "chunkIndex": chunk["chunkIndex"],
        "startSec": chunk["startSec"],
        "endSec": chunk["endSec"],
        "text": chunk["text"],
        "language": chunk.get("language", ""),
        "model": chunk["model"],
        "modelPath": chunk["modelPath"],
        "endpoint": chunk["endpoint"],
    }


def transcribe_file(
    session: Session,
    wav_path: Path,
    output_dir: Path,
    chunk_seconds: float,
    language: str | None,
    context: str,
    max_new_tokens: int | None,
    source_label: str,
    privacy: str,
    model_dir: Path,
    limit_chunks: int | None,
) -> dict:
    source, audio = source_metadata(wav_path, chunk_seconds, source_label, privacy)
    sample_rate = source.sampleRate
    samples_per_chunk = int(round(chunk_seconds * sample_rate))
    chunks_path = output_dir / "transcripts" / f"{wav_path.stem}.chunks.json"
    existing = read_json(chunks_path) or {}
    existing_chunks = {c.get("chunkIndex"): c for c in existing.get("chunks", [])}
    chunks = []

    total = source.chunkCount if limit_chunks is None else min(source.chunkCount, limit_chunks)
    print(f"LOCAL_ASR file={source.basename} chunks={total}/{source.chunkCount}", flush=True)

    for chunk_index in range(total):
        prior = existing_chunks.get(chunk_index)
        if prior and prior.get("status") == "success" and prior.get("text"):
            chunks.append(prior)
            print(f"LOCAL_ASR skip {source.basename} chunk {chunk_index + 1}/{total}", flush=True)
            continue

        start_sample = chunk_index * samples_per_chunk
        end_sample = min(len(audio), (chunk_index + 1) * samples_per_chunk)
        start_sec = start_sample / sample_rate
        end_sec = end_sample / sample_rate
        chunk_audio = np.ascontiguousarray(audio[start_sample:end_sample], dtype=np.float32)
        chunk_id = f"{wav_path.stem}-c{chunk_index:03d}-s1"
        started = time.time()

        try:
            result = session.transcribe(
                chunk_audio,
                context=context,
                language=language,
                return_chunks=False,
                return_timestamps=False,
                max_new_tokens=max_new_tokens,
                verbose=False,
            )
            text = (result.text or "").strip()
            chunk = {
                "status": "success" if text else "empty",
                "id": chunk_id,
                "sourceFile": source.basename,
                "sourceHashSha256": source.hashSha256,
                "chunkIndex": chunk_index,
                "startSec": round(start_sec, 3),
                "endSec": round(end_sec, 3),
                "text": text,
                "language": result.language,
                "model": "mlx-community/Qwen3-ASR-1.7B-4bit",
                "modelPath": str(model_dir),
                "endpoint": "local-mlx-metal",
                "finishReason": result.finish_reason,
                "truncated": result.truncated,
                "elapsedSec": round(time.time() - started, 3),
                "error": None,
            }
        except Exception as exc:
            chunk = {
                "status": "failed",
                "id": chunk_id,
                "sourceFile": source.basename,
                "sourceHashSha256": source.hashSha256,
                "chunkIndex": chunk_index,
                "startSec": round(start_sec, 3),
                "endSec": round(end_sec, 3),
                "text": "",
                "language": "",
                "model": "mlx-community/Qwen3-ASR-1.7B-4bit",
                "modelPath": str(model_dir),
                "endpoint": "local-mlx-metal",
                "finishReason": None,
                "truncated": False,
                "elapsedSec": round(time.time() - started, 3),
                "error": repr(exc),
            }

        chunks.append(chunk)
        print(
            f"LOCAL_ASR {chunk['status']} {source.basename} chunk {chunk_index + 1}/{total} "
            f"{chunk['startSec']:.1f}-{chunk['endSec']:.1f}s elapsed={chunk['elapsedSec']}",
            flush=True,
        )

        transcript_segments = [chunk_to_segment(c) for c in chunks if c.get("status") == "success" and c.get("text")]
        write_json(
            chunks_path,
            {
                "source": asdict(source),
                "chunkSeconds": chunk_seconds,
                "model": "mlx-community/Qwen3-ASR-1.7B-4bit",
                "modelPath": str(model_dir),
                "endpoint": "local-mlx-metal",
                "language": language,
                "context": context,
                "chunks": chunks,
                "transcriptSegments": transcript_segments,
                "failedChunks": [c["chunkIndex"] for c in chunks if c.get("status") != "success"],
                "partial": limit_chunks is not None and total < source.chunkCount,
            },
        )

    return read_json(chunks_path)


def build_full_outputs(
    output_dir: Path,
    meeting_id: str,
    meeting_title: str,
    file_runs: list[dict],
    chunk_seconds: float,
    model_dir: Path,
) -> dict:
    sources = [run["source"] for run in file_runs]
    segments = []
    failed = []
    partial = any(run.get("partial") for run in file_runs)
    for run in file_runs:
        segments.extend(run.get("transcriptSegments", []))
        failed.extend(
            {
                "sourceFile": c["sourceFile"],
                "chunkIndex": c["chunkIndex"],
                "startSec": c["startSec"],
                "endSec": c["endSec"],
                "status": c["status"],
                "error": c.get("error"),
            }
            for c in run.get("chunks", [])
            if c.get("status") != "success"
        )

    transcript = {
        "meetingId": meeting_id,
        "chunkSeconds": chunk_seconds,
        "transcription": {
            "model": "mlx-community/Qwen3-ASR-1.7B-4bit",
            "modelPath": str(model_dir),
            "endpoint": "local-mlx-metal",
            "externalAudioUpload": False,
        },
        "sources": sources,
        "transcriptSegments": segments,
        "failedChunks": failed,
    }
    evidence = {
        "meetingTitle": meeting_title,
        "meetingId": meeting_id,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "sources": sources,
        "transcriptSegments": segments,
        "rules": {
            "keyClaimsRequireSource": True,
            "rawTranscriptLongTermMemory": False,
            "externalAudioUpload": False,
            "textEvidenceExternalLlmDefault": "allow",
            "rawMediaExternalUploadDefault": "deny",
        },
    }
    summary = {
        "status": "needs_review" if failed else "partial" if partial else "complete",
        "meetingId": meeting_id,
        "sourceCount": len(sources),
        "transcriptSegments": len(segments),
        "failedChunks": len(failed),
        "partial": partial,
        "modelPath": str(model_dir),
        "externalAudioUpload": False,
        "textEvidenceExternalLlmDefault": "allow",
        "rawMediaExternalUploadDefault": "deny",
        "outputs": {
            "sources": str(output_dir / "evidence" / "sources.json"),
            "transcript": str(output_dir / "transcripts" / "transcript.full.json"),
            "evidenceIndex": str(output_dir / "evidence" / "evidence-index.json"),
            "summary": str(output_dir / "summary.json"),
        },
    }

    write_json(output_dir / "transcripts" / "transcript.full.json", transcript)
    write_json(output_dir / "evidence" / "sources.json", {"assets": sources})
    write_json(output_dir / "evidence" / "evidence-index.json", evidence)
    write_json(output_dir / "summary.json", summary)
    return summary


def prepare_output_dir(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for child in ["transcripts", "evidence", "logs"]:
        (output_dir / child).mkdir(parents=True, exist_ok=True)


def resolve_wav_paths(paths: list[str]) -> list[Path]:
    resolved = [Path(p).expanduser().resolve() for p in paths]
    for path in resolved:
        if not path.exists():
            raise FileNotFoundError(path)
        if path.suffix.lower() != ".wav":
            raise ValueError(f"Local ASR MVP currently supports WAV input only: {path}")
    return resolved


def run_transcription(
    paths: list[str],
    meeting_id: str,
    output_dir: str | Path,
    meeting_title: str = "Local ASR Meeting",
    model_dir: str | Path = "models/Qwen3-ASR-1.7B-MLX-4bit",
    chunk_seconds: float = 30.0,
    language: str | None = "Chinese",
    context: str = "会议录音，中文为主，可能夹杂英文术语、人名、产品名。",
    max_new_tokens: int | None = 512,
    source: str = "local",
    privacy: str = "private",
    limit_chunks: int | None = None,
    session: Session | None = None,
) -> dict:
    model_dir = Path(model_dir).expanduser().resolve()
    output_dir = Path(output_dir).expanduser().resolve()
    prepare_output_dir(output_dir)

    if not model_dir.exists():
        raise FileNotFoundError(f"Missing local ASR model directory: {model_dir}")

    wav_paths = resolve_wav_paths(paths)
    language = language.strip() or None if isinstance(language, str) else language

    if session is None:
        print(f"LOCAL_ASR loading_model {model_dir}", flush=True)
        session = Session(model=str(model_dir))
        print("LOCAL_ASR model_loaded", flush=True)

    runs = [
        transcribe_file(
            session=session,
            wav_path=path,
            output_dir=output_dir,
            chunk_seconds=chunk_seconds,
            language=language,
            context=context,
            max_new_tokens=max_new_tokens,
            source_label=source,
            privacy=privacy,
            model_dir=model_dir,
            limit_chunks=limit_chunks,
        )
        for path in wav_paths
    ]
    summary = build_full_outputs(output_dir, meeting_id, meeting_title, runs, chunk_seconds, model_dir)
    return summary

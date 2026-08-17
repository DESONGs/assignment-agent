#!/usr/bin/env python3
"""Host-owned runtime artifact store CLI.

runtime-store-v1 implements the local data backend described in
wiki/14-local-data-storage-cache-backend.md:

- Host-owned SQLite metadata; Docker workers do not write DB.
- Hybrid CAS for large/cacheable artifacts under runtime-runs/_store/objects/sha256.
- Small JSON/state/metrics/manifest control files stay in compatibility run dirs.
- Workspace-bound, indexed-only, pinned-safe retention cleanup with retention_actions.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME_ROOT = ROOT / "runtime-runs"
DEFAULT_DB = DEFAULT_RUNTIME_ROOT / "_store" / "runtime-store.sqlite"
STORE_SCHEMA_VERSION = "runtime-store-v1"
CONTRACT_MANIFEST_PATH = ROOT / "meeting-agent-pi-package" / "runtime" / "contract-manifest.json"
RUNTIME_CONTRACT_SCHEMA_VERSION = "assignment-agent-runtime-contracts-v1"
HASH_CHUNK_BYTES = 1024 * 1024
BOUNDED_PREVIEW_CHARS = 1200
CONTROL_FILE_NAMES = {
    "event.json",
    "source-events.ndjson",
    "task.json",
    "state.json",
    "run.metrics.json",
    "run-manifest.json",
    "publish.json",
    "reply.json",
    "progress-replies.ndjson",
    "agent-task.md",
    "agent-output.json",
    "pi.stdout.txt",
    "pi.stderr.txt",
}
NEVER_DELETE_TOP_LEVEL = {
    "meeting-agent-pi-package",
    "src",
    "wiki",
    "models",
    ".git",
    ".env",
}
SECRET_KEYWORDS = (
    "app_secret",
    "client_secret",
    "refresh_token",
    "access_token",
    "authorization",
    "cookie",
    "session",
    "tenant_access_token",
    "bearer ",
    "api_key",
)
TEXT_EXTENSIONS = {
    ".json",
    ".ndjson",
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".xml",
    ".log",
}
RAW_MEDIA_EXTENSIONS = {
    ".amr",
    ".opus",
    ".pcm",
    ".speex",
    ".wma",
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".webm",
    ".flv",
    ".mpeg",
    ".wmv",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".heic",
}
AUDIO_EXTENSIONS = {
    ".amr",
    ".opus",
    ".pcm",
    ".speex",
    ".wma",
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
}
AUDIO_MIN_READY_BYTES = 4096
FIXTURE_RUN_MARKERS = ("fixture", "mock", "dry_run", "dry-run", "fake_lark", "fake-lark")
RAW_DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".md",
    ".markdown",
    ".txt",
    ".csv",
    ".tsv",
}
CAS_KINDS = {
    "raw_media",
    "normalized_audio",
    "raw_document_file",
    "extracted_text",
    "transcript_evidence",
    "bounded_docker_bundle",
    "docker_worker_artifact",
    "generated_document",
    "runtime_tool_artifact",
    "model_stream_trace",
}
TTL_SECONDS_BY_KIND = {
    "recent_source": 30 * 60,
    "bounded_docker_bundle": 7 * 24 * 3600,
    "docker_worker_artifact": 7 * 24 * 3600,
    "normalized_audio": 7 * 24 * 3600,
    "runtime_tool_artifact": 14 * 24 * 3600,
    "model_stream_trace": 14 * 24 * 3600,
    "extracted_text": 30 * 24 * 3600,
    "raw_media": 45 * 24 * 3600,
    "raw_document_file": 60 * 24 * 3600,
    "transcript_evidence": 60 * 24 * 3600,
    "observability": 60 * 24 * 3600,
    "generated_document": 90 * 24 * 3600,
    "sanitized_learning": 180 * 24 * 3600,
}
KIND_MAX_BYTES = {
    "raw_media": 12 * 1024**3,
    "normalized_audio": 2 * 1024**3,
    "bounded_docker_bundle": 1024**3,
    "docker_worker_artifact": 1024**3,
    "runtime_tool_artifact": 1024**3,
    "model_stream_trace": 1024**3,
    "extracted_text": 2 * 1024**3,
    "transcript_evidence": 2 * 1024**3,
    "raw_document_file": 5 * 1024**3,
    "observability": 512 * 1024**2,
    "generated_document": 1024**3,
    "sanitized_learning": 512 * 1024**2,
}
DELETE_ORDER = {
    "normalized_audio": 10,
    "bounded_docker_bundle": 20,
    "docker_worker_artifact": 25,
    "runtime_tool_artifact": 30,
    "model_stream_trace": 35,
    "extracted_text": 50,
    "transcript_evidence": 60,
    "raw_media": 70,
    "raw_document_file": 80,
    "observability": 90,
    "generated_document": 100,
    "sanitized_learning": 110,
}


class StoreError(RuntimeError):
    """Runtime store command error."""


def load_runtime_contract_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(CONTRACT_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StoreError(f"runtime contract manifest unavailable: {exc}") from exc
    if manifest.get("schemaVersion") != RUNTIME_CONTRACT_SCHEMA_VERSION:
        raise StoreError("runtime contract manifest version mismatch")
    runtime_store = manifest.get("runtimeStore")
    if not isinstance(runtime_store, dict) or runtime_store.get("schemaVersion") != STORE_SCHEMA_VERSION:
        raise StoreError("runtime store contract version mismatch")
    statuses = runtime_store.get("resultStatuses")
    if not isinstance(statuses, list) or not all(isinstance(item, str) for item in statuses):
        raise StoreError("runtime store result status contract invalid")
    return manifest


def validate_runtime_store_result(value: Any) -> Any:
    if not isinstance(value, dict):
        raise StoreError("runtime store CLI result must be an object")
    runtime_store = load_runtime_contract_manifest()["runtimeStore"]
    status = value.get("status")
    if status is not None and status not in set(runtime_store["resultStatuses"]):
        raise StoreError(f"runtime store result status is not in contract: {status}")
    schema_version = value.get("schemaVersion")
    if schema_version is not None and schema_version != STORE_SCHEMA_VERSION:
        raise StoreError(f"runtime store result schema mismatch: {schema_version}")
    return value


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def unix_timestamp_iso(value: float | int) -> str:
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def add_seconds(timestamp: str | None, seconds: int | None) -> str | None:
    if not seconds:
        return None
    base = parse_iso(timestamp) or dt.datetime.now(dt.timezone.utc)
    return (base + dt.timedelta(seconds=seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ttl_seconds_for(conn: sqlite3.Connection, kind: str) -> int | None:
    row = conn.execute(
        """
        SELECT ttl_seconds
        FROM retention_policies
        WHERE kind = ? AND enabled = 1
        ORDER BY delete_order ASC
        LIMIT 1
        """,
        (kind,),
    ).fetchone()
    if row and row["ttl_seconds"] is not None:
        return int(row["ttl_seconds"])
    return TTL_SECONDS_BY_KIND.get(kind)


def hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_json_load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def print_json(value: Any, *, validate: bool = True) -> None:
    payload = validate_runtime_store_result(value) if validate else value
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def is_inside(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def workspace_path(value: str | Path, *, must_exist: bool = False) -> Path:
    raw = Path(value)
    resolved = raw.resolve() if raw.is_absolute() else (ROOT / raw).resolve()
    if not is_inside(ROOT, resolved):
        raise StoreError(f"workspace-bound path required: {value}")
    if must_exist and not resolved.exists():
        raise StoreError(f"path does not exist: {value}")
    return resolved


def store_relative(path: str | Path | None) -> str | None:
    if not path:
        return None
    resolved = workspace_path(path)
    return str(resolved.relative_to(ROOT))


def path_from_db(value: str | None) -> Path | None:
    if not value:
        return None
    return workspace_path(value)


def ensure_runtime_root(value: str | Path | None) -> Path:
    root = workspace_path(value or DEFAULT_RUNTIME_ROOT)
    root.mkdir(parents=True, exist_ok=True)
    return root


def default_db_for_root(runtime_root: Path) -> Path:
    return runtime_root / "_store" / "runtime-store.sqlite"


def resolve_db(args: argparse.Namespace, runtime_root: Path | None = None) -> Path:
    db_value = getattr(args, "db", None)
    if db_value:
        db = workspace_path(db_value)
    elif runtime_root:
        db = default_db_for_root(runtime_root)
    else:
        db = DEFAULT_DB
    if not is_inside(ROOT, db):
        raise StoreError("runtime store DB must stay inside workspace")
    return db


def redact_preview(value: str) -> str:
    output = str(value)
    for keyword in SECRET_KEYWORDS:
        lowered = output.lower()
        start = lowered.find(keyword)
        while start >= 0:
            end = output.find("\n", start)
            if end < 0:
                end = min(len(output), start + 160)
            output = f"{output[:start]}[redacted]{output[end:]}"
            lowered = output.lower()
            start = lowered.find(keyword)
    return output[:BOUNDED_PREVIEW_CHARS]


def bounded_preview(path: Path, kind: str, size: int) -> str | None:
    if kind in {"raw_media", "normalized_audio", "raw_document_file"} and path.suffix.lower() not in TEXT_EXTENSIONS:
        return None
    if path.suffix.lower() not in TEXT_EXTENSIONS and kind not in {"extracted_text", "transcript_evidence", "generated_document", "observability"}:
        return None
    try:
        raw = path.read_bytes()[:8192]
        text = raw.decode("utf-8", errors="ignore")
        return redact_preview(" ".join(text.split()))
    except Exception:
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extension(path: Path) -> str:
    suffix = path.suffix.lower()
    if not suffix:
        return ""
    if len(suffix) > 16:
        return ""
    if not suffix.startswith("."):
        return ""
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789.")
    return suffix if all(char in allowed for char in suffix) else ""


def is_fixture_run_id(run_id: str | None) -> bool:
    lowered = str(run_id or "").lower()
    return any(marker in lowered for marker in FIXTURE_RUN_MARKERS)


def is_audio_path(path: Path | None) -> bool:
    return bool(path and path.suffix.lower() in AUDIO_EXTENSIONS)


def audio_signature_status(path: Path) -> dict[str, Any]:
    """Validate that a local audio artifact is plausible before reuse.

    Marker: raw-audio-signature-validation invalid_audio_header fixture_artifact_excluded.
    """
    if not path.exists() or not path.is_file():
        return {"ok": False, "reason": "audio_file_missing"}
    size = path.stat().st_size
    suffix = path.suffix.lower()
    if size < AUDIO_MIN_READY_BYTES:
        return {"ok": False, "reason": "audio_file_too_small", "sizeBytes": size, "minBytes": AUDIO_MIN_READY_BYTES}
    try:
        with path.open("rb") as handle:
            head = handle.read(64)
    except Exception as exc:
        return {"ok": False, "reason": "audio_header_read_failed", "error": str(exc)}
    ok = False
    reason = "invalid_audio_header"
    if suffix == ".wav":
        ok = len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    elif suffix == ".mp3":
        ok = head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    elif suffix == ".m4a":
        ok = b"ftyp" in head[:16]
    elif suffix == ".flac":
        ok = head.startswith(b"fLaC")
    elif suffix == ".ogg":
        ok = head.startswith(b"OggS")
    elif suffix == ".aac":
        ok = len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xF0) == 0xF0
    elif suffix == ".amr":
        ok = head.startswith(b"#!AMR")
    elif suffix == ".opus":
        ok = head.startswith(b"OggS") or b"OpusHead" in head[:16]
    elif suffix == ".wma":
        ok = head.startswith(bytes((0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11)))
    elif suffix in {".pcm", ".speex"}:
        ok = True
    else:
        ok = True
        reason = "non_audio_extension"
    return {"ok": ok, "reason": None if ok else reason, "sizeBytes": size, "extension": suffix}


def audio_artifact_ready(row: sqlite3.Row) -> tuple[bool, dict[str, Any] | None]:
    if row["kind"] != "raw_media":
        return True, None
    candidates = [path_from_db(row["path"]), path_from_db(row["object_path"])]
    audio_paths = [path for path in candidates if path and is_audio_path(path)]
    if not audio_paths:
        return True, None
    for path in audio_paths:
        status = audio_signature_status(path)
        if status["ok"]:
            return True, status
    return False, audio_signature_status(audio_paths[0])


def object_path_for(runtime_root: Path, digest: str, path: Path) -> Path:
    ext = safe_extension(path)
    return runtime_root / "_store" / "objects" / "sha256" / digest[:2] / digest[2:4] / f"{digest}{ext}"


def should_cas(kind: str, path: Path, size: int) -> bool:
    if size <= 0:
        return False
    if path.name in CONTROL_FILE_NAMES:
        return False
    if kind in CAS_KINDS:
        return True
    return size >= 1024 * 1024


def ensure_cas_object(runtime_root: Path, path: Path, digest: str) -> Path:
    object_path = object_path_for(runtime_root, digest, path)
    object_path.parent.mkdir(parents=True, exist_ok=True)
    if not object_path.exists():
        tmp = object_path.with_name(f".{object_path.name}.{os.getpid()}.tmp")
        shutil.copy2(path, tmp)
        os.replace(tmp, object_path)
    return object_path


def replace_with_compat_link(target: Path, object_path: Path) -> str:
    if target.resolve() == object_path.resolve():
        return "object"
    if target.exists() and target.stat().st_ino == object_path.stat().st_ino:
        return "hardlink"
    tmp = target.with_name(f".{target.name}.runtime-store-link-{os.getpid()}")
    if tmp.exists() or tmp.is_symlink():
        tmp.unlink()
    try:
        os.link(object_path, tmp)
        mode = "hardlink"
    except OSError:
        try:
            os.symlink(os.path.relpath(object_path, target.parent), tmp)
            mode = "symlink"
        except OSError:
            shutil.copy2(object_path, tmp)
            mode = "copy"
    os.replace(tmp, target)
    return mode


def privacy_class_for(kind: str, path: Path) -> str:
    if kind in {"raw_media", "normalized_audio"}:
        return "raw_media"
    if kind == "raw_document_file":
        return "source_document"
    if kind in {"extracted_text", "transcript_evidence", "generated_document", "model_stream_trace"}:
        return "derived_content"
    if kind in {"bounded_docker_bundle", "docker_worker_artifact"}:
        return "bounded_artifact"
    return "metadata"


def kind_for_path(path: Path, run_dir: Path | None = None) -> str:
    parts = set(path.parts)
    suffix = path.suffix.lower()
    name = path.name
    if name in CONTROL_FILE_NAMES:
        return "observability"
    if "audio-normalized" in parts or "audio-normalized" in path.as_posix():
        return "normalized_audio"
    if "transcripts" in parts or "evidence" in parts or name in {"summary.json", "evidence-pack.json"}:
        return "transcript_evidence"
    if "docker-worker" in parts:
        return "bounded_docker_bundle" if name in {"task.json", "job.json"} else "docker_worker_artifact"
    if "runtime-tool-results" in parts or "runtime-tool-params" in parts:
        return "runtime_tool_artifact"
    if "model-streams" in parts:
        return "model_stream_trace"
    if run_dir and is_inside(run_dir / "inputs" / "file-context", path):
        return "extracted_text"
    if run_dir and is_inside(run_dir / "inputs" / "attachments", path):
        if suffix in RAW_MEDIA_EXTENSIONS:
            return "raw_media"
        if suffix in RAW_DOCUMENT_EXTENSIONS:
            return "raw_document_file"
    if suffix in RAW_MEDIA_EXTENSIONS:
        return "raw_media"
    if suffix in RAW_DOCUMENT_EXTENSIONS:
        return "generated_document" if suffix in {".md", ".markdown"} and run_dir and is_inside(run_dir / "artifacts", path) else "raw_document_file"
    return "observability"


def artifact_id_for(run_id: str | None, kind: str, rel_path: str) -> str:
    return hash_text(f"{run_id or ''}:{kind}:{rel_path}")[:32]


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  execution_profile TEXT,
  task_type TEXT,
  status TEXT NOT NULL,
  source_event_hash TEXT,
  run_dir TEXT NOT NULL,
  manifest_path TEXT,
  metrics_path TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  total_bytes INTEGER DEFAULT 0,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  expires_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  path TEXT NOT NULL,
  object_path TEXT,
  sha256 TEXT,
  size_bytes INTEGER DEFAULT 0,
  mime_type TEXT,
  extension TEXT,
  link_mode TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  bounded_preview TEXT,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha ON artifacts(sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind_expiry ON artifacts(kind, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(path);

CREATE TABLE IF NOT EXISTS source_refs (
  source_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id_hash TEXT,
  chat_id_hash TEXT,
  thread_id_hash TEXT,
  file_name TEXT,
  mime_type TEXT,
  source_sha256 TEXT,
  file_key TEXT,
  artifact_id TEXT,
  resolved_from TEXT,
  explicit_reference INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS recent_sources (
  recent_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  sender_id_hash TEXT NOT NULL,
  thread_key_hash TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  artifact_id TEXT,
  message_time_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS file_text_cache (
  cache_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  method TEXT,
  status TEXT NOT NULL,
  extracted_artifact_id TEXT,
  preview_hash TEXT,
  chars INTEGER DEFAULT 0,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_hit_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (extracted_artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS asr_cache (
  cache_key TEXT PRIMARY KEY,
  source_set_hash TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  target_spec_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  chunk_seconds INTEGER NOT NULL,
  language TEXT,
  status TEXT NOT NULL,
  transcript_artifact_id TEXT,
  evidence_artifact_id TEXT,
  summary_artifact_id TEXT,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_hit_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (transcript_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (evidence_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (summary_artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS worker_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  execution_profile TEXT,
  queue_name TEXT,
  result_key TEXT,
  status TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  worker_id TEXT,
  job_artifact_id TEXT,
  result_artifact_id TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  retry_later INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (job_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (result_artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS publish_records (
  publish_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  document_artifact_id TEXT,
  target_kind TEXT NOT NULL,
  target_pointer_hash TEXT,
  status TEXT NOT NULL,
  publish_artifact_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (document_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (publish_artifact_id) REFERENCES artifacts(artifact_id)
);

CREATE TABLE IF NOT EXISTS retention_policies (
  policy_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  ttl_seconds INTEGER,
  max_bytes INTEGER,
  delete_order INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS retention_actions (
  action_id TEXT PRIMARY KEY,
  artifact_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  bytes_reclaimed INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    source_ref_columns = {row["name"] for row in conn.execute("PRAGMA table_info(source_refs)").fetchall()}
    if "file_key" not in source_ref_columns:
        conn.execute("ALTER TABLE source_refs ADD COLUMN file_key TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_source_refs_file_key ON source_refs(file_key)")
    policies = []
    for kind, ttl in TTL_SECONDS_BY_KIND.items():
        policies.append(
            (
                f"{kind}-default",
                kind,
                privacy_class_for(kind, Path(kind)),
                ttl,
                KIND_MAX_BYTES.get(kind),
                DELETE_ORDER.get(kind, 90),
                1,
            )
        )
    conn.executemany(
        """
        INSERT INTO retention_policies(policy_id, kind, privacy_class, ttl_seconds, max_bytes, delete_order, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          ttl_seconds=excluded.ttl_seconds,
          max_bytes=excluded.max_bytes,
          delete_order=excluded.delete_order,
          enabled=excluded.enabled
        """,
        policies,
    )
    conn.commit()


def put_object(runtime_root: Path, path: Path, *, replace: bool) -> dict[str, Any]:
    path = workspace_path(path, must_exist=True)
    if not path.is_file():
        raise StoreError(f"put-object requires a file path: {path}")
    digest = sha256_file(path)
    size = path.stat().st_size
    object_path = ensure_cas_object(runtime_root, path, digest)
    mode = None
    if replace:
        mode = replace_with_compat_link(path, object_path)
    return {
        "status": "stored",
        "sha256": digest,
        "sizeBytes": size,
        "objectPath": store_relative(object_path),
        "path": store_relative(path),
        "linkMode": mode,
    }


def register_artifact(
    conn: sqlite3.Connection,
    runtime_root: Path,
    path: Path,
    *,
    run_id: str | None,
    kind: str | None = None,
    cas: bool = False,
    source_run_id: str | None = None,
) -> dict[str, Any] | None:
    path = workspace_path(path, must_exist=True)
    if not path.is_file():
        return None
    if any(part in {".git", "node_modules"} for part in path.parts):
        return None
    rel_path = store_relative(path)
    assert rel_path is not None
    run_dir_for_kind = None
    if run_id:
        run_row = conn.execute("SELECT run_dir FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if run_row:
            run_dir_for_kind = workspace_path(run_row["run_dir"])
    file_kind = kind or kind_for_path(path, run_dir_for_kind)
    privacy = privacy_class_for(file_kind, path)
    if privacy == "secret":
        raise StoreError("secret artifacts are not allowed in runtime store")
    stat = path.stat()
    digest = sha256_file(path)
    object_rel = None
    link_mode = None
    if cas and should_cas(file_kind, path, stat.st_size):
        object_path = ensure_cas_object(runtime_root, path, digest)
        link_mode = replace_with_compat_link(path, object_path)
        object_rel = store_relative(object_path)
    artifact_id = artifact_id_for(run_id, file_kind, rel_path)
    created = unix_timestamp_iso(stat.st_mtime)
    last_accessed = created
    expires = add_seconds(created, ttl_seconds_for(conn, file_kind))
    mime_type = mimetypes.guess_type(path.name)[0]
    preview = bounded_preview(path, file_kind, stat.st_size)
    conn.execute(
        """
        INSERT INTO artifacts(
          artifact_id, run_id, kind, privacy_class, path, object_path, sha256, size_bytes,
          mime_type, extension, link_mode, status, bounded_preview, source_run_id,
          created_at, last_accessed_at, expires_at, pinned, deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(artifact_id) DO UPDATE SET
          run_id=excluded.run_id,
          kind=excluded.kind,
          privacy_class=excluded.privacy_class,
          path=excluded.path,
          object_path=COALESCE(excluded.object_path, artifacts.object_path),
          sha256=excluded.sha256,
          size_bytes=excluded.size_bytes,
          mime_type=excluded.mime_type,
          extension=excluded.extension,
          link_mode=COALESCE(excluded.link_mode, artifacts.link_mode),
          status='ready',
          bounded_preview=excluded.bounded_preview,
          source_run_id=excluded.source_run_id,
          last_accessed_at=COALESCE(artifacts.last_accessed_at, excluded.last_accessed_at),
          expires_at=excluded.expires_at,
          deleted_at=NULL
        ON CONFLICT(path) DO UPDATE SET
          run_id=excluded.run_id,
          kind=excluded.kind,
          privacy_class=excluded.privacy_class,
          object_path=COALESCE(excluded.object_path, artifacts.object_path),
          sha256=excluded.sha256,
          size_bytes=excluded.size_bytes,
          mime_type=excluded.mime_type,
          extension=excluded.extension,
          link_mode=COALESCE(excluded.link_mode, artifacts.link_mode),
          status='ready',
          bounded_preview=excluded.bounded_preview,
          source_run_id=excluded.source_run_id,
          last_accessed_at=COALESCE(artifacts.last_accessed_at, excluded.last_accessed_at),
          expires_at=excluded.expires_at,
          deleted_at=NULL
        """,
        (
            artifact_id,
            run_id,
            file_kind,
            privacy,
            rel_path,
            object_rel,
            digest,
            stat.st_size,
            mime_type,
            safe_extension(path),
            link_mode,
            preview,
            source_run_id,
            created,
            last_accessed,
            expires,
        ),
    )
    return {
        "artifactId": artifact_id,
        "kind": file_kind,
        "path": rel_path,
        "objectPath": object_rel,
        "sha256": digest,
        "sizeBytes": stat.st_size,
        "linkMode": link_mode,
    }


def find_artifact_id_by_path(conn: sqlite3.Connection, path: str | Path | None) -> str | None:
    if not path:
        return None
    try:
        rel = store_relative(path)
    except StoreError:
        return None
    row = conn.execute("SELECT artifact_id FROM artifacts WHERE path = ? AND deleted_at IS NULL", (rel,)).fetchone()
    return str(row["artifact_id"]) if row else None


def channel_for_run(runtime_root: Path, run_dir: Path) -> str:
    try:
        parts = run_dir.relative_to(runtime_root).parts
    except ValueError:
        return "unknown"
    if "runs" in parts:
        index = parts.index("runs")
        if index > 0:
            return parts[index - 1]
    return parts[0] if parts else "unknown"


def run_id_from(run_dir: Path, task: dict[str, Any], state: dict[str, Any], manifest: dict[str, Any]) -> str:
    return str(task.get("runId") or state.get("runId") or manifest.get("runId") or run_dir.name)


def index_sources(conn: sqlite3.Connection, run_id: str, channel: str, task: dict[str, Any]) -> int:
    attachments = task.get("attachments") if isinstance(task.get("attachments"), list) else []
    event = task.get("sourceEvent") if isinstance(task.get("sourceEvent"), dict) else {}
    message = event.get("message") if isinstance(event.get("message"), dict) else {}
    sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
    created = now_iso()
    count = 0
    for index, item in enumerate(attachments):
        if not isinstance(item, dict):
            continue
        source_sha = item.get("sha256") or item.get("fileId")
        local_path = item.get("localPath") or item.get("sourcePath")
        artifact_id = find_artifact_id_by_path(conn, local_path)
        seed = f"{run_id}:{index}:{source_sha or item.get('name') or local_path or uuid.uuid4()}"
        source_id = hash_text(seed)[:32]
        message_id = item.get("sourceMessageId") or item.get("messageId") or message.get("messageId")
        chat_id = item.get("chatId") or message.get("chatId")
        thread_id = item.get("threadId") or message.get("threadId") or message.get("rootId") or message.get("parentId")
        source_kind = str(item.get("resourceType") or item.get("type") or "file")
        file_key = item.get("fileKey") or item.get("file_key") or item.get("fileToken") or item.get("fileId")
        conn.execute(
            """
            INSERT INTO source_refs(
              source_id, run_id, source_kind, channel, message_id_hash, chat_id_hash,
              thread_id_hash, file_name, mime_type, source_sha256, file_key, artifact_id,
              resolved_from, explicit_reference, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET
              artifact_id=excluded.artifact_id,
              source_sha256=excluded.source_sha256,
              file_key=excluded.file_key,
              resolved_from=excluded.resolved_from
            """,
            (
                source_id,
                run_id,
                source_kind,
                channel,
                hash_text(str(message_id))[:32] if message_id else None,
                hash_text(str(chat_id))[:32] if chat_id else None,
                hash_text(str(thread_id))[:32] if thread_id else None,
                item.get("name") or item.get("fileName"),
                item.get("mimeType") or item.get("mime_type"),
                source_sha,
                str(file_key) if file_key else None,
                artifact_id,
                "cache" if item.get("resolvedFromCache") else "download" if item.get("downloadStatus") else "unknown",
                1 if item.get("explicitFileReference") else 0,
                created,
            ),
        )
        sender_id = item.get("senderId") or sender.get("senderId")
        if chat_id and sender_id:
            recent_id = hash_text(f"{channel}:{chat_id}:{sender_id}:{thread_id}:{source_id}")[:32]
            conn.execute(
                """
                INSERT INTO recent_sources(
                  recent_id, channel, chat_id_hash, sender_id_hash, thread_key_hash,
                  source_kind, source_id, artifact_id, message_time_ms, created_at, expires_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(recent_id) DO UPDATE SET
                  artifact_id=excluded.artifact_id,
                  message_time_ms=excluded.message_time_ms,
                  created_at=excluded.created_at,
                  expires_at=excluded.expires_at
                """,
                (
                    recent_id,
                    channel,
                    hash_text(str(chat_id))[:32],
                    hash_text(str(sender_id))[:32],
                    hash_text(str(thread_id))[:32] if thread_id else None,
                    source_kind,
                    source_id,
                    artifact_id,
                    int(message.get("createTime") or 0) if str(message.get("createTime") or "").isdigit() else 0,
                    created,
                    add_seconds(created, TTL_SECONDS_BY_KIND["recent_source"]),
                ),
            )
        count += 1
    return count


def index_file_text_cache(conn: sqlite3.Connection, task: dict[str, Any]) -> int:
    contexts = (((task.get("fileContexts") or {}).get("contexts")) if isinstance(task.get("fileContexts"), dict) else []) or []
    created = now_iso()
    count = 0
    for context in contexts:
        if not isinstance(context, dict):
            continue
        extracted_path = context.get("extractedTextPath")
        extracted_id = find_artifact_id_by_path(conn, extracted_path)
        source_sha = context.get("fileId") if isinstance(context.get("fileId"), str) and len(context.get("fileId")) >= 16 else None
        if not source_sha:
            source_path = context.get("sourcePath")
            source_artifact = find_artifact_id_by_path(conn, source_path)
            if source_artifact:
                row = conn.execute("SELECT sha256 FROM artifacts WHERE artifact_id = ?", (source_artifact,)).fetchone()
                source_sha = row["sha256"] if row else None
        if not extracted_id or not source_sha:
            continue
        extraction = context.get("extraction") if isinstance(context.get("extraction"), dict) else {}
        method = extraction.get("method") or "unknown"
        extractor_version = "file-context-v1"
        extension = context.get("extension") or ""
        cache_key = hash_text(f"{source_sha}:{extractor_version}:{extension}:{method}")
        preview = context.get("contextPreview") or ""
        conn.execute(
            """
            INSERT INTO file_text_cache(
              cache_key, source_sha256, extractor_version, method, status,
              extracted_artifact_id, preview_hash, chars, hit_count, created_at,
              last_hit_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              status=excluded.status,
              extracted_artifact_id=excluded.extracted_artifact_id,
              preview_hash=excluded.preview_hash,
              chars=excluded.chars,
              hit_count=file_text_cache.hit_count + 1,
              last_hit_at=excluded.last_hit_at,
              expires_at=excluded.expires_at
            """,
            (
                cache_key,
                source_sha,
                extractor_version,
                method,
                context.get("status") or extraction.get("status") or "ready",
                extracted_id,
                hash_text(preview) if preview else None,
                int((extraction.get("chars") or 0) if isinstance(extraction.get("chars") or 0, int | float) else 0),
                created,
                created,
                add_seconds(created, TTL_SECONDS_BY_KIND["extracted_text"]),
            ),
        )
        count += 1
    return count


def index_asr_cache(conn: sqlite3.Connection, run_dir: Path, task: dict[str, Any]) -> int:
    normalize_path = run_dir / "artifacts" / "audio-normalize.json"
    if not normalize_path.exists():
        return 0
    normalize = safe_json_load(normalize_path)
    cache_key = normalize.get("cacheKey")
    if not cache_key:
        return 0
    artifacts_dir = run_dir / "artifacts"
    transcript_id = find_artifact_id_by_path(conn, artifacts_dir / "transcripts" / "transcript.full.json")
    evidence_id = find_artifact_id_by_path(conn, artifacts_dir / "evidence" / "evidence-index.json")
    summary_id = find_artifact_id_by_path(conn, artifacts_dir / "summary.json")
    audios = task.get("attachments") if isinstance(task.get("attachments"), list) else []
    source_hash = hash_text(json_dumps([{"sha256": item.get("sha256"), "size": item.get("sizeBytes")} for item in audios if isinstance(item, dict)]))
    created = now_iso()
    conn.execute(
        """
        INSERT INTO asr_cache(
          cache_key, source_set_hash, normalizer_version, target_spec_hash, model_id,
          chunk_seconds, language, status, transcript_artifact_id, evidence_artifact_id,
          summary_artifact_id, hit_count, created_at, last_hit_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          status=excluded.status,
          transcript_artifact_id=excluded.transcript_artifact_id,
          evidence_artifact_id=excluded.evidence_artifact_id,
          summary_artifact_id=excluded.summary_artifact_id,
          hit_count=asr_cache.hit_count + 1,
          last_hit_at=excluded.last_hit_at,
          expires_at=excluded.expires_at
        """,
        (
            cache_key,
            source_hash,
            normalize.get("version") or normalize.get("schemaVersion") or "audio-normalize-v1",
            hash_text(json_dumps(normalize.get("targetSpec") or {})),
            str(normalize.get("modelId") or "local-asr"),
            int(normalize.get("chunkSeconds") or 30),
            normalize.get("language") or "Chinese",
            normalize.get("status") or "ready",
            transcript_id,
            evidence_id,
            summary_id,
            created,
            created,
            add_seconds(created, TTL_SECONDS_BY_KIND["transcript_evidence"]),
        ),
    )
    return 1


def index_worker_jobs(conn: sqlite3.Connection, run_dir: Path, run_id: str, task: dict[str, Any], agent_output: dict[str, Any]) -> int:
    worker_dir = run_dir / "artifacts" / "docker-worker"
    job_path = worker_dir / "job.json"
    if not job_path.exists():
        return 0
    job = safe_json_load(job_path)
    job_id = str(job.get("jobId") or hash_text(str(job_path))[:32])
    job_artifact_id = find_artifact_id_by_path(conn, job_path)
    result_artifact_id = find_artifact_id_by_path(conn, run_dir / "agent-output.json")
    status = "completed" if agent_output.get("status") == "completed" else "blocked" if agent_output else "queued"
    reason = (agent_output.get("details") or {}).get("reason") if isinstance(agent_output.get("details"), dict) else agent_output.get("reason")
    created = str(job.get("createdAt") or now_iso())
    completed = now_iso() if agent_output else None
    conn.execute(
        """
        INSERT INTO worker_jobs(
          job_id, run_id, worker_kind, execution_profile, queue_name, result_key,
          status, attempts, worker_id, job_artifact_id, result_artifact_id,
          queued_at, started_at, completed_at, retry_later, reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          status=excluded.status,
          worker_id=excluded.worker_id,
          result_artifact_id=excluded.result_artifact_id,
          completed_at=excluded.completed_at,
          retry_later=excluded.retry_later,
          reason=excluded.reason
        """,
        (
            job_id,
            run_id,
            "local_docker_document_worker",
            job.get("executionProfile") or (task.get("taskIntent") or {}).get("executionProfile"),
            job.get("queueName") or "pi:document-worker:jobs",
            job.get("resultKey"),
            status,
            agent_output.get("workerId"),
            job_artifact_id,
            result_artifact_id,
            created,
            completed,
            1 if agent_output.get("retryLater") else 0,
            reason,
        ),
    )
    return 1


def index_publish_records(conn: sqlite3.Connection, run_id: str, publish: dict[str, Any]) -> int:
    documents = publish.get("documents") if isinstance(publish.get("documents"), list) else []
    publish_artifact_id = find_artifact_id_by_path(conn, publish.get("path") or None)
    count = 0
    created = now_iso()
    for index, doc in enumerate(documents):
        if not isinstance(doc, dict):
            continue
        doc_artifact_id = find_artifact_id_by_path(conn, doc.get("localPath"))
        pointer = doc.get("url") or doc.get("fileToken") or doc.get("targetFileToken") or doc.get("title") or ""
        publish_id = hash_text(f"{run_id}:{index}:{doc.get('fileName') or pointer}")[:32]
        conn.execute(
            """
            INSERT INTO publish_records(
              publish_id, run_id, document_artifact_id, target_kind, target_pointer_hash,
              status, publish_artifact_id, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(publish_id) DO UPDATE SET
              status=excluded.status,
              document_artifact_id=excluded.document_artifact_id,
              publish_artifact_id=excluded.publish_artifact_id
            """,
            (
                publish_id,
                run_id,
                doc_artifact_id,
                str(publish.get("publishTarget") or "unknown")[:80],
                hash_text(str(pointer))[:32] if pointer else None,
                doc.get("status") or publish.get("status") or "unknown",
                publish_artifact_id,
                created,
            ),
        )
        count += 1
    return count


def index_run(conn: sqlite3.Connection, runtime_root: Path, run_dir: Path, *, cas: bool) -> dict[str, Any]:
    run_dir = workspace_path(run_dir, must_exist=True)
    task = safe_json_load(run_dir / "task.json")
    state = safe_json_load(run_dir / "state.json")
    manifest = safe_json_load(run_dir / "run-manifest.json")
    metrics = safe_json_load(run_dir / "run.metrics.json")
    agent_output = safe_json_load(run_dir / "agent-output.json")
    publish = safe_json_load(run_dir / "publish.json")
    run_id = run_id_from(run_dir, task, state, manifest)
    channel = channel_for_run(runtime_root, run_dir)
    intent = task.get("taskIntent") if isinstance(task.get("taskIntent"), dict) else {}
    manifest_task = manifest.get("task") if isinstance(manifest.get("task"), dict) else {}
    status = str(state.get("status") or manifest.get("status") or task.get("status") or agent_output.get("status") or "unknown")
    started = str(metrics.get("startedAt") or task.get("requestedAt") or state.get("updatedAt") or now_iso())
    updated = str(state.get("updatedAt") or metrics.get("finishedAt") or now_iso())
    finished = metrics.get("finishedAt") or (updated if status in {"completed", "blocked", "failed", "needs_fix"} else None)
    source_event_hash = ((manifest.get("source") or {}).get("textHash") if isinstance(manifest.get("source"), dict) else None)
    if not source_event_hash and (run_dir / "event.json").exists():
        source_event_hash = sha256_file(run_dir / "event.json")
    conn.execute(
        """
        INSERT INTO runs(
          run_id, channel, execution_profile, task_type, status, source_event_hash,
          run_dir, manifest_path, metrics_path, started_at, updated_at,
          finished_at, total_bytes, retention_class, expires_at, pinned, deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'standard', ?, 0, NULL)
        ON CONFLICT(run_id) DO UPDATE SET
          channel=excluded.channel,
          execution_profile=excluded.execution_profile,
          task_type=excluded.task_type,
          status=excluded.status,
          source_event_hash=excluded.source_event_hash,
          run_dir=excluded.run_dir,
          manifest_path=excluded.manifest_path,
          metrics_path=excluded.metrics_path,
          updated_at=excluded.updated_at,
          finished_at=excluded.finished_at,
          expires_at=excluded.expires_at,
          deleted_at=NULL
        """,
        (
            run_id,
            channel,
            intent.get("executionProfile") or manifest_task.get("executionProfile"),
            intent.get("taskType") or manifest_task.get("taskType"),
            status,
            source_event_hash,
            store_relative(run_dir),
            store_relative(run_dir / "run-manifest.json") if (run_dir / "run-manifest.json").exists() else None,
            store_relative(run_dir / "run.metrics.json") if (run_dir / "run.metrics.json").exists() else None,
            started,
            updated,
            finished,
            add_seconds(finished or updated, TTL_SECONDS_BY_KIND["observability"]),
        ),
    )
    artifact_count = 0
    indexed_bytes = 0
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        if "_store" in path.parts:
            continue
        result = register_artifact(conn, runtime_root, path, run_id=run_id, kind=kind_for_path(path, run_dir), cas=cas)
        if result:
            artifact_count += 1
            indexed_bytes += int(result["sizeBytes"])
    conn.execute("UPDATE runs SET total_bytes = ? WHERE run_id = ?", (indexed_bytes, run_id))
    source_count = index_sources(conn, run_id, channel, task)
    file_cache_count = index_file_text_cache(conn, task)
    asr_count = index_asr_cache(conn, run_dir, task)
    worker_count = index_worker_jobs(conn, run_dir, run_id, task, agent_output)
    publish_count = index_publish_records(conn, run_id, publish)
    conn.commit()
    return {
        "status": "indexed",
        "runId": run_id,
        "runDir": store_relative(run_dir),
        "artifacts": artifact_count,
        "bytes": indexed_bytes,
        "sourceRefs": source_count,
        "fileTextCache": file_cache_count,
        "asrCache": asr_count,
        "workerJobs": worker_count,
        "publishRecords": publish_count,
        "cas": cas,
    }


def discover_run_dirs(runtime_root: Path) -> list[Path]:
    run_dirs: set[Path] = set()
    if not runtime_root.exists():
        return []
    for path in runtime_root.rglob("*"):
        if not path.is_file():
            continue
        if "_store" in path.parts:
            continue
        if path.name in {"task.json", "run-manifest.json", "state.json"} and path.parent.name != "docker-worker":
            if "runs" in path.parts:
                run_dirs.add(path.parent)
    return sorted(run_dirs)


def scan_asr_cache(conn: sqlite3.Connection, runtime_root: Path) -> dict[str, Any]:
    count = 0
    bytes_total = 0
    for asr_root in runtime_root.glob("*/asr-cache"):
        if not asr_root.is_dir():
            continue
        for cache_dir in asr_root.iterdir():
            if not cache_dir.is_dir():
                continue
            cache_key = cache_dir.name
            created = now_iso()
            artifact_ids: dict[str, str | None] = {"transcript": None, "evidence": None, "summary": None}
            for file_path in cache_dir.rglob("*"):
                if not file_path.is_file():
                    continue
                result = register_artifact(conn, runtime_root, file_path, run_id=None, kind="transcript_evidence", cas=False)
                if not result:
                    continue
                bytes_total += int(result["sizeBytes"])
                if "transcript" in file_path.name:
                    artifact_ids["transcript"] = result["artifactId"]
                elif "evidence" in file_path.name:
                    artifact_ids["evidence"] = result["artifactId"]
                elif file_path.name == "summary.json":
                    artifact_ids["summary"] = result["artifactId"]
            conn.execute(
                """
                INSERT INTO asr_cache(
                  cache_key, source_set_hash, normalizer_version, target_spec_hash, model_id,
                  chunk_seconds, language, status, transcript_artifact_id, evidence_artifact_id,
                  summary_artifact_id, hit_count, created_at, last_hit_at, expires_at
                )
                VALUES (?, ?, 'audio-normalize-v1', ?, 'local-asr', 30, 'Chinese', 'ready', ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                  status='ready',
                  transcript_artifact_id=excluded.transcript_artifact_id,
                  evidence_artifact_id=excluded.evidence_artifact_id,
                  summary_artifact_id=excluded.summary_artifact_id,
                  last_hit_at=excluded.last_hit_at
                """,
                (
                    cache_key,
                    hash_text(cache_key),
                    hash_text("asr-cache-scan"),
                    artifact_ids["transcript"],
                    artifact_ids["evidence"],
                    artifact_ids["summary"],
                    created,
                    created,
                    add_seconds(created, TTL_SECONDS_BY_KIND["transcript_evidence"]),
                ),
            )
            count += 1
    return {"asrCacheDirs": count, "bytes": bytes_total}


def retention_report_path(runtime_root: Path) -> Path:
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
    path = runtime_root / "_store" / "retention" / f"retention-report-{today}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def duplicate_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT sha256, COUNT(*) AS count, SUM(size_bytes) AS bytes
        FROM artifacts
        WHERE sha256 IS NOT NULL AND deleted_at IS NULL
        GROUP BY sha256
        HAVING COUNT(*) > 1
        ORDER BY bytes DESC
        LIMIT 50
        """
    ).fetchall()
    reclaimable = 0
    for row in rows:
        reclaimable += max(0, int(row["bytes"] or 0) - int(row["bytes"] or 0) // int(row["count"] or 1))
    return {
        "duplicateGroups": len(rows),
        "sample": [dict(row) for row in rows[:10]],
        "estimatedDuplicateBytes": reclaimable,
    }


def expired_candidate_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    now = now_iso()
    return conn.execute(
        """
        SELECT a.*, COALESCE(r.pinned, 0) AS run_pinned
        FROM artifacts a
        LEFT JOIN runs r ON r.run_id = a.run_id
        WHERE a.deleted_at IS NULL
          AND a.pinned = 0
          AND COALESCE(r.pinned, 0) = 0
          AND a.expires_at IS NOT NULL
          AND a.expires_at < ?
        ORDER BY a.expires_at ASC, a.size_bytes DESC
        """,
        (now,),
    ).fetchall()


def retention_policy_rows(conn: sqlite3.Connection, *, with_max_bytes: bool = False) -> list[sqlite3.Row]:
    where = "WHERE enabled = 1"
    if with_max_bytes:
        where += " AND max_bytes IS NOT NULL"
    return conn.execute(
        f"""
        SELECT kind, privacy_class, ttl_seconds, max_bytes, delete_order
        FROM retention_policies
        {where}
        ORDER BY delete_order ASC, kind ASC
        """
    ).fetchall()


def effective_kind_bytes(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT kind, COALESCE(SUM(size_bytes), 0) AS bytes
        FROM (
          SELECT
            kind,
            COALESCE(NULLIF(object_path, ''), path) AS storage_key,
            MAX(size_bytes) AS size_bytes
          FROM artifacts
          WHERE deleted_at IS NULL
          GROUP BY kind, storage_key
        )
        GROUP BY kind
        """
    ).fetchall()
    return {str(row["kind"]): int(row["bytes"] or 0) for row in rows}


def quota_overages(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    bytes_by_kind = effective_kind_bytes(conn)
    overages = []
    for policy in retention_policy_rows(conn, with_max_bytes=True):
        max_bytes = int(policy["max_bytes"] or 0)
        if max_bytes <= 0:
            continue
        current_bytes = int(bytes_by_kind.get(str(policy["kind"]), 0))
        if current_bytes > max_bytes:
            overages.append(
                {
                    "kind": policy["kind"],
                    "privacyClass": policy["privacy_class"],
                    "deleteOrder": int(policy["delete_order"]),
                    "maxBytes": max_bytes,
                    "currentBytes": current_bytes,
                    "overageBytes": current_bytes - max_bytes,
                }
            )
    return overages


def quota_lru_candidate_rows(conn: sqlite3.Connection, kind: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT a.*, COALESCE(r.pinned, 0) AS run_pinned
        FROM artifacts a
        LEFT JOIN runs r ON r.run_id = a.run_id
        WHERE a.deleted_at IS NULL
          AND a.kind = ?
          AND a.pinned = 0
          AND COALESCE(r.pinned, 0) = 0
        ORDER BY
          COALESCE(a.last_accessed_at, a.created_at) ASC,
          a.size_bytes DESC,
          a.created_at ASC
        """,
        (kind,),
    ).fetchall()


def write_report(runtime_root: Path, report: dict[str, Any]) -> Path:
    path = retention_report_path(runtime_root)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def scan_runtime(conn: sqlite3.Connection, runtime_root: Path) -> dict[str, Any]:
    run_dirs = discover_run_dirs(runtime_root)
    indexed = []
    for run_dir in run_dirs:
        indexed.append(index_run(conn, runtime_root, run_dir, cas=False))
    asr = scan_asr_cache(conn, runtime_root)
    conn.commit()
    status = store_status(conn, runtime_root)
    duplicates = duplicate_summary(conn)
    expired = expired_candidate_rows(conn)
    report = {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "mode": "scan",
        "runtimeRoot": store_relative(runtime_root),
        "indexedRuns": len(indexed),
        "indexedArtifacts": status["artifacts"],
        "indexedBytes": status["activeBytes"],
        "duplicates": duplicates,
        "expiredCandidates": len(expired),
        "expiredBytes": sum(int(row["size_bytes"] or 0) for row in expired),
        "asrCache": asr,
    }
    report_path = write_report(runtime_root, report)
    report["reportPath"] = store_relative(report_path)
    return report


def store_status(conn: sqlite3.Connection, runtime_root: Path) -> dict[str, Any]:
    runs = conn.execute("SELECT COUNT(*) AS value FROM runs WHERE deleted_at IS NULL").fetchone()["value"]
    artifacts = conn.execute("SELECT COUNT(*) AS value FROM artifacts WHERE deleted_at IS NULL").fetchone()["value"]
    active_bytes = conn.execute("SELECT COALESCE(SUM(size_bytes), 0) AS value FROM artifacts WHERE deleted_at IS NULL").fetchone()["value"]
    deleted_bytes = conn.execute("SELECT COALESCE(SUM(size_bytes), 0) AS value FROM artifacts WHERE deleted_at IS NOT NULL").fetchone()["value"]
    expired = expired_candidate_rows(conn)
    cas_root = runtime_root / "_store" / "objects" / "sha256"
    cas_count = 0
    cas_bytes = 0
    object_refs = {
        str(row["object_path"])
        for row in conn.execute("SELECT object_path FROM artifacts WHERE object_path IS NOT NULL AND deleted_at IS NULL").fetchall()
        if row["object_path"]
    }
    orphan_cas_count = 0
    orphan_cas_bytes = 0
    if cas_root.exists():
        for path in cas_root.rglob("*"):
            if path.is_file():
                cas_count += 1
                size = path.stat().st_size
                cas_bytes += size
                if store_relative(path) not in object_refs:
                    orphan_cas_count += 1
                    orphan_cas_bytes += size
    kind_rows = conn.execute(
        """
        SELECT kind, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
        FROM artifacts
        WHERE deleted_at IS NULL
        GROUP BY kind
        ORDER BY bytes DESC
        """
    ).fetchall()
    return {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "runtimeRoot": store_relative(runtime_root),
        "dbPath": store_relative(default_db_for_root(runtime_root)),
        "runs": int(runs),
        "artifacts": int(artifacts),
        "activeBytes": int(active_bytes),
        "deletedBytes": int(deleted_bytes),
        "casObjects": cas_count,
        "casBytes": cas_bytes,
        "orphanCasObjects": orphan_cas_count,
        "orphanCasBytes": orphan_cas_bytes,
        "expiredCandidates": len(expired),
        "expiredBytes": sum(int(row["size_bytes"] or 0) for row in expired),
        "quotaOverages": quota_overages(conn),
        "byKind": [dict(row) for row in kind_rows],
    }


def find_records(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    if args.run_id:
        run = conn.execute("SELECT * FROM runs WHERE run_id = ?", (args.run_id,)).fetchone()
        artifacts = conn.execute(
            "SELECT artifact_id, kind, privacy_class, path, object_path, sha256, size_bytes, status, expires_at, pinned, deleted_at FROM artifacts WHERE run_id = ? ORDER BY size_bytes DESC",
            (args.run_id,),
        ).fetchall()
        jobs = conn.execute("SELECT * FROM worker_jobs WHERE run_id = ?", (args.run_id,)).fetchall()
        return {
            "run": dict(run) if run else None,
            "artifacts": [dict(row) for row in artifacts],
            "workerJobs": [dict(row) for row in jobs],
        }
    if args.sha256:
        rows = conn.execute(
            "SELECT artifact_id, run_id, kind, path, object_path, size_bytes, status, pinned, deleted_at FROM artifacts WHERE sha256 = ? ORDER BY size_bytes DESC",
            (args.sha256,),
        ).fetchall()
        return {"sha256": args.sha256, "artifacts": [dict(row) for row in rows]}
    raise StoreError("find requires --run-id or --sha256")


def source_kind_candidates(kind: str | None) -> list[str]:
    if not kind:
        return []
    normalized = str(kind).strip().lower()
    if normalized == "raw_media":
        return ["audio", "video", "image", "raw_media", "file"]
    if normalized == "audio":
        return ["audio", "raw_media", "file"]
    return [normalized]


def artifact_paths_for_candidate(row: sqlite3.Row) -> list[str]:
    paths: list[str] = []
    for key in ("path", "object_path"):
        value = row[key]
        if not value:
            continue
        try:
            path = workspace_path(value, must_exist=True)
        except StoreError:
            continue
        if path.is_file() and path.stat().st_size > 0:
            paths.append(store_relative(path))
    return paths


def find_source_records(conn: sqlite3.Connection, args: argparse.Namespace) -> dict[str, Any]:
    """Find ready source artifacts without exposing SQLite internals.

    Marker: find-source source_refs ready raw_media local_reuse_store_artifact.
    """
    source_kinds = source_kind_candidates(args.kind)
    name_pattern = f"%{args.name}%" if args.name else None
    message_hashes = [hash_text(value)[:32] for value in (args.source_message_id, args.message_id) if value]
    params: list[Any] = []
    filters = [
        "a.deleted_at IS NULL",
        "a.status = 'ready'",
        "a.kind = ?",
    ]
    params.append(args.kind)
    if source_kinds:
        filters.append(f"sr.source_kind IN ({','.join('?' for _ in source_kinds)})")
        params.extend(source_kinds)
    if message_hashes:
        filters.append(f"sr.message_id_hash IN ({','.join('?' for _ in message_hashes)})")
        params.extend(message_hashes)
    if name_pattern:
        filters.append("(sr.file_name LIKE ? OR a.path LIKE ? OR a.object_path LIKE ?)")
        params.extend([name_pattern, name_pattern, name_pattern])
    if args.file_key:
        filters.append("sr.file_key = ?")
        params.append(args.file_key)
    if args.sha256:
        filters.append("(a.sha256 = ? OR sr.source_sha256 = ?)")
        params.extend([args.sha256, args.sha256])
    if not args.include_fixtures:
        filters.append("LOWER(a.run_id) NOT LIKE '%fixture%'")
        filters.append("LOWER(a.run_id) NOT LIKE '%mock%'")
        filters.append("LOWER(a.run_id) NOT LIKE '%dry_run%'")
        filters.append("LOWER(a.run_id) NOT LIKE '%dry-run%'")
        filters.append("LOWER(a.run_id) NOT LIKE '%fake_lark%'")
        filters.append("LOWER(a.run_id) NOT LIKE '%fake-lark%'")

    rows = conn.execute(
        f"""
        SELECT
          a.artifact_id, a.run_id, a.kind, a.path, a.object_path, a.sha256,
          a.size_bytes, a.status, a.created_at, a.last_accessed_at,
          sr.source_kind, sr.file_name, sr.file_key, sr.mime_type, sr.resolved_from,
          sr.explicit_reference
        FROM source_refs sr
        JOIN artifacts a ON a.artifact_id = sr.artifact_id
        WHERE {' AND '.join(filters)}
        ORDER BY COALESCE(a.last_accessed_at, a.created_at) DESC, a.size_bytes DESC
        LIMIT ?
        """,
        (*params, int(args.limit)),
    ).fetchall()

    candidates = []
    seen_paths: set[str] = set()
    for row in rows:
        ready, validation = audio_artifact_ready(row)
        if not ready:
            continue
        available_paths = artifact_paths_for_candidate(row)
        if not available_paths:
            continue
        primary = available_paths[0]
        if primary in seen_paths:
            continue
        seen_paths.add(primary)
        candidates.append(
            {
                "artifactId": row["artifact_id"],
                "runId": row["run_id"],
                "kind": row["kind"],
                "sourceKind": row["source_kind"],
                "fileName": row["file_name"],
                "fileKeyMatched": bool(args.file_key and row["file_key"] == args.file_key),
                "path": row["path"],
                "objectPath": row["object_path"],
                "availablePath": primary,
                "availablePaths": available_paths,
                "sha256": row["sha256"],
                "sizeBytes": row["size_bytes"],
                "status": row["status"],
                "resolvedFrom": row["resolved_from"],
                "audioValidation": validation,
                "rawSecretsReturned": False,
            },
        )
    return {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "status": "found" if candidates else "not_found",
        "query": {
            "fileKeyPresent": bool(args.file_key),
            "sourceMessageIdPresent": bool(args.source_message_id),
            "messageIdPresent": bool(args.message_id),
            "name": args.name,
            "kind": args.kind,
            "sha256Present": bool(args.sha256),
            "includeFixtures": bool(args.include_fixtures),
        },
        "candidates": candidates,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def record_retention_action(
    conn: sqlite3.Connection,
    *,
    artifact_id: str | None,
    run_id: str | None,
    action: str,
    reason: str,
    bytes_reclaimed: int,
    status: str,
    error: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO retention_actions(action_id, artifact_id, run_id, action, reason, bytes_reclaimed, status, executed_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (uuid.uuid4().hex, artifact_id, run_id, action, reason, bytes_reclaimed, status, now_iso(), error),
    )


def safe_cleanup_path(path: Path, runtime_root: Path) -> bool:
    if not is_inside(ROOT, path):
        return False
    if not is_inside(runtime_root, path):
        return False
    rel = path.relative_to(ROOT)
    if rel.parts and rel.parts[0] in NEVER_DELETE_TOP_LEVEL:
        return False
    if path.name.startswith(".env"):
        return False
    return True


def audit_pollution(conn: sqlite3.Connection, runtime_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT
          a.artifact_id, a.run_id, a.kind, a.path, a.object_path, a.sha256,
          a.size_bytes, a.status, a.deleted_at,
          sr.source_id, sr.file_key, sr.source_kind, sr.file_name, sr.resolved_from
        FROM artifacts a
        LEFT JOIN source_refs sr ON sr.artifact_id = a.artifact_id
        WHERE a.kind = 'raw_media' AND a.deleted_at IS NULL
        ORDER BY a.size_bytes ASC, a.run_id ASC
        LIMIT ?
        """,
        (int(args.limit),),
    ).fetchall()
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        reasons: list[str] = []
        if int(row["size_bytes"] or 0) < int(args.min_audio_bytes):
            reasons.append("raw_media_too_small")
        if is_fixture_run_id(row["run_id"]):
            reasons.append("fixture_artifact_in_production_store")
        ready, validation = audio_artifact_ready(row)
        if not ready:
            reasons.append(validation["reason"] if validation else "invalid_audio_artifact")
        if row["file_key"] and is_fixture_run_id(row["run_id"]):
            reasons.append("real_file_key_points_to_fixture_artifact")
        if not reasons:
            continue
        key = (row["artifact_id"], ",".join(sorted(set(reasons))))
        if key in seen:
            continue
        seen.add(key)
        findings.append(
            {
                "artifactId": row["artifact_id"],
                "runId": row["run_id"],
                "kind": row["kind"],
                "path": row["path"],
                "objectPath": row["object_path"],
                "sha256": row["sha256"],
                "sizeBytes": row["size_bytes"],
                "status": row["status"],
                "fileKeyPresent": bool(row["file_key"]),
                "fileName": row["file_name"],
                "reasons": sorted(set(reasons)),
                "audioValidation": validation,
            }
        )
    return {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "status": "polluted" if findings else "clean",
        "findingCount": len(findings),
        "findings": findings,
        "workspaceBound": True,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def quarantine_artifacts(conn: sqlite3.Connection, runtime_root: Path, args: argparse.Namespace) -> dict[str, Any]:
    if not args.sha256 and not args.artifact_id:
        raise StoreError("quarantine-artifact requires --sha256 or --artifact-id")
    params: list[Any] = []
    filters = ["deleted_at IS NULL"]
    if args.sha256:
        filters.append("sha256 = ?")
        params.append(args.sha256)
    if args.artifact_id:
        filters.append("artifact_id = ?")
        params.append(args.artifact_id)
    rows = conn.execute(
        f"SELECT * FROM artifacts WHERE {' AND '.join(filters)} ORDER BY run_id ASC",
        params,
    ).fetchall()
    selected_artifact_ids = {row["artifact_id"] for row in rows}
    reason = args.reason or "quarantined_invalid_fixture_audio"
    generated_at = now_iso()
    quarantine_root = runtime_root / "_store" / "quarantine" / generated_at.replace(":", "").replace("-", "")
    actions: list[dict[str, Any]] = []
    for row in rows:
        artifact_id = row["artifact_id"]
        run_id = row["run_id"]
        bytes_value = int(row["size_bytes"] or 0)
        moved_paths: list[dict[str, Any]] = []
        for db_key in ("path", "object_path"):
            value = row[db_key]
            if not value:
                continue
            if db_key == "object_path":
                shared = conn.execute(
                    """
                    SELECT artifact_id
                    FROM artifacts
                    WHERE object_path = ? AND deleted_at IS NULL AND artifact_id NOT IN ({})
                    LIMIT 1
                    """.format(",".join("?" for _ in selected_artifact_ids) or "''"),
                    (value, *selected_artifact_ids),
                ).fetchone()
                if shared:
                    moved_paths.append({"path": value, "status": "kept_shared_cas_object", "sharedArtifactId": shared["artifact_id"]})
                    continue
            try:
                source = workspace_path(value)
            except StoreError as exc:
                moved_paths.append({"path": value, "status": "blocked", "reason": str(exc)})
                continue
            if not safe_cleanup_path(source, runtime_root):
                moved_paths.append({"path": value, "status": "blocked", "reason": "path_not_safe_for_quarantine"})
                continue
            if not source.exists() and not source.is_symlink():
                moved_paths.append({"path": store_relative(source), "status": "missing"})
                continue
            if args.execute:
                quarantine_root.mkdir(parents=True, exist_ok=True)
                destination = quarantine_root / f"{artifact_id}-{db_key}-{source.name}"
                counter = 1
                while destination.exists():
                    destination = quarantine_root / f"{artifact_id}-{db_key}-{counter}-{source.name}"
                    counter += 1
                shutil.move(str(source), str(destination))
                moved_paths.append({"path": store_relative(source), "status": "moved", "quarantinePath": store_relative(destination)})
            else:
                moved_paths.append({"path": store_relative(source), "status": "would_move"})
        if args.execute:
            conn.execute(
                "UPDATE artifacts SET status = ?, deleted_at = ? WHERE artifact_id = ?",
                (reason, generated_at, artifact_id),
            )
            conn.execute(
                "UPDATE source_refs SET resolved_from = ? WHERE artifact_id = ?",
                (reason, artifact_id),
            )
            record_retention_action(
                conn,
                artifact_id=artifact_id,
                run_id=run_id,
                action="quarantine",
                reason=reason,
                bytes_reclaimed=bytes_value,
                status="completed",
            )
        actions.append(
            {
                "artifactId": artifact_id,
                "runId": run_id,
                "sha256": row["sha256"],
                "bytes": bytes_value,
                "status": "quarantined" if args.execute else "dry_run",
                "paths": moved_paths,
            }
        )
    if args.execute:
        conn.commit()
    return {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "status": "completed" if args.execute else "dry_run",
        "reason": reason,
        "artifactCount": len(actions),
        "actions": actions,
        "workspaceBound": True,
        "indexedOnly": True,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def delete_artifact_path(conn: sqlite3.Connection, row: sqlite3.Row, runtime_root: Path, *, execute: bool, reason: str) -> dict[str, Any]:
    artifact_id = row["artifact_id"]
    run_id = row["run_id"]
    path = path_from_db(row["path"])
    size = int(row["size_bytes"] or 0)
    if not path or not safe_cleanup_path(path, runtime_root):
        if execute:
            record_retention_action(conn, artifact_id=artifact_id, run_id=run_id, action="delete", reason=reason, bytes_reclaimed=0, status="blocked", error="path_outside_runtime_root")
        return {"artifactId": artifact_id, "path": row["path"], "status": "blocked", "reason": "path_outside_runtime_root", "bytes": 0}
    if not path.exists() and not path.is_symlink():
        if execute:
            conn.execute("UPDATE artifacts SET deleted_at = ?, status = 'deleted' WHERE artifact_id = ?", (now_iso(), artifact_id))
            record_retention_action(conn, artifact_id=artifact_id, run_id=run_id, action="delete", reason=reason, bytes_reclaimed=0, status="missing")
        return {"artifactId": artifact_id, "path": row["path"], "status": "missing", "reason": reason, "bytes": 0}
    if execute:
        try:
            path.unlink()
            conn.execute("UPDATE artifacts SET deleted_at = ?, status = 'deleted' WHERE artifact_id = ?", (now_iso(), artifact_id))
            record_retention_action(conn, artifact_id=artifact_id, run_id=run_id, action="delete", reason=reason, bytes_reclaimed=size, status="deleted")
            return {"artifactId": artifact_id, "path": row["path"], "status": "deleted", "reason": reason, "bytes": size}
        except Exception as exc:
            record_retention_action(conn, artifact_id=artifact_id, run_id=run_id, action="delete", reason=reason, bytes_reclaimed=0, status="failed", error=str(exc))
            return {"artifactId": artifact_id, "path": row["path"], "status": "failed", "reason": str(exc), "bytes": 0}
    return {"artifactId": artifact_id, "path": row["path"], "status": "planned", "reason": reason, "bytes": size}


def dedupe(conn: sqlite3.Connection, runtime_root: Path, *, execute: bool) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT sha256
        FROM artifacts
        WHERE sha256 IS NOT NULL AND deleted_at IS NULL AND pinned = 0 AND size_bytes > 0
        GROUP BY sha256
        HAVING COUNT(*) > 1
        """
    ).fetchall()
    actions = []
    bytes_relinked = 0
    for digest_row in rows:
        digest = digest_row["sha256"]
        artifacts = conn.execute(
            """
            SELECT a.*, COALESCE(r.pinned, 0) AS run_pinned
            FROM artifacts a
            LEFT JOIN runs r ON r.run_id = a.run_id
            WHERE a.sha256 = ? AND a.deleted_at IS NULL
            ORDER BY CASE WHEN a.object_path IS NOT NULL THEN 0 ELSE 1 END, a.size_bytes DESC
            """,
            (digest,),
        ).fetchall()
        if len(artifacts) < 2:
            continue
        keeper = artifacts[0]
        keeper_path = path_from_db(keeper["object_path"] or keeper["path"])
        if not keeper_path or not keeper_path.exists():
            continue
        if execute:
            object_path = path_from_db(keeper["object_path"]) if keeper["object_path"] else ensure_cas_object(runtime_root, keeper_path, digest)
        else:
            object_path = path_from_db(keeper["object_path"]) if keeper["object_path"] else object_path_for(runtime_root, digest, keeper_path)
        for row in artifacts[1:]:
            if row["pinned"] or row["run_pinned"]:
                continue
            path = path_from_db(row["path"])
            if not path or not path.exists() or not should_cas(row["kind"], path, int(row["size_bytes"] or 0)):
                continue
            action = {
                "artifactId": row["artifact_id"],
                "path": row["path"],
                "sha256": digest,
                "sizeBytes": int(row["size_bytes"] or 0),
                "status": "planned",
            }
            if execute:
                try:
                    mode = replace_with_compat_link(path, object_path)
                    conn.execute(
                        "UPDATE artifacts SET object_path = ?, link_mode = ?, last_accessed_at = ? WHERE artifact_id = ?",
                        (store_relative(object_path), mode, now_iso(), row["artifact_id"]),
                    )
                    record_retention_action(
                        conn,
                        artifact_id=row["artifact_id"],
                        run_id=row["run_id"],
                        action="dedupe_link",
                        reason="duplicate_sha256_relinked_to_cas",
                        bytes_reclaimed=int(row["size_bytes"] or 0) if mode != "copy" else 0,
                        status="completed",
                    )
                    action["status"] = "completed"
                    action["linkMode"] = mode
                    bytes_relinked += int(row["size_bytes"] or 0) if mode != "copy" else 0
                except Exception as exc:
                    record_retention_action(
                        conn,
                        artifact_id=row["artifact_id"],
                        run_id=row["run_id"],
                        action="dedupe_link",
                        reason="duplicate_sha256_relinked_to_cas",
                        bytes_reclaimed=0,
                        status="failed",
                        error=str(exc),
                    )
                    action["status"] = "failed"
                    action["reason"] = str(exc)
            actions.append(action)
    if execute:
        conn.commit()
    return {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "mode": "execute" if execute else "dry-run",
        "duplicateGroups": len(rows),
        "actions": actions[:200],
        "plannedActions": len(actions),
        "estimatedBytesRelinked": sum(item["sizeBytes"] for item in actions),
        "bytesRelinked": bytes_relinked,
    }


def cleanup(conn: sqlite3.Connection, runtime_root: Path, *, execute: bool) -> dict[str, Any]:
    ttl_candidates = list(expired_candidate_rows(conn))
    actions = []
    ttl_reclaimed = 0
    seen_artifact_ids: set[str] = set()
    for row in ttl_candidates:
        result = delete_artifact_path(conn, row, runtime_root, execute=execute, reason="ttl_expired_indexed_artifact")
        actions.append(result)
        seen_artifact_ids.add(str(row["artifact_id"]))
        ttl_reclaimed += int(result.get("bytes") or 0) if result.get("status") in {"deleted", "planned"} else 0
    quota_reclaimed = 0
    quota_actions = 0
    overages = quota_overages(conn)
    for overage in overages:
        kind = str(overage["kind"])
        target_bytes = int(overage["overageBytes"] or 0)
        kind_reclaimed = 0
        for row in quota_lru_candidate_rows(conn, kind):
            artifact_id = str(row["artifact_id"])
            if artifact_id in seen_artifact_ids:
                continue
            result = delete_artifact_path(conn, row, runtime_root, execute=execute, reason="quota_lru_over_max_bytes")
            result["kind"] = kind
            result["quotaMaxBytes"] = int(overage["maxBytes"])
            result["quotaCurrentBytes"] = int(overage["currentBytes"])
            actions.append(result)
            seen_artifact_ids.add(artifact_id)
            quota_actions += 1
            if result.get("status") in {"deleted", "planned"}:
                bytes_value = int(result.get("bytes") or 0)
                quota_reclaimed += bytes_value
                kind_reclaimed += bytes_value
            if kind_reclaimed >= target_bytes:
                break
    if execute:
        conn.commit()
    report = {
        "schemaVersion": STORE_SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "mode": "execute" if execute else "dry-run",
        "candidateCount": len(actions),
        "ttlCandidateCount": len(ttl_candidates),
        "quotaCandidateCount": quota_actions,
        "ttlBytes": ttl_reclaimed,
        "quotaBytes": quota_reclaimed,
        "bytes": ttl_reclaimed + quota_reclaimed,
        "quotaOverages": overages,
        "actions": actions[:500],
        "threeTierLifecycle": True,
        "lruQuotaCleanup": True,
        "indexedOnly": True,
        "pinnedSafe": True,
        "workspaceBound": True,
    }
    report_path = write_report(runtime_root, report)
    report["reportPath"] = store_relative(report_path)
    return report


def set_pin(conn: sqlite3.Connection, args: argparse.Namespace, *, pinned: bool) -> dict[str, Any]:
    if args.run_id:
        conn.execute("UPDATE runs SET pinned = ? WHERE run_id = ?", (1 if pinned else 0, args.run_id))
        conn.commit()
        return {"status": "pinned" if pinned else "unpinned", "runId": args.run_id}
    if args.artifact_id:
        conn.execute("UPDATE artifacts SET pinned = ? WHERE artifact_id = ?", (1 if pinned else 0, args.artifact_id))
        conn.commit()
        return {"status": "pinned" if pinned else "unpinned", "artifactId": args.artifact_id}
    raise StoreError("pin/unpin requires --run-id or --artifact-id")


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=argparse.SUPPRESS, help="runtime root, default runtime-runs")
    common.add_argument("--db", default=argparse.SUPPRESS, help="SQLite DB path, default <root>/_store/runtime-store.sqlite")
    parser = argparse.ArgumentParser(description="Host-owned local runtime store CLI")
    parser.add_argument("--root", default=str(DEFAULT_RUNTIME_ROOT), help="runtime root, default runtime-runs")
    parser.add_argument("--db", default=None, help="SQLite DB path, default <root>/_store/runtime-store.sqlite")
    sub = parser.add_subparsers(dest="command", required=True)
    command_parser = lambda name, help_text: sub.add_parser(name, help=help_text, parents=[common])

    command_parser("init", "initialize SQLite store")
    command_parser("status", "show indexed store status")
    scan = command_parser("scan", "scan runtime-runs and index existing runs")
    scan.add_argument("--dry-run", action="store_true", help="compatibility flag; scan indexes metadata and does not delete files")
    scan.add_argument("--cas", action="store_true", help="also move eligible scanned files into CAS")

    index_run_parser = command_parser("index-run", "index one run directory")
    index_run_parser.add_argument("--run-dir", required=True)
    index_run_parser.add_argument("--cas", action="store_true", help="put CAS-eligible artifacts into CAS and link run paths")

    put = command_parser("put-object", "put a single file into CAS")
    put.add_argument("--path", required=True)
    put.add_argument("--replace-with-link", action="store_true", help="replace original path with hardlink/symlink/copy compatibility path")

    find = command_parser("find", "find run or artifacts")
    find.add_argument("--run-id")
    find.add_argument("--sha256")

    find_source = command_parser("find-source", "find ready source artifacts for attachment reuse")
    find_source.add_argument("--file-key")
    find_source.add_argument("--source-message-id")
    find_source.add_argument("--message-id")
    find_source.add_argument("--name")
    find_source.add_argument("--kind", default="raw_media")
    find_source.add_argument("--sha256")
    find_source.add_argument("--limit", type=int, default=10)
    find_source.add_argument("--include-fixtures", action="store_true", help="include fixture/mock/dry-run artifacts for diagnostics only")

    audit = command_parser("audit-pollution", "audit production store for invalid or fixture raw media pollution")
    audit.add_argument("--limit", type=int, default=5000)
    audit.add_argument("--min-audio-bytes", type=int, default=AUDIO_MIN_READY_BYTES)

    quarantine = command_parser("quarantine-artifact", "quarantine indexed artifacts without deleting remote Feishu files")
    quarantine.add_argument("--sha256")
    quarantine.add_argument("--artifact-id")
    quarantine.add_argument("--reason", default="quarantined_invalid_fixture_audio")
    quarantine.add_argument("--execute", action="store_true")

    dedupe_parser = command_parser("dedupe", "dedupe duplicate indexed artifacts through CAS")
    dedupe_group = dedupe_parser.add_mutually_exclusive_group()
    dedupe_group.add_argument("--dry-run", action="store_true")
    dedupe_group.add_argument("--execute", action="store_true")

    cleanup_parser = command_parser("cleanup", "delete expired indexed runtime artifacts and quota LRU overflow")
    cleanup_group = cleanup_parser.add_mutually_exclusive_group()
    cleanup_group.add_argument("--dry-run", action="store_true")
    cleanup_group.add_argument("--execute", action="store_true")

    pin = command_parser("pin", "pin a run or artifact")
    pin.add_argument("--run-id")
    pin.add_argument("--artifact-id")
    unpin = command_parser("unpin", "unpin a run or artifact")
    unpin.add_argument("--run-id")
    unpin.add_argument("--artifact-id")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    runtime_root = ensure_runtime_root(args.root)
    db_path = resolve_db(args, runtime_root)
    conn = connect(db_path)
    init_db(conn)
    try:
        if args.command == "init":
            print_json({"schemaVersion": STORE_SCHEMA_VERSION, "status": "initialized", "dbPath": store_relative(db_path), "runtimeRoot": store_relative(runtime_root)})
        elif args.command == "scan":
            result = scan_runtime(conn, runtime_root)
            if args.cas:
                for run_dir in discover_run_dirs(runtime_root):
                    index_run(conn, runtime_root, run_dir, cas=True)
                result["cas"] = True
            print_json(result)
        elif args.command == "status":
            print_json(store_status(conn, runtime_root))
        elif args.command == "index-run":
            print_json(index_run(conn, runtime_root, workspace_path(args.run_dir, must_exist=True), cas=args.cas))
        elif args.command == "put-object":
            print_json(put_object(runtime_root, workspace_path(args.path, must_exist=True), replace=args.replace_with_link))
        elif args.command == "find":
            print_json(find_records(conn, args))
        elif args.command == "find-source":
            print_json(find_source_records(conn, args))
        elif args.command == "audit-pollution":
            print_json(audit_pollution(conn, runtime_root, args))
        elif args.command == "quarantine-artifact":
            print_json(quarantine_artifacts(conn, runtime_root, args))
        elif args.command == "dedupe":
            print_json(dedupe(conn, runtime_root, execute=bool(args.execute)))
        elif args.command == "cleanup":
            print_json(cleanup(conn, runtime_root, execute=bool(args.execute)))
        elif args.command == "pin":
            print_json(set_pin(conn, args, pinned=True))
        elif args.command == "unpin":
            print_json(set_pin(conn, args, pinned=False))
        else:
            raise StoreError(f"unknown command: {args.command}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except StoreError as exc:
        print_json({"schemaVersion": STORE_SCHEMA_VERSION, "status": "error", "error": str(exc)}, validate=False)
        raise SystemExit(2)

#!/usr/bin/env python3
import argparse
import hmac
import json
import os
import queue
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from mlx_qwen3_asr import Session
from local_asr_core import run_transcription


class LocalAsrHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32


def split_root_values(values: list[str] | None) -> list[str]:
    roots: list[str] = []
    for value in values or []:
        for part in value.split(os.pathsep):
            part = part.strip()
            if part:
                roots.append(part)
    return roots


def build_root_allowlist(cli_values: list[str] | None, env_name: str) -> list[Path]:
    values = split_root_values(cli_values)
    env_value = os.environ.get(env_name)
    if env_value:
        values.extend(split_root_values([env_value]))
    if not values:
        values = [os.getcwd()]
    return [Path(value).expanduser().resolve() for value in values]


def is_within_roots(path: Path, roots: list[Path]) -> bool:
    return any(path == root or root in path.parents for root in roots)


class LocalAsrState:
    def __init__(
        self,
        model_dir: str,
        preload: bool = False,
        bearer_token: str | None = None,
        input_roots: list[Path] | None = None,
        output_roots: list[Path] | None = None,
    ):
        self.default_model_dir = Path(model_dir).expanduser().resolve()
        self.bearer_token = bearer_token.strip() if bearer_token else None
        self.input_roots = input_roots or [Path.cwd().resolve()]
        self.output_roots = output_roots or [Path.cwd().resolve()]
        self.loaded_model_dir: Path | None = None
        self.session: Session | None = None
        self.model_lock = threading.Lock()
        self.run_lock = threading.Lock()
        self.worker_jobs: queue.Queue = queue.Queue()
        self.worker_ready = threading.Event()
        self.worker_thread = threading.Thread(target=self._worker_loop, name="local-asr-mlx-worker", daemon=True)
        self.worker_thread.start()
        self.worker_ready.wait(timeout=5)
        self.started_at = time.time()
        self.last_summary: dict | None = None
        self.last_error: str | None = None
        if preload:
            self.run_on_worker(lambda: self.get_session(self.default_model_dir))

    def _worker_loop(self) -> None:
        self.worker_ready.set()
        while True:
            fn, result_queue = self.worker_jobs.get()
            try:
                result_queue.put((True, fn()))
            except Exception as exc:
                result_queue.put((False, exc))

    def run_on_worker(self, fn):
        result_queue: queue.Queue = queue.Queue(maxsize=1)
        self.worker_jobs.put((fn, result_queue))
        ok, value = result_queue.get()
        if ok:
            return value
        raise value

    def get_session(self, model_dir: Path) -> Session:
        model_dir = model_dir.expanduser().resolve()
        if not model_dir.exists():
            raise FileNotFoundError(f"Missing local ASR model directory: {model_dir}")

        with self.model_lock:
            if self.session is None or self.loaded_model_dir != model_dir:
                print(f"LOCAL_ASR_SERVICE loading_model {model_dir}", flush=True)
                self.session = Session(model=str(model_dir))
                self.loaded_model_dir = model_dir
                print("LOCAL_ASR_SERVICE model_loaded", flush=True)
            return self.session

    def health(self) -> dict:
        return {
            "status": "ok",
            "service": "local-qwen3-asr-http",
            "uptimeSec": round(time.time() - self.started_at, 3),
            "busy": self.run_lock.locked(),
            "defaultModelDir": str(self.default_model_dir),
            "loadedModelDir": str(self.loaded_model_dir) if self.loaded_model_dir else None,
            "modelLoaded": self.session is not None,
            "authRequired": bool(self.bearer_token),
            "inputRoots": [str(root) for root in self.input_roots],
            "outputRoots": [str(root) for root in self.output_roots],
            "externalAudioUpload": False,
            "lastStatus": self.last_summary.get("status") if self.last_summary else None,
            "lastError": self.last_error,
        }

    def check_bearer(self, authorization: str | None) -> bool:
        if not self.bearer_token:
            return True
        return hmac.compare_digest(authorization or "", f"Bearer {self.bearer_token}")

    def require_allowed_path(self, value: str, roots: list[Path], label: str) -> Path:
        path = Path(value).expanduser().resolve()
        if not is_within_roots(path, roots):
            allowed = ", ".join(str(root) for root in roots)
            raise PermissionError(f"{label} is outside allowed roots: {allowed}")
        return path

    def transcribe(self, payload: dict) -> dict:
        paths = payload.get("paths")
        if not isinstance(paths, list) or not paths:
            raise ValueError("payload.paths must be a non-empty array of local WAV paths")

        meeting_id = payload.get("meetingId")
        output_dir = payload.get("outputDir")
        if not meeting_id or not isinstance(meeting_id, str):
            raise ValueError("payload.meetingId is required")
        if not output_dir or not isinstance(output_dir, str):
            raise ValueError("payload.outputDir is required")

        resolved_paths = [self.require_allowed_path(str(path), self.input_roots, "payload.paths[]") for path in paths]
        resolved_output_dir = self.require_allowed_path(output_dir, self.output_roots, "payload.outputDir")
        model_dir = Path(payload.get("modelDir") or self.default_model_dir).expanduser().resolve()
        limit_chunks = payload.get("limitChunks")
        if limit_chunks is not None:
            limit_chunks = int(limit_chunks)

        with self.run_lock:
            summary = self.run_on_worker(lambda: self._transcribe_on_worker(
                payload=payload,
                resolved_paths=resolved_paths,
                resolved_output_dir=resolved_output_dir,
                model_dir=model_dir,
                limit_chunks=limit_chunks,
            ))
            self.last_summary = summary
            self.last_error = None
            return {
                "status": summary.get("status", "complete"),
                "service": "local-qwen3-asr-http",
                "modelDir": str(model_dir),
                "externalAudioUpload": False,
                "summary": summary,
            }

    def _transcribe_on_worker(
        self,
        payload: dict,
        resolved_paths: list[Path],
        resolved_output_dir: Path,
        model_dir: Path,
        limit_chunks: int | None,
    ) -> dict:
        session = self.get_session(model_dir)
        return run_transcription(
            paths=[str(p) for p in resolved_paths],
            meeting_id=payload["meetingId"],
            meeting_title=payload.get("meetingTitle") or payload["meetingId"],
            output_dir=resolved_output_dir,
            model_dir=model_dir,
            chunk_seconds=float(payload.get("chunkSeconds") or 30.0),
            language=payload.get("language") or "Chinese",
            context=payload.get("context") or "会议录音，中文为主，可能夹杂英文术语、人名、产品名。",
            max_new_tokens=int(payload.get("maxNewTokens") or 512),
            source=payload.get("source") or "local",
            privacy=payload.get("privacy") or "private",
            limit_chunks=limit_chunks,
            session=session,
        )


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    if length > 4 * 1024 * 1024:
        raise ValueError("JSON request body exceeds 4MB limit")
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def build_handler(state: LocalAsrState):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalQwen3ASR/1.0"

        def log_message(self, fmt, *args):
            sys.stderr.write("LOCAL_ASR_SERVICE " + fmt % args + "\n")

        def send_json(self, status: int, data: dict):
            body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            if status == HTTPStatus.UNAUTHORIZED:
                self.send_header("www-authenticate", 'Bearer realm="local-asr"')
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def require_auth(self) -> bool:
            if state.check_bearer(self.headers.get("authorization")):
                return True
            self.send_json(
                HTTPStatus.UNAUTHORIZED,
                {
                    "status": "error",
                    "service": "local-qwen3-asr-http",
                    "error": "unauthorized",
                    "authRequired": True,
                    "externalAudioUpload": False,
                },
            )
            return False

        def do_GET(self):
            if not self.require_auth():
                return
            parsed = urlparse(self.path)
            if parsed.path in {"/health", "/v1/health"}:
                self.send_json(HTTPStatus.OK, state.health())
                return
            if parsed.path == "/v1/models":
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "service": "local-qwen3-asr-http",
                        "defaultModelDir": str(state.default_model_dir),
                        "loadedModelDir": str(state.loaded_model_dir) if state.loaded_model_dir else None,
                        "authRequired": bool(state.bearer_token),
                        "inputRoots": [str(root) for root in state.input_roots],
                        "outputRoots": [str(root) for root in state.output_roots],
                        "switching": "Pass modelDir in POST /v1/transcriptions to reload a different local model.",
                    },
                )
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"status": "error", "error": "not_found"})

        def do_POST(self):
            if not self.require_auth():
                return
            parsed = urlparse(self.path)
            if parsed.path != "/v1/transcriptions":
                self.send_json(HTTPStatus.NOT_FOUND, {"status": "error", "error": "not_found"})
                return

            try:
                payload = read_json_body(self)
                response = state.transcribe(payload)
                self.send_json(HTTPStatus.OK, response)
            except Exception as exc:
                state.last_error = repr(exc)
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "status": "error",
                        "service": "local-qwen3-asr-http",
                        "externalAudioUpload": False,
                        "error": repr(exc),
                    },
                )

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model-dir", default="models/Qwen3-ASR-1.7B-MLX-4bit")
    parser.add_argument("--preload", action="store_true")
    parser.add_argument(
        "--bearer-token",
        default=os.environ.get("LOCAL_ASR_BEARER_TOKEN"),
        help="Optional bearer token required for all HTTP requests. Can also be set with LOCAL_ASR_BEARER_TOKEN.",
    )
    parser.add_argument(
        "--input-root",
        action="append",
        help="Allowed local input root. May be repeated. Defaults to LOCAL_ASR_INPUT_ROOTS or the current working directory.",
    )
    parser.add_argument(
        "--output-root",
        action="append",
        help="Allowed local output root. May be repeated. Defaults to LOCAL_ASR_OUTPUT_ROOTS or the current working directory.",
    )
    args = parser.parse_args()

    input_roots = build_root_allowlist(args.input_root, "LOCAL_ASR_INPUT_ROOTS")
    output_roots = build_root_allowlist(args.output_root, "LOCAL_ASR_OUTPUT_ROOTS")
    state = LocalAsrState(
        model_dir=args.model_dir,
        preload=args.preload,
        bearer_token=args.bearer_token,
        input_roots=input_roots,
        output_roots=output_roots,
    )
    server = LocalAsrHTTPServer((args.host, args.port), build_handler(state))
    print(
        json.dumps(
            {
                "status": "listening",
                "service": "local-qwen3-asr-http",
                "url": f"http://{args.host}:{args.port}",
                "modelDir": str(state.default_model_dir),
                "preload": args.preload,
                "authRequired": bool(state.bearer_token),
                "inputRoots": [str(root) for root in state.input_roots],
                "outputRoots": [str(root) for root in state.output_roots],
                "externalAudioUpload": False,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())

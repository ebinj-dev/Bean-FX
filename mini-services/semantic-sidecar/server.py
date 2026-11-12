"""
BEAN FX — Semantic (RIISHE) sidecar for workstation deployments.

Speaks the OpenAI-compatible chat contract the application adapter uses
(src/lib/riishe-inference.ts, provider id "local-http"):

    POST /v1/chat/completions   { model?, messages, temperature? }
                                → OpenAI-shaped reply whose assistant content
                                  is the RIISHE-validated canonical JSON.

Two modes (BEANFX_SEM_SIDECAR_MODE):

  managed  — the sidecar LAUNCHES and supervises a llama.cpp `llama-server`
             process (ngl=0 → CPU-first; GPU layers remain a future option)
             with a locally installed GGUF model (default family: Qwen2.5
             Instruct GGUF). The sidecar never downloads models.
  proxy    — the sidecar validates traffic for an ALREADY-RUNNING
             OpenAI-compatible endpoint (llama.cpp server / LM Studio /
             llama-server on another host / vLLM), pointed at via
             BEANFX_SEM_SIDECAR_UPSTREAM_URL.

In BOTH modes every upstream reply is parsed leniently and validated against
the RIISHE pydantic schemas (riishe_schema.py). Malformed output triggers ONE
corrective retry; persistent invalidity, schema violations or upstream
failures answer 502 with an explicit "No classification was invented" error.
The first attempt carries a response_format json_schema constraint; upstreams
that reject the constraint are retried without it — validation still applies.

Env:
    BEANFX_SEM_SIDECAR_PORT             default 9301 (app-facing; the app's
                                        BEANFX_SEMANTIC_ENDPOINT points at
                                        http://127.0.0.1:<port>/v1/chat/completions)
    BEANFX_SEM_SIDECAR_MODE             "managed" (default) | "proxy"
    BEANFX_SEM_SIDECAR_INTERNAL_PORT    llama-server port in managed mode, default 9302
    BEANFX_SEM_SIDECAR_MODEL_PATH       managed: local GGUF file path
    BEANFX_SEM_SIDECAR_LLAMA_SERVER     managed: path to the llama-server binary
    BEANFX_SEM_SIDECAR_CTX_SIZE         managed: llama.cpp context size, default 8192
    BEANFX_SEM_SIDECAR_THREADS          managed: CPU threads for llama.cpp, default cpu_count
    BEANFX_SEM_SIDECAR_UPSTREAM_URL     proxy: OpenAI-compatible chat URL
    BEANFX_SEM_SIDECAR_UPSTREAM_TIMEOUT proxy: seconds, default 180
    BEANFX_SEM_SIDECAR_MODEL            model id reported upstream (default "local")
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

from riishe_schema import validate_riishe_output

PORT = int(os.environ.get("BEANFX_SEM_SIDECAR_PORT", "9301"))
INTERNAL_PORT = int(os.environ.get("BEANFX_SEM_SIDECAR_INTERNAL_PORT", "9302"))
MODE = os.environ.get("BEANFX_SEM_SIDECAR_MODE", "managed").strip().lower()
MODEL_PATH = os.environ.get("BEANFX_SEM_SIDECAR_MODEL_PATH", "").strip()
LLAMA_SERVER = os.environ.get("BEANFX_SEM_SIDECAR_LLAMA_SERVER", "").strip()
CTX_SIZE = int(os.environ.get("BEANFX_SEM_SIDECAR_CTX_SIZE", "8192"))
THREADS = int(os.environ.get("BEANFX_SEM_SIDECAR_THREADS", str(os.cpu_count() or 4)))
UPSTREAM_URL = os.environ.get("BEANFX_SEM_SIDECAR_UPSTREAM_URL", "").strip()
UPSTREAM_TIMEOUT = int(os.environ.get("BEANFX_SEM_SIDECAR_UPSTREAM_TIMEOUT", "180"))
REPORTED_MODEL = os.environ.get("BEANFX_SEM_SIDECAR_MODEL", "local").strip() or "local"

_DOCS = "docs/ASR_SEMANTIC_SIDECARS.md"
# The managed mode is designed around the Qwen2.5 Instruct GGUF family (CPU-
# friendly 3B/7B). The exact file is a user decision — but the requirement is
# named precisely in /ready, never guessed and never downloaded.
_MODEL_FAMILY = "Qwen2.5-Instruct GGUF (e.g. Qwen2.5-3B-Instruct-Q4_K_M.gguf)"

app = FastAPI(title="BEAN FX semantic (RIISHE) sidecar", version="1.0.0")


class _Managed:
    """Supervises the llama.cpp server child process (managed mode only)."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.error: str | None = None
        self.lock = threading.Lock()

    def config_error(self) -> str | None:
        """Actionable missing-requirement message, or None when configured."""
        if not MODEL_PATH:
            return (
                f"BEANFX_SEM_SIDECAR_MODEL_PATH is not set. Managed mode needs a locally installed "
                f"{_MODEL_FAMILY} file — the sidecar never downloads models (see {_DOCS})."
            )
        p = Path(MODEL_PATH)
        if not p.is_file():
            return (
                f"model file not found: {MODEL_PATH}. Managed mode needs a local {_MODEL_FAMILY} "
                f"file — the sidecar never downloads models (see {_DOCS})."
            )
        bin_path = LLAMA_SERVER or shutil.which("llama-server")
        if not bin_path:
            return (
                "llama-server binary not found. Install llama.cpp (CPU build is enough) and set "
                "BEANFX_SEM_SIDECAR_LLAMA_SERVER to its path — the sidecar never downloads binaries or models."
            )
        return None

    def ensure_running(self) -> str | None:
        """Start/keep llama-server alive. Returns an error string on failure."""
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                return None
            err = self.config_error()
            if err:
                self.error = err
                return err
            bin_path = LLAMA_SERVER or shutil.which("llama-server")
            try:
                self.proc = subprocess.Popen(
                    [
                        str(bin_path),
                        "--host", "127.0.0.1",
                        "--port", str(INTERNAL_PORT),
                        "--model", MODEL_PATH,
                        "--ctx-size", str(CTX_SIZE),
                        "--threads", str(THREADS),
                        "--ngl", "0",  # CPU-first: no GPU layers until the workstation enables them
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception as exc:
                self.error = f"failed to start llama-server: {exc}"
                return self.error
            # Wait for the child's own /health (llama.cpp exposes one).
            deadline = time.time() + 120
            while time.time() < deadline:
                if self.proc.poll() is not None:
                    self.error = "llama-server exited during startup"
                    return self.error
                try:
                    r = httpx.get(f"http://127.0.0.1:{INTERNAL_PORT}/health", timeout=2.0)
                    if r.status_code == 200:
                        self.error = None
                        return None
                except Exception:
                    pass
                time.sleep(1.0)
            self.error = "llama-server did not become healthy within 120s"
            return self.error

    def stop(self) -> None:
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                self.proc.terminate()


managed = _Managed()


def _upstream_base() -> str:
    if MODE == "proxy":
        return UPSTREAM_URL.rstrip("/")
    return f"http://127.0.0.1:{INTERNAL_PORT}/v1"


def _is_ready() -> tuple[bool, str | None]:
    if MODE == "proxy":
        if not UPSTREAM_URL:
            return False, "BEANFX_SEM_SIDECAR_MODE=proxy requires BEANFX_SEM_SIDECAR_UPSTREAM_URL."
        return True, None
    err = managed.ensure_running()
    return (err is None), err


def _riishe_json_schema() -> dict:
    """JSON Schema for the RIISHE output, derived from the pydantic models and
    sent upstream as a response_format json_schema constraint on the first
    attempt (structured-output-capable runtimes honour it; others may reject
    the constraint — the sidecar then retries without it, still validating)."""
    from riishe_schema import RiisheOutput
    return RiisheOutput.model_json_schema()


@app.get("/health")
def health() -> dict:
    ready, err = _is_ready()
    return {
        "ready": ready,
        "mode": MODE,
        "model": REPORTED_MODEL if ready else None,
        "modelPath": MODEL_PATH or None,
        "upstreamUrl": UPSTREAM_URL if MODE == "proxy" else f"http://127.0.0.1:{INTERNAL_PORT}/v1",
        "runtimeError": err,
    }


@app.get("/ready")
def ready_endpoint() -> JSONResponse:
    is_ready, err = _is_ready()
    if is_ready:
        return JSONResponse({"ok": True}, status_code=200)
    return JSONResponse({"error": err or "semantic sidecar is not ready"}, status_code=503)


def _error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "sidecar_error", "code": status}}, status_code=status)


_CORRECTIVE = (
    "Your previous reply was not valid RIISHE output ({why}). "
    'Respond with ONLY a JSON object: {{"suggestions": [{{"id": string, "action": "REMOVE"|"KEEP"|"REVIEW", '
    '"confidence": 0..1, "reason": string, "riskNotes": string|null}}], "summary": string}}. '
    "Every candidate id exactly once; no prose, no other keys."
)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    is_ready, err = _is_ready()
    if not is_ready:
        # 503 — honest unavailability, never a fabricated classification.
        return _error(err or "semantic sidecar has no model loaded — nothing can be classified", 503)

    try:
        body = await request.json()
    except Exception:
        return _error("request body must be JSON", 400)
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return _error("messages array is required", 400)
    temperature = body.get("temperature", 0.2)

    base = _upstream_base()
    schema = _riishe_json_schema()
    payload = {
        "model": body.get("model") or REPORTED_MODEL,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_schema", "json_schema": {"name": "riishe_output", "schema": schema}},
    }

    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT) as client:
        for attempt in (1, 2):
            try:
                resp = await client.post(f"{base}/chat/completions", json=payload)
            except httpx.TimeoutException:
                return _error(f"upstream timed out after {UPSTREAM_TIMEOUT}s — no classification was invented", 504)
            except httpx.HTTPError as exc:
                return _error(f"upstream unreachable ({base}): {exc}", 502)

            if resp.status_code >= 500:
                return _error(f"upstream answered {resp.status_code}: {resp.text[:200]}", 502)
            if resp.status_code == 400 and attempt == 1 and "response_format" in resp.text:
                # Upstream rejects the json_schema constraint → retry without
                # it; validation below still enforces the contract.
                payload.pop("response_format", None)
                continue
            if resp.status_code != 200:
                return _error(f"upstream answered {resp.status_code}: {resp.text[:200]}", 502)

            data = resp.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
            validated, why = validate_riishe_output(content)
            if validated is not None:
                return JSONResponse({
                    "id": f"chatcmpl-beanfx-{uuid.uuid4().hex[:12]}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": payload["model"],
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": validated.model_dump_json()},
                        "finish_reason": "stop",
                    }],
                    "usage": data.get("usage") or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                })

            if attempt == 1:
                # One corrective retry: show the model its invalid output and
                # restate the contract.
                payload["messages"] = list(messages) + [
                    {"role": "assistant", "content": content[:2000]},
                    {"role": "user", "content": _CORRECTIVE.format(why=why[:400])},
                ]
                continue
            return _error(
                f"upstream produced invalid RIISHE output twice ({why[:300]}). "
                "No classification was invented — the pipeline will report this stage honestly.",
                502,
            )

    return _error("unreachable state — no classification was invented", 500)


def main() -> None:
    if MODE == "managed":
        threading.Thread(target=managed.ensure_running, name="llama-supervisor", daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()

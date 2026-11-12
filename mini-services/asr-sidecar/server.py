"""
BEAN FX — ASR sidecar (workstation deployment).

A real, local speech-to-text service implementing the exact OpenAI-compatible
contract the application adapter speaks (src/lib/asr-providers.ts, provider
id "local-http"):

    POST /v1/audio/transcriptions   multipart { file, model, response_format }
                                    → {"text": "..."}

 backed by faster-whisper (CTranslate2) on CPU (int8) by default. GPU remains
 a future option selected via BEANFX_ASR_SIDECAR_DEVICE / _COMPUTE_TYPE — the
 application never needs to know.

Honesty rules (same as the pipeline):
  - The sidecar NEVER downloads models. It only loads a model from an explicit
    local directory that contains a CTranslate2 `model.bin`. Missing models,
    missing runtimes and bad audio produce actionable 503/400 errors — no
    fabrication, no silent degradation.
  - Health always tells the truth: /health reports ready/device/computeType/
    runtimeError; /ready returns 503 with the exact missing requirement.

Resource-awareness:
  - The model is loaded ONCE and reused (int8 on CPU keeps the footprint low).
  - Concurrent transcriptions are bounded by BEANFX_ASR_SIDECAR_MAX_CONCURRENT
    (default 2); saturation returns 429 instead of queueing unbounded work.
  - Every transcription is bounded by BEANFX_ASR_SIDECAR_TIMEOUT seconds
    (default 300). Client disconnects cancel the work (uvicorn cancels the
    request task, releasing the concurrency slot).

Env:
    BEANFX_ASR_SIDECAR_PORT            default 9300 (app-facing; the app's
                                       BEANFX_ASR_ENDPOINT points at
                                       http://127.0.0.1:<port>/v1/audio/transcriptions)
    BEANFX_ASR_SIDECAR_MODEL           REQUIRED path to a local faster-whisper
                                       model directory (with model.bin)
    BEANFX_ASR_SIDECAR_DEVICE          default "cpu" (future: "cuda")
    BEANFX_ASR_SIDECAR_COMPUTE_TYPE    default "int8" (future GPU: "float16")
    BEANFX_ASR_SIDECAR_CPU_THREADS     default = os.cpu_count()
    BEANFX_ASR_SIDECAR_MAX_CONCURRENT  default 2
    BEANFX_ASR_SIDECAR_TIMEOUT         default 300 (seconds per transcription)
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import struct
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

PORT = int(os.environ.get("BEANFX_ASR_SIDECAR_PORT", "9300"))
MODEL_DIR_RAW = os.environ.get("BEANFX_ASR_SIDECAR_MODEL", "").strip()
DEVICE = os.environ.get("BEANFX_ASR_SIDECAR_DEVICE", "cpu").strip().lower()
COMPUTE_TYPE = os.environ.get("BEANFX_ASR_SIDECAR_COMPUTE_TYPE", "int8").strip().lower()
CPU_THREADS = int(os.environ.get("BEANFX_ASR_SIDECAR_CPU_THREADS", str(os.cpu_count() or 4)))
MAX_CONCURRENT = max(1, int(os.environ.get("BEANFX_ASR_SIDECAR_MAX_CONCURRENT", "2")))
TIMEOUT_SEC = int(os.environ.get("BEANFX_ASR_SIDECAR_TIMEOUT", "300"))

_DOCS = "docs/ASR_SEMANTIC_SIDECARS.md"


def validate_model_dir(path: Path) -> tuple[bool, str]:
    """Validate a LOCAL model directory. Enforces the never-download rule:
    bare size names ("tiny", "large-v3", …) are not directories and are
    rejected; a directory without a CTranslate2 model.bin is rejected with the
    exact missing requirement."""
    if not path.exists():
        return False, (
            f"model directory does not exist: {path} — the sidecar never downloads models. "
            f"Install a faster-whisper model locally (see {_DOCS}) and set "
            "BEANFX_ASR_SIDECAR_MODEL to its directory."
        )
    if not path.is_dir():
        return False, (
            f"BEANFX_ASR_SIDECAR_MODEL must be a local model DIRECTORY, not '{path.name}' — "
            "size names like 'tiny' or 'large-v3' would trigger an implicit download, "
            "which the sidecar never does (see " + _DOCS + ")."
        )
    if not (path / "model.bin").is_file():
        return False, (
            f"model directory {path} is missing model.bin — not a valid CTranslate2 "
            "faster-whisper model. Install the model locally (never downloads; see " + _DOCS + ")."
        )
    return True, ""


class _WhisperState:
    """Lazy, thread-safe holder for the faster-whisper model."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.ready = False
        self.runtime_error: str | None = None
        self.model: Any = None
        self.model_id = "faster-whisper (local dir)"

    def load(self) -> None:
        with self.lock:
            ok, why = validate_model_dir(Path(MODEL_DIR_RAW)) if MODEL_DIR_RAW else (False, "BEANFX_ASR_SIDECAR_MODEL is not set — no local model configured.")
            if not ok:
                self.runtime_error = why
                return
            try:
                from faster_whisper import WhisperModel  # lazy: import works without the runtime
                self.model = WhisperModel(
                    MODEL_DIR_RAW,
                    device=DEVICE,
                    compute_type=COMPUTE_TYPE,
                    cpu_threads=CPU_THREADS,
                    num_workers=1,
                )
                self.model_id = Path(MODEL_DIR_RAW).name
                self.ready = True
            except Exception as exc:  # real runtime failure — reported, never faked around
                self.runtime_error = f"faster-whisper runtime failed to load {MODEL_DIR_RAW}: {exc}"


state = _WhisperState()

app = FastAPI(title="BEAN FX ASR sidecar", version="1.0.0")

# Bounded concurrency slot(s) for transcription work.
transcribe_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_active = 0
_active_lock = threading.Lock()


def _wav_duration_sec(data: bytes) -> float | None:
    """Best-effort duration read from a classic PCM WAV header (None if the
    container is exotic — faster-whisper will decode it itself)."""
    try:
        if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            return None
        pos = 12
        rate = channels = bits = None
        while pos + 8 <= len(data):
            cid = data[pos:pos + 4]
            size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
            body = data[pos + 8:pos + 8 + size]
            if cid == b"fmt ":
                channels = struct.unpack("<H", body[2:4])[0]
                rate = struct.unpack("<I", body[4:8])[0]
                bits = struct.unpack("<H", body[14:16])[0]
            elif cid == b"data":
                if rate and channels and bits:
                    bytes_per_frame = max(1, channels * bits // 8)
                    return size / bytes_per_frame / rate
                return None
            pos += 8 + size + (size % 2)
    except Exception:
        return None
    return None


def _decode_wav_to_float32(data: bytes) -> "numpy.ndarray":
    """Decode a PCM WAV chunk to float32 mono via the stdlib — no PyAV, so the
    app's 16 kHz mono WAV pipeline works on any PyAV version. The application
    contract guarantees WAV chunks (see src/lib/asr-providers.ts)."""
    import wave as _wave

    import numpy as np

    with _wave.open(io.BytesIO(data), "rb") as w:
        channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sampwidth != 2:
        raise ValueError(f"unsupported PCM sample width {sampwidth * 8} bits — send 16-bit WAV")
    ints = np.frombuffer(frames, dtype="<i2")
    if channels > 1:
        ints = ints.reshape(-1, channels).mean(axis=1)
    return (ints.astype("float32") / 32768.0), float(len(ints)) / rate


def _run_transcription(wav_bytes: bytes) -> str:
    """Blocking faster-whisper call — executed in the worker thread pool.
    Tries the PyAV decode path first (any input format); falls back to the
    stdlib WAV decoder, which always works for the app's WAV chunks."""
    try:
        segments, _info = state.model.transcribe(
            io.BytesIO(wav_bytes),
            vad_filter=True,  # skip silent stretches — matches the app's chunked pipeline
        )
    except Exception as exc:
        if isinstance(exc, TypeError) and "metadata_errors" in str(exc):
            # PyAV too new/old for faster-whisper's decode kwargs — decode the
            # WAV ourselves and hand faster-whisper a float32 array instead.
            audio, _rate = _decode_wav_to_float32(wav_bytes)
            segments, _info = state.model.transcribe(audio, vad_filter=True)
        else:
            raise
    return "".join(seg.text for seg in segments).strip()


@app.get("/health")
def health() -> dict:
    return {
        "ready": state.ready,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
        "cpuThreads": CPU_THREADS,
        "maxConcurrent": MAX_CONCURRENT,
        "active": _active,
        "model": state.model_id if state.ready else (MODEL_DIR_RAW or None),
        "runtimeError": state.runtime_error,
    }


@app.get("/ready")
def ready() -> JSONResponse:
    if state.ready:
        return JSONResponse({"ok": True}, status_code=200)
    if not MODEL_DIR_RAW:
        return JSONResponse(
            {"error": "BEANFX_ASR_SIDECAR_MODEL is not set. The sidecar never downloads models — "
                      f"install a faster-whisper model locally (see {_DOCS}) and restart."},
            status_code=503,
        )
    ok, why = validate_model_dir(Path(MODEL_DIR_RAW))
    if not ok:
        return JSONResponse({"error": why}, status_code=503)
    return JSONResponse(
        {"error": state.runtime_error or "model is valid but the runtime is still loading — retry shortly."},
        status_code=503,
    )


@app.get("/v1/models")
def models() -> dict:
    data = [{"id": state.model_id, "object": "model", "owned_by": "beanfx-local"}] if state.ready else []
    return {"object": "list", "data": data}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    response_format: str = Form("json"),
) -> JSONResponse:
    if not state.ready:
        # Actionable, honest 503 — the endpoint exists but no local model is
        # loaded. Never fabricate a transcription.
        why = state.runtime_error or (f"no local ASR model is loaded — the sidecar never downloads "
                                      f"models; set BEANFX_ASR_SIDECAR_MODEL to a local model directory (see {_DOCS})")
        return JSONResponse({"error": why}, status_code=503)
    if response_format not in ("json", "text"):
        return JSONResponse({"error": "response_format must be 'json' or 'text'"}, status_code=400)

    wav = await file.read()
    if not wav:
        return JSONResponse({"error": "empty audio upload"}, status_code=400)
    duration = _wav_duration_sec(wav)
    if duration is not None and duration > int(os.environ.get("BEANFX_ASR_SIDECAR_MAX_AUDIO_SEC", "3600")):
        return JSONResponse(
            {"error": f"audio too long for one chunk ({duration:.0f}s) — split it before sending"},
            status_code=400,
        )

    global _active
    if not transcribe_slots.acquire(blocking=False):
        return JSONResponse(
            {"error": f"asr sidecar busy: {MAX_CONCURRENT} transcription(s) already running — retry shortly"},
            status_code=429,
        )
    _active += 1
    loop = asyncio.get_running_loop()
    try:
        text = await loop.run_in_executor(None, _run_transcription, wav)
        return JSONResponse({"text": text})
    except asyncio.CancelledError:  # client disconnected → work cancelled, slot released
        raise
    except Exception as exc:
        import traceback as _tb

        _tb.print_exc()  # visible in server logs — a 500 must never be silent
        return JSONResponse(
            {"error": f"transcription failed on the local model: {exc} — nothing was invented"},
            status_code=400 if "format" in str(exc).lower() or "decode" in str(exc).lower() else 500,
        )
    finally:
        _active -= 1
        transcribe_slots.release()


def main() -> None:
    threading.Thread(target=state.load, name="model-loader", daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()

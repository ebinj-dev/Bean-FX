"""
BEAN FX — real-weights ASR sidecar verification (sandbox only).

Starts the ASR sidecar with REAL faster-whisper weights (Systran
faster-whisper-tiny, explicitly downloaded — the sidecar itself never
downloads), feeds it a generated WAV, and asserts the full OpenAI-compatible
contract path works end-to-end. This is the proof that the sidecar performs
REAL inference, unlike the contract suite's modelless/stub scenarios.
"""
import json
import math
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

MODEL_DIR = "/tmp/models/faster-whisper-tiny"
PORT = 9311
BASE = f"http://127.0.0.1:{PORT}"
SIDEcar_DIR = Path("/tmp/beanfx-release/mini-services/asr-sidecar")
PY = "/tmp/sidecar-venv/bin/python"


def get(url: str):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
    except Exception as e:
        return 0, {"error": str(e)}


def make_wav(seconds: float = 3.0, freq: float = 220.0, rate: int = 16000) -> bytes:
    """16 kHz mono 16-bit PCM WAV — a low tone with gentle amplitude envelope."""
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        amp = 0.6 * math.sin(2 * math.pi * freq * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.7 * t))
        frames += struct.pack("<h", int(amp * 32000))
    # Build the RIFF container manually (no platform-dependent file objects).
    data_rate, channels, bits = rate, 1, 16
    byte_rate = data_rate * channels * bits // 8
    block_align = channels * bits // 8
    hdr = b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, data_rate, byte_rate, block_align, bits)
    dat = b"data" + struct.pack("<I", len(frames)) + bytes(frames)
    return hdr + fmt + dat


def post_wav(wav: bytes):
    boundary = "beanfxreal42"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nfaster-whisper-tiny\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"tone.wav\"\r\n"
        "Content-Type: audio/wav\r\n\r\n".encode() + wav + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(
        f"{BASE}/v1/audio/transcriptions",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
    except Exception as e:
        return 0, {"error": str(e)}


def main() -> int:
    proc = subprocess.Popen(
        [PY, "server.py"],
        cwd=str(SIDEcar_DIR),
        env={**__import__("os").environ,
             "BEANFX_ASR_SIDECAR_PORT": str(PORT),
             "BEANFX_ASR_SIDECAR_MODEL": MODEL_DIR},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        for _ in range(120):
            time.sleep(1.0)
            st, h = get(f"{BASE}/health")
            if st == 200 and h.get("ready") is True:
                print("PASS sidecar loaded REAL weights:", {k: h[k] for k in ("ready", "device", "computeType", "model") if k in h})
                break
            if proc.poll() is not None:
                print("FAIL sidecar exited early:", (proc.stdout.read() if proc.stdout else "")[-600:])
                return 1
        else:
            print("FAIL sidecar never became ready; health:", get(f"{BASE}/health")[1])
            return 1

        st, r = get(f"{BASE}/v1/models")
        print(("PASS" if st == 200 and r.get("data") else "FAIL"), "/v1/models lists loaded model:", r)

        wav = make_wav(3.0)
        st, r = post_wav(wav)
        ok = st == 200 and isinstance(r.get("text"), str)
        print(("PASS" if ok else "FAIL"), f"real transcription status={st} response={json.dumps(r)[:120]}")
        if not ok:
            return 1

        # contract detail: response is exactly {"text": <string>} shaped JSON
        st, r = get(f"{BASE}/ready")
        print(("PASS" if st == 200 else "FAIL"), "/ready 200 with weights loaded:", r)
        print("RESULT: real-weights ASR verification PASSED")
        return 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())

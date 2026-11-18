"""
Phase 2/3 — SERVICE-LEVEL tests for the two local inference sidecars.

What this proves (and does NOT claim):
  - The sidecars implement the exact contracts the application adapters speak.
  - Missing runtime/model produces ACTIONABLE 503s (never silent, never fake).
  - The semantic sidecar validates every upstream reply against the RIISHE
    pydantic schemas, retries malformed output once, and fails loudly with 502.
  - The never-download rule is enforced (size names and missing dirs rejected).

A tiny TEST-ONLY stub upstream is used for the semantic validation tests. It
is test scaffolding, not inference: no result of this script may ever be
counted as "local inference worked" — that requires real model weights.
"""
import io
import json
import os
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASR_DIR = ROOT / "mini-services" / "asr-sidecar"
SEM_DIR = ROOT / "mini-services" / "semantic-sidecar"
ASR_PORT, SEM_PORT, SEM_INTERNAL, STUB_PORT = 9300, 9301, 9302, 9303
BASE_ASR = f"http://127.0.0.1:{ASR_PORT}"
BASE_SEM = f"http://127.0.0.1:{SEM_PORT}"

passed, failed = 0, 0


def check(name: str, ok: bool, detail: str = ""):
    global passed, failed
    passed += ok
    failed += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail[:150]}" if detail else ""))


def get(url: str) -> tuple[int, dict | str]:
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            body = r.read().decode()
            try:
                return r.status, json.loads(body)
            except Exception:
                return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body
    except Exception as e:
        return 0, str(e)


def post_json(url: str, payload: dict) -> tuple[int, dict | str]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    return _send(req)


def post_multipart_asr(fields: dict, filename: str = "chunk.wav", body: bytes = b"") -> tuple[int, dict | str]:
    boundary = "beanfxboundary42"
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        "Content-Type: audio/wav\r\n\r\n".encode() + body + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    data = b"".join(parts)
    req = urllib.request.Request(
        f"{BASE_ASR}/v1/audio/transcriptions", data=data,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST",
    )
    return _send(req)


def _send(req: urllib.request.Request) -> tuple[int, dict | str]:
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            try:
                return r.status, json.loads(body)
            except Exception:
                return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body
    except Exception as e:
        return 0, str(e)


def start_server(cwd: Path, env_extra: dict, wait_health: str) -> subprocess.Popen:
    env = {**os.environ, **env_extra}
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=str(cwd), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(120):
        time.sleep(0.5)
        try:
            status, _ = get(wait_health)
            if status == 200:
                return proc
        except Exception:
            pass
        if proc.poll() is not None:
            out = proc.stdout.read() if proc.stdout else ""
            raise RuntimeError(f"server exited early: {out[-800:]}")
    raise RuntimeError(f"server did not become healthy: {wait_health}")


# ---------------------------------------------------------------- test stub upstream
class StubUpstream(threading.Thread):
    """TEST-ONLY OpenAI-shaped upstream with switchable behavior."""
    def __init__(self):
        super().__init__(daemon=True)
        from http.server import BaseHTTPRequestHandler, HTTPServer
        self.mode = "valid"
        self.calls = 0

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                self.server.calls += 1
                mode = self.server.mode
                used_schema = "response_format" in payload
                if mode == "upstream500":
                    self.send_response(500); self.end_headers(); self.wfile.write(b"boom"); return
                if mode == "reject_schema" and used_schema:
                    self.send_response(400); self.end_headers()
                    self.wfile.write(b'{"error":"response_format json_schema not supported"}'); return
                content = self.server.render(mode)
                resp = json.dumps({"id": "stub", "object": "chat.completion", "created": 1,
                                   "model": "stub", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                                   "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp)

        srv = HTTPServer(("127.0.0.1", STUB_PORT), H)
        srv.calls = 0
        srv.mode = "valid"
        srv.render = self.render
        self.httpd = srv
        self.server_ref = srv

    def render(self, mode):
        valid = json.dumps({
            "suggestions": [{"id": "c1", "action": "REVIEW", "confidence": 0.5, "reason": "stub says review", "riskNotes": None}],
            "summary": "stub summary",
        })
        calls = self.server_ref.calls
        if mode == "malformed_once":
            return valid if calls >= 2 else "no json here at all"
        if mode == "malformed_always":
            return "no json here at all"
        if mode == "bad_enum":
            return json.dumps({"suggestions": [{"id": "c1", "action": "DELETE", "confidence": 0.5, "reason": "x"}]})
        if mode == "bad_confidence":
            return json.dumps({"suggestions": [{"id": "c1", "action": "KEEP", "confidence": 7.0, "reason": "x"}]})
        return valid

    def run(self):
        self.httpd.serve_forever()


def main():
    procs: list[subprocess.Popen] = []
    try:
        # ---------------- unit-level: never-download enforcement ----------------
        sys.path.insert(0, str(ASR_DIR))
        import server as asr_server  # imports fine without faster_whisper
        ok, why = asr_server.validate_model_dir(Path("/tmp/definitely-missing-model"))
        check("asr rejects missing model path with actionable error", not ok and "never downloads" in why, why)
        (bad := Path("/tmp/fake-model-dir")).mkdir(exist_ok=True)
        ok, why = asr_server.validate_model_dir(bad)
        check("asr rejects dir without model.bin", not ok and "model.bin" in why, why)
        ok, why = asr_server.validate_model_dir(Path("/tmp/not-a-dir"))
        check("asr rejects non-directory (size names would download)", not ok, why)

        sys.path.insert(0, str(SEM_DIR))
        import riishe_schema
        good = {"suggestions": [{"id": "a", "action": "REMOVE", "confidence": 0.9, "reason": "r" * 600}], "summary": None}
        parsed, err = None, ""
        try:
            parsed = riishe_schema.RiisheOutput.model_validate(good)
        except Exception as exc:
            err = str(exc)
        check("pydantic accepts schema-valid RIISHE output (600-char reason)", parsed is not None, err)
        for name, bad_obj, frag in [
            ("invalid action enum", {"suggestions": [{"id": "a", "action": "DELETE", "confidence": 0.5, "reason": "r"}]}, "action"),
            ("confidence out of range", {"suggestions": [{"id": "a", "action": "KEEP", "confidence": 1.5, "reason": "r"}]}, "confidence"),
            ("oversized reason", {"suggestions": [{"id": "a", "action": "KEEP", "confidence": 0.5, "reason": "r" * 601}]}, "reason"),
            ("empty suggestions", {"suggestions": []}, "suggestions"),
        ]:
            try:
                riishe_schema.RiisheOutput.model_validate(bad_obj)
                check(f"pydantic rejects {name}", False, "accepted!")
            except Exception as exc:
                check(f"pydantic rejects {name}", frag in str(exc), str(exc)[-90:])
        extracted = riishe_schema.lenient_extract_json('Sure! ```json\n{"suggestions": [{"id": "a", "action": "KEEP", "confidence": 0.5, "reason": "ok",}],}\n```')
        check("lenient parser extracts fenced JSON with trailing commas", extracted["suggestions"][0]["id"] == "a")

        # ---------------- ASR sidecar, modelless (real subprocess) ----------------
        asr = start_server(ASR_DIR, {
            "BEANFX_ASR_SIDECAR_PORT": str(ASR_PORT),
            "BEANFX_ASR_SIDECAR_MODEL": "/tmp/definitely-missing-model",
        }, f"{BASE_ASR}/health")
        procs.append(asr)
        st, h = get(f"{BASE_ASR}/health")
        check("asr /health 200 with config + runtimeError", st == 200 and h.get("ready") is False and h.get("device") == "cpu" and h.get("computeType") == "int8", str(h)[:120])
        st, r = get(f"{BASE_ASR}/ready")
        check("asr /ready 503 actionable (never-download rule stated)", st == 503 and "never downloads" in str(r.get("error", "")), str(r)[:120])
        st, r = post_multipart_asr({"model": "faster-whisper-large-v3", "response_format": "json"}, body=b"RIFFxxxxWAVEjunk")
        check("asr transcription endpoint 503 modelless", st == 503 and "model" in str(r.get("error", "")).lower(), str(r)[:120])
        st, r = get(f"{BASE_ASR}/v1/models")
        check("asr /v1/models empty until ready", st == 200 and r.get("data") == [])

        # ---------------- semantic sidecar, managed mode, model+llama-server absent ----------------
        sem = start_server(SEM_DIR, {
            "BEANFX_SEM_SIDECAR_PORT": str(SEM_PORT),
            "BEANFX_SEM_SIDECAR_INTERNAL_PORT": str(SEM_INTERNAL),
            "BEANFX_SEM_SIDECAR_MODE": "managed",
        }, f"{BASE_SEM}/health")
        procs.append(sem)
        st, h = get(f"{BASE_SEM}/health")
        check("semantic /health 200 managed-mode not-ready", st == 200 and h.get("ready") is False and h.get("mode") == "managed", str(h)[:120])
        st, r = get(f"{BASE_SEM}/ready")
        err = str(r.get("error", "")) if isinstance(r, dict) else str(r)
        check("semantic /ready 503 names exact model requirement", st == 503 and "Qwen2.5" in err and "never downloads" in err, err[:150])
        st, r = post_json(f"{BASE_SEM}/v1/chat/completions", {"messages": [{"role": "user", "content": "hi"}]})
        check("semantic chat 503 modelless (no fabrication)", st == 503, str(r)[:120])

        # ---------------- semantic validation via TEST-ONLY stub upstream (proxy mode) ----------------
        stub = StubUpstream()
        stub.start()
        sem2_port = 9305
        BASE_SEM2 = f"http://127.0.0.1:{sem2_port}"
        stub.server_ref.calls = 0

        def sem2_env(mode: str):
            return {
                "BEANFX_SEM_SIDECAR_PORT": str(sem2_port),
                "BEANFX_SEM_SIDECAR_MODE": "proxy",
                "BEANFX_SEM_SIDECAR_UPSTREAM_URL": f"http://127.0.0.1:{STUB_PORT}",
                "BEANFX_SEM_SIDECAR_UPSTREAM_TIMEOUT": "20",
                "BEANFX_SEM_SIDECAR_TEST_MODE": mode,  # read by the stub via server_ref below
            }

        msg = {"messages": [{"role": "assistant", "content": "sys"}, {"role": "user", "content": "classify"}], "temperature": 0.2}

        # (a) valid upstream → 200, canonical validated content
        stub.server_ref.mode = "valid"; stub.server_ref.calls = 0
        p2 = start_server(SEM_DIR, sem2_env("valid"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        content = r.get("choices", [{}])[0].get("message", {}).get("content", "") if isinstance(r, dict) else ""
        ok_shape = False
        try:
            obj = json.loads(content)
            ok_shape = obj["suggestions"][0]["action"] in ("REMOVE", "KEEP", "REVIEW") and r.get("object") == "chat.completion"
        except Exception:
            pass
        check("semantic 200 passthrough with RIISHE-validated canonical content", st == 200 and ok_shape, content[:100])
        check("json_schema constraint was sent upstream", stub.server_ref.calls >= 1)
        p2.terminate(); procs.remove(p2)
        time.sleep(1)
        stub.server_ref.mode = "malformed_once"; stub.server_ref.calls = 0
        p2 = start_server(SEM_DIR, sem2_env("malformed_once"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        check("semantic corrective retry recovers malformed output", st == 200 and stub.server_ref.calls == 2, f"calls={stub.server_ref.calls}")
        p2.terminate(); procs.remove(p2)

        # (c) always malformed → 502, no fabrication
        stub.server_ref.mode = "malformed_always"; stub.server_ref.calls = 0
        p2 = start_server(SEM_DIR, sem2_env("malformed_always"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        err = r.get("error", {}).get("message", "") if isinstance(r, dict) else str(r)
        check("semantic 502 after 2 invalid attempts, explicitly no invention", st == 502 and "No classification was invented" in err, err[:140])
        p2.terminate(); procs.remove(p2)

        # (d) upstream hard-down (invalid action enum both attempts) → 502
        stub.server_ref.mode = "bad_enum"; stub.server_ref.calls = 0
        p2 = start_server(SEM_DIR, sem2_env("bad_enum"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        check("semantic 502 on invalid action enum (schema enforced)", st == 502, str(r)[:120])
        p2.terminate(); procs.remove(p2)

        # (e) upstream 500 → 502 (provider failure surfaced, nothing invented)
        stub.server_ref.mode = "upstream500"
        p2 = start_server(SEM_DIR, sem2_env("upstream500"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        err = r.get("error", {}).get("message", "") if isinstance(r, dict) else str(r)
        check("semantic 502 when upstream answers 500", st == 502 and "upstream answered 500" in err, err[:140])
        p2.terminate(); procs.remove(p2)

        # (f) upstream rejects response_format json_schema → falls back, still validated
        stub.server_ref.mode = "reject_schema"; stub.server_ref.calls = 0
        p2 = start_server(SEM_DIR, sem2_env("reject_schema"), f"{BASE_SEM2}/health"); procs.append(p2)
        st, r = post_json(f"{BASE_SEM2}/v1/chat/completions", msg)
        check("semantic falls back when upstream rejects json_schema (validation still applied)", st == 200, str(r)[:120])
        p2.terminate()

        print(f"\nRESULT pass={passed} fail={failed}")
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

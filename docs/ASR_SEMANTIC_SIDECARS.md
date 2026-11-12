# BEAN FX — Local ASR & Semantic Sidecars (Workstation Deployment)

The BEAN FX pipeline speaks to inference providers over two OpenAI-compatible
HTTP contracts. In the default cloud deployment the z-ai SDK answers those
contracts. On your workstation the **sidecars** in `mini-services/` answer
them locally — real implementations, no mocks, no Ollama, and **they never
download models**.

| Sidecar | Directory | App-facing contract | Default port |
|---|---|---|---|
| ASR (speech → text) | `mini-services/asr-sidecar/` | `POST /v1/audio/transcriptions` (multipart `file`, `model`, `response_format`) → `{"text": "..."}` | 9300 |
| Semantic (RIISHE classification) | `mini-services/semantic-sidecar/` | `POST /v1/chat/completions` (OpenAI chat shape) → validated RIISHE JSON in assistant content | 9301 |

Both contracts are already implemented by the application adapters
(`src/lib/asr-providers.ts`, `src/lib/riishe-inference.ts`) — the sidecars
implement the *other end* of those exact contracts. `scripts/phase2-sidecar-tests.py`
verifies every behavior below end-to-end.

---

## 1. Model installation (OPTIONAL and MANUAL — never automatic)

Neither sidecar ever downloads a model. Models must exist on disk **before**
startup; missing models produce actionable 503s that name the exact missing
requirement. There is no silent fallback and no fabricated result.

### 1a. ASR — faster-whisper (CTranslate2) model directory

Pick a size that fits your machine (Ryzen 7 / 32 GB RAM handles `large-v3`,
but `small`/`medium` start faster):

| Model | Speed on CPU | Install to |
|---|---|---|
| `Systran/faster-whisper-small` | fast | `D:\BeanFX Models\asr\faster-whisper-small` |
| `Systran/faster-whisper-medium` | balanced | `D:\BeanFX Models\asr\faster-whisper-medium` |
| `Systran/faster-whisper-large-v3` | slow, best quality | `D:\BeanFX Models\asr\faster-whisper-large-v3` |

Manual download (one command, run by YOU — the sidecar will not do this):

```bash
pip install huggingface-hub
hf download Systran/faster-whisper-small --local-dir "D:\BeanFX Models\asr\faster-whisper-small"
```

The directory must contain `model.bin` (the CTranslate2 weights) — the sidecar
validates this at startup and refuses anything else.

### 1b. Semantic — Qwen2.5 Instruct GGUF + llama.cpp

Two artifacts, both installed manually:

1. **`llama-server` binary** — build llama.cpp with CPU (or any backend you
   have): `cmake -B build -DGGML_CUDA=OFF && cmake --build build` → note the
   path of `llama-server` (add `-DGGML_CUDA=ON` later for your RTX 5060 Ti —
   the sidecar's `--ngl 0` flag then becomes your tuning knob).
2. **A Qwen2.5 Instruct GGUF model file** (CPU-friendly: 3B–7B, Q4_K_M):
   `Qwen/Qwen2.5-3B-Instruct-GGUF` → e.g. `D:\BeanFX Models\semantic\Qwen2.5-3B-Instruct-Q4_K_M.gguf`

---

## 2. Running the sidecars

```bash
cd mini-services/asr-sidecar
python -m venv .venv && .venv/bin/pip install -r requirements.txt
BEANFX_ASR_SIDECAR_MODEL="D:\BeanFX Models\asr\faster-whisper-small" .venv/bin/python server.py
```

```bash
cd mini-services/semantic-sidecar
python -m venv .venv && .venv/bin/pip install -r requirements.txt
BEANFX_SEM_SIDECAR_MODEL_PATH="D:\BeanFX Models\semantic\Qwen2.5-3B-Instruct-Q4_K_M.gguf" \
BEANFX_SEM_SIDECAR_LLAMA_SERVER="/opt/llama.cpp/build/bin/llama-server" \
.venv/bin/python server.py
```

Then point the application at them (`.env`):

```
BEANFX_ASR_PROVIDER=local-http
BEANFX_ASR_ENDPOINT=http://127.0.0.1:9300/v1/audio/transcriptions
BEANFX_ASR_MODEL=faster-whisper-small

BEANFX_SEMANTIC_PROVIDER=local-http
BEANFX_SEMANTIC_ENDPOINT=http://127.0.0.1:9301/v1/chat/completions
BEANFX_SEMANTIC_MODEL=Qwen2.5-3B-Instruct-Q4_K_M
```

### Sidecar environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BEANFX_ASR_SIDECAR_PORT` | 9300 | app-facing port |
| `BEANFX_ASR_SIDECAR_MODEL` | — | **required**: local model directory (with `model.bin`) |
| `BEANFX_ASR_SIDECAR_DEVICE` | `cpu` | future GPU: `cuda` |
| `BEANFX_ASR_SIDECAR_COMPUTE_TYPE` | `int8` | future GPU: `float16` |
| `BEANFX_ASR_SIDECAR_CPU_THREADS` | all cores | whisper CPU threads |
| `BEANFX_ASR_SIDECAR_MAX_CONCURRENT` | 2 | bounded parallel transcriptions (saturation → 429) |
| `BEANFX_ASR_SIDECAR_TIMEOUT` | 300 | hard per-request timeout (→ 504) |
| `BEANFX_SEM_SIDECAR_PORT` | 9301 | app-facing port |
| `BEANFX_SEM_SIDECAR_MODE` | `managed` | `managed` = sidecar supervises llama-server; `proxy` = validate an existing endpoint |
| `BEANFX_SEM_SIDECAR_INTERNAL_PORT` | 9302 | llama-server port (managed) |
| `BEANFX_SEM_SIDECAR_MODEL_PATH` | — | **required (managed)**: local GGUF file |
| `BEANFX_SEM_SIDECAR_LLAMA_SERVER` | PATH lookup | path to `llama-server` binary |
| `BEANFX_SEM_SIDECAR_CTX_SIZE` | 8192 | llama.cpp context |
| `BEANFX_SEM_SIDECAR_THREADS` | all cores | llama.cpp CPU threads |
| `BEANFX_SEM_SIDECAR_UPSTREAM_URL` | — | **required (proxy)**: existing OpenAI-compatible chat URL |
| `BEANFX_SEM_SIDECAR_UPSTREAM_TIMEOUT` | 180 | upstream timeout seconds |

---

## 3. Honest-failure semantics (tested by `scripts/phase2-sidecar-tests.py`)

| Situation | Response |
|---|---|
| No local model configured / path missing / not a CT2 dir | `/ready` 503 stating the exact requirement + "never downloads"; transcription 503 |
| Invalid/undecodable audio | 400 naming the failure — nothing invented |
| Sidecar saturated | 429 with the active count (resource-aware, unbounded queues impossible) |
| Transcription exceeding the timeout | 504 |
| Semantic upstream 5xx / unreachable / timeout | 502 (or 504 on timeout) — the pipeline reports the stage honestly |
| Upstream reply that is not valid RIISHE JSON | ONE corrective retry, then 502 "No classification was invented" |
| Upstream reply violating the RIISHE schema (bad enum, confidence 1.5, oversized reason) | same retry + 502 path — schema is enforced locally, never trusted |
| Upstream rejects `response_format` json_schema | retried without the constraint, validation still applied |

Client disconnects cancel in-flight work (uvicorn cancels the request task and
releases the concurrency slot) — the app's job runner owns retry/cancel policy.

## 4. Validation & tests

```bash
python scripts/phase2-sidecar-tests.py   # full contract suite: success + every failure mode
```

The suite proves: the exact wire contracts, modelless 503s, the never-download
rule, schema enforcement, corrective retry, json_schema fallback, and honest
502s — using a TEST-ONLY stub upstream for the validation cases. Real-model
inference requires the weights from §1 and is verified separately.

## 5. GPU acceleration (future, capability-based)

CPU-first today: `--ngl 0`, `device=cpu`, `int8`. When your Windows machine
enables CUDA (RTX 5060 Ti): install a CUDA build of faster-whisper/CTranslate2
and llama.cpp, set `BEANFX_ASR_SIDECAR_DEVICE=cuda`,
`BEANFX_ASR_SIDECAR_COMPUTE_TYPE=float16`, and raise llama.cpp `--ngl`.
The application adapters need **no changes** — the contracts are identical.
Hardware acceleration is claimed working only after verification on the
actual machine.

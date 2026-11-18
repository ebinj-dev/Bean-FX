#!/usr/bin/env bash
# One-command M5 push (runs with the persistent credential).
# Clones fresh at the remote tip, overlays the M5 file set, commits, pushes
# ONLY feature/ai-creative-studio (plain push, never force), then verifies
# the remote SHA and that main is untouched.
set -euo pipefail
SRC=/home/z/my-project
AUTH="$SRC/scripts/git-cred-helper.sh"
BRANCH=feature/ai-creative-studio
CLONE=/tmp/beanfx-push-m5

# 0. authentication gate (persistent credential; exact-reason failures)
bash "$SRC/scripts/gh-auth-restore.sh" || { echo "FATAL: GitHub authentication not ready — see reason above"; exit 1; }
test -x "$AUTH" || { echo "FATAL: credential helper $AUTH missing"; exit 1; }

# 1. fresh clone at the remote tip
rm -rf "$CLONE"
git clone -c credential.helper="!$AUTH" "https://github.com/ebinj-dev/Bean-FX.git" "$CLONE"
cd "$CLONE"
echo "=== tips before push ==="
git ls-remote origin refs/heads/"$BRANCH" refs/heads/main | cat
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
BASE=$(git rev-parse HEAD)
echo "branch tip before push: $BASE"

# 2. overlay the M5 set
bash "$SRC/scripts/overlay-m5.sh" "$CLONE"

# 3. commit
if git status --porcelain | grep -q .; then
  git add -A
  git -c user.name="Z User" -c user.email="z@container" commit -m "M5 (GANGZII): audio intelligence engine — analysis, DSP, non-destructive processing, editor + MY AI integration

- analysis (src/lib/gangzii): streaming 48 kHz decode (memory-bounded) with
  ITU-R BS.1770-4 loudness (integrated/short-term/LRA/momentary, exact 48 kHz
  K-weighting table — EBU Tech 3341 anchors verified by tests), 4x-oversampled
  true peak, clipping runs, DC offset, per-channel RMS + measured imbalance and
  corrective gains, 48-band spectrum (dependency-free FFT), speech/music
  heuristic (labelled as heuristic), silence spans, noise floor, waveform
- DSP chain builder (dsp.ts): the ONLY place FFmpeg filter strings are composed
  — strict zod params in, deterministic ordered chain out (balance, high-pass,
  adeclick, hum notches, afftdn, deesser, EQ, gate, acompressor, static-gain or
  dynamic loudness, trim, alimiter with auto-level disabled, fades); 11 presets
- non-destructive: GangziiProcess rows store params + inspection as structured
  data; outputs are derived files under media-store/derived/ registered as
  MediaAsset rows (derivedFromId -> original); editor applies results as ONE
  M1 ReplaceClip command (undo/redo/autosave native); A/B bypass swaps
  original <-> derived; reprocess always starts from the original
- durable jobs: GANGZII_ANALYZE/GANGZII_PROCESS owned by the M3.4 worker
  (claim, heartbeat, stale recovery, retry, hard timeouts 900s/1800s);
  FFmpeg via JobManager.runFfmpeg (real -progress, cancel, timeout kill);
  A/V sync guard verifies derived duration (±50ms; ±500ms dynamic loudnorm);
  cancellation never touches originals, partial outputs removed
- MY AI interface (proposal.ts): deterministic intent table -> zod-validated
  proposals with measured facts (noise floor, hum frequency, balance gains);
  unmatched instructions answered honestly; no LLM inside GANGZII, no Ollama,
  no ML claims; GANGZII_ENGINE descriptor = M8 registry groundwork
- editor: GangziiPanel in the existing design system (analyse, presets,
  bounded param editors, apply, A/B, saved profiles with reprocess/delete)
- DB: additive-only migration (GangziiProcess table + MediaAsset.derivedFromId)
  with content-verified backup applier; prisma validate clean
- tests: 102 tests across 9 suites, 0 failures via scripts/run-all-tests.sh
  (per-suite process isolation fixes the five previously-flaky combined-run
  failures: bun runs files in one process, so a suite's DATABASE_URL override
  lost to the db.ts PrismaClient singleton); BS.1770 anchors, real-FFmpeg
  round-trips (hum -20dB, loudness ±1 LU, duration ±50ms, video copied
  bit-exact), non-destructive md5, cancel mid-run, tenant isolation,
  persistence/reprocess, undo/redo, measured timing
- gates: tsc clean, eslint --max-warnings=0 clean, prisma validate, build ok
- docs: M5_GANGZII.md (architecture, contracts, measurements, limitations)"
  SHA=$(git rev-parse HEAD)
else
  SHA=$(git rev-parse HEAD)
  echo "no diff after overlay — nothing to commit"
fi

# 4. push — plain push to the one branch only (fails on non-fast-forward; never force)
git push origin "$BRANCH"
echo "=== pushed local SHA: $SHA ==="

# 5. verify via GitHub (ls-remote = the authoritative remote state)
sleep 2
REMOTE_TIP=$(git ls-remote origin refs/heads/"$BRANCH" | awk '{print $1}')
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | awk '{print $1}')
echo "remote $BRANCH tip: $REMOTE_TIP"
echo "remote main tip:   $REMOTE_MAIN"
[ "$REMOTE_TIP" = "$SHA" ] && echo "VERIFIED: remote branch tip == pushed commit" || { echo "MISMATCH between pushed and remote tip"; exit 1; }
echo "$REMOTE_MAIN" > /tmp/remote-main-sha-m5.txt
echo "=== pushed files ==="
git diff --name-only "$BASE" HEAD
echo "PUSH_COMPLETE"

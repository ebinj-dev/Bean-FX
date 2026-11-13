#!/usr/bin/env bash
# TEST FIXTURE — a deterministic fake "z-ai" CLI for JAZMII/LAXII lifecycle
# tests. NOT a real provider; labeled as a fixture everywhere it is used.
# Behavior driven by FAKE_ZAI_DIR:
#   task.json / result.json  — video + async-result subcommands (JSON out)
#   output.jpg / output2.jpg — image / image-edit subcommands (binary copy)
#   reject.txt               — when present for image ops: exit 42 (auth fail)
out=""; prev=""
for a in "$@"; do
  if [[ "$prev" == "-o" ]]; then out="$a"; fi
  prev="$a"
done
d="${FAKE_ZAI_DIR:?}"
case " $* " in
  *" async-result "*)
    if [[ -f "$d/result.json" ]]; then cat "$d/result.json" > "$out"; else echo '{}' > "$out"; fi ;;
  *" video "*)
    if [[ -f "$d/task.json" ]]; then cat "$d/task.json" > "$out"; fi ;;
  *" image-edit "*)
    if [[ -f "$d/reject.txt" ]]; then echo "429 rate limited (fixture)" >&2; exit 42; fi
    [[ -f "$d/output2.jpg" ]] && cp "$d/output2.jpg" "$out" ;;
  *" image "*)
    if [[ -f "$d/reject.txt" ]]; then echo "401 unauthorized api key (fixture)" >&2; exit 42; fi
    [[ -f "$d/output.jpg" ]] && cp "$d/output.jpg" "$out" ;;
esac

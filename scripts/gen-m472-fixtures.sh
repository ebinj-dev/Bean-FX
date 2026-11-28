#!/usr/bin/env bash
# M48-G4 — regenerate the documented M47.2 render-matrix fixtures into
# /tmp/m472-media (content per the matrix header: deterministic, locally
# generated with ffmpeg; no user media is used or modified).
set -euo pipefail
DIR=/tmp/m472-media
mkdir -p "$DIR"

ffmpeg -y -f lavfi -i testsrc2=duration=6:size=480x270:rate=30 -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$DIR/t2.mp4" > /dev/null 2>&1

# cycler: red→green→blue + sine 440 Hz, content-addressable. Blend zones are
# built with fade-in-from-previous-colour (deterministic linear blends — no
# xfade offset ambiguity): red [0–2.5], red→green [2.5–2.9], green [2.9–4.5],
# green→blue [4.5–4.9], blue [4.9–6.7]. Sizing per the matrix's frame math
# (case C samples pure colours at 1/3/5 s; case I samples the red→green
# blend at ~2.75 s).
ffmpeg -y \
  -f lavfi -i "color=red:size=480x270:rate=30:duration=2.5" \
  -f lavfi -i "color=green:size=480x270:rate=30:duration=0.4,fade=t=in:st=0:d=0.4:color=red" \
  -f lavfi -i "color=green:size=480x270:rate=30:duration=1.6" \
  -f lavfi -i "color=blue:size=480x270:rate=30:duration=0.4,fade=t=in:st=0:d=0.4:color=green" \
  -f lavfi -i "color=blue:size=480x270:rate=30:duration=1.8" \
  -f lavfi -i sine=frequency=440:duration=6.7 \
  -filter_complex "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -map 5:a -c:v libx264 -c:a aac -shortest "$DIR/cycler.mp4" > /dev/null 2>&1

ffmpeg -y -f lavfi -i testsrc2=duration=4:size=480x270:rate=30 \
  -c:v libx264 -pix_fmt yuv420p -an "$DIR/silent.mp4" > /dev/null 2>&1

ffmpeg -y -f lavfi -i smptebars=duration=4:size=480x270:rate=30 -f lavfi -i sine=frequency=523:duration=4 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$DIR/smpte.mp4" > /dev/null 2>&1

ffmpeg -y -f lavfi -i mandelbrot=size=480x270:rate=30 -f lavfi -i sine=frequency=659:duration=4 \
  -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$DIR/mandel.mp4" > /dev/null 2>&1

ffmpeg -y -f lavfi -i sine=frequency=880:duration=4 -c:a pcm_s16le "$DIR/music.wav" > /dev/null 2>&1

ffmpeg -y -f lavfi -i "color=red:size=480x270:rate=30:duration=4" -frames:v 1 "$DIR/red.png" > /dev/null 2>&1
ffmpeg -y -f lavfi -i "color=blue:size=480x270:rate=30:duration=4" -frames:v 1 "$DIR/blue.png" > /dev/null 2>&1

# longcycler: red/green/blue 84 s each (252 s total) + sine
ffmpeg -y -f lavfi -i "color=red:size=480x270:rate=30:duration=84" \
  -f lavfi -i "color=green:size=480x270:rate=30:duration=84" \
  -f lavfi -i "color=blue:size=480x270:rate=30:duration=84" \
  -f lavfi -i sine=frequency=440:duration=252 \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -map 3:a -c:v libx264 -c:a aac -shortest "$DIR/longcycler.mp4" > /dev/null 2>&1

ls -la "$DIR" | awk '{print $9, $5}' | tail -n +2

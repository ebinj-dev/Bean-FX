#!/usr/bin/env python3
"""Simulate the CORRECTED deterministic classification on the 20:19 recording.

Replicates the pipeline (HIGH profile VAD → gaps → fixed intraSentence rule →
fixed classification) and reports the honest REMOVE / REVIEW proposal set with
exact timestamps, plus a near-duplicate (repeated-take) scan of the transcript.
"""
import json, re, difflib
import numpy as np
import subprocess

SRC = "/home/z/my-project/media-store/originals/mw3274j8aiu1ad.mp3"
SR = 16000; WINDOW = 0.010
res = json.load(open("/home/z/my-project/media-store/analysis-results/cmw77i6fu0001pqvclh7lav8g.json"))
segs = res["transcript"]["segments"]

raw = subprocess.run(["ffmpeg","-v","error","-i",SRC,"-f","f32le","-ac","1","-ar",str(SR),"-"],capture_output=True,check=True).stdout
pcm = np.frombuffer(raw, dtype=np.float32)
n = len(pcm)//int(SR*WINDOW); frames = pcm[:n*int(SR*WINDOW)].reshape(n, int(SR*WINDOW))
env = np.sqrt((frames**2).mean(axis=1))
floor = float(np.percentile(env,10))

def med3(v):
    o=v.copy(); o[1:-1]=np.minimum(np.maximum(v[:-2],v[2:]),v[1:-1]); return o
def spans_for(mult):
    hi=max(floor*mult,0.006); lo=hi*0.55
    sm=med3(env); out=[]; act=False; st=0; q=0; c=0
    ms=max(2,round(0.06/WINDOW)); hg=max(1,round(0.12/WINDOW))
    for i,v in enumerate(sm):
        if not act:
            if v>=hi: act=True; st=i; c=1; q=0
        else:
            c+=1
            if v>=lo: q=0
            else:
                q+=1
                if q>hg:
                    e=i-q+1
                    if c>=ms: out.append([st*WINDOW, e*WINDOW, float(env[st:e].mean())])
                    act=False; c=0; q=0
    if act and c>=ms: out.append([st*WINDOW, len(sm)*WINDOW, float(env[st:].mean())])
    return out

spans = spans_for(4.4)  # HIGH profile (matches job's speechSpanCount 465≈469)
print(f"spans={len(spans)} (job reported 465)")
speech_rms = sorted(s[2] for s in spans); median_rms = speech_rms[len(speech_rms)//2]

def terminal(t):
    t=t.strip()
    if not t or re.search(r"(…|\.\.\.|\. \. \.)$",t): return False
    return bool(re.search(r"[.!?।؟。ஃ]$",t))
def cont_start(t):
    t=t.strip()
    if not t: return False
    if re.match(r"[a-zà-öø-ÿ]",t[0]): return True
    return bool(re.match(r"^(because|and|but|so|which|that|was|were|is|are|to|then|just|since|as|for|with|without|after|before|when|while|if)\b",t))

# settings (defaults): pad 0.15/0.2, target 0.35, tighten on, minSilence 0.5
PAD_H,PAD_T,TARGET,MIN_SIL = 0.15,0.2,0.35,0.5
remove_list=[]; review_list=[]; dropped_keep=0; counts={}
for a,b in zip(spans[:-1],spans[1:]):
    g0,g1 = a[1], b[0]; pause = g1-g0
    if pause < MIN_SIL: continue
    start = g0+PAD_H; end = g1-PAD_T; removable = end-start
    if removable < 0.25: continue                       # tighten: nothing to save
    cut_len = max(0.03, removable - max(0.0, TARGET-(PAD_H+PAD_T)))
    cs = start + (removable-cut_len)/2; ce = cs+cut_len
    prev = [s for s in segs if s["start"] < g0 and s["end"] > g0-1.5]
    prev = max(prev,key=lambda s:s["end"]) if prev else None
    nxt = [s for s in segs if s["end"] > g1 and s["start"] < g1+1.5]
    nxt = min(nxt,key=lambda s:s["start"]) if nxt else None
    words = sum(1 for s in segs for w in s.get("words",[]) if w["start"]<ce and w["end"]>cs)
    # FIXED intra rule: both sides must signal continuation (or same segment)
    intra = bool(prev and nxt and (prev is nxt or (not terminal(prev["text"]) and cont_start(nxt["text"]))))
    quiet = (a[2] < median_rms*0.35) or (b[2] < median_rms*0.35)
    if words>0: k="REVIEW"; note=f"{words} word(s) in range"
    elif intra and pause<=3.0: dropped_keep+=1; continue
    elif intra: k="REVIEW"; note="long intra-sentence pause"
    elif quiet and pause<2.5: k="REVIEW"; note="quiet speech nearby"
    elif pause>=1.0: k="REMOVE"; note=f"inter-sentence dead air {pause:.2f}s"
    else: k="REVIEW"; note=f"short gap {pause:.2f}s"
    counts[k]=counts.get(k,0)+1
    entry=(cs,ce,cut_len,pause,note)
    (remove_list if k=="REMOVE" else review_list).append(entry)

tot_r=sum(e[2] for e in remove_list); tot_v=sum(e[2] for e in review_list)
print(f"\nFIXED classification: REMOVE={len(remove_list)} ({tot_r:.1f}s)  REVIEW={len(review_list)} ({sum(e[3] for e in review_list):.1f}s raw pauses)  dropped-KEEP(short intra)={dropped_keep}")
def mmss(t): return f"{int(t)//60:02d}:{int(t)%60:02d}"
print("\nREMOVE intervals (start→end, cut):")
for cs,ce,cut,pause,note in remove_list:
    print(f"  {mmss(cs)}.{int(cs*100)%100:02d} → {mmss(ce)}.{int(ce*100)%100:02d}  cut {cut:5.2f}s (pause {pause:.2f}s)  {note}")
print("\nREVIEW intervals (top 25 by pause):")
for cs,ce,cut,pause,note in sorted(review_list,key=lambda e:-e[3])[:25]:
    print(f"  {mmss(cs)} → {mmss(ce)}  pause {pause:.2f}s  {note}")

# repeated-take scan: consecutive near-duplicate segments
dups=[]
for i in range(1,len(segs)):
    a,b=segs[i-1]["text"],segs[i]["text"]
    r=difflib.SequenceMatcher(None,a.lower(),b.lower()).ratio()
    if r>=0.75: dups.append((i,r,a[:60],b[:60]))
print(f"\nnear-duplicate consecutive segments (ratio≥0.75): {len(dups)}")
for i,r,a,b in dups[:8]: print(f"  seg{i} r={r:.2f}: [{a}] vs [{b}]")

# filler scan on words
words=[w["text"].lower().strip(".,!?;:\"()") for s in segs for w in s.get("words",[])]
lex=["um","uh","erm","hmm","uhh","you know","i mean","sort of","kind of","eatho","ennavo","appo","appadeinu","ஏதோ","என்னவோ","அப்போ","அப்படேனு"]
print("\nlexicon fillers present:", {f:words.count(f) for f in lex if words.count(f)})

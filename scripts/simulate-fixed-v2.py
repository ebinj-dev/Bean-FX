#!/usr/bin/env python3
"""Final design quantification: categorize every gap and compute the proposal
set under the FIXED rules before touching the TypeScript."""
import json, re, subprocess
import numpy as np

SRC = "/home/z/my-project/media-store/originals/mw3274j8aiu1ad.mp3"
SR = 16000; WINDOW = 0.010
res = json.load(open("/home/z/my-project/media-store/analysis-results/cmw77i6fu0001pqvclh7lav8g.json"))
segs = res["transcript"]["segments"]

raw = subprocess.run(["ffmpeg","-v","error","-i",SRC,"-f","f32le","-ac","1","-ar",str(SR),"-"],capture_output=True,check=True).stdout
pcm = np.frombuffer(raw, dtype=np.float32)
n = len(pcm)//int(SR*WINDOW); frames = pcm[:n*int(SR*WINDOW)].reshape(n, int(SR*WINDOW))
env = np.sqrt((frames**2).mean(axis=1)); floor = float(np.percentile(env,10))
def med3(v):
    o=v.copy(); o[1:-1]=np.minimum(np.maximum(v[:-2],v[2:]),v[1:-1]); return o
spans=[]; hi=max(floor*4.4,0.006); lo=hi*0.55; sm=med3(env)
act=False; st=0; q=0; c=0; ms=2; hg=12
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
                if c>=ms: spans.append([st*WINDOW, e*WINDOW, float(env[st:e].mean())])
                act=False; c=0; q=0
if act and c>=ms: spans.append([st*WINDOW, len(sm)*WINDOW, float(env[st:].mean())])
med_rms = sorted(s[2] for s in spans)[len(spans)//2]

def terminal(t):
    t=t.strip()
    if not t or re.search(r"(…|\.\.\.)\s*$",t): return False
    return bool(re.search(r"[.!?।؟。ஃ]\s*$",t))
def cont(t):
    t=t.strip()
    if not t: return False
    if re.match(r"[a-zà-öø-ÿ]",t[0]): return True
    return bool(re.match(r"^(because|and|but|so|which|that|was|were|is|are|to|then|just|since|as|for|with|without|after|before|when|while|if)\b",t))

PAD_H,PAD_T,TARGET,MIN_SIL = 0.15,0.2,0.35,0.5
remove=[]; review=[]; dropped=0; cats={}
for a,b in zip(spans[:-1],spans[1:]):
    g0,g1=a[1],b[0]; pause=g1-g0
    if pause<MIN_SIL: continue
    start=g0+PAD_H; end=g1-PAD_T; removable=end-start
    if removable<0.25: continue
    cut=max(0.03, removable-max(0.0,TARGET-(PAD_H+PAD_T)))
    cs=start+(removable-cut)/2; ce=cs+cut
    prev=[s for s in segs if s["start"]<g0 and s["end"]>g0-1.5]
    prev=max(prev,key=lambda s:s["end"]) if prev else None
    nxt=[s for s in segs if s["end"]>g1 and s["start"]<g1+1.5]
    nxt=min(nxt,key=lambda s:s["start"]) if nxt else None
    words=sum(1 for s in segs for w in s.get("words",[]) if w["start"]<ce and w["end"]>cs)
    quiet=(a[2]<med_rms*0.35) or (b[2]<med_rms*0.35)
    same = prev is not None and nxt is not None and prev is nxt
    if words>0: cat="words"; k="REVIEW"
    elif pause>=3.0: cat="long-dead-air"; k="REMOVE"
    elif same: cat="same-seg"; dropped+=1; continue
    elif prev and nxt and terminal(prev["text"]): cat="inter-terminal"; k="REMOVE" if pause>=1.0 else "REVIEW"
    elif prev and nxt and not terminal(prev["text"]) and cont(nxt["text"]): cat="intra-cont"; dropped+=1; continue
    elif prev and nxt: cat="boundary-unknown"; k="REVIEW"
    else: cat="no-neighbour(failed-asr/edge)"; k="REMOVE" if pause>=1.0 else "REVIEW"
    if quiet and pause<2.5 and k=="REMOVE": k="REVIEW"; cat+="+quiet"
    if quiet and pause<2.5 and k in("REMOVE",): pass
    cats[cat]=cats.get(cat,0)+1
    (remove if k=="REMOVE" else review).append((cs,ce,cut,pause,cat))

tot=sum(e[2] for e in remove)
print(f"categories: {cats}")
print(f"REMOVE: {len(remove)} intervals, cut total {tot:.2f}s")
for cs,ce,cut,pause,cat in remove:
    print(f"  {int(cs)//60:02d}:{int(cs)%60:02d}.{int(cs*100)%100:02d} → {int(ce)//60:02d}:{int(ce)%60:02d}.{int(ce*100)%100:02d}  cut {cut:5.2f}s (pause {pause:4.2f}s)  {cat}")
print(f"REVIEW: {len(review)} intervals, raw pause {sum(e[3] for e in review):.1f}s")
print(f"dropped as normal short intra-sentence pauses (not cards): {dropped}")

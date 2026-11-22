# M35 Track I — Cost & Capacity Model

**Rules honored:** every priced line carries source + access date + billing unit; anything unsourced is **COST UNKNOWN**; no billing activated; no free-tier claims beyond what vendor pages state.

**Sourced pricing (accessed 2026-11-22):**
- Cloudflare R2 — developers.cloudflare.com/r2/pricing: storage $0.015/GB-mo; Class A ops $4.50/M; Class B ops $0.36/M; egress free; free tier 10 GB-mo + 1M Class A + 10M Class B monthly. Region-agnostic (R2), USD.
- Backblaze B2 — backblaze.com/cloud-storage/pricing: $6.95/TB-mo (~$0.007/GB-mo); egress free up to 3× monthly average stored, then $0.01/GB; unlimited free egress via partner CDNs (incl. Cloudflare); Class A/B/C transactions free on PAYG; free tier 10 GB. Region US (rates may vary), USD.
- Hetzner Cloud — hetzner.com/cloud: shared-vCPU lines from **€5.49–5.99/mo** (too small for the 8 GB render requirement); **dedicated-vCPU General Purpose line from €36.99/mo** (excl. VAT, EU/US regions; per-spec table on plan pages). EUR.
- Domain registration, AWS S3, managed PostgreSQL, CDN, monitoring SaaS: **COST UNKNOWN** (not sourced this milestone).

**Workload assumptions (ESTIMATE, from M20/M34 measurements):** 1 long render ≈ 2.5 GB peak ffmpeg RSS; 600 s timeline ≈ 395 s wall on a 4 vCPU-class host; media growth dominated by uploads+exports; DB small (66 tables, MB-scale for a beta).

## Size 1 — Personal development / single operator

| Line item | Spec | Monthly | Source/class |
|---|---|---|---|
| Host (app+DB+render+media, single server) | 8 GB RAM dedicated-vCPU class | from €36.99 (≈ $40) | Hetzner GP floor, 2026-11-22 — VERIFIED price floor; final tier owner choice |
| Database | SQLite file on host | €0 | included |
| Media storage | host disk sized to library (e.g., 200 GB) | included in host/upgrade COST UNKNOWN beyond host floor | VERIFIED floor + UNKNOWN delta |
| Backups | off-host target | B2: $0.007/GB-mo → 200 GB ≈ **$1.40** | B2 VERIFIED rate × ESTIMATE volume |
| Transfer | R2/B2 egress models | ≈ $0 at these volumes (B2 ≤3× rule; R2 free) | VERIFIED rules |
| Domain + TLS | 1 domain; TLS via Let's Encrypt | domain **COST UNKNOWN**; TLS €0 | UNSOURCED / VERIFIED-free |
| Monitoring | local scripts (Track H) | €0 | VERIFIED approach |
| AI providers | unconfigured / manual | $0 (no paid calls authorized) | CONFIGURATION REQUIRED; paid pricing **COST UNKNOWN** (M32/M34: pricing never verified) |
| **Total** | | **≈ $41–45/mo + domain (UNKNOWN)** | floor-based, VERIFIED anchors + honest gaps |

## Size 2 — Small controlled beta (≤ ~25 users)

| Line item | Spec | Monthly | Class |
|---|---|---|---|
| App+DB host | 16 GB / 8 vCPU dedicated | ESTIMATE **$55–90** (tier above GP floor; exact tier table COST UNKNOWN — owner picks from Hetzner plan pages) | ESTIMATE |
| Render | same host, serialized (Track E) | included | VERIFIED approach |
| Media storage | 500 GB host disk | included/upgrade COST UNKNOWN | ESTIMATE |
| Backups | 500 GB on B2 | ≈ **$3.50** | VERIFIED rate × ESTIMATE |
| Transfer | same | ≈ $0–5 | ESTIMATE within free rules |
| Domain + TLS + monitoring | as Size 1 | +domain UNKNOWN | as above |
| AI providers | still unconfigured | $0; paid use requires owner approval + pricing verification (COST UNKNOWN) | CONFIGURATION REQUIRED |
| **Total** | | **≈ $60–100/mo + domain** | honest ranges, no invented tiers |

## Size 3 — Growing production workload (Option 2/3 topology)

| Line item | Spec | Monthly | Class |
|---|---|---|---|
| App host (API only) | 8 GB dedicated | from $40 | VERIFIED floor |
| Render worker host(s) | 16–32 GB dedicated, 1–2 | ESTIMATE $90–180 | ESTIMATE |
| Database | **PostgreSQL required** (Track C) — managed or self-host | **COST UNKNOWN** (vendor unchosen; self-host = host cost) | INFRASTRUCTURE REQUIRED + UNKNOWN |
| Object storage (media durable tier) | 1 TB R2 | **$15** | VERIFIED rate ($0.015/GB-mo) |
| Storage transfer | R2 egress free / B2 3× rule | ≈ $0–20 | VERIFIED rules + ESTIMATE ops volume |
| Backups | DB + metadata on B2 (≈ small) | ≈ $1–3 | VERIFIED rate × ESTIMATE |
| CDN (optional) | not required by current architecture | COST UNKNOWN | UNSOURCED |
| Monitoring | local scripts → optionally external | COST UNKNOWN (owner approval required) | UNSOURCED |
| AI providers | paid generation if approved | **COST UNKNOWN** until authoritative provider pricing is recorded (long-standing M32/M34 restriction) | COST UNKNOWN |
| **Total** | | **≈ $150–250/mo + UNKNOWN lines** | ranges with explicit gaps |

## Lowest-reasonable-cost path preserving migration options

**Start:** single server (Hetzner GP-class floor €36.99/mo VERIFIED) + B2 backups (~$1.40/mo VERIFIED rate) + Let's Encrypt TLS + local monitoring. **Preserved options:** `DATABASE_URL` provider swap path (Track C design ready), media root → object-storage key model (Track D design ready), worker split (Track E sizing ready) — none require re-architecture, only the pre-designed migration steps and owner infrastructure approvals.

**Explicit COST UNKNOWN register:** domain registration; exact VPS tier tables above the GP floor; AWS S3 rates; managed PostgreSQL; CDN; external monitoring; **all paid AI provider pricing** (standing restriction since M32 — provider execution requires owner approval and verified pricing first).

# M35 Track B — Hosting Topology Comparison

**Basis:** the actual architecture (Track A): one Next.js process owning an in-process job runner, SQLite via Prisma, a local media root, ffmpeg children. Pricing appears only where sourced (Track I, accessed 2026-11-22); everything else is structural assessment.

## Option 1 — Single-server deployment (everything on one host)

One sufficiently provisioned server runs frontend+API (Next.js/Bun), SQLite (WAL), media root, and the in-process render runner with its ffmpeg children.

| Dimension | Assessment |
|---|---|
| Advantages | Zero architectural change: this is exactly what M34 qualified (clean checkout → 3-format workflow 6/6; M20 T1–T7 8/8 ran on this topology). Local FS paths just work; DB+media on one volume makes backup atomic-simple; one process to monitor/restart; smallest attack surface (one host, one port). |
| Disadvantages | Resource contention: renders (2.5 GB RSS observed on a 600 s windowed render) share CPU/RAM with request handling — the 4 GB sandbox OOM history is the evidence; a render-heavy user can starve interactive latency. Failure isolation is poor by construction: OOM can take the whole server (M20 T5 shows the job fails honestly, but the server itself dies too at the sandbox level). Storage growth is bounded by one disk. |
| Minimum resources | 8 GB RAM (M34 render-host minimum), 4 vCPU recommended, SSD with ~2× media-library headroom for render temporaries. |
| Failure modes | host loss = total loss without off-host backups (Track G); OOM under concurrent renders (mitigation: serialize long renders — SQLite already serializes writers; consider a max-1-long-render guard); disk full = render failure (handled honestly by the runner, tracked in Track E). |
| Security implications | smallest public surface; still requires TLS reverse proxy, OS hardening, DB file permissions (media root + DB must be private to the app user). |
| Cost | Sourced anchors only: Hetzner dedicated-vCPU General Purpose line **from €36.99/mo** (accessed 2026-11-22); exact RAM tier selection is an owner procurement decision (COST UNKNOWN beyond published floor). |
| Operational complexity | Lowest. Single systemd-style service + backup cron (Track J scripts). |
| Upgrade path | Vertical first (RAM/CPU), then Option 2 later — no data-format change needed to split the worker out. |
| Suitable scale | Single operator / controlled beta (≤ ~10 concurrent users, one long render at a time). |

## Option 2 — Split application and render workers

Frontend/API host + separate render-worker host; DB and media on shared storage.

| Dimension | Assessment |
|---|---|
| Advantages | True failure isolation (OOM kills a worker, not the API); renders scale independently; interactive latency stays stable during long renders. |
| Disadvantages | **Requires architecture work that does not exist yet:** the runner is in-process; splitting means (a) a worker binary that claims `Job` rows via the same DB coordination + stale-sweep contract, (b) shared access to the media root (NFS/SMB mount or the Track D object-storage migration — neither validated), (c) SQLite becomes the cross-host coordination point — acceptable for job claims with the existing 120 s sweep only if the DB lives somewhere BOTH hosts can reach reliably; SQLite on NFS is a known data-corruption risk → PostgreSQL becomes effectively REQUIRED at this step. |
| Minimum resources | API host 4 GB; worker host 8 GB (M34 minimum); shared storage sized to media library. |
| Failure modes | split-brain job claims if sweep timing is misconfigured across hosts; storage network becomes a render-critical dependency (segments are written/read repeatedly — latency-sensitive); more complex recovery. |
| Security implications | worker host must be private (no public ingress); storage network path must be encrypted; two hosts to patch. |
| Cost | two hosts + shared storage; only the Hetzner floor (€36.99/mo dedicated line, 2026-11-22) is sourced — total COST UNKNOWN until owner picks vendors. |
| Operational complexity | Medium-high (two services, shared-FS or object storage, job-claim correctness across hosts). |
| Upgrade path | This IS the first scaling step from Option 1; worker count can grow behind the same DB coordination. |

## Option 3 — Horizontally expandable architecture

Multiple app instances, managed database (PostgreSQL), object storage (S3-compatible), worker fleet.

| Dimension | Assessment |
|---|---|
| Advantages | True HA and independent scaling; renders never touch the API host; media durability decoupled from hosts. |
| Disadvantages | Largest change set: PostgreSQL migration (Track C), media path model → object storage URLs (Track D migration project), multiple app instances require session affinity care or stateless sessions (sessions are DB rows — already stateless-friendly), load balancer, DB connection pooling per instance (M34's `connection_limit=2`-style budgets per process), significantly higher cost and operational skill. **Not justified by any current requirement** — this would be microservices-for-fashion. |
| Minimum resources | LB + ≥2 app hosts + managed PG + object storage + ≥1 worker; everything COST UNKNOWN until vendors chosen. |
| Failure modes | distributed failure modes (partial writes across storage/DB, multi-instance job claim races) — the existing single-DB claim coordination actually handles multiple claimers safely (409-style conflict handling proven in M34's writer ladder), but every new moving part adds novel failure classes that no test has covered. |
| Security implications | largest surface: LB, storage ACLs, DB network, multi-host secret distribution. |
| Operational complexity | High — requires on-call-grade practices BEAN FX does not yet have. |

## Recommendation: **Option 1 — SINGLE-SERVER INITIAL DEPLOYMENT**, with Option 2 as the pre-planned scaling step

Why: BEAN FX's actual requirements are (a) one long render at a time for a small controlled user base, (b) DB+media locality that the code already assumes, (c) honest, recoverable failure behavior — all satisfied by the M34-qualified single-server topology with zero code change. Option 2's prerequisite work (worker binary, shared storage, PostgreSQL) is explicitly designed in Tracks C/D/E so that the upgrade path requires no rewrite of the job contract — but building it now would add unvalidated moving parts to a system whose qualification is built on reproducibility. The simplest architecture that supports the actual rendering and media requirements is one well-provisioned server with disciplined backups.

| Decision inputs | Value |
|---|---|
| Minimum infrastructure for recommendation | 1 host: 8 GB RAM / 4 vCPU / SSD ≥ 2× media headroom; TLS reverse proxy (Caddy/Nginx); off-host backup target (Track G) |
| When to move to Option 2 | sustained demand > 1 concurrent long render, or interactive latency degradation during renders, or user count beyond a controlled beta |
| What must exist first (owner) | backup/restore drill on the real host (Track G scripts provided), PostgreSQL decision deferred (Track C: SQLite sufficient for Option 1) |

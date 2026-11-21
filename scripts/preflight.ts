/**
 * BEAN FX — startup preflight (M34 Track A2).
 *
 * Read-only health/config gate for operators and developers. It NEVER prints
 * secret VALUES — for credential-bearing variables it reports presence only.
 * A missing optional provider is CONFIGURATION REQUIRED, not a system failure;
 * only missing hard dependencies produce BLOCKED.
 *
 * Run: bun scripts/preflight.ts [--json]
 */
import { accessSync, constants as fsConstants } from "fs";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { statfs } from "fs/promises";
import { promisify } from "util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const asJson = args.includes("--json");

type Status = "READY" | "WARNING" | "CONFIGURATION REQUIRED" | "BLOCKED" | "UNSUPPORTED";
interface Check { id: string; group: string; status: Status; detail: string; hint?: string }
const checks: Check[] = [];
const add = (id: string, group: string, status: Status, detail: string, hint?: string) =>
  checks.push({ id, group, status, detail, ...(hint ? { hint } : {}) });

/** Prisma client may be ungenerated in a fresh checkout — surface a clear hint instead of crashing. */
async function importPrisma(): Promise<typeof import("@prisma/client")> {
  try {
    return await import("@prisma/client");
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("prisma generate")) throw e;
    throw new Error(`@prisma/client unavailable — did you run \`bunx prisma generate\`? (${msg.slice(0, 80)})`);
  }
}

function binVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["-version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).split("\n")[0].trim());
    });
  });
}
function binExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["-version"], { timeout: 10_000 }, (err) => resolve(!err));
  });
}
/** PATH lookup for CLIs that may not support a -version flag. */
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      accessSync(path.join(d, bin), fsConstants.X_OK);
      return true;
    } catch { return false; }
  });
}
/** Presence-only secret report: never the value, never its length. */
function secretState(name: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? "NOT CONFIGURED" : "CONFIGURED";
}

async function main(): Promise<number> {
  // ---- Runtime ----
  const bunV = process.versions.bun ?? "n/a";
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  add("runtime.bun", "Runtime", "READY", `bun ${bunV} / node ${process.versions.node}`);
  if (nodeMajor < 18) add("runtime.node", "Runtime", "BLOCKED", `node ${process.versions.node} is too old for Next 16 (need >= 18)`);
  else add("runtime.node", "Runtime", "READY", `node ${process.versions.node}`);

  // ---- Required dependencies ----
  const nm = await fs.stat(path.join(process.cwd(), "node_modules")).then(() => true).catch(() => false);
  add("deps.node_modules", "Dependencies", nm ? "READY" : "BLOCKED",
    nm ? "node_modules present" : "node_modules missing — run `bun install`", "bun install");
  const ffmpeg = await binVersion("ffmpeg");
  add("deps.ffmpeg", "Dependencies", ffmpeg ? "READY" : "BLOCKED",
    ffmpeg ?? "ffmpeg not found on PATH — render pipeline cannot run", "install ffmpeg 6+ on PATH");
  const ffprobe = await binVersion("ffprobe");
  add("deps.ffprobe", "Dependencies", ffprobe ? "READY" : "BLOCKED",
    ffprobe ?? "ffprobe not found on PATH — uploads and renders are validated by it", "install ffprobe (ships with ffmpeg)");
  let pyOk = false; let pyDetail = "python3 not found — mask tooling unavailable";
  try {
    const { stdout } = await run("python3", ["-I", "-c", "import PIL; import sys; print(sys.version.split()[0], PIL.__version__)"], { timeout: 15_000 });
    pyOk = true; pyDetail = `python3 ${stdout.trim()}`;
  } catch { /* keep default detail */ }
  add("deps.python", "Dependencies", pyOk ? "READY" : "WARNING",
    pyOk ? `${pyDetail} (isolated mode -I verified)` : pyDetail,
    pyOk ? undefined : "install python3 + Pillow (mask processing, poster checks)");

  // ---- Database ----
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    add("db.url", "Database", "BLOCKED", "DATABASE_URL is not set", "DATABASE_URL=file:./db/custom.db");
  } else if (!dbUrl.startsWith("file:")) {
    add("db.url", "Database", "READY", "non-SQLite datasource configured (connection_limit not forced)");
  } else {
    const file = dbUrl.slice("file:".length).split("?")[0];
    const exists = await fs.stat(file).then(() => true).catch(() => false);
    add("db.file", "Database", exists ? "READY" : "CONFIGURATION REQUIRED",
      exists ? `database file present: ${file}` : `database file absent: ${file} — initialize with prisma db push`,
      "bunx prisma db push");
    try {
      // Read-only connectivity probe against the runtime URL semantics (pool param included).
      const { PrismaClient } = await importPrisma();
      const probe = new PrismaClient({ datasources: { db: { url: dbUrl.includes("connection_limit=") ? dbUrl : `${dbUrl.split("?")[0]}?connection_limit=2` } }, log: [] });
      const t0 = Date.now();
      await probe.$queryRawUnsafe("SELECT 1");
      await probe.$disconnect();
      add("db.connect", "Database", "READY", `connected in ${Date.now() - t0}ms`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes("prisma generate")) {
        add("db.connect", "Database", "BLOCKED", "prisma client not generated yet", "bunx prisma generate");
      } else {
        add("db.connect", "Database", "BLOCKED", `connect failed: ${msg.slice(0, 140)}`);
      }
    }
    // Schema drift (read-only): diff live database against the schema file.
    // Only meaningful when the database file actually exists — a missing file
    // is already reported by db.file above.
    if (exists) {
      try {
        // Prisma 6.19: `migrate diff` exits non-zero when the sources differ
        // and prints the human-readable diff; exit 0 = no drift.
        await run("bunx", ["prisma", "migrate", "diff", "--from-url", dbUrl, "--to-schema-datamodel", "prisma/schema.prisma"], { timeout: 60_000 });
        add("db.schema", "Database", "READY", "schema matches (no drift)");
      } catch (e: unknown) {
        const err = e as { code?: number; stdout?: string; message?: string };
        const out = String(err.stdout ?? "");
        if (err.code !== undefined && out && !out.includes("unknown or unexpected option")) {
          add("db.schema", "Database", "WARNING", "schema drift detected — apply with `bunx prisma db push` (review the diff first)", "bunx prisma db push");
        } else {
          add("db.schema", "Database", "WARNING", `drift check unavailable: ${out.slice(0, 120) || String(err.message ?? "").slice(0, 120)}`);
        }
      }
    }
    // WAL state (persistent property, read via pragma).
    try {
      const { PrismaClient } = await importPrisma();
      const probe = new PrismaClient({ datasources: { db: { url: dbUrl.includes("connection_limit=") ? dbUrl : `${dbUrl.split("?")[0]}?connection_limit=2` } }, log: [] });
      const mode = await probe.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode');
      await probe.$disconnect();
      const m = String(mode?.[0]?.journal_mode ?? "unknown");
      add("db.wal", "Database", m === "wal" ? "READY" : "WARNING",
        m === "wal" ? "WAL active" : `journal mode is ${m} (WAL expected; the app enables it on first write)`);
    } catch { add("db.wal", "Database", "WARNING", "WAL state unreadable"); }
  }

  // ---- Media storage ----
  let root = "";
  try {
    const mod = await import("../src/lib/media-storage");
    root = mod.MEDIA_ROOT;
    const st = await mod.validateStorageRoot();
    if (st.ok) add("storage.root", "Media storage", "READY", `${root} writable (originals/exports/tmp/proxies verified)`);
    else add("storage.root", "Media storage", "BLOCKED", `storage root unusable: ${st.error}`);
    // Capacity via statfs on the root.
    try {
      const s = await statfs(root);
      const freeGb = (s.bavail * Number(s.bsize)) / 1024 ** 3;
      const status: Status = freeGb < 0.5 ? "BLOCKED" : freeGb < 2 ? "WARNING" : "READY";
      const hint = status === "READY" ? undefined : status === "WARNING" ? "free disk below 2 GB — renders need transient space" : "free disk below 500 MB — uploads and renders will fail";
      add("storage.disk", "Media storage", status, `${freeGb.toFixed(1)} GB free on the storage filesystem`, hint);
    } catch { add("storage.disk", "Media storage", "WARNING", "disk capacity unavailable"); }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("prisma generate")) {
      add("storage.root", "Media storage", "BLOCKED", "prisma client not generated yet", "bunx prisma generate");
    } else {
      add("storage.root", "Media storage", "BLOCKED", `storage root invalid: ${msg.slice(0, 140)}`);
    }
  }

  // ---- Worker ----
  const autostart = process.env.BEANFX_MEDIA_WORKER_AUTOSTART;
  add("worker.autostart", "Render worker", "READY",
    autostart === "0" ? "in-process worker autostart disabled (BEANFX_MEDIA_WORKER_AUTOSTART=0) — start a worker explicitly or re-enable" : "in-process worker autostart enabled (durable Job queue; M20 claim/recovery contract)");

  // ---- Application config ----
  add("app.public_url", "Application", process.env.PUBLIC_APP_URL ? "READY" : "WARNING",
    process.env.PUBLIC_APP_URL ? `PUBLIC_APP_URL=${process.env.PUBLIC_APP_URL}` : "PUBLIC_APP_URL unset — share links and provider callbacks fall back to the request host");
  add("app.rate_limit_scale", "Application", "READY", `RATE_LIMIT_SCALE=${process.env.RATE_LIMIT_SCALE ?? "1 (default)"}`);

  // ---- Auth/session ----
  add("auth.session", "Authentication", "READY", "session cookie beanfx_session (None+Secure+Partitioned); scrypt password hashing — no extra configuration required");

  // ---- Mail (optional) ----
  const mail = process.env.SMTP_URL ?? process.env.SMTP_HOST;
  add("mail.smtp", "Integrations", mail ? "READY" : "CONFIGURATION REQUIRED",
    mail ? "SMTP configured (presence only — value never shown)" : "SMTP not configured — email verification/reset mails cannot send (local auth still works)");

  // ---- AI providers (optional; honest per-provider states) ----
  const zaiBin = process.env.BEANFX_ZAI_BIN ?? "z-ai";
  const zaiPresent = onPath(zaiBin);
  add("provider.zai.cli", "AI providers", zaiPresent ? "READY" : "CONFIGURATION REQUIRED",
    zaiPresent ? `provider CLI ${zaiBin} reachable` : `provider CLI ${zaiBin} not found — generation stages degrade to CONFIGURATION REQUIRED (product still runs)`,
    zaiPresent ? undefined : "install/configure the z-ai CLI per M34_PROVIDER_ONBOARDING.md");
  add("provider.zai.key", "AI providers", "CONFIGURATION REQUIRED",
    `ZAI_API_KEY ${secretState("ZAI_API_KEY")}, Z_AI_API_KEY ${secretState("Z_AI_API_KEY")} (presence only)`,
    "set the provider key in the environment, never in chat or committed files");
  add("provider.segmentation", "AI providers", "CONFIGURATION REQUIRED",
    "automatic segmentation intentionally NOT configured (M32/M33 decision) — manual mask import is the supported path",
    "owner approval + verified provider required before enabling");

  // ---- Summary ----
  const order: Status[] = ["BLOCKED", "UNSUPPORTED", "CONFIGURATION REQUIRED", "WARNING", "READY"];
  const worst: Status = order.find((s) => checks.some((c) => c.status === s)) ?? "READY";
  const blocked = checks.filter((c) => c.status === "BLOCKED");
  const exit = blocked.length > 0 ? 1 : 0;
  if (asJson) {
    console.log(JSON.stringify({ overall: worst, exit, checks }, null, 2));
  } else {
    const groups = [...new Set(checks.map((c) => c.group))];
    for (const g of groups) {
      console.log(`\n## ${g}`);
      for (const c of checks.filter((x) => x.group === g)) {
        console.log(`  [${c.status.padEnd(22)}] ${c.id}: ${c.detail}${c.hint ? `\n       ↳ ${c.hint}` : ""}`);
      }
    }
    console.log(`\nOVERALL: ${worst}${blocked.length ? ` — ${blocked.length} BLOCKED item(s); fix before startup` : " — safe to start the application"}`);
  }
  return exit;
}

process.exit(await main());

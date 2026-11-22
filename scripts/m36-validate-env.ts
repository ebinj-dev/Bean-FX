/**
 * BEAN FX — M36 Phase B-A: startup environment validation.
 *
 * Read-only. Validates a deployment environment file (or the current process
 * env) against the REQUIRED / OPTIONAL / PROVIDER classification and exits
 * non-zero with actionable errors when critical configuration is missing.
 * It NEVER prints secret VALUES — presence only, same rule as preflight.ts.
 * It never substitutes insecure defaults: missing REQUIRED = failure.
 *
 * Usage:
 *   bun scripts/m36-validate-env.ts --env /path/.env.staging [--strict] [--json]
 *   bun scripts/m36-validate-env.ts --process [--json]   (validate current env)
 *
 * Exit codes: 0 = valid (or valid-with-CONFIGURATION-REQUIRED in non-strict),
 * 1 = INVALID (missing required / forbidden value set / bad path),
 * 2 = CONFIGURATION REQUIRED present while --strict passed.
 */
import { statSync, accessSync, constants, readFileSync } from "fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const envIdx = args.indexOf("--env");
const useProcess = args.includes("--process");

type Finding = { id: string; status: "OK" | "CONFIGURATION REQUIRED" | "INVALID"; detail: string };
const findings: Finding[] = [];
const add = (id: string, status: Finding["status"], detail: string) => findings.push({ id, status, detail });

function loadEnvFile(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(p, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env: Record<string, string> = {};
let envSource = "process";
if (useProcess) {
  Object.assign(env, process.env as Record<string, string>);
} else if (envIdx >= 0 && args[envIdx + 1]) {
  envSource = args[envIdx + 1];
  Object.assign(env, loadEnvFile(envSource));
  if ((statSync(envSource).mode & 0o077) !== 0) {
    // Real deployments must chmod 600; the placeholder template itself is only a WARNING-level note
    // (INVALID under --strict, so sample validation doesn't hard-fail on a repo file).
    add("env-file-perms", strict ? "INVALID" : "CONFIGURATION REQUIRED",
      `${envSource} is group/world accessible — chmod 600 required before real deployment`);
  }
} else {
  console.error("usage: m36-validate-env.ts --env <file> | --process [--strict] [--json]");
  process.exit(1);
}

// ---- REQUIRED ----
const dbUrl = env.DATABASE_URL ?? "";
if (!dbUrl) add("DATABASE_URL", "INVALID", "missing — the deployment cannot start without a database URL");
else if (!dbUrl.startsWith("file:"))
  add("DATABASE_URL", "INVALID", "must be a file: SQLite URL for the initial deployment (provider switch is a separate, designed migration — see M35_DATABASE_DECISION)");
else {
  const dbPath = dbUrl.slice("file:".length).split("?")[0];
  const normPath = dbPath.replace(/^\.\//, "");
  if (normPath.endsWith("db/custom.db"))
    add("DATABASE_URL", "INVALID", "points at the development default db/custom.db — staging must use a dedicated path (refusing to silently share the dev database)");
  const dir = dbPath.replace(/\/[^/]+$/, "") || "/";
  try {
    accessSync(dir, constants.W_OK);
    add("DATABASE_URL", "OK", `sqlite file under writable dir ${dir}`);
  } catch {
    add("DATABASE_URL", "INVALID", `directory ${dir} missing or not writable by the current user`);
  }
}

const media = env.BEANFX_DATA_DIR ?? "";
if (!media) add("BEANFX_DATA_DIR", "INVALID", "missing — the media root must be an explicit dedicated directory");
else if (media === "/" || media === "." || !media.startsWith("/"))
  add("BEANFX_DATA_DIR", "INVALID", "must be an absolute dedicated directory, never / or a relative path (media-storage.ts guard)");
else {
  try {
    statSync(media);
    try { accessSync(media, constants.W_OK); add("BEANFX_DATA_DIR", "OK", `exists and writable: ${media}`); }
    catch { add("BEANFX_DATA_DIR", "INVALID", `${media} exists but is not writable by the current user`); }
  } catch {
    // Missing is fixable at install time (m36-fs-layout.sh creates it) — INVALID only in strict mode.
    add("BEANFX_DATA_DIR", strict ? "INVALID" : "CONFIGURATION REQUIRED", `${media} does not exist yet — run scripts/m36-fs-layout.sh first`);
  }
}

// ---- OPTIONAL (absence is CONFIGURATION REQUIRED, never a crash) ----
if (!env.PUBLIC_APP_URL) add("PUBLIC_APP_URL", "CONFIGURATION REQUIRED", "not set — absolute links/preview embeds will be relative-only");
else add("PUBLIC_APP_URL", "OK", env.PUBLIC_APP_URL);

// ---- PROVIDER-SPECIFIC (optional subsystem; never affects core health) ----
if (!env.BEANFX_ZAI_BIN) add("BEANFX_ZAI_BIN", "CONFIGURATION REQUIRED", "provider CLI not configured — AI generation disabled, core editor unaffected");
else add("BEANFX_ZAI_BIN", "OK", "provider CLI path set");

// ---- FORBIDDEN ----
if (env.RATE_LIMIT_SCALE && env.RATE_LIMIT_SCALE !== "1")
  add("RATE_LIMIT_SCALE", "INVALID", `test-only scaling env must be UNSET in deployment (found value; presence-only reported, never printed for secrets)`);
else add("RATE_LIMIT_SCALE", "OK", "unset or 1");

// ---- INSECURE DEFAULTS ----
for (const k of Object.keys(env)) {
  if (/^(SECRET|TOKEN|API_KEY|PASSWORD)(_|$)/i.test(k) && /^(changeme|secret|password|__SET_ON_HOST__)$/i.test(env[k]))
    add(k, "INVALID", "placeholder/default credential detected — set a real value on the host");
}

const invalid = findings.filter((f) => f.status === "INVALID");
const cfgReq = findings.filter((f) => f.status === "CONFIGURATION REQUIRED");
const verdict = invalid.length ? "INVALID" : cfgReq.length && strict ? "CONFIGURATION REQUIRED" : "VALID";

if (asJson) console.log(JSON.stringify({ verdict, envSource, findings }, null, 2));
else {
  console.log(`ENV VALIDATION: ${verdict}  (source: ${envSource}${strict ? ", strict" : ""})`);
  for (const f of findings) console.log(`  [${f.status}] ${f.id}: ${f.detail}`);
  if (invalid.length) console.log("\nActionable failures above — fix them before starting the service.");
}
process.exit(verdict === "VALID" ? 0 : verdict === "CONFIGURATION REQUIRED" ? 2 : 1);

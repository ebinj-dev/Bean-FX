/**
 * BEAN FX — M34 Track B: reproducible isolated fixtures for legacy suites.
 *
 * The M19/M20–M23 era suites originally pointed at the real development
 * database (`db/custom.db`), which made them environment-dependent and
 * unsafe to run in a clean checkout (M33 closeout: INFRASTRUCTURE REQUIRED).
 * Audit result (M34_BASELINE_AUDIT.md §10): those suites self-seed
 * deterministic records (fixed-ID upserts) and only require a schema-migrated
 * database — none of them need historical rows.
 *
 * `scratchLegacyDb(suite)` gives each suite its own deterministic scratch
 * database, applies the CURRENT schema (the repository's actual migration
 * history — the repo uses `prisma db push` schema-sync; there is no
 * prisma/migrations directory), and refuses to ever touch `db/custom.db`.
 *
 * Operators can pin a shared scratch DB for hybrid suites (direct DB +
 * HTTP :3117 against the same file) via BEANFX_LEGACY_TEST_DB.
 */
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function scratchLegacyDb(suite: string): string {
  const explicit = process.env.BEANFX_LEGACY_TEST_DB;
  const file = explicit && explicit.trim() !== ""
    ? explicit.trim()
    : path.join(os.tmpdir(), `beanfx-legacy-${suite}.db`);
  const resolved = path.resolve(file.replace(/^file:/, ""));
  const repoDb = path.resolve(process.cwd(), "db", "custom.db");
  if (resolved === repoDb) {
    throw new Error(`legacy fixture refusal: ${suite} must not use the development database db/custom.db`);
  }
  const url = `file:${resolved}`;
  // Always apply the current schema — `prisma db push` is an idempotent
  // schema sync, so re-running a suite against its scratch DB is safe and
  // the schema is never older than the checkout. Rows are retained across
  // runs, matching how these suites behaved against the persistent dev DB
  // (they self-seed fixed-ID records and are rerun-safe by design).
  if (process.env.BEANFX_LEGACY_SKIP_PUSH !== "1") {
    execSync("bunx prisma db push --skip-generate", {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  }
  return url;
}

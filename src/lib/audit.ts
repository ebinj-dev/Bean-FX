/**
 * M19 §14 — privileged-action audit trail. Always awaited in mutation paths;
 * failures never break the request (best-effort with a swallow).
 */
import { db } from "@/lib/db";

export async function audit(action: string, opts: { userId?: string | null; detail?: string; ip?: string | null } = {}): Promise<void> {
  await db.auditEvent.create({
    data: { action, userId: opts.userId ?? null, detail: opts.detail?.slice(0, 800) ?? null, ip: opts.ip ?? null },
  }).catch(() => undefined);
}

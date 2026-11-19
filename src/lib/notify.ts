/**
 * M30 — durable in-app notifications (the ONLY notification store; nothing
 * new is invented alongside it). Email stays optional via the M19 mailer and
 * is never a hard dependency.
 *
 * Retry-safety: callers pass a stable `dedupKey` — the unique index makes
 * duplicate delivery during job retries impossible.
 * Privacy: payloads carry ids/titles only — never storage paths, tokens or
 * private media references.
 */
import { db } from "@/lib/db";

export type NotifyInput = {
  userId: string;
  type: string;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  dedupKey?: string;
};

export async function notify(input: NotifyInput): Promise<void> {
  const { userId, type, projectId, payload, dedupKey } = input;
  if (dedupKey) {
    // Retry-safe: a duplicate key leaves the original notification in place.
    await db.notification.upsert({
      where: { dedupKey },
      create: {
        userId,
        type,
        projectId: projectId ?? null,
        payloadJson: payload ? JSON.stringify(payload) : null,
        dedupKey,
      },
      update: {},
    }).catch(() => undefined); // unique race → the notification already exists
    return;
  }
  await db.notification.create({
    data: {
      userId,
      type,
      projectId: projectId ?? null,
      payloadJson: payload ? JSON.stringify(payload) : null,
    },
  }).catch(() => undefined);
}

/** Notify many recipients without storms: one call, deduped, bounded. */
export async function notifyMany(userIds: string[], input: Omit<NotifyInput, "userId">): Promise<void> {
  const unique = [...new Set(userIds)];
  await Promise.all(unique.map((userId) => notify({ ...input, userId })));
}

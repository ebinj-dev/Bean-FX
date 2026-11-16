/**
 * M19 §3 — provider-independent transactional email interface.
 *
 * HONEST DELIVERY CONTRACT: unless SMTP/SMTP_URL is configured this adapter
 * does NOT deliver mail. Delivery attempts are recorded in the AuditEvent
 * table (action "email.attempt") so flows can be verified end-to-end in dev,
 * and callers receive { delivered: false } so UIs can tell the user the
 * truth ("email delivery is not configured on this deployment") instead of
 * pretending a message was sent. Configure SMTP_URL to enable real delivery
 * via nodemailer (see docs/M19_ENVIRONMENT_VARIABLES.md).
 *
 * Token hygiene: raw tokens are returned to callers ONLY to be embedded in a
 * message; storage keeps a SHA-256 hash (auth.ts hashToken).
 */
import { createHash } from "crypto";
import { db } from "@/lib/db";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type MailAttachment = never; // M19 sends no attachments.

export type MailMessage = {
  to: string;
  subject: string;
  body: string;
};

export type MailResult = { delivered: boolean; reason?: string };

const SMTP_URL = process.env.SMTP_URL ?? "";
const FROM = process.env.MAIL_FROM ?? "no-reply@beanfx.invalid";

/**
 * Attempt delivery. Never throws — flows must not break because mail is down.
 * In dev without SMTP_URL this writes an audit row (first 500 chars of body)
 * and reports delivered: false.
 */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
  try {
    if (!SMTP_URL) {
      await db.auditEvent.create({
        data: {
          action: "email.attempt",
          detail: `to=${msg.to} subject=${msg.subject} (delivery not configured; body sample: ${msg.body.slice(0, 500).replace(/\s+/g, " ")})`,
        },
      });
      return { delivered: false, reason: "SMTP not configured on this deployment." };
    }
    // Real delivery requires nodemailer; it is an optional dependency —
    // import dynamically so the app runs without it.
    // @ts-expect-error optional peer dependency — production deployments that
    // configure SMTP_URL install nodemailer; dev runs without it.
    const nodemailer = (await import("nodemailer").catch(() => null)) as
      | { createTransport: (url: string) => { sendMail: (opts: Record<string, string>) => Promise<unknown> } }
      | null;
    if (!nodemailer) {
      await db.auditEvent.create({ data: { action: "email.attempt", detail: `SMTP_URL set but nodemailer not installed — to=${msg.to}` } });
      return { delivered: false, reason: "SMTP transport unavailable (nodemailer not installed)." };
    }
    const transport = nodemailer.createTransport(SMTP_URL);
    await transport.sendMail({ from: FROM, to: msg.to, subject: msg.subject, text: msg.body });
    await db.auditEvent.create({ data: { action: "email.delivered", detail: `to=${msg.to} subject=${msg.subject}` } });
    return { delivered: true };
  } catch (err) {
    await db.auditEvent.create({
      data: { action: "email.failed", detail: `to=${msg.to} error=${err instanceof Error ? err.message.slice(0, 200) : "unknown"}` },
    }).catch(() => undefined);
    return { delivered: false, reason: "The mail provider rejected the message." };
  }
}

export function mailConfigured(): boolean {
  return Boolean(SMTP_URL);
}

export function mailFrom(): string {
  return FROM;
}

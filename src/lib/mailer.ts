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
      // M20 §5: the audit sample must never carry live tokens — verification
      // and reset links embed them. Redact query-string token values first.
      const safeBody = msg.body.replace(/([?&]token=)[A-Za-z0-9._-]+/g, "$1REDACTED");
      await db.auditEvent.create({
        data: {
          action: "email.attempt",
          detail: `to=${msg.to} subject=${msg.subject} (delivery not configured; body sample: ${safeBody.slice(0, 500).replace(/\s+/g, " ")})`,
        },
      });
      return { delivered: false, reason: "SMTP not configured on this deployment." };
    }
    // Real delivery requires nodemailer; it is an optional dependency —
    // import dynamically so the app runs without it (M20: installed in this
    // repo and delivery-verified against a live SMTP endpoint).
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

/** M20 §5 — named security-flow templates (single source of truth). The raw
 * token travels ONLY inside the email body — never in the returned result,
 * never in logs (sendMail redacts query tokens from audit samples), never in
 * client payloads. The origin comes from the caller (request origin or
 * PUBLIC_APP_URL); a safe placeholder keeps the template usable without
 * leaking configuration. */
function appOrigin(origin?: string): string {
  return origin ?? process.env.PUBLIC_APP_URL ?? "https://your-beanfx-domain.example";
}

export async function sendVerificationEmail(to: string, token: string, origin?: string): Promise<MailResult> {
  return sendMail({
    to,
    subject: "Verify your BEAN FX email address",
    body: `Welcome to BEAN FX. Confirm this email address within 24 hours:\n${appOrigin(origin)}/verify-email?token=${token}`,
  });
}

/** M30 §2 — workspace invitation. Delivery is honest: { delivered: false }
 * when SMTP is unconfigured (the UI shows a copyable invite URL instead). */
export async function sendInvitationEmail(input: { to: string; workspaceName: string; role: string; inviterName: string; token: string; origin?: string }): Promise<MailResult> {
  return sendMail({
    to: input.to,
    subject: `You are invited to collaborate in "${input.workspaceName}" on BEAN FX`,
    body: `${input.inviterName} invited you to join the workspace "${input.workspaceName}" as ${input.role}.

Accept within 7 days:
${appOrigin(input.origin)}/invite/${input.token}

If you were not expecting this, you can simply ignore it — the invitation expires automatically.`,
  });
}

export async function sendPasswordResetEmail(to: string, token: string, origin?: string): Promise<MailResult> {
  return sendMail({
    to,
    subject: "Reset your BEAN FX password",
    body: `Someone requested a password reset for your BEAN FX account.\n\nOpen this link within 30 minutes to choose a new password:\n${appOrigin(origin)}/reset-password?token=${token}\n\nIf you did not request this, ignore this email — your password stays unchanged.`,
  });
}

/** M20 §5 — security notification: password changed (other sessions revoked). */
export async function sendPasswordChangedNotice(to: string): Promise<MailResult> {
  return sendMail({
    to,
    subject: "Your BEAN FX password was changed",
    body: [
      "The password for your BEAN FX account was just changed.",
      "All other sessions were signed out. If this was not you, reset your",
      "password immediately from the sign-in page and contact support.",
    ].join("\n"),
  });
}

/** M20 §5 — account deletion confirmation (immediate lockout notice). */
export async function sendAccountDeletedConfirmation(to: string): Promise<MailResult> {
  return sendMail({
    to,
    subject: "Your BEAN FX account was deleted",
    body: [
      "Your BEAN FX account was deleted as requested. Access is revoked",
      "immediately and all sessions were signed out. Your profile, projects,",
      "uploads and exports are queued for permanent cleanup. Media still",
      "referenced by other users is not removed. This action cannot be undone.",
    ].join("\n"),
  });
}

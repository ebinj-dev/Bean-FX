/**
 * M21 P2 — integration token management (session-authenticated).
 * GET    /api/account/tokens       — list (never returns raw tokens)
 * POST   /api/account/tokens       — create; raw `bfx_…` returned ONCE
 * DELETE /api/account/tokens?id=…  — revoke immediately
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import {
  createIntegrationToken, listIntegrationTokens, revokeIntegrationToken,
} from "@/lib/integration-tokens";
import { TOKEN_SCOPES, type TokenScope } from "@/lib/core/types";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string().min(1)).min(1).max(TOKEN_SCOPES.length),
  ttlDays: z.number().int().min(1).max(365).optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return NextResponse.json({ tokens: await listIntegrationTokens(user.id) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const scopes = parsed.data.scopes as TokenScope[];
  if (scopes.some((s) => !TOKEN_SCOPES.includes(s))) {
    return badRequest(`Unknown scope; allowed: ${TOKEN_SCOPES.join(", ")}`);
  }
  try {
    const created = await createIntegrationToken(user.id, parsed.data.name, scopes, parsed.data.ttlDays);
    // Audit the lifecycle event without ever logging the raw token.
    await db.auditEvent.create({ data: { userId: user.id, action: "integration_token.created", detail: JSON.stringify({ tokenId: created.id, scopes, prefix: created.prefix }) } }).catch(() => {});
    return NextResponse.json({
      token: { id: created.id, prefix: created.prefix, scopes: created.scopes, expiresAt: created.expiresAt },
      rawToken: created.raw, // shown once
    }, { status: 201 });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "token creation failed");
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const ok = await revokeIntegrationToken(user.id, id);
  if (!ok) return badRequest("Token not found or already revoked.");
  await db.auditEvent.create({ data: { userId: user.id, action: "integration_token.revoked", detail: JSON.stringify({ tokenId: id }) } }).catch(() => {});
  return NextResponse.json({ revoked: true });
}

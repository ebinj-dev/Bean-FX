/**
 * Automation tokens — POST (create; raw shown ONCE), GET (list), DELETE (revoke).
 * Server-side credential handling per §9B/§12: only SHA-256 hashes stored.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { createToken, listTokens, revokeToken, type AutomationProfile } from "@/lib/automation/tokens";
import { db } from "@/lib/db";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  profile: z.enum(["read-only", "editing"]).default("read-only"),
  allowlist: z.array(z.string().max(64)).max(100).default([]),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid token request.");
  const created = await createToken(user.id, parsed.data.name, parsed.data.profile as AutomationProfile, parsed.data.allowlist);
  await db.automationAudit.create({
    data: { userId: user.id, action: "TOKEN_CREATED", detailJson: JSON.stringify({ tokenId: created.id, profile: created.profile }) },
  });
  // The raw token appears exactly once, in this response — never stored in plaintext.
  return NextResponse.json({ id: created.id, token: created.raw, prefix: created.prefix, profile: created.profile, note: "Store it now — it cannot be retrieved again." });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return NextResponse.json({ tokens: await listTokens(user.id) });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return badRequest("id required.");
  const ok = await revokeToken(id, user.id);
  return ok ? NextResponse.json({ revoked: true }) : NextResponse.json({ error: "Token not found or already revoked." }, { status: 404 });
}

/**
 * M21 P4 — human approval surface for MCP mutations (session-only).
 * POST /api/mcp/approvals { action, args } → one-time approval id.
 * The payload hash binds the approval to EXACTLY those arguments; the MCP
 * tool call must present the id within 15 minutes and matches args or fails.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { argsHash } from "@/lib/mcp/tools";

export const runtime = "nodejs";

const APPROVAL_ACTIONS = new Set(["jobs.submit", "jobs.cancel", "myai.execute"]);
const ApprovalSchema = z.object({
  action: z.string().min(1).max(40),
  args: z.record(z.string(), z.unknown()),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = ApprovalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request.");
  const { action, args } = parsed.data;
  if (!APPROVAL_ACTIONS.has(action)) {
    return badRequest(`Unknown action; approvable: ${[...APPROVAL_ACTIONS].join(", ")}`);
  }
  const row = await db.mcpApproval.create({
    data: {
      userId: user.id,
      action,
      payloadHash: argsHash(action, args),
      expiresAt: new Date(Date.now() + 15 * 60000),
    },
  });
  return NextResponse.json({ approvalId: row.id, expiresAt: row.expiresAt }, { status: 201 });
}

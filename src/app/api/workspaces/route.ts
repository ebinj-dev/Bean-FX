/** M30 §2 — team workspaces. Personal usage is unchanged; workspaces are
 * additive. Creation makes the caller the sole OWNER member. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { AuditEvent } from "@prisma/client";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "A workspace name (1–120 chars) is required." }, { status: 400 });
  }
  const workspace = await db.workspace.create({
    data: {
      name: name.slice(0, 120),
      ownerUserId: user.id,
      members: { create: { userId: user.id, role: "OWNER", createdById: user.id } },
    },
    include: { members: true },
  });
  await db.auditEvent.create({
    data: { userId: user.id, action: "workspace.created", detail: `workspace=${workspace.id}` },
  }).catch(() => undefined);
  return NextResponse.json({
    workspace: { id: workspace.id, name: workspace.name, role: "OWNER", createdAt: workspace.createdAt },
  }, { status: 201 });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const memberships = await db.workspaceMember.findMany({
    where: { userId: user.id },
    include: { workspace: { include: { _count: { select: { members: true, projects: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      memberCount: m.workspace._count.members,
      projectCount: m.workspace._count.projects,
      createdAt: m.workspace.createdAt,
    })),
  });
}

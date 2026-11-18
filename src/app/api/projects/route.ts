import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { assertWithinLimit, PlanLimitError, planLimitResponse } from "@/lib/billing/entitlements";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: { _count: { select: { mediaAssets: true } } },
  });
  return NextResponse.json({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      mediaCount: p._count.mediaAssets,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return NextResponse.json({ error: "Project name is required." }, { status: 400 });
  // M25 P2 — plan entitlement (server-side; FREE is unlimited so this never
  // affects existing users unless an admin assigns a limited plan).
  try {
    await assertWithinLimit(user.id, "maxProjects");
  } catch (err) {
    if (err instanceof PlanLimitError) {
      const { body: limitBody, status } = planLimitResponse(err);
      return NextResponse.json(limitBody, { status });
    }
    throw err;
  }
  const project = await db.project.create({
    data: {
      userId: user.id,
      name,
      description: typeof body?.description === "string" ? body.description.slice(0, 500) : null,
    },
  });
  return NextResponse.json({ project: { id: project.id, name: project.name, description: project.description } });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  await db.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

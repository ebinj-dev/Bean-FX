/**
 * M19 §14 — operational admin: user lookup + status. Enforced server-side by
 * requireAdmin (role on the User row). Returns SAFE fields only — never
 * password hashes or session tokens. Every access is audited.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const admin = await requireAdmin();
    await audit("admin.users_listed", { userId: admin.id, ip: clientIp(req) });
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 80);
    const users = await db.user.findMany({
      where: q ? { OR: [{ email: { contains: q } }, { name: { contains: q } }] } : {},
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, email: true, name: true, role: true, emailVerified: true,
        deletedAt: true, createdAt: true, updatedAt: true, _count: { select: { projects: true, sessions: true } },
      },
    });
    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: u.emailVerified,
        deleted: Boolean(u.deletedAt), createdAt: u.createdAt, projectCount: u._count.projects, sessionCount: u._count.sessions,
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

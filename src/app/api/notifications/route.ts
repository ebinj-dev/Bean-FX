/** M30 §7 — durable in-app notifications: bounded retrieval, unread count,
 * mark-read, dismissal. Recipient access is enforced (users only ever see
 * their own rows). Payloads carry ids/titles — never paths or tokens. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const url = new URL(req.url);
  const take = Math.min(Math.max(Number(url.searchParams.get("take")) || 30, 1), 100);
  const before = url.searchParams.get("before"); // createdAt cursor for paging
  const unreadOnly = url.searchParams.get("unread") === "1";
  const notifications = await db.notification.findMany({
    where: {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {}),
      ...(before && !Number.isNaN(Date.parse(before)) ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  const unreadCount = await db.notification.count({ where: { userId: user.id, readAt: null } });
  return NextResponse.json({
    notifications: notifications.map((n) => ({
      id: n.id, type: n.type, projectId: n.projectId,
      payload: n.payloadJson ? JSON.parse(n.payloadJson) : null,
      readAt: n.readAt, createdAt: n.createdAt,
    })),
    unreadCount,
    nextCursor: notifications.length === take ? notifications[notifications.length - 1].createdAt.toISOString() : null,
  });
}

/** POST { ids?: string[], all?: boolean } → mark read (idempotent). */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (body?.all === true) {
    const r = await db.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ ok: true, marked: r.count });
  }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids[] or all:true is required." }, { status: 400 });
  const r = await db.notification.updateMany({
    where: { id: { in: ids }, userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, marked: r.count });
}

/** DELETE ?id= → dismiss (delete own notification only). */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const r = await db.notification.deleteMany({ where: { id, userId: user.id } });
  if (r.count === 0) return NextResponse.json({ error: "Notification not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

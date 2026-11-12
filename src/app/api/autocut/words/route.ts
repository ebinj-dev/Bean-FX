import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

/** The user's reusable words-to-remove reference list. Entries are removal
 *  PREFERENCES: RIISHE inspects every occurrence in context and proposes
 *  candidates — nothing is ever removed automatically. */

const createSchema = z.object({
  phrase: z.string().trim().min(1).max(80),
  note: z.string().trim().max(200).optional().nullable(),
});

function clean(phrase: string): string {
  return phrase.replace(/\s+/g, " ").trim();
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const entries = await db.wordsToRemove.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    entries: entries.map((e) => ({ id: e.id, phrase: e.phrase, note: e.note, createdAt: e.createdAt.toISOString() })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Invalid entry: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
  }
  const phrase = clean(parsed.data.phrase);
  if (!phrase) return NextResponse.json({ error: "The word or phrase cannot be empty." }, { status: 400 });
  const count = await db.wordsToRemove.count({ where: { userId: user.id } });
  if (count >= 100) return NextResponse.json({ error: "The words-to-remove list is limited to 100 entries." }, { status: 400 });
  const entry = await db.wordsToRemove.upsert({
    where: { userId_phrase: { userId: user.id, phrase } },
    update: { note: parsed.data.note ?? null },
    create: { userId: user.id, phrase, note: parsed.data.note ?? null },
  });
  return NextResponse.json({ entry: { id: entry.id, phrase: entry.phrase, note: entry.note, createdAt: entry.createdAt.toISOString() } });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing entry id." }, { status: 400 });
  const existing = await db.wordsToRemove.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  await db.wordsToRemove.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

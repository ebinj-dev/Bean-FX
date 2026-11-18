/**
 * M26 P4 — creative preset library. Kind-shaped payloads (v1 contracts):
 * - VIDEO_EFFECT: { effects: [{ type, enabled, params }] }
 * - CAPTION:      { captionStyle: { fontSize, color, background, position } }
 * - AUDIO:        { gangziiPresetId: string } (executed by the GANGZII tool)
 * - EXPORT:       { profileIds: string[] }   (consumed by batch export)
 * Server-side ownership + unique-name enforcement; rename/duplicate/delete
 * are explicit routes. Applying happens client-side through reversible
 * editor commands (the server never mutates project timelines directly).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const KINDS = ["VIDEO_EFFECT", "CAPTION", "AUDIO", "EXPORT"] as const;
const CreateSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()),
});

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const kind = new URL(req.url).searchParams.get("kind");
  const presets = await db.creativePreset.findMany({
    where: { userId: user.id, ...(kind && (KINDS as readonly string[]).includes(kind) ? { kind } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, kind: true, name: true, payloadJson: true, version: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ presets: presets.map((p) => ({ ...p, payload: JSON.parse(p.payloadJson) as Record<string, unknown> })) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("kind, name and payload required.");
  const exists = await db.creativePreset.findUnique({ where: { userId_kind_name: { userId: user.id, kind: parsed.data.kind, name: parsed.data.name } } });
  if (exists) return NextResponse.json({ error: "A preset with this name already exists for the kind." }, { status: 409 });
  const created = await db.creativePreset.create({
    data: { userId: user.id, kind: parsed.data.kind, name: parsed.data.name, payloadJson: JSON.stringify(parsed.data.payload), version: 1 },
    select: { id: true, kind: true, name: true, version: true },
  });
  await audit("preset.created", { userId: user.id, detail: JSON.stringify({ presetId: created.id, kind: created.kind }) });
  return NextResponse.json({ preset: created });
}

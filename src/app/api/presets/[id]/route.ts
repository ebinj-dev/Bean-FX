/**
 * M26 P4 — single preset operations (owner-only):
 * PATCH  /api/presets/[id]  — rename (and/or payload update, version bumped)
 * DELETE /api/presets/[id]  — delete with ?confirm=<name> safeguard
 * POST   /api/presets/[id]  — duplicate ("name (copy)" / next free suffix)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

async function owned(id: string, userId: string) {
  return db.creativePreset.findFirst({ where: { id, userId } });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const preset = await owned(id, user.id);
  if (!preset) return badRequest("Preset not found.");
  const parsed = z.object({ name: z.string().min(1).max(80).optional(), payload: z.record(z.string(), z.unknown()).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Nothing to update.");
  if (parsed.data.name && parsed.data.name !== preset.name) {
    const clash = await db.creativePreset.findUnique({ where: { userId_kind_name: { userId: user.id, kind: preset.kind, name: parsed.data.name } } });
    if (clash) return NextResponse.json({ error: "A preset with this name already exists for the kind." }, { status: 409 });
  }
  const updated = await db.creativePreset.update({
    where: { id: preset.id },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.payload ? { payloadJson: JSON.stringify(parsed.data.payload), version: { increment: 1 } } : {}),
    },
    select: { id: true, name: true, version: true },
  });
  await audit("preset.renamed", { userId: user.id, detail: JSON.stringify({ presetId: preset.id }) });
  return NextResponse.json({ preset: updated });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const preset = await owned(id, user.id);
  if (!preset) return badRequest("Preset not found.");
  let name = `${preset.name} (copy)`;
  let n = 2;
  while (await db.creativePreset.findUnique({ where: { userId_kind_name: { userId: user.id, kind: preset.kind, name } } })) {
    name = `${preset.name} (copy ${n++})`;
    if (n > 50) return badRequest("Too many copies.");
  }
  const copy = await db.creativePreset.create({
    data: { userId: user.id, kind: preset.kind, name, payloadJson: preset.payloadJson, version: preset.version },
    select: { id: true, name: true, version: true },
  });
  await audit("preset.duplicated", { userId: user.id, detail: JSON.stringify({ from: preset.id, to: copy.id }) });
  return NextResponse.json({ preset: copy });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const preset = await owned(id, user.id);
  if (!preset) return badRequest("Preset not found.");
  const confirm = req.nextUrl.searchParams.get("confirm") ?? "";
  if (confirm !== preset.name) {
    return NextResponse.json({ error: `Safeguard: pass ?confirm=${encodeURIComponent(preset.name)} to delete this preset.` }, { status: 412 });
  }
  await db.creativePreset.delete({ where: { id: preset.id } });
  await audit("preset.deleted", { userId: user.id, detail: JSON.stringify({ presetId: preset.id, kind: preset.kind }) });
  return NextResponse.json({ deleted: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { saveLutForProject } from "@/lib/editor/lut-store";
import { ProjectNotFoundError } from "@/lib/editor/persistence";

export const dynamic = "force-dynamic";

const NAME_RE = /^[\w.\- ()\[\]]{1,120}$/;

/** POST /api/editor/projects/[projectId]/luts — validate + store a .cube
 *  upload. Returns the Lut record; registering it with the sequence is the
 *  client's AddLut canonical command (nothing is auto-applied to clips). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  const limited = enforceRateLimit(req, "editorTimeline", user.id, RATE_LIMITS.timeline);
  if (limited) {
    return NextResponse.json({ error: "Rate limit exceeded — try again shortly." }, { status: 429 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with a `file` field." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing `file` field." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".cube")) {
    return NextResponse.json({ error: "Only .cube LUTs are accepted." }, { status: 415 });
  }
  const nameRaw = String(form.get("name") ?? file.name.replace(/\.cube$/i, "")).trim();
  if (!NAME_RE.test(nameRaw)) {
    return NextResponse.json({ error: "LUT name must be 1..120 safe characters." }, { status: 400 });
  }
  if (file.size > 16 * 1024 * 1024) {
    return NextResponse.json({ error: "LUT exceeds the 16 MiB size cap." }, { status: 413 });
  }
  const content = await file.text();
  try {
    const saved = await saveLutForProject(projectId, user.id, nameRaw, content, file.name.slice(0, 200));
    return NextResponse.json({ lut: saved.lut }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "LUT import failed." }, { status: 400 });
  }
}

// Submit a render via the API as the suite user and watch it to a terminal state.
const BASE = "http://localhost:3117";
// The suite3 setup account: STAMP is per-run; discover it from the recent users.
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const users = await db.user.findMany({
  where: { email: { contains: "m20render-" }, createdAt: { gte: new Date(Date.now() - 3600_000) } },
  orderBy: { createdAt: "desc" },
  take: 2,
  select: { email: true },
});
const project = await db.project.findFirst({
  where: { updatedAt: { gte: new Date(Date.now() - 7200_000) }, timelineVersions: { some: {} } },
  orderBy: { updatedAt: "desc" },
  select: { id: true, name: true },
});
console.log("user:", users[0]?.email, "project:", project?.id, project?.name);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: users[0].email, password: "render-pass-99" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log("login:", login.status);

const sub = await fetch(`${BASE}/api/editor/projects/${project.id}/render`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({}),
});
const subJson = await sub.json();
console.log("submit:", sub.status, JSON.stringify(subJson).slice(0, 120));
const jobId = subJson.jobId;

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (!jobId) { console.log("no jobId — aborting"); break; }
  const st = await fetch(`${BASE}/api/jobs/${jobId}`, { headers: { cookie } });
  if (st.status !== 200) { console.log("job poll:", st.status); continue; }
  const j = await st.json();
  const job = j.job ?? j;
  console.log(`poll ${i}:`, job.status, "|", (job.stage || job.message || "").slice(0, 100));
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) break;
}
await db.$disconnect();
process.exit(0);

process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const link = await db.reviewLink.findFirst({ where: { state: "ACTIVE" }, include: { revision: { select: { id: true } } } });
console.log("link:", link?.id?.slice(-6), "permission:", link?.permission, "expires:", link?.expiresAt > new Date());
const guest = await db.guestAccess.findFirst({ where: { linkId: link!.id }, orderBy: { createdAt: "desc" } });
console.log("guest:", guest?.displayName, "createdAt:", guest?.createdAt);
await db.$disconnect();
if (!link || !guest) { console.log("no active link/guest in DB"); process.exit(0); }
// Reconstruct the cookie the suite would hold — but we only have the HASH of
// the guest token (never stored raw). That is exactly the problem space; to
// validate resolution we need the raw token — recreate a link+session the
// honest way: hash a known token.
const { sha256Hex } = await import("../src/lib/collab.ts");
const knownToken = "debug-token-123";
await db.$disconnect();
const { reviewLink } = await import("@prisma/client");
console.log("hash sanity:", sha256Hex(knownToken).slice(0, 8));
// Now simulate resolveReviewActor with a cookie built from a REAL session:
// create link+guest directly with a known token.
const db2 = new PrismaClient();
const l2 = await db2.reviewLink.create({
  data: { revisionId: link.revision.id, tokenHash: sha256Hex(knownToken), state: "ACTIVE", permission: "COMMENT", expiresAt: new Date(Date.now() + 86400_000), createdById: link.createdById },
});
const g2 = await db2.guestAccess.create({ data: { linkId: l2.id, displayName: "DbgGuest", tokenHash: sha256Hex(knownToken) } });
await db2.$disconnect();
const { resolveReviewActor } = await import("../src/lib/review-access.ts");
const cookie = `beanfx_review=${encodeURIComponent(`${l2.id}.${knownToken}`)}`;
const fakeReq = { headers: { get: (k: string) => (k === "cookie" ? cookie : null) } } as unknown as import("next/server").NextRequest;
const r = await resolveReviewActor(link!.revision.id, fakeReq);
console.log("resolution:", r.ok ? `OK kind=${r.actor.kind} permission=${(r.actor as any).permission}` : `ERROR ${r.error.status}`);
process.exit(0);

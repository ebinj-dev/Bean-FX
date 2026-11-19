/**
 * M28 — media pipeline hardening tests: runtime codec capabilities, disk-space
 * guard, stale-proxy repair sweep, proxy regeneration API behavior, media/list
 * diagnostic fields. DB-touching tests run against the synthetic dev DB.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { checkExportCodecAvailable, EXPORT_CODEC_NEEDS, setMediaCapabilitiesForTests, type MediaCapabilities } from "../src/lib/media-capabilities";
import { hasEnoughDisk, freeDiskBytes, assertDiskSpace } from "../src/lib/media-storage";
import { runScratchSweeps } from "../src/lib/media-worker";

const CAPS: MediaCapabilities = {
  encoders: new Set(["libx264", "aac", "pcm_s16le"]),
  muxers: new Set(["mp4", "wav", "webm"]),
  ffmpegVersion: "test-7.1.5",
  probedAt: Date.now(),
};

describe("M28 P5 — runtime codec capabilities", () => {
  test("codec needs cover every M9 export family with real encoder names", () => {
    for (const family of ["H264", "H265", "PRORES", "VP9", "AAC_AUDIO", "PCM_AUDIO"]) {
      const need = EXPORT_CODEC_NEEDS[family];
      expect(need.encoder.length).toBeGreaterThan(2);
      expect(need.muxer.length).toBeGreaterThan(1);
      expect(need.label).toContain("(");
    }
  });

  test("available when encoder + muxer exist; honest reasons when missing", async () => {
    setMediaCapabilitiesForTests(CAPS);
    const h264 = await checkExportCodecAvailable("H264");
    expect(h264.available).toBe(true);
    expect(h264.reason).toBeNull();
    const hevc = await checkExportCodecAvailable("H265");
    expect(hevc.available).toBe(false);
    expect(hevc.reason).toContain("libx265");
    const prores = await checkExportCodecAvailable("PRORES");
    expect(prores.available).toBe(false);
    expect(prores.reason).toContain("prores_ks");
    expect(prores.reason).toContain("mov"); // muxer missing in the fixture too
    const pcm = await checkExportCodecAvailable("PCM_AUDIO");
    expect(pcm.available).toBe(true);
    setMediaCapabilitiesForTests(null);
  });
});

describe("M28 P6 — disk-space guard", () => {
  test("hasEnoughDisk: floor + need logic", () => {
    expect(hasEnoughDisk(600 * 1024 * 1024)).toBe(true);
    expect(hasEnoughDisk(400 * 1024 * 1024)).toBe(false);
    expect(hasEnoughDisk(600 * 1024 * 1024, 700 * 1024 * 1024)).toBe(false);
    expect(hasEnoughDisk(2 * 1024 * 1024 * 1024, 700 * 1024 * 1024)).toBe(true);
  });

  test("freeDiskBytes reports real capacity for a writable dir", async () => {
    const free = await freeDiskBytes("/tmp");
    expect(free).toBeGreaterThan(0);
  });

  test("assertDiskSpace throws an actionable PermanentJobError under pressure", async () => {
    // Force the floor absurdly high so the real /tmp capacity fails the check.
    let message = "";
    try {
      await assertDiskSpace("/tmp", 0, Number.MAX_SAFE_INTEGER / 4);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Not enough disk space");
    expect(message).toContain("MiB");
    expect(message).toContain("originals are untouched");
  });

  test("assertDiskSpace passes on healthy volumes (real /tmp, default floor)", async () => {
    await assertDiskSpace("/tmp"); // must not throw on the sandbox
  });
});

describe("M28 P2 — stale proxy repair sweep", () => {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  let assetId = "";

  beforeAll(async () => {
    const reg = await fetch("http://localhost:3117/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `m28sweep-${Date.now().toString(36)}@test.local`, password: "m28-sweep-pass-1", name: "M28 Sweep" }),
    });
    for (const c of reg.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") {
        const user = await db.user.findFirst({ where: { email: { startsWith: "m28sweep-" } }, orderBy: { createdAt: "desc" } });
        if (!user) throw new Error("sweep user not created");
        assetId = (await db.mediaAsset.create({
          data: {
            userId: user.id,
            kind: "VIDEO",
            originalName: "m28-stale.mp4",
            mimeType: "video/mp4",
            storagePath: "/tmp/m28-stale-source.mp4",
            sizeBytes: 1,
            probeStatus: "READY",
            proxyStatus: "READY",
            proxyPath: "/nonexistent/m28-stale-proxy.mp4",
          },
        })).id;
      }
    }
    if (!assetId) throw new Error("cookie parse failed — sweep fixture not created");
  });

  afterAll(async () => {
    await db.mediaAsset.deleteMany({ where: { id: assetId } });
    await db.$disconnect();
  });

  test("sweep repairs READY assets whose proxy file is gone (honest FAILED + actionable message)", async () => {
    const result = await runScratchSweeps();
    expect(result.stale).toBeGreaterThanOrEqual(1);
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    expect(asset?.proxyStatus).toBe("FAILED");
    expect(asset?.proxyError).toContain("Regenerate");
  });
});

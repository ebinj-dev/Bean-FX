import { describe, expect, test } from "bun:test";
import { asrChunkCacheKey } from "../src/lib/autocut-analysis";
import { resolveAsrProvider } from "../src/lib/asr-providers";

describe("ASR chunk cache keys", () => {
  const wavA = Buffer.alloc(1024, 7);
  const wavB = Buffer.alloc(1024, 9);

  test("same provider + same chunk bytes → same key (resume works)", () => {
    const p = resolveAsrProvider({});
    expect(asrChunkCacheKey(p, wavA)).toBe(asrChunkCacheKey(p, wavA));
  });

  test("different chunk bytes → different key (no cross-chunk collisions)", () => {
    const p = resolveAsrProvider({});
    expect(asrChunkCacheKey(p, wavA)).not.toBe(asrChunkCacheKey(p, wavB));
  });

  test("different provider identity → different key (provider switch re-transcribes)", () => {
    const cloud = resolveAsrProvider({});
    const local = resolveAsrProvider({
      BEANFX_ASR_PROVIDER: "local-http",
      BEANFX_ASR_ENDPOINT: "http://127.0.0.1:9000/v1/audio/transcriptions",
    });
    expect(asrChunkCacheKey(cloud, wavA)).not.toBe(asrChunkCacheKey(local, wavA));
  });

  test("key is a hex sha256 (safe filename)", () => {
    expect(asrChunkCacheKey(resolveAsrProvider({}), wavA)).toMatch(/^[0-9a-f]{64}$/);
  });
});

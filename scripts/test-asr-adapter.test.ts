import { afterAll, describe, expect, test } from "bun:test";
import { resolveAsrProvider, transcribeChunkViaProvider } from "../src/lib/asr-providers";

/**
 * Contract tests for the ASR provider adapters. The local-http adapter speaks
 * the OpenAI-compatible /audio/transcriptions contract used by faster-whisper
 * servers (speaches), whisper.cpp server and similar self-hosted gateways.
 * A stub server verifies the REQUEST the adapter sends and the parsing of the
 * response — the default z-ai provider remains the configured one and is not
 * touched by these tests.
 */

const received: { contentType: string | null; model: string | null; hasFile: boolean; filename: string | null }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/audio/transcriptions") {
      const contentType = req.headers.get("content-type");
      const form = await req.formData();
      const file = form.get("file");
      const model = form.get("model");
      received.push({
        contentType,
        model: typeof model === "string" ? model : null,
        hasFile: file instanceof Blob && file.size > 0,
        filename: file instanceof File ? file.name : null,
      });
      if (url.searchParams.get("fail") === "500") {
        return new Response("boom", { status: 500 });
      }
      if (url.searchParams.get("empty") === "1") {
        return Response.json({ text: "" });
      }
      return Response.json({ text: "  hello from the local engine  " });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

describe("ASR provider resolution", () => {
  test("defaults to the configured cloud SDK", () => {
    const cfg = resolveAsrProvider({});
    expect(cfg.id).toBe("zai");
  });

  test("local-http requires an endpoint (honest configuration error)", () => {
    expect(() => resolveAsrProvider({ BEANFX_ASR_PROVIDER: "local-http" })).toThrow(/BEANFX_ASR_ENDPOINT/);
  });

  test("local-http picks up endpoint and optional model", () => {
    const cfg = resolveAsrProvider({
      BEANFX_ASR_PROVIDER: "local-http",
      BEANFX_ASR_ENDPOINT: "http://127.0.0.1:9000/v1/audio/transcriptions",
      BEANFX_ASR_MODEL: "faster-whisper-large-v3",
    });
    expect(cfg.id).toBe("local-http");
    expect(cfg.endpoint).toBe("http://127.0.0.1:9000/v1/audio/transcriptions");
    expect(cfg.model).toBe("faster-whisper-large-v3");
  });
});

describe("local-http adapter contract", () => {
  test("posts multipart WAV with model field and trims returned text", async () => {
    const cfg = resolveAsrProvider({
      BEANFX_ASR_PROVIDER: "local-http",
      BEANFX_ASR_ENDPOINT: `http://localhost:${server.port}/v1/audio/transcriptions`,
      BEANFX_ASR_MODEL: "test-model",
    });
    const wav = Buffer.alloc(64, 7);
    const text = await transcribeChunkViaProvider(cfg, wav);
    expect(text).toBe("hello from the local engine");
    expect(received.length).toBe(1);
    expect(received[0].contentType?.startsWith("multipart/form-data")).toBe(true);
    expect(received[0].model).toBe("test-model");
    expect(received[0].hasFile).toBe(true);
    expect(received[0].filename).toBe("chunk.wav");
  });

  test("empty transcription is an empty string (silence), never fabricated text", async () => {
    const cfg = resolveAsrProvider({
      BEANFX_ASR_PROVIDER: "local-http",
      BEANFX_ASR_ENDPOINT: `http://localhost:${server.port}/v1/audio/transcriptions?empty=1`,
    });
    expect(await transcribeChunkViaProvider(cfg, Buffer.alloc(8))).toBe("");
  });

  test("HTTP failure surfaces as a real error for the pipeline to report honestly", async () => {
    const cfg = resolveAsrProvider({
      BEANFX_ASR_PROVIDER: "local-http",
      BEANFX_ASR_ENDPOINT: `http://localhost:${server.port}/v1/audio/transcriptions?fail=500`,
    });
    let msg = "";
    try {
      await transcribeChunkViaProvider(cfg, Buffer.alloc(8));
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("500");
  });
});

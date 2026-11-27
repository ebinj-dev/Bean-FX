/**
 * M48-B — deep-link contract tests (#/editor?project=…&conversation=…&plan=…&export=…).
 * The parser is the shared contract between the chat "Open in Editor" anchors,
 * the editor mount effect and the hashchange listener.
 */
import { describe, test, expect } from "bun:test";
import { parseEditorHash, returnToChatHash, EMPTY_EDITOR_LINK_CONTEXT } from "../src/lib/editor/deep-link";

describe("M48-B editor deep-link parser", () => {
  test("full context: project + conversation + plan + export", () => {
    const h = "#/editor?project=p1&conversation=c2&plan=pl3&export=e4";
    expect(parseEditorHash(h)).toEqual({ projectId: "p1", conversationId: "c2", planId: "pl3", exportId: "e4" });
  });

  test("project only (legacy anchors keep working)", () => {
    expect(parseEditorHash("#/editor?project=abc")).toEqual({ projectId: "abc", conversationId: null, planId: null, exportId: null });
  });

  test("no query → empty context (plain #/editor keeps the current project)", () => {
    expect(parseEditorHash("#/editor")).toEqual(EMPTY_EDITOR_LINK_CONTEXT);
    expect(parseEditorHash("")).toEqual(EMPTY_EDITOR_LINK_CONTEXT);
    expect(parseEditorHash(null)).toEqual(EMPTY_EDITOR_LINK_CONTEXT);
  });

  test("blank and oversized values are rejected (no junk into state)", () => {
    expect(parseEditorHash("#/editor?project=%20%20")).toEqual(EMPTY_EDITOR_LINK_CONTEXT);
    expect(parseEditorHash(`#/editor?project=${"x".repeat(200)}`).projectId).toBeNull();
    expect(parseEditorHash("#/editor?conversation=").conversationId).toBeNull();
  });

  test("URL-encoded ids survive parsing", () => {
    expect(parseEditorHash("#/editor?project=a%2Fb&conversation=c+d").projectId).toBe("a/b");
    expect(parseEditorHash("#/editor?project=a%2Fb&conversation=c+d").conversationId).toBe("c d");
  });

  test("hashchange shape: an unrelated hash yields empty context", () => {
    expect(parseEditorHash("#/studio")).toEqual(EMPTY_EDITOR_LINK_CONTEXT);
    expect(parseEditorHash("#/home?conversation=keepme").conversationId).toBe("keepme");
  });

  test("returnToChatHash: conversation context vs tools hub", () => {
    expect(returnToChatHash("conv-9")).toBe("#/home?conversation=conv-9");
    expect(returnToChatHash("a/b&c")).toBe("#/home?conversation=a%2Fb%26c");
    expect(returnToChatHash(null)).toBe("#/studio");
  });
});

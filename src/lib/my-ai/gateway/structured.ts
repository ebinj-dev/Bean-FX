/**
 * MY AI — structured output helper (M8 §4): asks the LLM for JSON, parses,
 * validates with a provided zod schema, and makes ONE repair attempt on
 * invalid output. Invalid after repair → INVALID_RESPONSE (the planner
 * treats that as "no usable plan", never as license to guess).
 */
import { z } from "zod";
import { llmProvider, type LLMChatOptions } from "./provider";

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // The verified provider wraps JSON in ```json fences even when asked not to.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : trimmed).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in response");
  const sliced = candidate.slice(start);
  try {
    return JSON.parse(sliced);
  } catch {
    // Truncate to the last closing bracket — recovers trailing prose.
    const lastBrace = Math.max(sliced.lastIndexOf("}"), sliced.lastIndexOf("]"));
    if (lastBrace > 0) return JSON.parse(sliced.slice(0, lastBrace + 1));
    throw new Error("unparseable JSON in response");
  }
}

export async function chatValidated<T>(
  userId: string,
  schema: z.ZodType<T>,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  options: LLMChatOptions & { onUsage?: (r: { usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null; model: string }) => void },
): Promise<{ data: T; raw: string; model: string }> {
  const provider = llmProvider();
  const first = await provider.chat(messages, options);
  options.onUsage?.(first);
  const attempt = (raw: string): T => schema.parse(extractJson(raw));
  const issuesOf = (err: unknown): string => {
    if (err && typeof err === "object" && "issues" in err) {
      const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.slice(0, 6);
      return issues.map((i) => `- ${i.path.join(".") || "root"}: ${i.message}`).join("; ");
    }
    return err instanceof Error ? err.message.slice(0, 300) : "schema validation failed";
  };
  try {
    return { data: attempt(first.content), raw: first.content, model: first.model };
  } catch (firstErr) {
    // One bounded repair attempt WITH the actual validation issues in view.
    const repair = await provider.chat(
      [
        ...messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: `Your JSON failed schema validation. Violations: ${issuesOf(firstErr)}. Respond AGAIN with ONLY corrected JSON — no prose, no fences — fixing exactly these violations.`,
        },
      ],
      { ...options, temperature: 0 },
    );
    options.onUsage?.(repair);
    return { data: attempt(repair.content), raw: repair.content, model: repair.model };
  }
}

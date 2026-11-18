/**
 * MY AI — usage accounting (M8 §4/§13): persist per-call token usage reported
 * by the provider. Cost estimation stays HONEST: no invented $/token rates —
 * only token counts the provider actually reported.
 */
import { db } from "@/lib/db";
import type { LLMChatResult } from "./provider";

export async function recordUsage(
  userId: string,
  result: LLMChatResult,
  purpose: string,
  ok = true,
): Promise<void> {
  await db.aIUsage
    .create({
      data: {
        userId,
        provider: result.provider,
        model: result.model,
        purpose,
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
        latencyMs: result.latencyMs,
        ok,
      },
    })
    .catch(() => undefined);
}

export async function usageSummary(userId: string): Promise<{
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  note: string;
}> {
  const rows = await db.aIUsage.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 500 });
  const sums = rows.reduce(
    (acc, r) => {
      acc.calls += 1;
      acc.promptTokens += r.promptTokens;
      acc.completionTokens += r.completionTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  return {
    ...sums,
    note: "Token counts as reported by the provider; BEAN FX does not estimate cost without verified pricing data.",
  };
}

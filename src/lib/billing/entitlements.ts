/**
 * M25 P2 — billing & subscription foundation.
 *
 * Payments are DISABLED by design: there is no provider, no prices, and no
 * checkout. Paid tiers exist as entitlement profiles that only the workspace
 * admin can assign manually (audited) until the owner authorizes payments.
 *
 * Usage is computed from the tables that already record it (projects,
 * ExportFile minutes, AIUsage calls, media storage) — no second bookkeeping
 * that could drift from reality.
 */
import { db } from "@/lib/db";

export interface PlanEntitlements {
  maxProjects: number | null;
  monthlyExportMinutes: number | null;
  monthlyAiCalls: number | null;
  /** Overrides the deployment media quota when set; null = deployment default. */
  storageQuotaBytes: number | null;
  maxConcurrentRenders: number | null;
  features: {
    watermarkRemoval: boolean;
    aiGeneration: boolean;
    publishPackages: boolean;
  };
  requiresPayment: boolean;
  selfServe: boolean;
}

export interface PlanCatalogEntry {
  id: string;
  name: string;
  sort: number;
  entitlements: PlanEntitlements;
  active: boolean;
}

/**
 * The honest catalog: FREE matches today's behavior (unlimited core usage —
 * enforcement must never break existing users). CREATOR/STUDIO are tighter on
 * concurrency but add features; they require payment and are NOT self-serve
 * while payments are disabled.
 */
export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    id: "free",
    name: "Free",
    sort: 0,
    active: true,
    entitlements: {
      maxProjects: null,
      monthlyExportMinutes: null,
      monthlyAiCalls: null,
      storageQuotaBytes: null,
      maxConcurrentRenders: null,
      features: { watermarkRemoval: true, aiGeneration: true, publishPackages: true },
      requiresPayment: false,
      selfServe: true,
    },
  },
  {
    id: "creator",
    name: "Creator",
    sort: 1,
    active: true,
    entitlements: {
      maxProjects: 25,
      monthlyExportMinutes: 120,
      monthlyAiCalls: 2000,
      storageQuotaBytes: 50 * 1024 * 1024 * 1024,
      maxConcurrentRenders: 2,
      features: { watermarkRemoval: true, aiGeneration: true, publishPackages: true },
      requiresPayment: true,
      selfServe: false,
    },
  },
  {
    id: "studio",
    name: "Studio",
    sort: 2,
    active: true,
    entitlements: {
      maxProjects: 100,
      monthlyExportMinutes: 600,
      monthlyAiCalls: 10000,
      storageQuotaBytes: 250 * 1024 * 1024 * 1024,
      maxConcurrentRenders: 6,
      features: { watermarkRemoval: true, aiGeneration: true, publishPackages: true },
      requiresPayment: true,
      selfServe: false,
    },
  },
];

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Upsert the catalog rows (lazy seed — no separate seed plumbing). */
export async function ensurePlans(): Promise<void> {
  for (const plan of PLAN_CATALOG) {
    await db.subscriptionPlan.upsert({
      where: { id: plan.id },
      update: { name: plan.name, sort: plan.sort, entitlementsJson: JSON.stringify(plan.entitlements), active: plan.active },
      create: { id: plan.id, name: plan.name, sort: plan.sort, entitlementsJson: JSON.stringify(plan.entitlements), active: plan.active },
    });
  }
}

/** Every user always has a subscription; FREE is the default. */
export async function ensureSubscription(userId: string): Promise<{ id: string; planId: string; status: string; cancelAtPeriodEnd: boolean; provider: string; currentPeriodStart: Date; currentPeriodEnd: Date }> {
  await ensurePlans();
  const existing = await db.subscription.findUnique({ where: { userId }, include: { plan: true } });
  if (existing) {
    // Lazy monthly roll: a period whose end has passed renews without charge
    // (payments disabled). A cancelled subscription ends here → FREE.
    if (existing.currentPeriodEnd.getTime() <= Date.now()) {
      if (existing.cancelAtPeriodEnd || existing.status === "ENDED") {
        const rolled = await db.subscription.update({
          where: { id: existing.id },
          data: { planId: "free", status: "ACTIVE", cancelAtPeriodEnd: false, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + MONTH_MS) },
        });
        await db.billingEvent.create({
          data: { userId, type: "SUBSCRIPTION_ENDED", detailJson: JSON.stringify({ fromPlan: existing.planId, toPlan: "free", note: "cancelled period rolled over — no payment charged (payments disabled)" }), subscriptionId: rolled.id },
        });
        return rolled;
      }
      const rolled = await db.subscription.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + MONTH_MS) },
      });
      await db.billingEvent.create({
        data: { userId, type: "PERIOD_RENEWED", detailJson: JSON.stringify({ planId: existing.planId, note: "period rolled — no payment charged (payments disabled)" }), subscriptionId: rolled.id },
      });
      return rolled;
    }
    return existing;
  }
  const created = await db.subscription.create({
    data: { userId, planId: "free", status: "ACTIVE", provider: "none", currentPeriodEnd: new Date(Date.now() + MONTH_MS) },
  });
  await db.billingEvent.create({
    data: { userId, type: "SUBSCRIPTION_ACTIVATED", detailJson: JSON.stringify({ planId: "free" }), subscriptionId: created.id },
  });
  return created;
}

export async function getPlanForUser(userId: string): Promise<{ subscription: Awaited<ReturnType<typeof ensureSubscription>>; entitlements: PlanEntitlements }> {
  const subscription = await ensureSubscription(userId);
  const plan = await db.subscriptionPlan.findUnique({ where: { id: subscription.planId } });
  const entitlements = plan ? (JSON.parse(plan.entitlementsJson) as PlanEntitlements) : PLAN_CATALOG[0].entitlements;
  return { subscription, entitlements };
}

/** Usage for the CURRENT period, computed from the real tables. */
export async function getUsage(userId: string, periodStart: Date): Promise<{
  projects: number;
  exportMinutes: number | null;
  aiCalls: number;
  storageBytes: number | null;
  activeRenders: number;
}> {
  const [projects, exportsAgg, aiCalls, activeRenders] = await Promise.all([
    db.project.count({ where: { userId } }),
    db.exportFile.aggregate({ where: { userId, createdAt: { gte: periodStart }, kind: { in: ["VIDEO", "AUDIO"] } }, _sum: { durationSec: true } }),
    db.aIUsage.count({ where: { userId, createdAt: { gte: periodStart } } }),
    db.job.count({ where: { userId, status: { in: ["QUEUED", "RUNNING"] }, type: { contains: "RENDER" } } }),
  ]);
  const mediaAgg = await db.mediaAsset.aggregate({ where: { userId }, _sum: { sizeBytes: true } });
  const minutes = exportsAgg._sum.durationSec;
  return {
    projects,
    exportMinutes: minutes === null ? null : Math.round((minutes / 60) * 10) / 10,
    aiCalls,
    storageBytes: mediaAgg._sum.sizeBytes === null ? null : Number(mediaAgg._sum.sizeBytes),
    activeRenders,
  };
}

/** Typed limit rejection — routes map this to an honest 402 response. */
export class PlanLimitError extends Error {
  code = "PLAN_LIMIT";
  limit: string;
  used: number | null;
  max: number;
  constructor(limit: string, used: number | null, max: number) {
    super(`Plan limit reached: ${limit} (${used ?? "?"}/${max}). Change the subscription to continue.`);
    this.limit = limit;
    this.used = used;
    this.max = max;
  }
}

/** Throws PlanLimitError when the named numeric limit is exceeded. */
export async function assertWithinLimit(userId: string, limit: "maxProjects" | "monthlyExportMinutes" | "monthlyAiCalls" | "maxConcurrentRenders", projectedUse: number = 1): Promise<void> {
  const { subscription, entitlements } = await getPlanForUser(userId);
  const max = entitlements[limit];
  if (max === null || max === undefined) return; // unlimited
  const usage = await getUsage(userId, subscription.currentPeriodStart);
  const used =
    limit === "maxProjects" ? usage.projects
    : limit === "monthlyExportMinutes" ? (usage.exportMinutes ?? 0)
    : limit === "monthlyAiCalls" ? usage.aiCalls
    : usage.activeRenders;
  if (used + projectedUse > max) throw new PlanLimitError(limit, used, max);
}

/** Throws PlanLimitError when a feature flag is false. */
export async function assertFeature(userId: string, feature: keyof PlanEntitlements["features"]): Promise<void> {
  const { entitlements } = await getPlanForUser(userId);
  if (!entitlements.features[feature]) throw new PlanLimitError(`feature:${feature}`, null, 0);
}

/** Storage override (bytes) for the user's plan, or null = deployment default. */
export async function planStorageQuota(userId: string): Promise<number | null> {
  const { entitlements } = await getPlanForUser(userId);
  return entitlements.storageQuotaBytes;
}

export function planLimitResponse(err: PlanLimitError): { body: Record<string, unknown>; status: number } {
  return {
    body: { error: err.message, code: err.code, limit: err.limit, used: err.used, max: err.max },
    status: 402,
  };
}

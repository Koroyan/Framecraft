import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, creditTransactions, generationJobs, notifications, plans, providerSpend, subscriptions } from '../db/schema';

export type Plan = typeof plans.$inferSelect;

export async function getUserPlan(db: Db, userId: string): Promise<Plan> {
  const [sub] = await db
    .select({ plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.key, subscriptions.planKey))
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ['active', 'trialing']), gte(subscriptions.currentPeriodEnd, new Date())))
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  if (sub) return sub.plan;
  const [free] = await db.select().from(plans).where(eq(plans.key, 'free'));
  return free!;
}

export async function audit(db: Db, p: { actorUserId?: string | null; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown>; ip?: string }) {
  await db.insert(auditLogs).values({ ...p, actorUserId: p.actorUserId ?? null, metadata: p.metadata ?? {} });
}

export async function notify(db: Db, p: { userId: string; type: string; title: string; body?: string; link?: string }) {
  await db.insert(notifications).values({ ...p, body: p.body ?? '' });
}

export const ACTIVE_STATUSES = ['queued', 'preparing', 'generating', 'processing', 'rendering'] as const;

export async function activeJobCount(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(generationJobs)
    .where(and(eq(generationJobs.userId, userId), inArray(generationJobs.status, [...ACTIVE_STATUSES]), sql`${generationJobs.parentJobId} is null`));
  return r?.n ?? 0;
}

/** Credits captured or reserved by the user today (UTC). */
export async function creditsSpentToday(db: Db, userId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(case when ${creditTransactions.type} = 'reserve' then ${creditTransactions.amount} when ${creditTransactions.type} = 'release' then -${creditTransactions.amount} else 0 end),0)::int` })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.userId, userId), gte(creditTransactions.createdAt, start)));
  return Math.max(0, r?.n ?? 0);
}

export const today = () => new Date().toISOString().slice(0, 10);

export async function providerSpendToday(db: Db): Promise<number> {
  const [r] = await db.select({ usd: sql<number>`coalesce(sum(${providerSpend.usd}),0)::float` }).from(providerSpend).where(eq(providerSpend.day, today()));
  return r?.usd ?? 0;
}

/**
 * Spend the daily kill-switch must count: finished provider work today plus the estimated
 * cost of live jobs still in flight (providers bill at submission, before we see the result).
 */
export async function committedProviderSpendToday(db: Db): Promise<number> {
  const [r] = await db
    .select({ usd: sql<number>`coalesce(sum(${generationJobs.estimatedCostUsd}),0)::float` })
    .from(generationJobs)
    .where(and(inArray(generationJobs.status, [...ACTIVE_STATUSES]), eq(generationJobs.isFixture, false)));
  return (await providerSpendToday(db)) + (r?.usd ?? 0);
}

export async function recordProviderSpend(db: Db, providerKey: string, usd: number) {
  await db
    .insert(providerSpend)
    .values({ day: today(), providerKey, usd, jobs: 1 })
    .onConflictDoUpdate({ target: [providerSpend.day, providerSpend.providerKey], set: { usd: sql`${providerSpend.usd} + ${usd}`, jobs: sql`${providerSpend.jobs} + 1` } });
}

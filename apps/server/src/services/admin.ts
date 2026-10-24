import { and, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets, auditLogs, creditTransactions, generationJobs, modelPricing, modelRegistry, plans, providerJobs, providers, subscriptions, users } from '../db/schema';
import { queueHealth } from '../queue/queue';
import { getConfig } from './admin-config';
import { providerSpendToday } from './common';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

/** Admin dashboard metrics, computed from persisted data. Fixture jobs are excluded from cost metrics. */
export async function adminOverview(ctx: AppContext) {
  const db = ctx.db;
  const since = daysAgo(30);
  const rules = await getConfig(db, 'pricing');
  const [userStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active7: sql<number>`count(*) filter (where ${users.lastActiveAt} > now() - interval '7 days')::int`,
      new7: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '7 days')::int`,
      new30: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '30 days')::int`,
    })
    .from(users);
  const jobStats = await db
    .select({ status: generationJobs.status, n: sql<number>`count(*)::int` })
    .from(generationJobs)
    .where(and(gte(generationJobs.createdAt, since), inArray(generationJobs.kind, ['video', 'image', 'audio'])))
    .groupBy(generationJobs.status);
  const byModel = await db
    .select({
      modelKey: providerJobs.modelKey,
      jobs: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${providerJobs.status} = 'succeeded')::int`,
      costUsd: sql<number>`coalesce(sum(${providerJobs.costUsd}),0)::float`,
    })
    .from(providerJobs)
    .where(and(gte(providerJobs.createdAt, since), sql`${providerJobs.providerKey} <> 'fixture'`))
    .groupBy(providerJobs.modelKey)
    .orderBy(desc(sql`coalesce(sum(${providerJobs.costUsd}),0)`));
  const byProvider = await db
    .select({ providerKey: providerJobs.providerKey, jobs: sql<number>`count(*)::int`, costUsd: sql<number>`coalesce(sum(${providerJobs.costUsd}),0)::float` })
    .from(providerJobs)
    .where(and(gte(providerJobs.createdAt, since), sql`${providerJobs.providerKey} <> 'fixture'`))
    .groupBy(providerJobs.providerKey);
  const [money] = await db
    .select({
      creditsCaptured: sql<number>`coalesce(-sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} = 'capture'),0)::int`,
      creditsPurchased: sql<number>`coalesce(sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} in ('purchase','subscription_allowance')),0)::int`,
      creditsGranted: sql<number>`coalesce(sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} = 'grant'),0)::int`,
      creditsRefunded: sql<number>`coalesce(sum(${creditTransactions.amount}) filter (where ${creditTransactions.type} = 'refund'),0)::int`,
    })
    .from(creditTransactions)
    .where(gte(creditTransactions.createdAt, since));
  const [cost] = await db
    .select({
      providerCostUsd: sql<number>`coalesce(sum(${generationJobs.actualCostUsd}),0)::float`,
      avgCostUsd: sql<number>`coalesce(avg(${generationJobs.actualCostUsd}) filter (where ${generationJobs.status} = 'completed'),0)::float`,
    })
    .from(generationJobs)
    .where(and(gte(generationJobs.createdAt, since), eq(generationJobs.isFixture, false)));
  const usageByPlan = await db
    .select({ plan: sql<string>`coalesce(${subscriptions.planKey}, 'free')`, users: sql<number>`count(distinct ${users.id})::int` })
    .from(users)
    .leftJoin(subscriptions, and(eq(subscriptions.userId, users.id), eq(subscriptions.status, 'active')))
    .groupBy(sql`coalesce(${subscriptions.planKey}, 'free')`);
  const [storage] = await db.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}),0)::float`, files: sql<number>`count(*)::int` }).from(assets).where(isNull(assets.deletedAt));

  const revenueUsd = money!.creditsCaptured * rules.creditValueUsd;
  const providerCost = cost!.providerCostUsd;
  const statusMap = Object.fromEntries(jobStats.map((j) => [j.status, j.n]));
  return {
    users: userStats,
    generations: {
      total: jobStats.reduce((s, j) => s + j.n, 0),
      completed: statusMap.completed ?? 0,
      failed: statusMap.failed ?? 0,
      cancelled: statusMap.cancelled ?? 0,
      active: ['queued', 'preparing', 'generating', 'processing', 'rendering'].reduce((s, k) => s + (statusMap[k] ?? 0), 0),
    },
    costs: {
      providerCostUsd30d: Math.round(providerCost * 100) / 100,
      avgCostPerGenerationUsd: Math.round(cost!.avgCostUsd * 1000) / 1000,
      providerSpendTodayUsd: Math.round((await providerSpendToday(db)) * 100) / 100,
      byModel,
      byProvider,
    },
    credits: money,
    margin: {
      // Value of captured credits at list price; real cash revenue depends on plan/pack mix.
      creditRevenueUsd: Math.round(revenueUsd * 100) / 100,
      grossMarginPct: revenueUsd > 0 ? Math.round(((revenueUsd - providerCost) / revenueUsd) * 1000) / 10 : null,
    },
    usageByPlan,
    queue: await queueHealth(db),
    storage: { gb: Math.round((storage!.bytes / 1024 ** 3) * 100) / 100, files: storage!.files },
    config: { liveGenerationEnabled: ctx.liveEnabled, configuredProviders: [...ctx.configured], fixtures: ctx.env.devFixturesEnabled },
  };
}

/** Effective margin per plan: price per credit vs. worst-case provider cost per credit. */
export async function planMarginReport(ctx: AppContext) {
  const rules = await getConfig(ctx.db, 'pricing');
  const maxCostPerCredit = rules.creditValueUsd / (1 + rules.markup);
  const rows = await ctx.db.select().from(plans).orderBy(plans.sort);
  return rows.map((p) => {
    const perCredit = p.monthlyCredits ? p.priceCents / 100 / p.monthlyCredits : null;
    return { key: p.key, name: p.name, pricePerCreditUsd: perCredit, worstCaseMarginPct: perCredit ? Math.round((1 - maxCostPerCredit / perCredit) * 1000) / 10 : null, belowMinimum: perCredit ? 1 - maxCostPerCredit / perCredit < rules.minMargin : false };
  });
}

export async function adminListUsers(ctx: AppContext, q?: string, limit = 50) {
  const where = q ? or(ilike(users.email, `%${q}%`), ilike(users.name, `%${q}%`)) : undefined;
  return ctx.db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, status: users.status, createdAt: users.createdAt, lastActiveAt: users.lastActiveAt, balance: sql<number>`(select balance from credit_wallets w where w.user_id = ${users.id})` })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit);
}

export async function adminModels(ctx: AppContext) {
  const [models, prices, provs] = await Promise.all([ctx.db.select().from(modelRegistry).orderBy(modelRegistry.providerKey, modelRegistry.key), ctx.db.select().from(modelPricing), ctx.db.select().from(providers)]);
  return {
    providers: provs.map((p) => ({ ...p, configured: ctx.configured.has(p.key as never) })),
    models: models.map((m) => ({ ...m, pricing: prices.filter((p) => p.modelKey === m.key) })),
  };
}

export async function adminFailedJobs(ctx: AppContext, limit = 50) {
  return ctx.db
    .select({ job: generationJobs, email: users.email })
    .from(generationJobs)
    .innerJoin(users, eq(users.id, generationJobs.userId))
    .where(eq(generationJobs.status, 'failed'))
    .orderBy(desc(generationJobs.updatedAt))
    .limit(limit);
}

export async function adminAuditLog(ctx: AppContext, limit = 100) {
  return ctx.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

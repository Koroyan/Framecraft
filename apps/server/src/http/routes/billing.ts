import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { assertVerified } from '../../auth/protection';
import type { AppContext } from '../../context';
import { parse, requireUser } from '../app';
import { creditPacks, creditTransactions, payments, plans, subscriptions } from '../../db/schema';
import { getWallet } from '../../billing/wallet';
import { cancelSubscription, fulfillPayment, handlePaymentWebhook, paymentProvider, startCheckout } from '../../billing/payments';
import { getUserPlan } from '../../services/common';
import { getConfig } from '../../services/admin-config';
import { forbidden, notFound } from '../../lib/errors';

export async function billingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/billing/plans', async () => {
    const [planRows, packRows, rules] = await Promise.all([
      ctx.db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.sort),
      ctx.db.select().from(creditPacks).where(eq(creditPacks.active, true)),
      getConfig(ctx.db, 'pricing'),
    ]);
    return { plans: planRows, packs: packRows, creditValueUsd: rules.creditValueUsd, provider: ctx.env.PAYMENT_PROVIDER, paymentsConfigured: paymentProvider(ctx).isConfigured() };
  });

  app.get('/api/billing', async (req) => {
    const u = requireUser(req);
    const [wallet, plan, ledger, pays, subs] = await Promise.all([
      getWallet(ctx.db, u.id),
      getUserPlan(ctx.db, u.id),
      ctx.db.select().from(creditTransactions).where(eq(creditTransactions.userId, u.id)).orderBy(desc(creditTransactions.createdAt)).limit(100),
      ctx.db.select().from(payments).where(eq(payments.userId, u.id)).orderBy(desc(payments.createdAt)).limit(50),
      ctx.db.select().from(subscriptions).where(eq(subscriptions.userId, u.id)).orderBy(desc(subscriptions.createdAt)).limit(5),
    ]);
    return { wallet, plan, ledger, payments: pays, subscription: subs.find((s) => s.status === 'active') ?? null };
  });

  app.post('/api/billing/checkout', { config: { rateLimit: { max: ctx.env.isTest ? 10_000 : 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    await assertVerified(ctx, u.id);
    const body = parse(z.object({ kind: z.enum(['credits', 'subscription']), productKey: z.string().max(60), idempotencyKey: z.string().min(8).max(100) }), req.body);
    const p = await startCheckout(ctx, u, body);
    return { paymentId: p.id, checkoutUrl: p.checkoutUrl };
  });

  /** Development sandbox only: simulate the payment provider's success/failure callback. */
  app.post('/api/billing/sandbox/complete', async (req) => {
    const u = requireUser(req);
    if (ctx.env.isProduction || ctx.env.PAYMENT_PROVIDER !== 'sandbox') throw forbidden('Sandbox payments are disabled');
    const body = parse(z.object({ paymentId: z.string().uuid(), outcome: z.enum(['success', 'failure']) }), req.body);
    const [p] = await ctx.db.select().from(payments).where(and(eq(payments.id, body.paymentId), eq(payments.userId, u.id), eq(payments.provider, 'sandbox')));
    if (!p) throw notFound('Payment');
    if (body.outcome === 'failure') {
      await ctx.db.update(payments).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(payments.id, p.id), eq(payments.status, 'pending')));
      return { ok: true, status: 'failed' };
    }
    const r = await fulfillPayment(ctx.db, p.id);
    return { ok: true, status: 'succeeded', applied: r.applied };
  });

  app.get('/api/billing/payments/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [p] = await ctx.db.select().from(payments).where(and(eq(payments.id, id), eq(payments.userId, u.id)));
    if (!p) throw notFound('Payment');
    return { payment: p };
  });

  app.post('/api/billing/subscription/cancel', async (req) => {
    const u = requireUser(req);
    return { subscription: await cancelSubscription(ctx, u.id) };
  });

  app.post('/api/webhooks/stripe', async (req, reply) => {
    const provider = paymentProvider(ctx);
    if (provider.key !== 'stripe') return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const evt = provider.verifyWebhook(req.rawBody ?? Buffer.alloc(0), req.headers as Record<string, string>);
    return handlePaymentWebhook(ctx, evt);
  });
}

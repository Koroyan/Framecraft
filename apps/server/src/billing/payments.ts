import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { creditPacks, payments, plans, subscriptions, webhookEvents } from '../db/schema';
import { addCredits } from './wallet';
import { AppError, badRequest, configurationRequired, notFound } from '../lib/errors';
import { audit, notify } from '../services/common';

/**
 * Payment abstraction. The application never depends on one processor:
 * - `sandbox`: development-only simulated checkout (no money moves; disabled in production).
 * - `stripe`: Stripe Checkout via REST + signed webhooks. Verify Stripe supports your
 *   merchant entity's country before choosing it (see docs/BILLING.md); a merchant-of-record
 *   provider (e.g. Paddle, Lemon Squeezy) or a local acquirer can be added as another adapter.
 */
export type CheckoutRequest = { paymentId: string; userId: string; email: string; kind: 'credits' | 'subscription'; name: string; amountCents: number; currency: string; successUrl: string; cancelUrl: string; priceId?: string };
export type CheckoutResult = { checkoutUrl: string; providerPaymentId: string };
export type WebhookEvent = { id: string; type: string; data: Record<string, unknown> };

export interface PaymentProvider {
  readonly key: 'sandbox' | 'stripe';
  isConfigured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookEvent;
}

export class SandboxPayments implements PaymentProvider {
  readonly key = 'sandbox' as const;
  constructor(private readonly enabled: boolean) {}
  isConfigured() {
    return this.enabled;
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (!this.enabled) throw configurationRequired('Sandbox payments are disabled in production');
    return { checkoutUrl: `/app/billing/sandbox?payment=${req.paymentId}`, providerPaymentId: `sandbox_${req.paymentId}` };
  }
  verifyWebhook(): WebhookEvent {
    throw badRequest('Sandbox payments have no webhooks');
  }
}

export class StripePayments implements PaymentProvider {
  readonly key = 'stripe' as const;
  constructor(
    private readonly secretKey: string | undefined,
    private readonly webhookSecret: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  isConfigured() {
    return Boolean(this.secretKey && this.webhookSecret);
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (!this.secretKey) throw configurationRequired('Stripe is not configured (STRIPE_SECRET_KEY)');
    const form = new URLSearchParams();
    form.set('mode', req.kind === 'subscription' ? 'subscription' : 'payment');
    form.set('success_url', req.successUrl);
    form.set('cancel_url', req.cancelUrl);
    form.set('client_reference_id', req.paymentId);
    form.set('customer_email', req.email);
    form.set('metadata[payment_id]', req.paymentId);
    form.set('metadata[user_id]', req.userId);
    if (req.kind === 'subscription') form.set('subscription_data[metadata][payment_id]', req.paymentId);
    if (req.priceId) {
      form.set('line_items[0][price]', req.priceId);
    } else {
      form.set('line_items[0][price_data][currency]', req.currency);
      form.set('line_items[0][price_data][unit_amount]', String(req.amountCents));
      form.set('line_items[0][price_data][product_data][name]', req.name);
      if (req.kind === 'subscription') form.set('line_items[0][price_data][recurring][interval]', 'month');
    }
    form.set('line_items[0][quantity]', '1');
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': req.paymentId },
      body: form,
    });
    const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !body.url || !body.id) throw new AppError('payment_provider_error', body.error?.message ?? 'Could not start checkout', 502);
    return { checkoutUrl: body.url, providerPaymentId: body.id };
  }
  /** Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, `${t}.${payload}`)); 5-minute tolerance. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): WebhookEvent {
    if (!this.webhookSecret) throw configurationRequired('STRIPE_WEBHOOK_SECRET is not set');
    const header = headers['stripe-signature'] ?? '';
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    const t = Number(parts.t);
    const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new AppError('invalid_signature', 'Invalid webhook signature', 400);
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
    const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!ok) throw new AppError('invalid_signature', 'Invalid webhook signature', 400);
    const evt = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; data: { object: Record<string, unknown> } };
    return { id: evt.id, type: evt.type, data: evt.data.object };
  }
}

export function paymentProvider(ctx: AppContext): PaymentProvider {
  if (ctx.env.PAYMENT_PROVIDER === 'stripe') return new StripePayments(ctx.env.STRIPE_SECRET_KEY, ctx.env.STRIPE_WEBHOOK_SECRET, ctx.fetch as typeof fetch);
  return new SandboxPayments(ctx.env.PAYMENT_PROVIDER === 'sandbox' && !ctx.env.isProduction);
}

export async function startCheckout(ctx: AppContext, user: { id: string; email: string }, p: { kind: 'credits' | 'subscription'; productKey: string; idempotencyKey: string }) {
  const provider = paymentProvider(ctx);
  if (!provider.isConfigured()) throw configurationRequired('Payments are not configured yet.');
  const [existing] = await ctx.db.select().from(payments).where(and(eq(payments.userId, user.id), eq(payments.idempotencyKey, p.idempotencyKey)));
  if (existing?.checkoutUrl) return existing;

  let name: string, amountCents: number, currency: string, credits: number, priceId: string | undefined;
  if (p.kind === 'credits') {
    const [pack] = await ctx.db.select().from(creditPacks).where(and(eq(creditPacks.key, p.productKey), eq(creditPacks.active, true)));
    if (!pack) throw notFound('Credit pack');
    ({ name, priceCents: amountCents, currency, credits } = pack);
    priceId = pack.providerPriceIds[provider.key];
  } else {
    const [plan] = await ctx.db.select().from(plans).where(and(eq(plans.key, p.productKey), eq(plans.active, true)));
    if (!plan || plan.priceCents === 0) throw notFound('Plan');
    name = `${plan.name} plan`;
    amountCents = plan.priceCents;
    currency = plan.currency;
    credits = plan.monthlyCredits;
    priceId = plan.providerPriceIds[provider.key];
  }
  const [payment] = await ctx.db
    .insert(payments)
    .values({ userId: user.id, provider: provider.key, kind: p.kind, productKey: p.productKey, amountCents, currency, credits, idempotencyKey: p.idempotencyKey })
    .onConflictDoNothing()
    .returning();
  const row = payment ?? existing!;
  const base = ctx.env.PUBLIC_APP_URL;
  const checkout = await provider.createCheckout({
    paymentId: row.id,
    userId: user.id,
    email: user.email,
    kind: p.kind,
    name,
    amountCents,
    currency,
    priceId,
    successUrl: `${base}/app/billing?status=success&payment=${row.id}`,
    cancelUrl: `${base}/app/billing?status=cancelled`,
  });
  const [updated] = await ctx.db.update(payments).set({ checkoutUrl: checkout.checkoutUrl, providerPaymentId: checkout.providerPaymentId, updatedAt: new Date() }).where(eq(payments.id, row.id)).returning();
  return updated!;
}

/** Mark a payment paid and grant credits / activate the subscription. Idempotent. */
export async function fulfillPayment(db: Db, paymentId: string, opts: { providerSubscriptionId?: string } = {}) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [p] = await t.update(payments).set({ status: 'succeeded', updatedAt: new Date() }).where(and(eq(payments.id, paymentId), eq(payments.status, 'pending'))).returning();
    if (!p) return { applied: false };
    if (p.kind === 'credits') {
      await addCredits(t, { userId: p.userId, amount: p.credits, type: 'purchase', description: `Purchased ${p.credits} credits`, idempotencyKey: `payment:${p.id}`, paymentId: p.id });
    } else {
      const start = new Date();
      const end = new Date(start.getTime() + 30 * 86400_000);
      await t.update(subscriptions).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(subscriptions.userId, p.userId), eq(subscriptions.status, 'active')));
      const [sub] = await t
        .insert(subscriptions)
        .values({ userId: p.userId, planKey: p.productKey, status: 'active', provider: p.provider, providerSubscriptionId: opts.providerSubscriptionId ?? `local_${p.id}`, currentPeriodStart: start, currentPeriodEnd: end })
        .returning();
      await addCredits(t, { userId: p.userId, amount: p.credits, type: 'subscription_allowance', description: `${p.productKey} plan monthly credits`, idempotencyKey: `allowance:${sub!.id}:${start.toISOString().slice(0, 10)}`, paymentId: p.id });
    }
    await audit(t, { actorUserId: p.userId, action: 'payment.succeeded', targetType: 'payment', targetId: p.id, metadata: { amountCents: p.amountCents, provider: p.provider } });
    await notify(t, { userId: p.userId, type: 'payment.succeeded', title: p.kind === 'credits' ? `${p.credits} credits added` : 'Subscription active' });
    return { applied: true };
  });
}

/** Apply a verified provider webhook exactly once. */
export async function handlePaymentWebhook(ctx: AppContext, evt: WebhookEvent) {
  const inserted = await ctx.db.insert(webhookEvents).values({ source: 'stripe', eventId: evt.id, type: evt.type, payload: evt.data }).onConflictDoNothing().returning();
  if (!inserted.length) return { duplicate: true };
  const obj = evt.data as Record<string, unknown>;
  const meta = (obj.metadata ?? {}) as Record<string, string>;
  if (evt.type === 'checkout.session.completed' && obj.payment_status !== 'unpaid') {
    const paymentId = meta.payment_id ?? (obj.client_reference_id as string);
    if (paymentId) await fulfillPayment(ctx.db, paymentId, { providerSubscriptionId: obj.subscription as string | undefined });
  } else if (evt.type === 'invoice.paid' && obj.billing_reason === 'subscription_cycle') {
    const [sub] = await ctx.db.select().from(subscriptions).where(and(eq(subscriptions.provider, 'stripe'), eq(subscriptions.providerSubscriptionId, obj.subscription as string)));
    if (sub) {
      const [plan] = await ctx.db.select().from(plans).where(eq(plans.key, sub.planKey));
      const start = new Date();
      await ctx.db.update(subscriptions).set({ currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * 86400_000), status: 'active', updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
      await addCredits(ctx.db, { userId: sub.userId, amount: plan!.monthlyCredits, type: 'subscription_allowance', description: `${plan!.name} monthly credits`, idempotencyKey: `allowance:${sub.id}:${obj.id}` });
    }
  } else if (evt.type === 'customer.subscription.deleted') {
    await ctx.db.update(subscriptions).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(subscriptions.provider, 'stripe'), eq(subscriptions.providerSubscriptionId, obj.id as string)));
  } else if (evt.type === 'charge.refunded') {
    await audit(ctx.db, { action: 'payment.refunded_at_provider', metadata: { charge: obj.id } });
  }
  await ctx.db.update(webhookEvents).set({ processedAt: new Date() }).where(and(eq(webhookEvents.source, 'stripe'), eq(webhookEvents.eventId, evt.id)));
  return { duplicate: false };
}

export async function cancelSubscription(ctx: AppContext, userId: string) {
  const rows = await ctx.db.update(subscriptions).set({ cancelAtPeriodEnd: true, updatedAt: new Date() }).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active'))).returning();
  // With Stripe, the operator should also cancel at the provider (dashboard or API) — recorded for follow-up.
  if (rows.length) await audit(ctx.db, { actorUserId: userId, action: 'subscription.cancel_requested', targetType: 'subscription', targetId: rows[0]!.id });
  return rows[0] ?? null;
}


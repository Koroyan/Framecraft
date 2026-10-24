import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { creditReservations, creditTransactions, creditWallets } from '../db/schema';
import { AppError, paymentRequired } from '../lib/errors';

type TxType = (typeof creditTransactions.$inferInsert)['type'];

export type WalletView = { balance: number; reserved: number; available: number; lifetimePurchased: number; lifetimeSpent: number };

export async function ensureWallet(db: Db, userId: string): Promise<void> {
  await db.insert(creditWallets).values({ userId }).onConflictDoNothing();
}

export async function getWallet(db: Db, userId: string): Promise<WalletView> {
  await ensureWallet(db, userId);
  const [w] = await db.select().from(creditWallets).where(eq(creditWallets.userId, userId));
  return { balance: w!.balance, reserved: w!.reserved, available: w!.balance - w!.reserved, lifetimePurchased: w!.lifetimePurchased, lifetimeSpent: w!.lifetimeSpent };
}

async function existingByIdem(db: Db, idempotencyKey?: string) {
  if (!idempotencyKey) return undefined;
  const [tx] = await db.select().from(creditTransactions).where(eq(creditTransactions.idempotencyKey, idempotencyKey));
  return tx;
}

async function ledger(
  db: Db,
  row: { userId: string; type: TxType; amount: number; description: string; reservationId?: string; jobId?: string; paymentId?: string; idempotencyKey?: string; metadata?: Record<string, unknown> },
) {
  const [w] = await db.select().from(creditWallets).where(eq(creditWallets.userId, row.userId));
  await db.insert(creditTransactions).values({ ...row, balanceAfter: w!.balance, reservedAfter: w!.reserved, metadata: row.metadata ?? {} });
}

/** Add credits (purchase, allowance, grant, refund, positive adjustment). Idempotent per key. */
export async function addCredits(
  db: Db,
  p: { userId: string; amount: number; type: TxType; description: string; idempotencyKey: string; paymentId?: string; jobId?: string; metadata?: Record<string, unknown> },
): Promise<{ applied: boolean }> {
  if (!Number.isInteger(p.amount) || p.amount <= 0) throw new AppError('invalid_amount', 'Credit amount must be a positive integer');
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    if (await existingByIdem(t, p.idempotencyKey)) return { applied: false };
    await ensureWallet(t, p.userId);
    await t
      .update(creditWallets)
      .set({
        balance: sql`${creditWallets.balance} + ${p.amount}`,
        lifetimePurchased: p.type === 'purchase' ? sql`${creditWallets.lifetimePurchased} + ${p.amount}` : creditWallets.lifetimePurchased,
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.userId, p.userId));
    await ledger(t, { ...p });
    return { applied: true };
  });
}

/** Admin debit adjustment; never takes the balance below the reserved amount. */
export async function debitAdjustment(db: Db, p: { userId: string; amount: number; description: string; idempotencyKey: string }) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    if (await existingByIdem(t, p.idempotencyKey)) return { applied: false };
    const res = await t
      .update(creditWallets)
      .set({ balance: sql`${creditWallets.balance} - ${p.amount}`, updatedAt: new Date() })
      .where(and(eq(creditWallets.userId, p.userId), gte(sql`${creditWallets.balance} - ${creditWallets.reserved}`, p.amount)))
      .returning({ userId: creditWallets.userId });
    if (!res.length) throw paymentRequired('Not enough available credits for this adjustment');
    await ledger(t, { userId: p.userId, type: 'adjustment', amount: -p.amount, description: p.description, idempotencyKey: p.idempotencyKey });
    return { applied: true };
  });
}

/**
 * Hold credits for a job. Uses a single conditional UPDATE so concurrent
 * reservations can never exceed the available balance.
 */
export async function reserveCredits(
  db: Db,
  p: { userId: string; amount: number; jobId?: string; description: string; idempotencyKey: string; ttlHours?: number },
): Promise<{ reservationId: string; created: boolean }> {
  if (!Number.isInteger(p.amount) || p.amount <= 0) throw new AppError('invalid_amount', 'Reservation must be a positive integer');
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const prior = await existingByIdem(t, p.idempotencyKey);
    if (prior?.reservationId) return { reservationId: prior.reservationId, created: false };
    await ensureWallet(t, p.userId);
    const updated = await t
      .update(creditWallets)
      .set({ reserved: sql`${creditWallets.reserved} + ${p.amount}`, updatedAt: new Date() })
      .where(and(eq(creditWallets.userId, p.userId), gte(sql`${creditWallets.balance} - ${creditWallets.reserved}`, p.amount)))
      .returning({ balance: creditWallets.balance, reserved: creditWallets.reserved });
    if (!updated.length) {
      const [w] = await t.select().from(creditWallets).where(eq(creditWallets.userId, p.userId));
      throw paymentRequired(`This needs ${p.amount} credits but you have ${(w?.balance ?? 0) - (w?.reserved ?? 0)} available.`, {
        required: p.amount,
        available: (w?.balance ?? 0) - (w?.reserved ?? 0),
      });
    }
    const [r] = await t
      .insert(creditReservations)
      .values({ userId: p.userId, jobId: p.jobId, amount: p.amount, expiresAt: new Date(Date.now() + (p.ttlHours ?? 48) * 3600_000) })
      .returning({ id: creditReservations.id });
    await ledger(t, { userId: p.userId, type: 'reserve', amount: p.amount, description: p.description, reservationId: r!.id, jobId: p.jobId, idempotencyKey: p.idempotencyKey });
    return { reservationId: r!.id, created: true };
  });
}

/**
 * Settle a reservation: charge `chargeAmount` (≤ reserved) and release the rest.
 * Safe to call repeatedly — a settled reservation is left untouched.
 */
export async function settleReservation(
  db: Db,
  p: { reservationId: string; chargeAmount: number; description: string; metadata?: Record<string, unknown> },
): Promise<{ charged: number; released: number; alreadySettled: boolean }> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Claim the reservation atomically; only one settler can win.
    const claimed = await t
      .update(creditReservations)
      .set({ status: p.chargeAmount > 0 ? 'captured' : 'released', capturedAmount: sql`LEAST(${creditReservations.amount}, ${Math.max(0, p.chargeAmount)})`, updatedAt: new Date() })
      .where(and(eq(creditReservations.id, p.reservationId), eq(creditReservations.status, 'held')))
      .returning();
    const r = claimed[0];
    if (!r) return { charged: 0, released: 0, alreadySettled: true };
    const charge = r.capturedAmount;
    const release = r.amount - charge;
    await t
      .update(creditWallets)
      .set({
        reserved: sql`${creditWallets.reserved} - ${r.amount}`,
        balance: sql`${creditWallets.balance} - ${charge}`,
        lifetimeSpent: sql`${creditWallets.lifetimeSpent} + ${charge}`,
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.userId, r.userId));
    if (charge > 0)
      await ledger(t, { userId: r.userId, type: 'capture', amount: -charge, description: p.description, reservationId: r.id, jobId: r.jobId ?? undefined, idempotencyKey: `capture:${r.id}`, metadata: p.metadata });
    if (release > 0)
      await ledger(t, { userId: r.userId, type: 'release', amount: release, description: charge > 0 ? 'Unused reserved credits released' : p.description, reservationId: r.id, jobId: r.jobId ?? undefined, idempotencyKey: `release:${r.id}` });
    return { charged: charge, released: release, alreadySettled: false };
  });
}

export const releaseReservation = (db: Db, reservationId: string, description: string) => settleReservation(db, { reservationId, chargeAmount: 0, description });

/** Refund credits previously captured for a job (e.g. admin refund after a bad output). */
export async function refundJob(db: Db, p: { userId: string; jobId: string; amount: number; reason: string; idempotencyKey?: string }) {
  return addCredits(db, { userId: p.userId, amount: p.amount, type: 'refund', description: `Refund: ${p.reason}`, idempotencyKey: p.idempotencyKey ?? `refund:${p.jobId}`, jobId: p.jobId });
}

/** Release reservations whose jobs never settled (crash safety net). */
export async function releaseExpiredReservations(db: Db): Promise<number> {
  const expired = await db
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(and(eq(creditReservations.status, 'held'), sql`${creditReservations.expiresAt} < now()`));
  for (const r of expired) await releaseReservation(db, r.id, 'Reservation expired');
  return expired.length;
}

# Billing, credits & refunds

## Credit pricing

`credits = ceil((provider cost + processing) × confidence buffer × (1 + markup) / credit value)`, raised if needed so the job keeps the **minimum gross margin**. Defaults (Admin → Routing & limits → pricing): credit value $0.01, markup 60%, minimum margin 35%, processing $0.0008/s, +15% buffer for partly confirmed prices. **Unverified prices are never charged** unless an admin explicitly allows it.

Plans are priced so that subscription credits stay above the margin floor. Admin → Overview shows the worst-case margin per plan and flags any plan below the minimum.

## Lifecycle of a charge

1. The estimate is shown, and the user confirms by clicking Generate (an extra dialog appears above 500 credits). Films require ticking an explicit approval of the total.
2. **Reserve**: an atomic conditional `UPDATE` (`balance − reserved ≥ amount`) plus a ledger entry, in the same transaction as the job and queue entry. Concurrent requests can't overspend (covered by tests).
3. **Settle**: on success, charge `min(reserved, credits recomputed from the provider-reported cost)` and release the rest. When the provider doesn't report cost, the reservation is charged. Overruns are absorbed and audit-logged.
4. Each step is idempotent (unique ledger keys; a reservation can only be settled once).

## Refund policy (as implemented)

| Outcome | Charged |
|---|---|
| Provider error, timeout, invalid output, cancelled before submission | 0 (full release) |
| Content-policy rejection that the provider does **not** refund (Runway `SAFETY.INPUT.*`) | Provider cost only, no markup (abuse deterrent) |
| User cancels mid-generation | Provider cost of segments already completed |
| Film with failed shots | Only completed shots; failed shots can be regenerated individually and finished shots are never re-charged |
| Admin refund (Admin → Failed jobs) | Captured credits returned to the wallet (idempotent) |
| Development fixtures | Never charged |

## Payment providers

`PAYMENT_PROVIDER`:

- `sandbox`: simulated checkout page for development. Disabled in production.
- `stripe`: Checkout Sessions via REST, `Stripe-Signature` HMAC verification (5-minute tolerance) and event de-duplication (`webhook_events`).
- `none`: payments off.

**Merchant availability:** Stripe does not support every merchant country. Before launch, confirm the processor supports your legal entity's country. For a Georgia-registered business, evaluate a merchant-of-record provider (e.g. Paddle or Lemon Squeezy) or a local acquirer (e.g. TBC Bank / Bank of Georgia e-commerce). Add it as another `PaymentProvider` adapter in `apps/server/src/billing/payments.ts`; the interface is `createCheckout` + `verifyWebhook`.

Plan renewals grant the monthly allowance on `invoice.paid` (idempotent per invoice). Cancelling sets `cancelAtPeriodEnd`; with Stripe, also cancel at the provider (dashboard or API). This is not automated yet.

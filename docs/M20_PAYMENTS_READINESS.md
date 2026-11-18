# M20 §9 — Payments & Commercial Readiness Audit

Status: **PAYMENTS DISABLED — no payment infrastructure exists, none is displayed, none is claimed.**

## Audit findings (2026-11-16, feature branch tip 2a7c18d + M20 working tree)

| Check | Result |
|---|---|
| Payment provider code (Stripe / Razorpay / PayPal / checkout SDK) in `src/`, `prisma/schema.prisma`, `package.json` | **ABSENT** — zero occurrences (only unrelated `types.ts` wording matched a coarse grep) |
| Pricing page functional purchase buttons (`Buy now`, `Checkout`, `Pay`, `Start subscription`) | **0 matches** — CTAs route to signup/contact only |
| Billing models in schema (Subscription / Invoice / PaymentIntent) | **ABSENT** |
| Terms §11 "Billing" page text | States explicitly: *BEAN FX does not currently accept payments* |

## Owner requirements before payments ever launch (recorded, not assumed)

1. **Merchant configuration**: verified provider account (e.g. Razorpay for India — requires KYC'd business entity, PAN, bank account; Stripe otherwise), webhook signing secret, server-side-only keys. Live mode requires explicit owner authorization.
2. **Billing model requirements**: plan catalog (monthly/annual), per-plan storage & render quotas, proration rules, seat/usage metering for exports.
3. **Cancellation & refunds**: self-serve cancel at period end vs immediate; refund window policy; India consumer-law fairness review (legal).
4. **Invoices & tax**: GST registration status (India), invoice sequence numbering, place-of-supply rules, reverse-charge handling — **professional tax advice required**.
5. **Architecture (future integration, deliberately not built)**:
   - `PaymentCustomer` / `Subscription` / `Invoice` tables (additive Prisma migrations only).
   - Server-side webhook endpoint with signature verification + idempotency keys.
   - Entitlement middleware mapping plan → quota overrides; no client-trusted plan state.
   - Dunning emails via the M20 mailer template registry.
6. **Compliance gates**: DPDP notice update, ToS billing section rewrite, refund policy page — all under **REQUIRES LEGAL REVIEW** before launch.

Until every gate above is owner-approved, payment acceptance stays disabled and no functional-looking purchase UI exists.

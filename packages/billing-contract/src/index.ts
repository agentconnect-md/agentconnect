// The billing wire contract — zod schemas and their inferred types, zero
// implementation. Two consumers, in two repositories: the console (types for its
// client) and the closed-source billing service (request validation + response
// types). Sharing one declaration is what keeps them from drifting.
//
// Publishing this is safe by construction: the wire format is visible in any
// browser's network panel, so the types reveal nothing the panel doesn't. What
// must NOT leak is the implementation — pricing rules, entitlement evaluation,
// metering — and none of it is here. The one real leak surface is a field
// arriving ahead of its feature, so: A FIELD ENTERS THIS PACKAGE WHEN ITS
// FEATURE SHIPS, not when its branch opens.
//
// Amounts are integer microUSD (1 USD = 1_000_000) on the wire. Formatting to
// dollars is the console's business; arithmetic on money is the service's.
//
// What the shipped-feature rule keeps OUT of here today:
//   - `state` (active/suspended/closed) and `tier` — nothing enforces a balance
//     of zero yet, so nothing can report a state
//   - `lowBalanceThresholdMicro` — the console banner's trigger, which needs the
//     same notification path
// They arrive together with the code that produces them, not one hopeful field at
// a time. There is deliberately NO in-flight/pending figure: usage is billed only
// once it is final, so the balance below is the whole truth rather than an
// estimate awaiting correction.

import { z } from 'zod'

/** microUSD per USD. Exported so no consumer hard-codes the factor. */
export const MICRO_PER_USD = 1_000_000

/** What put credit on the ledger. */
export const CreditKindSchema = z.enum(['purchase', 'adjustment', 'promo', 'refund'])
export type CreditKind = z.infer<typeof CreditKindSchema>

export const BillingAccountSchema = z.object({
  orgId: z.string(),
  /** Credit posted minus usage billed. One definition, settled facts only. */
  balanceMicro: z.number()
})
export type BillingAccount = z.infer<typeof BillingAccountSchema>

export const BillingTransactionSchema = z.object({
  id: z.string(),
  kind: CreditKindSchema,
  amountMicro: z.number(),
  /** ISO 8601 instant. */
  at: z.string()
})
export type BillingTransaction = z.infer<typeof BillingTransactionSchema>

export const BillingTransactionsPageSchema = z.object({
  items: z.array(BillingTransactionSchema),
  /** Pass back as `?cursor=` for the next page; null ⇒ this is the last one. */
  nextCursor: z.string().nullable()
})
export type BillingTransactionsPage = z.infer<typeof BillingTransactionsPageSchema>

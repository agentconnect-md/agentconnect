/**
 * Single-tenant default identities (design §3.2, §3.13).
 *
 * The MVP ships one seeded `Org` + owner `User` so every `orgId`/`actorUserId`
 * FK has an anchor and the C2 devAuth stub has a fixed principal to inject. These
 * ids are stable and live in `src/` (not `prisma/`) so the composition root and
 * services can reference them WITHOUT reaching outside `src/` — `prisma/seed.ts`
 * imports them from here.
 */

/** The default single-tenant Org id (stable across seeds). */
export const DEFAULT_ORG_ID = 'org_default00000000000000000'
/** The default owner User id (stable across seeds). */
export const DEFAULT_OWNER_ID = 'usr_owner000000000000000000'
/** `-` on purpose: never a legal user slug (regex forbids it), so the seeded
 *  default org owns the uniform console URL `/-/…` in no-auth mode. */
export const DEFAULT_ORG_SLUG = '-'
export const DEFAULT_OWNER_EMAIL = 'owner@agentconnect.local'

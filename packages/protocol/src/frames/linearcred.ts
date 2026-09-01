import { z } from 'zod'

// Linear access-token broker (linear-integration.md §4.4, §7.3) — daemon-pulled, CP-refreshed.
// Linear tokens expire in ~24 h and refresh ROTATES the refresh token, so the CP is the single
// durable writer: it holds the client secret and the refresh token, refreshes behind a
// single-flight, persists the rotated pair BEFORE replying, and re-pushes the integration spec.
// The daemon never sees the client secret or the refresh token — it caches the granted access
// token in memory and re-requests when it nears expiry.
// Like `gitcred` (and unlike the lease-and-reference `secrets/*`), the grant carries the TOKEN
// MATERIAL itself: same plaintext-over-TLS-WS posture as `integration/upsert`, same discipline —
// **never log the payload**.
// Failures come back as correlated `error` REPs: `SCOPE_DENIED` (the integration's agent is not
// placed on this daemon — stop asking), `LEASE_DENIED` (refresh rejected upstream; the workspace
// connection needs an operator reconnect), `RATE_LIMITED`, `INTERNAL`.

/** D→C, REQ — the daemon may only name an integration; the CP resolves integration → bot → workspace token itself. */
export const LinearCredRequest = z.object({
  integrationId: z.string().uuid()
})
export type LinearCredRequest = z.infer<typeof LinearCredRequest>

/** C→D, REP (plaintext token — never log). */
export const LinearCredGrant = z.object({
  accessToken: z.string(),
  // Observability and cache-margin input only; a daemon must never resurrect a token on a skewed local clock.
  expiresAt: z.string().datetime()
})
export type LinearCredGrant = z.infer<typeof LinearCredGrant>

import { createHash } from 'node:crypto'

/** Reserved prefix for member-scoped runtime probes; the Control Plane never assigns it. */
export const PROBE_AGENT_ID_PREFIX = 'ac-runtime-probe'
export const PROBE_CLAIM_LABEL = 'agentconnect.md/runtime-probe'
export const PROBE_CLAIM_EXPIRES_ANNOTATION = 'agentconnect.md/runtime-probe-expires-at'
/** Bounds an abandoned probe claim while leaving ample room for cold scheduling and the probe. */
export const PROBE_CLAIM_TTL_MS = 15 * 60_000

/** A deterministic, DNS-safe probe identity unique to one daemon member. */
export function probeAgentId(memberId: string): string {
  const memberHash = createHash('sha256').update(memberId).digest('hex').slice(0, 16)
  return `${PROBE_AGENT_ID_PREFIX}-${memberHash}`
}

/** Whether a claim is a runtime probe's, and if so when its window closes (NaN when unreadable). */
export function probeClaimExpiry(claim: {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
}): number | undefined {
  if (claim.metadata?.labels?.[PROBE_CLAIM_LABEL] !== 'true') return undefined
  const raw = claim.metadata.annotations?.[PROBE_CLAIM_EXPIRES_ANNOTATION]
  return raw ? Date.parse(raw) : Number.NaN
}

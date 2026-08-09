import type { FastifyRequest } from 'fastify'
import type { OrgId } from '../domain/ids.js'
import type { ExternalScopeRecord } from '../persistence/ports.js'

/**
 * Why a provider could not answer, as one low-cardinality CAUSE — never a
 * target. Nothing derived from a channel, conversation, user, team, or scope
 * belongs here; the console renders this to a member of the owning org, and
 * `provider`/`region`/`reason` is the whole vocabulary it gets.
 *
 * The two authorization reasons are told apart by WHOSE authorization fell
 * short, because their remedies have nothing in common:
 *
 * - `authorization` — the VIEWER's linked identity. They fix it themselves, on
 *   their own Profile, and no one else's view is affected.
 * - `app_authorization` — the INSTALLED APP's grant or credential. An
 *   administrator fixes it once, on Integrations, and it was the missing
 *   variant: a Slack app short of a required scope reached the console as a
 *   bare `degraded`, so the only copy that fit was "checks unavailable" —
 *   which reads as an outage and suggests nothing to do, while the state
 *   persists until someone reauthorizes the app.
 *
 * `unavailable` stays what it says: rate limiting, an outage, a timeout —
 * something that clears on its own. Do not widen it to carry either.
 */
export interface SessionAccessIssue {
  provider: string
  region?: string
  reason: 'authorization' | 'app_authorization' | 'quota' | 'unavailable'
}

export interface SessionAccessViewer {
  request: FastifyRequest
  orgId: OrgId
  userId: string
  identitySet: Set<string>
}

export interface SessionAccessResult {
  allowedScopes: Array<{ id: string; aclRevision: bigint }>
  degraded: boolean
  accessIssues?: SessionAccessIssue[]
}

/** §4.1 warm outcome (session-access-cold-visit.md): `warmed` carries the verdict now
 *  leased; `skipped` is a fence refusing before any provider call; `failed` is a check
 *  that ran and could not answer — and, by the wrapper invariant, was never cached. */
export type SessionAccessWarmOutcome =
  { outcome: 'warmed'; verdict: string } | { outcome: 'skipped' | 'failed'; reason: string }

/** Provider-owned half of Session visibility. Core combines the provider
 * audience with the Session's own classification; Agent Team visibility is a
 * separate resource boundary. */
export interface SessionAccessPlugin {
  provider: string
  available: boolean
  addViewerIdentities?(viewer: SessionAccessViewer): Promise<void>
  resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult>
}

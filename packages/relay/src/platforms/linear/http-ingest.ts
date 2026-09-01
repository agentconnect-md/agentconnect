// Linear's per-bot HTTP ingest (linear-integration.md §6.1) — a PURE decoder: no socket to
// open, no provider API calls, and no relay-side egress; the daemon owns every Linear write.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { truncateUtf8 } from '../../hooks/github-ingress.js'
import { HookRateLimiter } from '../../hooks/rate-limit.js'

/** Replay window on the `Linear-Timestamp` header, which carries epoch MILLISECONDS. */
export const LINEAR_TIMESTAMP_WINDOW_MS = 60_000

/** Hard cap on one delivery's raw body (§6.1). */
export const LINEAR_BODY_LIMIT = 1024 * 1024

/** Byte budget shared by `promptContext` + `previousComments` in the adapter bag (§6.1). */
export const LINEAR_CONTEXT_BUDGET_BYTES = 32 * 1024

const LinearTeam = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  name: z.string().optional()
})

const LinearIssue = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  team: LinearTeam.nullish()
})

// Only the fields the relay actually forwards survive parsing: the adapter bag is
// model-visible on the daemon, so an unlisted field (a commenter's email) never rides along.
const LinearPreviousComment = z.object({
  id: z.string().optional(),
  body: z.string().optional(),
  userId: z.string().optional(),
  createdAt: z.string().optional()
})
export type LinearPreviousComment = z.infer<typeof LinearPreviousComment>

const LinearAgentSession = z.object({
  id: z.string(),
  creatorId: z.string().nullish(),
  commentId: z.string().nullish(),
  sourceCommentId: z.string().nullish(),
  status: z.string().nullish(),
  summary: z.string().nullish(),
  url: z.string().nullish(),
  comment: z.object({ id: z.string().optional(), body: z.string().optional() }).nullish(),
  // Nullable by Linear's own schema — `app:mentionable` also covers documents (§4.5).
  issue: LinearIssue.nullish()
})

const LinearAgentActivity = z.object({
  id: z.string(),
  // A STOP arrives as `prompted` with `signal: "stop"`, never as an action of its own.
  signal: z.string().nullish(),
  sourceCommentId: z.string().nullish(),
  content: z.object({ type: z.string().optional(), body: z.string().optional() }).nullish(),
  user: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish()
})

export const LinearAgentSessionEvent = z.object({
  type: z.literal('AgentSessionEvent'),
  action: z.string(),
  organizationId: z.string(),
  oauthClientId: z.string(),
  appUserId: z.string().nullish(),
  agentSession: LinearAgentSession,
  agentActivity: LinearAgentActivity.nullish(),
  previousComments: z.array(LinearPreviousComment).nullish(),
  guidance: z.string().nullish(),
  promptContext: z.string().nullish(),
  webhookTimestamp: z.number().nullish(),
  webhookId: z.string().nullish()
})
export type LinearAgentSessionEvent = z.infer<typeof LinearAgentSessionEvent>

// The pre-discrimination envelope: type/action pick the branch, and the identity pair is the
// tenant-scoped demux the signature alone cannot perform.
const LinearEnvelope = z.object({
  type: z.string().optional(),
  action: z.string().optional(),
  organizationId: z.string().optional(),
  oauthClientId: z.string().optional(),
  webhookTimestamp: z.number().optional()
})

/** The plugin's typed verified product — derived exactly once, in `verify`. */
export type VerifiedLinearDelivery =
  | { kind: 'agent-session'; event: LinearAgentSessionEvent }
  | { kind: 'revoked'; eventAtMs?: number }
  | { kind: 'ignored' }

/** Identity + credentials one workspace bot's ingest is built from (§6.2's two opaque bags). */
export interface LinearIngestIdentity {
  clientId: string
  organizationId: string
  appUserId?: string
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Linear signs the exact request bytes as bare lowercase hex (no scheme prefix), so neither
// shared primitive fits verbatim — the discipline is theirs: decode, length-check, compare.
function signatureIsValid(signingSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !/^[0-9a-fA-F]+$/.test(header)) return false
  const expected = createHmac('sha256', signingSecret).update(rawBody).digest()
  const presented = Buffer.from(header, 'hex')
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function timestampInWindow(header: string | undefined, now: number): boolean {
  if (!header || !/^\d+$/.test(header)) return false
  const ms = Number(header)
  return Number.isSafeInteger(ms) && Math.abs(now - ms) <= LINEAR_TIMESTAMP_WINDOW_MS
}

/** Content-derived dedup identity (§4.5) — stable across Linear's 1 min/1 h/6 h redeliveries. */
export function linearDedupId(event: LinearAgentSessionEvent): string | undefined {
  if (event.action === 'created') return `linear:${event.agentSession.id}:created`
  if (event.action === 'prompted' && event.agentActivity) return `linear:${event.agentActivity.id}`
  return undefined
}

/** True iff this `prompted` is the native stop signal rather than a follow-up message. */
export function linearIsStop(event: LinearAgentSessionEvent): boolean {
  return event.action === 'prompted' && event.agentActivity?.signal === 'stop'
}

/** §6.4 adapter-extension bag: opaque to relay core, round-tripped to the daemon's linear module. */
export interface LinearAdapterExt {
  agentSessionId: string
  issueIdentifier?: string
  issueTitle?: string
  promptContext?: string
  guidance?: string
  previousComments?: LinearPreviousComment[]
  truncated?: boolean
}

// Spend one shared byte budget on the two attacker-authored context fields, longest-lived
// first: the prompt context, then as many previous comments as the remainder still affords.
function budgetContext(
  promptContext: string | undefined,
  previousComments: LinearPreviousComment[] | undefined,
  budgetBytes: number
): { promptContext?: string; previousComments?: LinearPreviousComment[]; truncated: boolean } {
  let remaining = budgetBytes
  let truncated = false
  let context: string | undefined
  if (promptContext !== undefined) {
    const cut = truncateUtf8(promptContext, remaining)
    context = cut.text
    truncated ||= cut.truncated
    remaining -= Buffer.byteLength(cut.text, 'utf8')
  }
  let comments: LinearPreviousComment[] | undefined
  if (previousComments && previousComments.length > 0) {
    comments = []
    for (const comment of previousComments) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      const cut = truncateUtf8(comment.body ?? '', remaining)
      truncated ||= cut.truncated
      remaining -= Buffer.byteLength(cut.text, 'utf8')
      comments.push({ ...comment, body: cut.text })
    }
  }
  return {
    ...(context !== undefined ? { promptContext: context } : {}),
    ...(comments !== undefined ? { previousComments: comments } : {}),
    truncated
  }
}

// The member's instruction must be readable as TEXT, never only inside the fenced prompt
// context (§6.3): the follow-up body verbatim, else the delegation line the session opened with.
function instructionText(event: LinearAgentSessionEvent): string {
  if (event.action === 'prompted') return event.agentActivity?.content?.body ?? ''
  const session = event.agentSession
  return session.comment?.body?.trim() || session.issue?.title || session.summary || ''
}

// The human who delegated, mentioned, or replied. An unattributed session falls back to its own
// id so the sender is never fabricated, never shared, and never `linear:undefined`.
function actorId(event: LinearAgentSessionEvent): string {
  const session = event.agentSession
  return event.agentActivity?.user?.id ?? session.creatorId ?? session.id
}

// One verified `created`/`prompted` event as the message relay core arbitrates: `channel` is the
// immutable issue UUID, falling back to the session UUID for the issue-less surfaces (§4.5).
export function normalizeLinearEvent(
  event: LinearAgentSessionEvent,
  msgId: string,
  appUserId: string | undefined
): WireNormalizedMessage {
  const session = event.agentSession
  const issue = session.issue ?? undefined
  const context = budgetContext(
    event.promptContext ?? undefined,
    event.previousComments ?? undefined,
    LINEAR_CONTEXT_BUDGET_BYTES
  )
  const adapterExt: LinearAdapterExt = {
    agentSessionId: session.id,
    ...(issue?.identifier ? { issueIdentifier: issue.identifier } : {}),
    ...(issue?.title ? { issueTitle: issue.title } : {}),
    ...(context.promptContext !== undefined ? { promptContext: context.promptContext } : {}),
    ...(event.guidance ? { guidance: event.guidance } : {}),
    ...(context.previousComments !== undefined ? { previousComments: context.previousComments } : {}),
    ...(context.truncated ? { truncated: true } : {})
  }
  const senderName = event.agentActivity?.user?.name
  const eventAtMs = typeof event.webhookTimestamp === 'number' ? Math.trunc(event.webhookTimestamp) : undefined
  return {
    msgId,
    traceId: msgId,
    source: 'user',
    platform: 'linear',
    channel: issue?.id ?? session.id,
    thread: session.id,
    ...(issue?.url?.startsWith('https://') ? { threadUrl: issue.url } : {}),
    sender: {
      id: `linear:${actorId(event)}`,
      isBot: false,
      ...(senderName ? { name: senderName } : {})
    },
    text: instructionText(event),
    // Every Linear event exists because the app was delegated to or mentioned (§6.1), so the
    // arbitration ladder's "explicitly addressed" gate is satisfied by construction.
    mentionedBots: appUserId ? [appUserId] : [],
    isDm: false,
    trigger: 'mention',
    ...(eventAtMs !== undefined && eventAtMs > 0 ? { platformTimeMs: eventAtMs } : {}),
    adapterExt: { linear: adapterExt }
  }
}

// One workspace bot's callback verifier: it holds the deployment app's webhook signing secret
// and nothing else — no access token, no client secret, no refresh token (§12).
export class LinearHttpIngest {
  private readonly limiter: HookRateLimiter

  constructor(
    readonly botId: string,
    readonly identity: LinearIngestIdentity,
    private readonly signingSecret: string,
    private readonly now: () => number,
    /** The generation THIS ingest was built from — the fence a revocation report carries. */
    readonly credentialRevision?: number
  ) {
    this.limiter = new HookRateLimiter({ now: () => this.now() })
  }

  /** §8 RelayBotIngress: a pure decoder has nothing to release. */
  stop(): void {}

  /** Take one token from this bot's ingress bucket; false ⇒ drop the delivery (still 200). */
  allow(): boolean {
    return this.limiter.allow(this.botId)
  }

  // Authenticate one delivery and derive its typed product exactly once: signature over the exact
  // request bytes, then the replay window on the `Linear-Timestamp` HEADER. The body's
  // `webhookTimestamp` mirrors that header but is only ever read for reporting, never to verify.
  decode(
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    now: number
  ): VerifiedLinearDelivery | undefined {
    if (!signatureIsValid(this.signingSecret, rawBody, headerString(headers['linear-signature']))) return undefined
    if (!timestampInWindow(headerString(headers['linear-timestamp']), now)) return undefined
    const envelope = LinearEnvelope.safeParse(body)
    if (!envelope.success) return undefined
    // Tenant-scoped demux (§6.1/§12): every sibling install of the deployment app shares this
    // signing secret, so the payload's own identity is the only thing separating workspaces.
    if (envelope.data.organizationId !== this.identity.organizationId) return undefined
    if (envelope.data.oauthClientId !== undefined && envelope.data.oauthClientId !== this.identity.clientId) {
      return undefined
    }
    // `Linear-Event` is outside the HMAC, so the branch is taken on the SIGNED body's own type.
    if (envelope.data.type === 'OAuthApp' && envelope.data.action === 'revoked') {
      const at = envelope.data.webhookTimestamp
      const eventAtMs = typeof at === 'number' && Number.isFinite(at) ? Math.trunc(at) : undefined
      return { kind: 'revoked', ...(eventAtMs !== undefined && eventAtMs >= 0 ? { eventAtMs } : {}) }
    }
    if (envelope.data.type !== 'AgentSessionEvent') return { kind: 'ignored' }
    const parsed = LinearAgentSessionEvent.safeParse(body)
    return parsed.success ? { kind: 'agent-session', event: parsed.data } : { kind: 'ignored' }
  }
}

import { z } from 'zod'

/**
 * Routing & orchestration (C→D control) — protocol §5.
 *
 * `SessionKey` is the canonical session primitive shared across route/*,
 * agent/*, and event/session. Its canonical string form is
 * `${platform}:${channel}:${thread ?? "-"}`.
 */

// `webchat`, `hook`, and `dream` are session-identity platforms only (the
// Playground conversation / a webhook trigger / a background memory-consolidation
// run) — no integration, no bind rules, no routing-table participation, never a
// persisted DB Platform.
//
// S1a tolerant readers (integration-plugin-architecture.md §6.2): every peer
// READS platform fields as an open string, because zod rejects unknown enum
// values wholesale and an unknown id inside a known frame is frame-fatal —
// a new id reaching an old peer's `register` reader is a fatal handshake
// reconnect loop. WRITERS keep emitting only `KNOWN_PLATFORMS` values until
// the fleet gate passes (every deployed peer reads tolerantly); only then may
// a new platform id be emitted (S1b).
//
// Per-frame policy for an unknown (non-legacy) id, decided per frame where the
// value is consumed, never by closing this schema:
//   - `register.capabilities.platforms` — accept the frame; an unknown id
//     simply never matches a placement/capability gate (ignore-unknown).
//   - `event/session` — store the value verbatim (session rows are text).
//   - `rd/msg` — decode succeeds; the daemon may refuse the ITEM on semantic
//     grounds (fail-closed coordinate checks), but never the socket.
export const KNOWN_PLATFORMS = ['slack', 'telegram', 'webchat', 'discord', 'feishu', 'hook', 'dream'] as const
export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number]
export function isKnownPlatform(p: string): p is KnownPlatform {
  return (KNOWN_PLATFORMS as readonly string[]).includes(p)
}
// The origin-kind classification seed (integration-plugin-architecture.md §6.1): the
// session-identity platforms are channel-free — no integration row, no persisted
// conversation, no placement snapshot entry. Everything OUTSIDE this list is
// chat-shaped and must be treated fail-closed where a placement matters
// (`coordsDecision` refuses an unrecorded coordinate on any chat-shaped id,
// including ids this build does not know). S1b replaces this constant with
// wire-carried per-id classification riding collab snapshots / rc/bot-assign.
export const SESSION_IDENTITY_PLATFORMS = ['webchat', 'hook', 'dream'] as const
export type SessionIdentityPlatform = (typeof SESSION_IDENTITY_PLATFORMS)[number]
export function isSessionIdentityPlatform(p: string): p is SessionIdentityPlatform {
  return (SESSION_IDENTITY_PLATFORMS as readonly string[]).includes(p)
}
// D3: the origin-KIND axis. `chat` = an external chat platform (an open, growing
// set); the session-identity kinds are core surfaces and each is its own kind. A
// new KIND is a core change, never a platform module — but wire fields carrying a
// kind still read as open strings (the S1a rule), so adding one is not
// frame-fatal to older peers.
export const ORIGIN_KINDS = ['chat', 'hook', 'dream', 'webchat'] as const
export type OriginKind = (typeof ORIGIN_KINDS)[number]
/** Classification seed for the platform ids THIS build knows. Wire-carried
 *  entries (`CollabRoutesSnapshot.platformKinds`, `rc/bot-assign.originKind`)
 *  extend it for ids a newer peer introduces (§6.1). `undefined` = an id neither
 *  the seed nor the wire classified — consumers treat it as `'chat'`, the
 *  fail-closed default wherever placements matter. */
export function originKindOf(p: string): OriginKind | undefined {
  if (isSessionIdentityPlatform(p)) return p
  return isKnownPlatform(p) ? 'chat' : undefined
}

/** The origin kinds a console composer may continue (webchat-cross-integration-continuation.md
 *  §2.2, §9): a chat thread, whose human turn is mirrored back to the platform, and a hook
 *  session — a code-host event or a generic webhook — whose only human surface IS the console.
 *  `webchat` continues in place and `dream` is not a conversation; an id this build cannot
 *  classify stays refused, like every other fail-closed coordinate check. */
export function continuableOrigin(platform: string): boolean {
  const kind = originKindOf(platform)
  return kind === 'chat' || kind === 'hook'
}
export const Platform = z.string().min(1)
export type Platform = z.infer<typeof Platform>

export const SessionKey = z.object({
  platform: Platform,
  channel: z.string(),
  thread: z.string().optional() // absent = channel-root
})
export type SessionKey = z.infer<typeof SessionKey>

/** Trigger-matching rule for a binding (protocol §5.1). */
export const BindRule = z.object({
  match: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('mention') }),
    z.object({ kind: z.literal('dm') }),
    z.object({ kind: z.literal('keyword'), value: z.string() }),
    z.object({ kind: z.literal('auto') }) // alert-channel auto-handle
  ])
})
export type BindRule = z.infer<typeof BindRule>

export const RouteAssign = z.object({
  // also appears in RegisterOk.assignments[]
  sessionKey: SessionKey,
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(), // which D9 workspace to prepare
  bindRules: z.array(BindRule).default([])
})
export type RouteAssign = z.infer<typeof RouteAssign>

export const RouteAssignAck = z.object({
  ok: z.boolean(),
  sessionKey: SessionKey,
  reason: z.string().optional()
})
export type RouteAssignAck = z.infer<typeof RouteAssignAck>

export const RouteUpdate = z.object({
  routingEpoch: z.number().int(),
  rules: z.array(z.object({ match: z.unknown(), agentId: z.string().uuid() }))
})
export type RouteUpdate = z.infer<typeof RouteUpdate>

/** Graceful scale-down / rebalance — protocol §5.3. */
export const Drain = z.object({
  scope: z.union([
    z.object({ kind: z.literal('agent'), agentId: z.string().uuid() }),
    z.object({ kind: z.literal('daemon') }), // whole-daemon drain (shutdown/upgrade)
    z.object({ kind: z.literal('session'), sessionKey: SessionKey })
  ]),
  deadline: z.string().datetime() // hard cutoff; in-flight turns past this are cancelled
})
export type Drain = z.infer<typeof Drain>

export const DrainProgress = z.object({
  remaining: z.number().int(),
  drained: z.array(SessionKey)
})
export type DrainProgress = z.infer<typeof DrainProgress>

export const DrainDone = z.object({
  released: z.array(SessionKey) // CP may now reassign — fenced by new epoch
})
export type DrainDone = z.infer<typeof DrainDone>

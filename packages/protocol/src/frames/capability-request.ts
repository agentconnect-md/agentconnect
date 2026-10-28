import { z } from 'zod'
import { ChatActions } from './agent.js'
import { ExecutorStrategyName } from './executor.js'

/** Capability requests (capability-requests.md): a CP advertising it serves `capability/*`, and a daemon advertising it answers `session/capability-settled`. */
export const CAPABILITY_REQUESTS_FEATURE = 'capability-requests-v1'

/** Phase 2: a CP advertising it takes `repository`, `connection` and `secret` asks; a daemon advertising it takes `agent/mcp-rebound` and offers those kinds. */
export const CAPABILITY_REQUESTS_V2_FEATURE = 'capability-requests-v2'

/** Phase 3: a CP advertising it takes `secret` asks on the `live` route and ships `AgentSpec.liveSecrets`; a daemon advertising it serves them through `agentconnect-secrets`. */
export const CAPABILITY_REQUESTS_V3_FEATURE = 'capability-requests-v3'

/** §4.12: a CP advertising it takes every agent-form field in `agent-settings` and the `cron` kind; a daemon advertising it offers them. */
export const CAPABILITY_REQUESTS_V4_FEATURE = 'capability-requests-v4'

/** The kinds a CP or daemon without `capability-requests-v2` knows. */
export const CAPABILITY_V1_KINDS: readonly CapabilityKind[] = ['agent-settings', 'mcp-server', 'skill']

/** At most this many open requests started from one session (§4.1). */
export const CAPABILITY_REQUEST_SESSION_CAP = 3
/** A request nobody settles expires after seven days (§4.3). */
export const CAPABILITY_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** An identical request declined within this window is not reopened (§4.1). */
export const CAPABILITY_REQUEST_DECLINE_MEMORY_MS = 24 * 60 * 60 * 1000
/** A wake not accepted within this window is given up as `gone` (§4.7.3). */
export const CAPABILITY_WAKE_GIVE_UP_MS = 24 * 60 * 60 * 1000
/** The agent's reason, shown as plain text (§4.1). */
export const CAPABILITY_REASON_MAX = 280
/** A decider's note on a decline (§4.7.1). */
export const CAPABILITY_NOTE_MAX = 500

/** What an agent may ask for (§4.2). */
export const CapabilityKind = z.enum([
  'agent-settings',
  'mcp-server',
  'skill',
  'repository',
  'connection',
  'secret',
  'cron'
])
export type CapabilityKind = z.infer<typeof CapabilityKind>

/** The `agent-settings` fields a CP or daemon without `capability-requests-v4` knows. */
export const CAPABILITY_V1_SETTINGS_FIELDS = [
  'model',
  'reasoningEffort',
  'fastMode',
  'outputMode',
  'permissionMode'
] as const

/** The `agent-settings` fields an agent may ask for (§4.2, §4.12): the agent form's plain values; workspace, visibility and sharing are not among them. */
export const CapabilitySettingsWant = z
  .object({
    model: z.string().min(1).max(200).optional(),
    reasoningEffort: z.string().min(1).max(50).optional(),
    fastMode: z.boolean().optional(),
    outputMode: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
    permissionMode: z.string().min(1).max(100).optional(),
    runtime: z.string().min(1).max(100).optional(),
    execution: ExecutorStrategyName.optional(),
    chatActions: ChatActions.optional(),
    introduceOnJoin: z.boolean().optional(),
    showFooter: z.boolean().optional(),
    showStatusBar: z.boolean().optional(),
    displayName: z.string().min(1).max(100).optional()
  })
  .strict()
  .refine((want) => Object.values(want).some((value) => value !== undefined), { message: 'name at least one field' })
export type CapabilitySettingsWant = z.infer<typeof CapabilitySettingsWant>

/** An organization MCP server, by the name the console shows. */
export const CapabilityMcpServerWant = z.object({ server: z.string().min(1).max(200) }).strict()
export type CapabilityMcpServerWant = z.infer<typeof CapabilityMcpServerWant>

/** A skill reference `<source>/<skill>`. */
export const CapabilitySkillWant = z
  .object({
    skill: z
      .string()
      .min(3)
      .max(300)
      .regex(/^[^\s/]+(?:\/[^\s/]+)*\/[^\s/]+$/, 'expected <source>/<skill>')
  })
  .strict()
export type CapabilitySkillWant = z.infer<typeof CapabilitySkillWant>

/** A repository on a code host and the tier wanted; `host` names a self-managed GitLab, else the provider's public host. */
export const CapabilityRepositoryWant = z
  .object({
    provider: z.enum(['github', 'gitlab']),
    host: z.string().min(1).max(253).optional(),
    repository: z
      .string()
      .min(3)
      .max(300)
      .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/, 'expected <owner>/<repo>'),
    access: z.enum(['read', 'write'])
  })
  .strict()
export type CapabilityRepositoryWant = z.infer<typeof CapabilityRepositoryWant>

/** A connection the console makes through a browser redirect: an MCP server's OAuth, a code host, or a chat integration. */
export const CapabilityConnectionWant = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcp-oauth'), server: z.string().min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal('code-host'),
      provider: z.enum(['github', 'gitlab']),
      host: z.string().min(1).max(253).optional()
    })
    .strict(),
  z.object({ type: z.literal('chat-integration'), platform: z.string().min(1).max(50) }).strict()
])
export type CapabilityConnectionWant = z.infer<typeof CapabilityConnectionWant>

const LIVE_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/

/** A secret by name and purpose, never its value; the route says whether the agent can read it (§4.9). */
export const CapabilitySecretWant = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(200),
    use: z.discriminatedUnion('route', [
      z.object({ route: z.literal('mcp-header'), server: z.string().min(1).max(200) }).strict(),
      z.object({ route: z.literal('live') }).strict()
    ])
  })
  .strict()
  .refine((want) => (want.use.route === 'live' ? LIVE_SECRET_NAME : HEADER_NAME).test(want.name), {
    message: 'a live secret is named like an environment variable (A-Z, 0-9, _), a header like an HTTP header'
  })
export type CapabilitySecretWant = z.infer<typeof CapabilitySecretWant>

/** A scheduled task (§4.12): a new cron of the agent, or with `cronId` a change to one of its own; `trigger` is the prompt it runs. */
export const CapabilityCronWant = z
  .object({
    cronId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    schedule: z.string().trim().min(1).max(100),
    timezone: z.string().min(1).max(64).optional(),
    trigger: z.string().trim().min(1).max(2000)
  })
  .strict()
export type CapabilityCronWant = z.infer<typeof CapabilityCronWant>

/** Whether an ask needs a CP and daemon with `capability-requests-v4`: the `cron` kind, or a setting outside the v1 fields. */
export function capabilityAskNeedsV4(ask: CapabilityAsk): boolean {
  if (ask.kind === 'cron') return true
  if (ask.kind !== 'agent-settings') return false
  const v1: readonly string[] = CAPABILITY_V1_SETTINGS_FIELDS
  return Object.entries(ask.want).some(([field, value]) => value !== undefined && !v1.includes(field))
}

/** The kind with its validated `want`; unknown fields are refused, not ignored (§4.2). */
export const CapabilityAsk = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent-settings'), want: CapabilitySettingsWant }),
  z.object({ kind: z.literal('mcp-server'), want: CapabilityMcpServerWant }),
  z.object({ kind: z.literal('skill'), want: CapabilitySkillWant }),
  z.object({ kind: z.literal('repository'), want: CapabilityRepositoryWant }),
  z.object({ kind: z.literal('connection'), want: CapabilityConnectionWant }),
  z.object({ kind: z.literal('secret'), want: CapabilitySecretWant }),
  z.object({ kind: z.literal('cron'), want: CapabilityCronWant })
])
export type CapabilityAsk = z.infer<typeof CapabilityAsk>

/** The deduplication target with the agent and kind: the server, the skill, or the settings fields asked for. */
export function capabilityTarget(ask: CapabilityAsk): string {
  switch (ask.kind) {
    case 'agent-settings':
      return Object.keys(ask.want)
        .filter((key) => ask.want[key as keyof CapabilitySettingsWant] !== undefined)
        .sort()
        .join('+')
    case 'mcp-server':
      return ask.want.server
    case 'skill':
      return ask.want.skill
    case 'repository':
      return `${ask.want.provider}:${ask.want.host ?? ''}:${ask.want.repository.toLowerCase()}:${ask.want.access}`
    case 'connection': {
      const want = ask.want
      if (want.type === 'mcp-oauth') return `mcp-oauth:${want.server}`
      if (want.type === 'code-host') return `code-host:${want.provider}:${want.host ?? ''}`
      return `chat-integration:${want.platform}`
    }
    case 'secret':
      return `${ask.want.use.route}:${ask.want.use.route === 'mcp-header' ? ask.want.use.server : ''}:${ask.want.name}`
    // A change to one cron is keyed by it; a new one by its schedule and zone, so a reworded prompt joins the open request.
    case 'cron':
      return ask.want.cronId
        ? `cron:${ask.want.cronId}`
        : `new:${ask.want.schedule}:${ask.want.timezone ?? ''}:${(ask.want.name ?? '').toLowerCase()}`
  }
}

/** One person a turn speaks for, as the daemon's read rule names them (assistant-mode.md §5.5). */
export const CapabilityAsker = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('member'),
    platform: z.string().min(1).max(50),
    integrationId: z.string().min(1).max(200),
    userId: z.string().min(1).max(200),
    name: z.string().max(200).optional()
  }),
  z.object({ kind: z.literal('console'), userId: z.string().min(1).max(200), name: z.string().max(200).optional() })
])
export type CapabilityAsker = z.infer<typeof CapabilityAsker>

/** At most this many people per origin; a turn speaking for more is recorded as nobody's rather than cut short. */
export const CAPABILITY_ASKERS_MAX = 32

/** An origin's asker context, stored as given and never widened (§4.3). */
export const CapabilityAskers = z.object({
  people: z.array(CapabilityAsker).max(CAPABILITY_ASKERS_MAX),
  nobody: z.boolean()
})
export type CapabilityAskers = z.infer<typeof CapabilityAskers>

/** Where the card of an origin went: its own conversation, the responsible user's DM, or nowhere (Activity only). */
export const CapabilityCardPlacement = z.enum(['conversation', 'dm', 'none'])
export type CapabilityCardPlacement = z.infer<typeof CapabilityCardPlacement>

export const CapabilityRequestStatus = z.enum(['open', 'completed', 'declined', 'expired', 'withdrawn'])
export type CapabilityRequestStatus = z.infer<typeof CapabilityRequestStatus>

/** D→C REQ, `capability/request`: the tool call with its session's coordinates and asker context. */
export const CapabilityRequestReq = z.object({
  agentId: z.string().uuid(),
  // The origin session, by its outward id and the daemon's session key.
  sessionId: z.string().min(1).max(200),
  sessionKey: z.string().min(1).max(1000),
  ask: CapabilityAsk,
  reason: z.string().min(1).max(CAPABILITY_REASON_MAX),
  askers: CapabilityAskers,
  // The place, for display: its platform and a human label when the daemon has one.
  platform: z.string().min(1).max(50),
  placeLabel: z.string().max(200).optional(),
  // The origin is an external place: its details stay out of the other organization's view (§4.4.5).
  external: z.boolean().optional()
})
export type CapabilityRequestReq = z.infer<typeof CapabilityRequestReq>

/** Why a request was not taken: the per-session cap, a target the agent cannot be given, or a malformed want. */
export const CapabilityRequestRefusal = z.enum(['limit', 'unknown_target', 'invalid', 'not_offered', 'unsupported'])
export type CapabilityRequestRefusal = z.infer<typeof CapabilityRequestRefusal>

/** C→D REP to `capability/request`. `pending` names the request (new or joined), its link and the CP's wording of it. */
export const CapabilityRequestResult = z.object({
  status: z.enum(['pending', 'already_satisfied', 'declined_recently', 'refused']),
  requestId: z.string().uuid().optional(),
  generation: z.number().int().positive().optional(),
  // `<webAppUrl>/<orgSlug>/requests/<id>`; it carries nothing else and is not a credential (§4.4).
  link: z.string().url().optional(),
  // What was asked, as the CP words it from `want`: "add the MCP server "Linear"".
  summary: z.string().max(500).optional(),
  // This conversation joined a request another conversation opened (§4.1).
  joined: z.boolean().optional(),
  declined: z
    .object({
      by: z.string().max(200),
      note: z.string().max(CAPABILITY_NOTE_MAX).optional(),
      at: z.string().datetime()
    })
    .optional(),
  refused: CapabilityRequestRefusal.optional(),
  message: z.string().max(500).optional()
})
export type CapabilityRequestResult = z.infer<typeof CapabilityRequestResult>

/** D→C REQ, `capability/withdraw`: the agent no longer needs its open request; nobody is woken. */
export const CapabilityWithdrawReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  requestId: z.string().uuid()
})
export type CapabilityWithdrawReq = z.infer<typeof CapabilityWithdrawReq>

export const CapabilityWithdrawResult = z.object({
  status: z.enum(['withdrawn', 'not_found', 'already_settled'])
})
export type CapabilityWithdrawResult = z.infer<typeof CapabilityWithdrawResult>

/** Who declined from a chat card: a linked console user, else the platform identity and its display name (§4.4.3). */
export const CapabilityDecider = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('console'), userId: z.string().min(1).max(200), name: z.string().max(200).optional() }),
  z.object({
    kind: z.literal('member'),
    platform: z.string().min(1).max(50),
    integrationId: z.string().min(1).max(200),
    userId: z.string().min(1).max(200),
    name: z.string().max(200).optional()
  })
])
export type CapabilityDecider = z.infer<typeof CapabilityDecider>

/** D→C REQ, `capability/decide`: a Decline clicked on a card, settled by compare-and-set on status and generation (§4.4.4). */
export const CapabilityDecideReq = z.object({
  agentId: z.string().uuid(),
  requestId: z.string().uuid(),
  generation: z.number().int().positive(),
  decision: z.literal('decline'),
  by: CapabilityDecider
})
export type CapabilityDecideReq = z.infer<typeof CapabilityDecideReq>

export const CapabilityDecideResult = z.object({
  result: z.enum(['settled', 'already_settled', 'not_found'])
})
export type CapabilityDecideResult = z.infer<typeof CapabilityDecideResult>

/** A settled request's outcome, as the card and the reminder show it. */
export const CapabilitySettledStatus = z.enum(['completed', 'declined', 'expired'])
export type CapabilitySettledStatus = z.infer<typeof CapabilitySettledStatus>

/** C→D REQ, `session/capability-settled`: one origin's wake, sent only by the CP's settling commit (§4.7.1). */
export const SessionCapabilitySettled = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  sessionKey: z.string().min(1).max(1000),
  requestId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: CapabilitySettledStatus,
  askers: CapabilityAskers,
  summary: z.string().max(500),
  reason: z.string().max(CAPABILITY_REASON_MAX),
  // CP-computed from what changed; empty for a decline or an expiry.
  outcome: z.string().max(500),
  // The saved change differs from what was asked (§4.6).
  differs: z.boolean().optional(),
  by: z.object({ name: z.string().max(200) }).optional(),
  note: z.string().max(CAPABILITY_NOTE_MAX).optional(),
  // Forget the runtime session before the reminder's turn (§4.8).
  reload: z.boolean()
})
export type SessionCapabilitySettled = z.infer<typeof SessionCapabilitySettled>

/** D→C REP: accepted once the reminder is durable; `not_found` marks the origin gone, anything else is retried (§4.7.3). */
export const SessionCapabilitySettledResult = z.object({
  accepted: z.boolean(),
  reason: z.enum(['not_found', 'busy', 'integration_offline', 'paused', 'not_ready', 'durability']).optional()
})
export type SessionCapabilitySettledResult = z.infer<typeof SessionCapabilitySettledResult>

/** C→D REQ → `ack`, `capability/reopened`: an editor reopened a declined request; the daemon rewrites its cards to the open form with the new generation (§4.5). */
export const CapabilityReopened = z.object({
  agentId: z.string().uuid(),
  requestId: z.string().uuid(),
  generation: z.number().int().positive(),
  summary: z.string().max(500),
  reason: z.string().max(CAPABILITY_REASON_MAX),
  link: z.string().url()
})
export type CapabilityReopened = z.infer<typeof CapabilityReopened>

/** C→D REQ, `capability/forward`: a viewer without authority forwards the request to someone who has it, through the agent's linked-DM path (§4.5). */
export const CapabilityForward = z.object({
  agentId: z.string().uuid(),
  requestId: z.string().uuid(),
  generation: z.number().int().positive(),
  // The console user to reach; the daemon finds their linked chat identity through `agent/approval-route`.
  consoleUserId: z.string().min(1).max(200),
  forwardedBy: z.string().max(200),
  summary: z.string().max(500),
  reason: z.string().max(CAPABILITY_REASON_MAX),
  link: z.string().url()
})
export type CapabilityForward = z.infer<typeof CapabilityForward>

/** D→C REP: `delivered` once the card is in their DM; otherwise the request stays where it is listed. */
export const CapabilityForwardResult = z.object({
  delivered: z.boolean(),
  reason: z.enum(['no_linked_identity', 'no_card_surface', 'not_found', 'failed']).optional()
})
export type CapabilityForwardResult = z.infer<typeof CapabilityForwardResult>

/** C→D EVT, `agent/mcp-rebound`: an MCP server's OAuth connected; the daemon reloads the agent's sessions that use it (§4.8 item 2). */
export const AgentMcpRebound = z.object({
  agentId: z.string().uuid(),
  server: z.string().min(1).max(200)
})
export type AgentMcpRebound = z.infer<typeof AgentMcpRebound>

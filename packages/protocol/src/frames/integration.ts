import { z } from 'zod'

/**
 * Platform integration distribution (C→D) — the Slack "install" flow.
 *
 * The Control Plane is the source of truth for platform integrations and pushes
 * them to the daemon that owns the integration's agent (`integration/upsert`, and
 * the reconcile snapshot `RegisterOk.integrations[]`). The daemon opens the Socket
 * Mode connection from the delivered config (see slack/connection.ts).
 *
 * SECURITY: `integration/upsert` and `RegisterOk.integrations[]` carry PLAINTEXT
 * platform tokens (botToken/appToken/appSecret). These payloads MUST NEVER be logged — no
 * body dump on decode error, no register/ok snapshot debug dump. The daemon
 * persists them into the owning agent's local `agent.json` (same trust boundary
 * as hand-authored agents, which already keep tokens there) so integrations
 * survive a restart with the CP down.
 *
 * `signingSecret` is intentionally absent: Socket Mode authenticates with the
 * app-level token, so the daemon never needs a signing secret.
 */

/** Trigger match — mirrors the daemon BindRuleConfig.match (agents/agent-schema.ts). */
export const BindMatch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mention') }),
  z.object({ kind: z.literal('dm') }),
  z.object({ kind: z.literal('keyword'), value: z.string() }),
  z.object({ kind: z.literal('auto') })
])
export type BindMatch = z.infer<typeof BindMatch>

/** One channel/thread trigger binding — mirrors the daemon BindRuleConfig. */
export const IntegrationBindRule = z.object({
  channel: z.string().optional(), // absent = any channel
  thread: z.string().optional(),
  match: BindMatch
})
export type IntegrationBindRule = z.infer<typeof IntegrationBindRule>

/**
 * The Slack config a daemon receives (no signingSecret). `mode` splits the two
 * distribution paths of shared-bot-relay.md §7.3:
 *
 *  - `direct` (today's behaviour, the default): the daemon owns the whole bot —
 *    it opens the Socket Mode connection itself (needs `appToken`) and arbitrates
 *    inbound locally (`bindRules`). Unchanged from before shared bots existed.
 *  - `shared`: the bot's INBOUND lives on a relay (§4.1), so the daemon gets
 *    xoxb ONLY — enough to SEND (`chat.postMessage`, attachment fetch). No
 *    `appToken` (credential domaining: the daemon must not be able to subscribe
 *    the event stream) and no `bindRules` (routing is arbitrated in the relay,
 *    delivered pre-addressed). `botUserId` is optional and lazily resolved by the
 *    daemon via `auth.test` (same as direct) if the sender ever needs it.
 *
 * Modeled as a flat object with a defaulted discriminator (not a
 * `discriminatedUnion`) so specs persisted before this field existed still decode
 * as `direct`. `.superRefine` enforces the one hard per-mode requirement the union
 * would otherwise give: direct needs the app-level token.
 */
export const IntegrationSlackConfig = z
  .object({
    mode: z.enum(['direct', 'shared']).default('direct'),
    botToken: z.string(), // xoxb-…  (plaintext — never log) — always present (send path)
    appToken: z.string().optional(), // xapp-… (plaintext — never log) — direct only (Socket Mode)
    appId: z.string().optional(), // A… public metadata — permission-update deep link (especially shared mode)
    // Multi-agent opt-in — the bot backs MANY agents, so an in-thread "Switch agent"
    // control is meaningful. ONLY ever true in `shared` mode (an http/relay bot); a
    // non-shareable http bot is still `shared` for routing but has one agent, so the
    // switch control is suppressed. Defaults false so pre-field specs (and every direct
    // bot) decode as non-shareable.
    shareable: z.boolean().default(false),
    botUserId: z.string().optional(), // lazily resolved via auth.test; may be seeded by CP
    bindRules: z.array(IntegrationBindRule).default([]), // empty for shared (relay arbitrates)
    // Channels the operator switched OFF. bindRules can only ADD reach, so an
    // ungated integration — whose defaults are unscoped (@-mention anywhere + DMs) —
    // has no way to say "not here" without a subtractive fence. A muted channel
    // matches no rule of this integration at all: no mention, no thread continuity,
    // no control command. Channels only (a DM is never muted this way); a GATED
    // integration leaves this empty, since its Off is already the ABSENCE of a
    // conversation-scoped rule. Defaults empty (pre-field specs).
    mutedChannels: z.array(z.string()).default([]),
    // Conversation gating (resource-visibility.md §14): true ⇒ this integration is
    // fail-closed — the CP ships only conversation-scoped bindRules (no unscoped
    // defaults), and the daemon answers explicitly-addressed unrouted messages with
    // a one-time notice + reports DM conversations. Derived from the owning agent's
    // restricted visibility; carries NO identities. Defaults false (pre-field specs).
    gated: z.boolean().default(false)
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'direct' && !c.appToken)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'direct slack requires appToken', path: ['appToken'] })
  })
export type IntegrationSlackConfig = z.infer<typeof IntegrationSlackConfig>

/**
 * The Telegram config the daemon needs to open long-polling + route (grammY).
 * Telegram has a SINGLE BotFather HTTP token — no app-level token and no signing
 * secret (long-polling authenticates every getUpdates call with the bot token).
 */
export const IntegrationTelegramConfig = z.object({
  botToken: z.string(), // BotFather "123456:ABC…"  (plaintext — never log)
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(z.string()).default([]), // Off channels — see IntegrationSlackConfig.mutedChannels
  gated: z.boolean().default(false) // conversation gating — see IntegrationSlackConfig.gated
})
export type IntegrationTelegramConfig = z.infer<typeof IntegrationTelegramConfig>

/**
 * The Discord config the daemon needs to open the Gateway + route (discord.js).
 * Discord authenticates the Gateway with a SINGLE bot token — no Slack-style
 * app-level token and no signing secret. `applicationId` is public metadata (the
 * client id for the OAuth2 bot-invite URL); it is not secret material.
 */
export const IntegrationDiscordConfig = z.object({
  botToken: z.string(), // Bot <token>  (plaintext — never log)
  applicationId: z.string().optional(), // client/application id — public, for the invite URL
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(z.string()).default([]), // Off channels — see IntegrationSlackConfig.mutedChannels
  gated: z.boolean().default(false) // conversation gating — see IntegrationSlackConfig.gated
})
export type IntegrationDiscordConfig = z.infer<typeof IntegrationDiscordConfig>

/**
 * The Feishu / Lark config the daemon needs to open the long-connection WebSocket
 * (`@larksuiteoapi/node-sdk` `WSClient`) + route. A Feishu self-built app
 * authenticates with an `appId` + `appSecret` PAIR — the SDK exchanges them for a
 * short-lived `tenant_access_token` internally (no Slack-style app-level token, no
 * signing secret). `appId` is a semi-public identifier (`cli_…`); `appSecret` is
 * plaintext secret material — NEVER log it. `botOpenId` is the bot's own open_id
 * for @-mention routing; lazily resolved by the daemon via `bot/info` if absent.
 *
 * `region` selects the open-platform gateway the daemon SDK (and CP verifier)
 * talk to — `'feishu'` = mainland China (`open.feishu.cn`, the SDK default) vs
 * `'lark'` = international (`open.larksuite.com`). Same app model, different host;
 * an app is registered in exactly one region. Defaults to `'feishu'` so existing
 * installs are unaffected.
 */
export const FeishuRegion = z.enum(['feishu', 'lark'])
export type FeishuRegion = z.infer<typeof FeishuRegion>

export const IntegrationFeishuConfig = z.object({
  // `direct` opens the SDK long connection on the daemon. `shared` keeps only
  // the authenticated REST client on the daemon; HTTP callbacks arrive through
  // the relay and are delivered pre-addressed over rd/*.
  mode: z.enum(['direct', 'shared']).default('direct'),
  appId: z.string(), // cli_… — app identifier (semi-public), needed for REST and direct WS
  appSecret: z.string(), // app secret (plaintext — never log)
  botOpenId: z.string().optional(), // bot's own open_id; lazily resolved via bot/info
  region: FeishuRegion.default('feishu'), // open-platform gateway: feishu.cn vs larksuite.com
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(z.string()).default([]), // Off channels — see IntegrationSlackConfig.mutedChannels
  gated: z.boolean().default(false) // conversation gating — see IntegrationSlackConfig.gated
})
export type IntegrationFeishuConfig = z.infer<typeof IntegrationFeishuConfig>

/**
 * §6.4 core routing ENVELOPE (integration-plugin-architecture.md D4): the knobs CORE
 * reads — routing, gating, ingress mode — platform-independent. Dual-shape window:
 * the CP emits this ALONGSIDE the legacy nested per-platform block (below) and the
 * daemon prefers it; once the fleet reads the envelope, legacy emission drops and
 * `config` becomes the only platform payload (validated by the platform module, S2).
 */
export const IntegrationCoreEnvelope = z.object({
  mode: z.enum(['direct', 'shared']).default('direct'),
  bindRules: z.array(IntegrationBindRule).default([]),
  mutedChannels: z.array(z.string()).default([]),
  gated: z.boolean().default(false)
})
export type IntegrationCoreEnvelope = z.infer<typeof IntegrationCoreEnvelope>

/**
 * One platform integration, owned by exactly one agent. Also the element type of
 * `RegisterOk.integrations[]` (the per-daemon reconcile set). Discriminated on
 * `platform`: the daemon opens a Slack Socket Mode connection, a Telegram
 * long-poll, a Discord Gateway, or a Feishu long-connection from whichever variant
 * is delivered.
 *
 * ENVELOPE-ONLY (§6.4, legacy RETIRED): each variant is `core` (routing knobs)
 * + opaque `config`, validated by the consuming platform module against its own
 * per-platform schema. The legacy nested block (`slack` / `telegram` /
 * `discord` / `feishu`) retired one release after CP emission stopped; a frame
 * from an older CP still parses (non-strict objects strip the stale key) and
 * reads through `config`, which that CP dual-emitted since §6.4 landed. A
 * variant carrying no usable `config` is rejected by the reader, not the schema
 * (tolerant-reader rule). Collapsing the union to one flat `platformId` object
 * is an S3 protocol cleanup — it changes the TYPE for every consumer.
 */
export const IntegrationSpec = z.discriminatedUnion('platform', [
  z.object({
    integrationId: z.string().uuid(),
    agentId: z.string().uuid(),
    platform: z.literal('slack'),
    core: IntegrationCoreEnvelope.optional(),
    config: z.unknown().optional()
  }),
  z.object({
    integrationId: z.string().uuid(),
    agentId: z.string().uuid(),
    platform: z.literal('telegram'),
    core: IntegrationCoreEnvelope.optional(),
    config: z.unknown().optional()
  }),
  z.object({
    integrationId: z.string().uuid(),
    agentId: z.string().uuid(),
    platform: z.literal('discord'),
    core: IntegrationCoreEnvelope.optional(),
    config: z.unknown().optional()
  }),
  z.object({
    integrationId: z.string().uuid(),
    agentId: z.string().uuid(),
    platform: z.literal('feishu'),
    core: IntegrationCoreEnvelope.optional(),
    config: z.unknown().optional()
  })
])
export type IntegrationSpec = z.infer<typeof IntegrationSpec>

/** C→D EVT — install/update an integration on the owning agent's daemon. */
export const IntegrationUpsert = IntegrationSpec
export type IntegrationUpsert = z.infer<typeof IntegrationUpsert>

/** C→D EVT — remove an integration from the daemon. */
export const IntegrationRemove = z.object({
  integrationId: z.string().uuid()
})
export type IntegrationRemove = z.infer<typeof IntegrationRemove>

/**
 * One conversation the bot participates in (metadata only — no messages).
 * `kind` distinguishes member channels from direct conversations (resource-
 * visibility.md §14.3): absent = 'channel' for wire compatibility. DM rows
 * (`kind: 'im'`, Slack "D…" ids) are reported for every integration on first
 * inbound DM; their `name` is the counterpart's display name. Group DMs
 * (`kind: 'mpim'`, Slack multi-person DMs) are reported on observation the same
 * way — never enumerated, because Slack does not list them as bot membership —
 * but they behave like a channel: several humans share the room, so the agent
 * stays mention-gated there rather than answering every message.
 *
 * `spaceId`/`space` identify the container the conversation lives in — a Discord
 * GUILD, which a bot in several servers needs for the channel to be identifiable at
 * all (every server has a "#general"). The ID is the identity: two distinct guilds
 * may carry the SAME name, so grouping on the name alone would merge them and hide
 * the ambiguity it was meant to resolve. `space` is the display label only. Both are
 * absent on platforms with one implicit container per bot (Slack workspace, Telegram,
 * Feishu tenant) and on DM rows.
 */
export const IntegrationChannel = z.object({
  id: z.string(), // platform conversation id (Slack "C…" / DM "D…")
  name: z.string().optional(), // "#deploys" without the hash (or DM counterpart); absent if lookup failed
  spaceId: z.string().optional(), // enclosing Discord guild snowflake — the space's IDENTITY
  space: z.string().optional(), // that guild's display name; absent until resolved
  isPrivate: z.boolean().optional(),
  kind: z.enum(['channel', 'im', 'mpim']).optional() // absent = 'channel'
})
export type IntegrationChannel = z.infer<typeof IntegrationChannel>

/**
 * D→C EVT — channels observed by an integration's bot (fire-and-forget,
 * latest-wins). Slack reports an authoritative membership snapshot; platforms
 * such as Telegram that cannot enumerate every chat set `authoritative:false`,
 * so the CP upserts what was observed without deleting older rows that are
 * absent from this report. An absent flag means authoritative for wire
 * compatibility. Channel names are control metadata, never message content.
 *
 * `removed` is how a NON-enumerating platform retracts one conversation. Absence
 * from `channels` cannot mean "gone" there — the reported set is incomplete by
 * construction, so a non-authoritative report never deletes — which left a bot
 * that had actually left a group visible in the console forever. Naming the
 * conversation explicitly is the only way to say it. An authoritative reporter
 * needs none of this (its omissions already delete) but may still send it, and
 * a removal is applied even for a conversation absent from `channels`.
 */
export const IntegrationChannels = z.object({
  integrationId: z.string().uuid(),
  channels: z.array(IntegrationChannel),
  authoritative: z.boolean().optional(),
  // Optional rather than defaulted: nearly every report has nothing to retract, and
  // an absent field reads the same as an empty one to the CP.
  removed: z.array(z.string()).optional()
})
export type IntegrationChannels = z.infer<typeof IntegrationChannels>

/**
 * What a leave targets. Platforms disagree about what a bot can withdraw from, and
 * the difference is not cosmetic — so the caller has to say which it means rather
 * than the daemon guessing from an id:
 *
 *  - `conversation` — one channel/group the bot is a member of (Slack
 *    `conversations.leave`, Telegram `leaveChat`).
 *  - `space` — the whole container. Discord has no per-channel membership for a
 *    bot at all: it is in a GUILD and sees that guild's channels through
 *    permissions, so the only thing it can leave is the entire server. That is a
 *    much larger action than leaving one channel and must be requested as such.
 */
export const IntegrationLeaveTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), channel: z.string().min(1) }),
  z.object({ kind: z.literal('space'), spaceId: z.string().min(1) })
])
export type IntegrationLeaveTarget = z.infer<typeof IntegrationLeaveTarget>

/**
 * C→D REQ → `integration/leave/ok` — withdraw the bot from a conversation or space
 * at the PLATFORM. Unlike every other channel control this leaves AgentConnect's own
 * state alone and changes the outside world, so it is a request with a reply: the
 * console reports what the platform actually said rather than assuming.
 *
 * The daemon owns provider egress for both transports (a relay-managed bot still
 * holds send credentials), so this is a daemon call in every topology.
 */
export const IntegrationLeave = z.object({
  integrationId: z.string().uuid(),
  target: IntegrationLeaveTarget
})
export type IntegrationLeave = z.infer<typeof IntegrationLeave>

/**
 * C→D REQ → `ack` — stop REPORTING these conversations; the platform is not touched.
 *
 * The console's Forget needs this for the same reason a leave does. A non-enumerating
 * platform's observed set is rebuilt from session history, so deleting the row in the
 * CP alone lasts only until the daemon's next refresh pushes it back. The daemon holds
 * the suppression durably and lifts it when the conversation talks to it again.
 *
 * Acknowledged rather than fire-and-forget: the suppression is what makes the removal
 * stick, so a daemon that never received it WILL list the conversation again. Reporting
 * that as success would be a lie the operator only discovers later.
 */
export const IntegrationForget = z.object({
  integrationId: z.string().uuid(),
  channels: z.array(z.string()).min(1)
})
export type IntegrationForget = z.infer<typeof IntegrationForget>

/**
 * D→C REP (corr = `integration/leave` id). `ok:false` carries the platform's own
 * refusal so the console can show it verbatim — "last_member", a missing scope, a
 * bot that lacks the right — instead of a generic failure. The daemon reconciles
 * the channel set separately over `integration/channels`; this reply is only the
 * verdict on the platform call.
 */
export const IntegrationLeaveOk = z.object({
  ok: z.boolean(),
  error: z.string().optional()
})
export type IntegrationLeaveOk = z.infer<typeof IntegrationLeaveOk>

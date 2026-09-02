import { z } from 'zod'
import { Platform } from './route.js'

/**
 * Platform integration distribution (C→D) — the Slack "install" flow.
 *
 * The Control Plane is the source of truth for platform integrations and pushes
 * them to the daemon that owns the integration's agent (`integration/upsert`, and
 * the reconcile snapshot `RegisterOk.integrations[]`). The daemon opens the Socket
 * Mode connection from the delivered config (see slack/connection.ts).
 *
 * SECURITY: `integration/upsert` and `RegisterOk.integrations[]` carry PLAINTEXT
 * platform tokens (botToken/appToken/appSecret). These payloads MUST NEVER be
 * logged — no body dump on decode error, no register/ok snapshot debug dump.
 * CP-owned integrations live only in daemon MEMORY and are re-converged on
 * reconnect; hand-authored agents keep tokens in their own `agent.json` (the
 * same trust boundary as the daemon process).
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
 * The Slack config payload (no signingSecret). Platform-PRIVATE material only
 * (§6.4): the ingress mode and the routing knobs (`bindRules`/`mutedChannels`/
 * `gated`) live in the CORE ENVELOPE — this block never duplicates them. What
 * the envelope's `mode` means for Slack (shared-bot-relay.md §7.3):
 *
 *  - `direct`: the daemon owns the whole bot — it opens the Socket Mode
 *    connection itself, so the payload carries `appToken`.
 *  - `shared`: the bot's INBOUND lives on a relay (§4.1), so the daemon gets
 *    xoxb ONLY — enough to SEND (`chat.postMessage`, attachment fetch). No
 *    `appToken` (credential domaining: the daemon must not be able to subscribe
 *    the event stream). `botUserId` is optional and lazily resolved by the
 *    daemon via `auth.test` (same as direct) if the sender ever needs it.
 *
 * The direct-mode `appToken` requirement is a cross-field rule with the
 * envelope's `mode`, so the daemon enforces it at its wire ingest, where both
 * are in view (`cp/cp-integration-registry.ts` `toIntegration`) — §6.4 puts
 * per-platform payload validation at the consuming edge.
 */
export const IntegrationSlackConfig = z.object({
  botToken: z.string(), // xoxb-…  (plaintext — never log) — always present (send path)
  appToken: z.string().optional(), // xapp-… (plaintext — never log) — direct only (Socket Mode)
  appId: z.string().optional(), // A… public metadata — permission-update deep link (especially shared mode)
  // Multi-agent opt-in — the bot backs MANY agents, so an in-thread "Switch agent"
  // control is meaningful. ONLY ever true in `shared` mode (an http/relay bot); a
  // non-shareable http bot is still `shared` for routing but has one agent, so the
  // switch control is suppressed. Defaults false (every direct bot decodes as
  // non-shareable).
  shareable: z.boolean().default(false),
  botUserId: z.string().optional() // lazily resolved via auth.test; may be seeded by CP
})
export type IntegrationSlackConfig = z.infer<typeof IntegrationSlackConfig>

/**
 * The Telegram config payload — long-polling + routing (grammY). Telegram has a
 * SINGLE BotFather HTTP token — no app-level token and no signing secret
 * (long-polling authenticates every getUpdates call with the bot token).
 */
export const IntegrationTelegramConfig = z.object({
  botToken: z.string() // BotFather "123456:ABC…"  (plaintext — never log)
})
export type IntegrationTelegramConfig = z.infer<typeof IntegrationTelegramConfig>

/**
 * The Discord config payload — the Gateway connection (discord.js). Discord
 * authenticates the Gateway with a SINGLE bot token — no Slack-style app-level
 * token and no signing secret. `applicationId` is public metadata (the client
 * id for the OAuth2 bot-invite URL); it is not secret material.
 */
export const IntegrationDiscordConfig = z.object({
  botToken: z.string(), // Bot <token>  (plaintext — never log)
  applicationId: z.string().optional() // client/application id — public, for the invite URL
})
export type IntegrationDiscordConfig = z.infer<typeof IntegrationDiscordConfig>

/**
 * The Feishu / Lark config payload — the long-connection WebSocket
 * (`@larksuiteoapi/node-sdk` `WSClient`) + REST client. A Feishu self-built app
 * authenticates with an `appId` + `appSecret` PAIR — the SDK exchanges them for a
 * short-lived `tenant_access_token` internally (no Slack-style app-level token, no
 * signing secret). `appId` is a semi-public identifier (`cli_…`); `appSecret` is
 * plaintext secret material — NEVER log it. `botOpenId` is the bot's own open_id
 * for @-mention routing; lazily resolved by the daemon via `bot/info` if absent.
 *
 * The envelope's `mode` decides the transport: `direct` opens the SDK long
 * connection on the daemon; `shared` keeps only the authenticated REST client
 * (callbacks arrive through the relay, pre-addressed over rd/*).
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
  appId: z.string(), // cli_… — app identifier (semi-public), needed for REST and direct WS
  appSecret: z.string(), // app secret (plaintext — never log)
  botOpenId: z.string().optional(), // bot's own open_id; lazily resolved via bot/info
  region: FeishuRegion.default('feishu') // open-platform gateway: feishu.cn vs larksuite.com
})
export type IntegrationFeishuConfig = z.infer<typeof IntegrationFeishuConfig>

// The Linear config payload (linear-integration.md §7.2) — the one platform whose spec carries a
// SHORT-LIVED credential rather than a durable bot token. Ingress is relay-terminated, so the daemon
// gets egress material only: a ≤24 h access token snapshot, refreshed on demand over `linearcred`
// (§7.3) while the CP alone holds the client secret and the rotating refresh token.
// `accessToken` is plaintext secret material — NEVER log it. `workspaceId` is the Linear organization
// id; `appUserId` is the app's own Linear user id, used by the daemon as its self-echo guard.
export const IntegrationLinearConfig = z.object({
  workspaceId: z.string(), // Linear organization id (the connected workspace's identity)
  workspaceName: z.string().optional(), // display label only
  appUserId: z.string().optional(), // the app's Linear user id — self-echo guard
  accessToken: z.string(), // ≤24 h snapshot (plaintext — never log); refreshed via linearcred/request
  accessTokenExpiresAt: z.string().datetime() // ISO expiry of the snapshot above
})
export type IntegrationLinearConfig = z.infer<typeof IntegrationLinearConfig>

/**
 * §6.3 core routing ENVELOPE (integration-plugin-architecture.md D4): the knobs CORE
 * reads — routing, gating, ingress mode — platform-independent. This is the ONLY
 * carrier of these knobs on the wire: the opaque per-platform `config` payload
 * never duplicates them (the daemon reads routing exclusively from here).
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
 * `RegisterOk.integrations[]` (the per-daemon reconcile set) and of
 * `AgentActivate.integrations[]` (the move bundle).
 *
 * §6.4 FINAL SHAPE (S3): one flat object — identity + an OPEN `platform` id +
 * the core envelope + an opaque per-platform `config`. Core never interprets
 * `config`; the consuming platform module validates it against its own schema,
 * resolved through the platform registry on the daemon
 * (`platforms/integration-config.ts`), and the CP's platform provider is the
 * only producer (`projectIntegrationConfig`, §9). The closed four-literal
 * discriminated union this replaces — and the per-variant duplication of the
 * routing knobs inside each config block — was the S1b dual-shape window;
 * pre-release, every deployment cut over in one release, so the legacy shape
 * has no readers or writers left.
 *
 *  - `platform` stays the field name (not §6.4's sketch spelling `platformId`):
 *    every platform-bearing frame on this wire (`SessionKey`, `rc/bot-assign`,
 *    `event/session`, …) spells it `platform`, typed by the open
 *    `Platform = z.string()` (S1a).
 *  - `core` is REQUIRED. Its absence was the dual-shape tolerance; defaulting
 *    it now would silently mint a rule-less integration out of a stale writer,
 *    so a core-less spec fails the frame instead (fail-closed and visible).
 *  - a spec whose `config` is absent or fails the platform module's schema is
 *    rejected by the READER (skip + warn), not the frame schema — one bad spec
 *    must not kill the register/ok snapshot it rides in.
 */
export const IntegrationSpec = z.object({
  orgId: z.string().min(1).max(64).optional(),
  integrationId: z.string().uuid(),
  agentId: z.string().uuid(),
  platform: Platform,
  core: IntegrationCoreEnvelope,
  config: z.unknown().optional()
})
export type IntegrationSpec = z.infer<typeof IntegrationSpec>

/** C→D EVT — install/update an integration on the owning agent's daemon. */
export const IntegrationUpsert = IntegrationSpec
export type IntegrationUpsert = z.infer<typeof IntegrationUpsert>

/** C→D EVT — remove an integration from the daemon. */
export const IntegrationRemove = z.object({
  integrationId: z.string().uuid()
})
export type IntegrationRemove = z.infer<typeof IntegrationRemove>

/** Cap on a conversation's icon — a name or one emoji, never a payload. */
const CHANNEL_ICON_MAX = 64

/** A conversation's color as the row stores it: `#rrggbb`, tolerating a missing hash. */
const CHANNEL_COLOR = /^#?[0-9a-fA-F]{6}$/

/**
 * A conversation's glyph pair narrowed to what {@link IntegrationChannel} accepts. Every writer
 * of the row — the daemon's platform reads, the CP's own provider queries — narrows THROUGH this
 * rather than restating the bounds, so a value the schema would refuse is dropped at the source:
 * one oddly spelled conversation costs its own glyph and never the report it rides in.
 */
export function conversationGlyph(icon: unknown, color: unknown): { icon?: string; color?: string } {
  const i = typeof icon === 'string' ? icon.trim() : ''
  const c = typeof color === 'string' ? color.trim() : ''
  return {
    ...(i && i.length <= CHANNEL_ICON_MAX ? { icon: i } : {}),
    ...(c && CHANNEL_COLOR.test(c) ? { color: c } : {})
  }
}

/** Cap on a conversation's platform key — a short handle such as a Linear team's `ENG`. */
const CHANNEL_KEY_MAX = 32

/** Cap on a conversation's own link — a permalink the console opens, never a payload. */
const CHANNEL_URL_MAX = 512

/** Only an `https` origin is a link here: the console opens it in a new tab. */
const CHANNEL_URL = /^https:\/\/\S+$/

/**
 * A conversation's platform handle and permalink narrowed to what {@link IntegrationChannel}
 * accepts — {@link conversationGlyph}'s sibling, and narrowed at the source for the same reason:
 * one oddly spelled conversation costs its own field and never the report it rides in.
 */
export function conversationLink(key: unknown, url: unknown): { key?: string; url?: string } {
  const k = typeof key === 'string' ? key.trim() : ''
  const u = typeof url === 'string' ? url.trim() : ''
  return {
    ...(k && k.length <= CHANNEL_KEY_MAX ? { key: k } : {}),
    ...(u && u.length <= CHANNEL_URL_MAX && CHANNEL_URL.test(u) ? { url: u } : {})
  }
}

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
 *
 * `icon`/`color` are the conversation's own display glyph and tint where the platform
 * has one — a Linear team. Absent everywhere else, and never load-bearing: a row without
 * them renders exactly as it did before they existed. `key`/`url` are the same class of
 * display metadata: the conversation's short platform handle and the page it opens on the
 * platform, carried as their own fields so no reader ever parses them back out of `name`.
 */
export const IntegrationChannel = z.object({
  id: z.string(), // platform conversation id (Slack "C…" / DM "D…")
  name: z.string().optional(), // "#deploys" without the hash (or DM counterpart); absent if lookup failed
  spaceId: z.string().optional(), // enclosing Discord guild snowflake — the space's IDENTITY
  space: z.string().optional(), // that guild's display name; absent until resolved
  isPrivate: z.boolean().optional(),
  kind: z.enum(['channel', 'im', 'mpim']).optional(), // absent = 'channel'
  // The conversation's own glyph and tint, where the platform gives one — a Linear team's
  // `icon` (a provider icon name such as "Feather", or an emoji) and `color` (a hex string).
  // Display only: bounded so a hostile provider cannot grow a row, and never parsed for routing.
  icon: z.string().max(CHANNEL_ICON_MAX).optional(),
  color: z.string().regex(CHANNEL_COLOR).optional(),
  // The conversation's short platform handle (a Linear team's `ENG`) and the page it opens
  // on the platform. Display only, bounded the same way, and never a coordinate: `id` is.
  key: z.string().max(CHANNEL_KEY_MAX).optional(),
  url: z.string().max(CHANNEL_URL_MAX).regex(CHANNEL_URL).optional(),
  // The 1:1 DM counterpart's platform member id (§14.8) — control metadata of the same
  // class as `name`, and the only thing that identifies WHO a private agent's DM row is
  // with. Absent on channels and group DMs, whose membership is a room, not a person.
  dmUserId: z.string().optional()
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

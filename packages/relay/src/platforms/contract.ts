/**
 * The relay's **two-sided platform-ingress contract** (design §8, stage S3) —
 * published FIRST, with every implementation still in place. This is the same
 * sequencing that carried the daemon through S2 (its `platforms/contract.ts`,
 * #525): moving a body while ALSO changing what it can reach is how a file move
 * turns into a silent contract redesign (§16), so the seam lands as types, and
 * the Slack / Feishu ingests move against it in their own PRs.
 *
 * WHY "TWO-SIDED". The design's first cut — `{ verify, toDelivery }` — was
 * verified against both real ingests and found insufficient (§8): a platform
 * owns BOTH edges of the HTTP exchange. Inbound, demux is stateful and
 * per-platform (Slack signature-scans the assigned registry with a learned
 * `(api_app_id, team_id)` index; Feishu demuxes on body app id with optional
 * AES decrypt). Outbound, two platforms require SYNCHRONOUS bodies on the HTTP
 * 200 (Slack `block_suggestion` options; Feishu's card-action toast), so the
 * response side cannot be a fixed pipeline step either.
 *
 * THE INSTANCE MODEL (audited reality, refining the §8 sketch): a plugin is
 * per-PLATFORM and stateless; what it builds is a per-BOT ingest instance
 * holding that bot's credentials and event handling. Core keeps ONE pool of
 * instances per platform (the S2 registry precedent) instead of today's two
 * platform-named maps, and every lifecycle edge (assign → build, rotate →
 * rebuild, unassign/revoke → stop) goes through the plugin.
 *
 * DEMUX IS DECLARED, NOT CODED, where it can be (§5 `identityScope`):
 *
 *  - `'tenant'` — every install of a distributed app shares one app id AND one
 *    signing secret, so the composite `(appId, tenantId)` index is the ONLY
 *    safe demux; a signature-scan hit against a sibling install would leak one
 *    workspace's messages into another tenant's bot. Assign-derived, never
 *    learned, eagerly cleaned on unassign.
 *  - `'app'` — the app id alone identifies the bot. May be LEARNED from the
 *    first verified delivery when the CP didn't stamp it (bounded, lazily
 *    evicted).
 *
 * What cannot be declared stays in the plugin: the VERIFY step itself (Slack
 * HMAC over the raw body; Feishu token check / AES decrypt) and the fallback
 * scan order. Core owns the index STORAGE and the route's outer hard cap; the
 * plugin owns everything platform-shaped, including its response deadline
 * (Feishu's ~2.5s toast, Slack's 3s trigger) — it races the daemon round trip
 * against the platform's window using the host clock and degrades to an
 * ack-only body on timeout.
 *
 * WHAT STAYS IN CORE (§12): bot arbitration, the 3-leg thread-affinity dance,
 * pending report queues (thread-assign / channels / revocation), fencing
 * (`credentialRevision`), and event-identity dedup STORAGE — the plugin mints
 * the dedup id (it derives from parsed action semantics); core owns the table.
 */
import type { RcBotChannels, RcThreadAssign, RdAck, RdMsg } from '@agentconnect.md/protocol'
import type { BotAssignment, RouteTarget } from '../bot-arbitration.js'

/** Demux hints a plugin extracts from one raw inbound callback BEFORE
 *  verification — the only pre-verify parse core performs on a plugin's behalf.
 *  Both fields are the PLATFORM'S vocabulary mapped onto §5's identity axes
 *  (Slack: `api_app_id` / `team_id`; Feishu: body `app_id`, tenantless). */
export interface DemuxHints {
  appId?: string
  tenantId?: string
}

/** One bot's live ingress instance: the object a plugin builds per assignment,
 *  holding that bot's credentials and event decoding. Core never reads its
 *  internals — it starts it, stops it, and hands it inbound deliveries through
 *  the plugin that built it. */
export interface RelayBotIngress {
  /** Open long-lived resources (Slack resolves its bot user id lazily; a pure
   *  HTTP decoder has nothing to open). Absent ⇒ nothing to start. */
  start?(): Promise<void>
  /** Release everything. Idempotent — assign rebuilds call it first. */
  stop(): Promise<void> | void
}

/**
 * Host services a plugin's ingest may call back into — relay core's side of the
 * contract. This is the capability set the two existing ingests actually
 * consume today (audited), deliberately narrow and platform-free: forwarding is
 * PRE-ADDRESSED (the plugin resolved its bot; arbitration resolves the agent),
 * and every report rides core's pending queues + fencing.
 */
export interface RelayIngressHost {
  /** Forward one normalized inbound message through bot arbitration to the
   *  owning daemon. */
  forward(botId: string, message: RdMsg): void
  /** Forward one platform interaction as a §6.6 platform_action and return the
   *  daemon's ack — the sync-response race (see the module doc) awaits this. */
  forwardAction(msg: RdMsg): Promise<RdAck>
  /** Report the bot's channel-membership snapshot (queued while the CP link is
   *  down; a newer snapshot supersedes). */
  reportChannels(snapshot: RcBotChannels): void
  /** Report a platform-side revocation, echoing the assignment's credential
   *  generation so the CP's fence can refuse a stale report. */
  reportRevoked(reason: string, eventAtMs?: number): void
  /** Durable thread affinity (the 3-leg dance's first leg stays core). */
  reportThreadAssign(report: RcThreadAssign): void
  /** Arbitration reads — never the router object itself. */
  directory: {
    agents(botId: string): { agentId: string; name: string }[]
    channelOwner(botId: string, channelId: string): string | undefined
    targetForAgentId(botId: string, agentId: string): RouteTarget | undefined
  }
  /** Persist + broadcast an explicit channel-owner change (Switch agent). */
  setChannelAgent(botId: string, channelId: string, agentId: string): void
  clock: { now(): number }
  log: { info(m: string): void; warn(m: string): void; debug(m: string): void }
}

/**
 * One platform's relay ingress plugin — stateless, per-platform, registered
 * once. Adding a platform registers one of these; no manager fork grows.
 */
export interface RelayPlatformIngressPlugin<TIngest extends RelayBotIngress = RelayBotIngress> {
  /** Platform id (§6.1 vocabulary). Never parsed. */
  readonly platformId: string
  /** §5 identity axes: how one bot is identified for inbound demux — whether
   *  the app-only index may be LEARNED from verified traffic (`'app'`) or the
   *  composite index is the only safe demux (`'tenant'`). */
  readonly identityScope: 'app' | 'tenant'
  /**
   * Validate the assignment's secrets / ingress identity and build the bot's
   * ingest instance. `undefined` = incomplete assignment (log-and-skip; the CP
   * re-sends) — the shape check is the PLUGIN's, because §9 moves projection
   * into the CP provider and validation of the opaque payload lives with the
   * same platform's modules on every host.
   */
  buildIngest(assignment: BotAssignment, host: RelayIngressHost): TIngest | undefined
  /** Pre-verify demux hints from one raw callback (see {@link DemuxHints}). */
  extractDemuxHints(rawBody: Buffer, body: unknown, headers: Record<string, string | string[] | undefined>): DemuxHints
  /**
   * Authenticate one inbound delivery against a candidate ingest. Core drives
   * the lookup ladder (declared-index fast paths, then the bounded scan the
   * platform's identityScope permits) and calls this per candidate; the plugin
   * owns the cryptography (HMAC window, AES decrypt, token compare).
   */
  verify(
    ingest: TIngest,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): boolean
}

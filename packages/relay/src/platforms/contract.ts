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
import type { FastifyInstance } from 'fastify'
import type { RcBotChannels, RdAck, RdMsgPlatformAction, WireNormalizedMessage } from '@agentconnect.md/protocol'
import type { BotAssignment, RouteTarget } from '../bot-arbitration.js'
import type { Logger } from '../log.js'

/** Demux hints a plugin extracts from one raw inbound callback BEFORE
 *  verification — the only pre-verify parse core performs on a plugin's behalf.
 *  Both fields are the PLATFORM'S vocabulary mapped onto §5's identity axes
 *  (Slack: `api_app_id` / `team_id`; Feishu: body `app_id`, tenantless).
 *
 *  The identity SCOPE is per-ASSIGNMENT, not per-platform: one Slack bot may be
 *  tenant-scoped (a distributed app's install carries a tenant id — composite
 *  index only, assign-derived, never learned) while a legacy sibling is
 *  app-only (learnable from the first verified delivery). Core derives the
 *  scope from the assignment's ingress identity; a plugin never declares a
 *  blanket rule that would misfile the other shape. */
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
  /**
   * Release everything. Idempotent — assign rebuilds call it first.
   *
   * REQUIRED, not optional, and that is the point: teardown iterates the
   * registry and cannot know which platforms have resources to release, so
   * "nothing to stop, only to drop" is THIS method's business — a pure decoder
   * implements it as a no-op. Core naming the platforms that need stopping is
   * how a third platform's ingest came to leak (audit F2).
   */
  stop(): Promise<void> | void
  /**
   * OPTIONAL relay-side egress/read facet (§8: "Slack performs relay-side
   * egress …; Feishu deliberately keeps egress on the daemon. Optional by
   * design."). Core consults it AFTER arbitration for the two §14 gating
   * flows: the one-time "explicitly addressed but routed nowhere" notice, and
   * labeling a discovered DM row with its counterpart's name. A platform
   * without the facet silently skips both — the pre-seam behavior of every
   * non-Slack platform, which the audit recorded as a structural fork
   * ("which map the bot lives in" acting as the platform test).
   */
  egress?: {
    /** Post one plain-text notice into a conversation (never recorded). */
    notice(channelId: string, text: string, threadTs?: string): Promise<void>
    /** Resolve a platform user id to a display name (DM-row labeling). */
    lookupUserName(userId: string): Promise<string | undefined>
  }
}

/**
 * Host services a plugin's ingest may call back into — relay core's side of the
 * contract. This is the capability set the two existing ingests actually
 * consume today (audited), deliberately narrow and platform-free: forwarding is
 * PRE-ADDRESSED (the plugin resolved its bot; arbitration resolves the agent),
 * and every report rides core's pending queues + fencing.
 */
/**
 * Per-message values a plugin forwards BESIDE the normalized payload, never inside it.
 *
 * The one member today is Slack's ephemeral search credential. It travels outside `payload`
 * for the reason §8.2 keeps the relay's `trusted*` assertions outside it, plus a stronger
 * one: the owning daemon persists the payload to its durable inbox and replays it after a
 * restart, and a credential must not be written there.
 */
export interface RelayIngressSidecar {
  searchActionToken?: string
}

export interface RelayIngressHost {
  /** Forward one NORMALIZED inbound message. Core owns arbitration: it resolves
   *  the owning agent/daemon and constructs the pre-addressed `rd/msg` — the
   *  plugin supplies conversation content, never target identity. The promise
   *  is the delivery attempt's completion (drop counting rides it). */
  forward(botId: string, message: WireNormalizedMessage, sidecar?: RelayIngressSidecar): Promise<void>
  /** Forward one platform interaction as a §6.6 platform_action and return the
   *  daemon's ack — the sync-response race (see the module doc) awaits this.
   *  `msgId` is the DEDUP IDENTITY, and the plugin mints it (it derives from
   *  parsed action semantics); core owns the dedup table on the daemon side.
   *  `route` is the target the plugin resolved through the directory — the
   *  three directory lookups are three distinct trust models, so delivery must
   *  not re-resolve and silently substitute a different one. Core still honours
   *  the activation rendezvous on top of that route: a recorded member that has
   *  since handed the duty on answers `not_holder`, and the SAME frame is
   *  re-sent once to the member it names, so the ack returned here is the true
   *  holder's verdict (including its `response` body). */
  forwardAction(msg: RdMsgPlatformAction, route: RouteTarget): Promise<RdAck>
  /** Report the bot's channel-membership snapshot (queued while the CP link is
   *  down; a newer snapshot supersedes). */
  reportChannels(snapshot: RcBotChannels): void
  /** Report a platform-side revocation for `botId`. `credentialRevision` is
   *  the generation of the ASSIGNMENT THAT OBSERVED the dead credential — the
   *  plugin captures it at buildIngest time, because assignments start
   *  fire-and-forget and an older ingest's lifecycle probe can finish after a
   *  newer assignment installed: fencing with the mutable current revision
   *  would let that stale observation revoke the replacement credential. */
  reportRevoked(botId: string, reason: string, eventAtMs?: number, credentialRevision?: number): void
  /** Arbitration reads — never the router object itself. */
  directory: {
    agents(botId: string): { agentId: string; name: string }[]
    channelOwner(botId: string, channelId: string): string | undefined
    targetForAgentId(botId: string, agentId: string): RouteTarget | undefined
    /**
     * CORE-owned resolution of bare conversation coordinates to a routable
     * target — the ladder a coordinate-only interaction (a Slack message
     * shortcut) needs before it can be forwarded: live thread affinity, then
     * channel owner, then the default agent, with the mute and gating fences
     * applied at every rung. `undefined` = nothing addressable (the plugin
     * answers the platform accordingly and forwards nothing).
     */
    resolveTarget(botId: string, coords: { channelId: string; threadTs: string }): RouteTarget | undefined
    /** The conversation's remembered participant set, re-resolved through the member
     *  directory with the mute/gate fences applied — the recipients of a session-level
     *  event that must reach EVERY participant (Slack's native Stop), where the
     *  single-owner ladder above would drop the siblings a shared bot fans out to. */
    conversationParticipants(botId: string, coords: { channelId: string; threadTs: string }): RouteTarget[]
    /** Exact-pair validation for an interaction that CARRIES its rendered
     *  target AND must still hold a live routing rule (a Slack status-modal
     *  action): stale/tampered buttons reject instead of falling through to a
     *  channel's current owner. */
    targetForAgent(botId: string, agentId: string, integrationId: string): RouteTarget | undefined
    /** Rendered-target resolution through the member DIRECTORY, with no
     *  conversation-rule requirement (a Feishu card action — the daemon's
     *  active-card map is its terminal fence). The three lookups are three
     *  distinct trust models; a plugin picks the one its interaction earns. */
    integrationTarget(botId: string, agentId: string, integrationId: string): RouteTarget | undefined
    /** The single-install fallback for an interaction whose payload embeds no
     *  target (a pre-target Feishu card): the bot's sole routable member. */
    soleTarget(botId: string): RouteTarget | undefined
  }
  /** Report the bot's own platform user identity once the platform reveals it
   *  (Slack resolves it lazily via auth.test on start). Arbitration's mention
   *  matching and echo suppression keep their fallback through this — an
   *  assignment is NOT guaranteed to carry `botUserId` (a manual-paste bot's
   *  CP row learns it from this very report). */
  reportBotUserId(botId: string, botUserId: string): void
  /** Event-identity dedup — CORE owns the bounded, TTL'd table; the PLUGIN
   *  mints the identity (it derives from parsed envelope semantics, §8) and
   *  carries it on its verified product into `handle`. True ⇒ already seen
   *  (drop); false ⇒ marked now. An absent identity is never deduped. */
  dedupSeen(identity: string | undefined): boolean
  /** Whether `route`'s daemon is connected RIGHT NOW. For interactions whose
   *  platform affordance is one-shot (a Slack shortcut consumes its trigger
   *  id), the plugin must know synchronously that delivery is possible, so it
   *  can surface the platform's local unavailable path instead of silently
   *  eating the interaction. */
  canDeliver(route: RouteTarget): boolean
  /** Persist an explicit channel default-agent change (the config modal's
   *  durable, CP-broadcast side; no local routing effect of its own). */
  setChannelAgent(botId: string, channelId: string, agentId: string): void
  /** Make an inline Switch-agent selection effective for the thread NOW, then
   *  durably: core applies local channel ownership AND thread affinity before
   *  any report leaves the pod — the guarantee un-mentioned follow-ups in the
   *  same thread route to the new agent immediately — and then persists via the
   *  CP (the 3-leg thread-affinity dance stays core). */
  selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void
  clock: { now(): number }
  log: Logger
}

/** What handling one verified delivery produces. `syncResponse`, when present,
 *  is the body the HTTP route must return on THIS request's 200 — the two known
 *  shapes are a challenge echo (Feishu `url_verification`) and an interaction
 *  result raced against the platform's response window (Feishu toast, Slack
 *  `block_suggestion` options). Everything asynchronous — normalized messages,
 *  reports — already left through {@link RelayIngressHost} by the time this
 *  returns. */
export interface HandledDelivery {
  syncResponse?: unknown
}

/** The relay-core INBOUND seam a platform's HTTP route drives: demux + verify
 *  + handle in one core-owned ladder (satisfied by `RelayIngressManager`), with
 *  the plugin owning the cryptography and everything after authentication.
 *  `undefined` ⇒ no assigned bot owns the delivery, and the route answers 401. */
export interface RelayInboundSeam {
  handleInbound(
    platformId: string,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<HandledDelivery | undefined>
}

/** What {@link RelayPlatformIngressPlugin.installRoutes} is handed. `manager` is
 *  LATE-BOUND deliberately: routes must register before `listen()`, while the
 *  manager is constructed alongside the rd/* server that comes after it. */
export interface RelayIngressRouteDeps {
  manager: () => RelayInboundSeam | undefined
  log: Logger
}

/**
 * One platform's relay ingress plugin — stateless, per-platform, registered
 * once. Adding a platform registers one of these; no manager fork grows.
 *
 * @typeParam TIngest   The per-bot instance this plugin builds.
 * @typeParam TVerified The plugin's OWN verified-delivery type — the typed
 *                      product of authentication (Feishu's decrypted
 *                      challenge/event/card-action union; Slack's raw body +
 *                      parsed envelope). Opaque to core: it flows from
 *                      {@link verify} into {@link handle} and is never read
 *                      between them.
 */
export interface RelayPlatformIngressPlugin<TIngest extends RelayBotIngress = RelayBotIngress, TVerified = unknown> {
  /** Platform id (§6.1 vocabulary). Never parsed. */
  readonly platformId: string
  /**
   * Mount this platform's PUBLIC HTTP callback routes. Closes §6 item 12's
   * "route mounting by name" blind spot (audit F5) the way the CP closed its
   * twin in #605 (`installRoutes(scope)`): the bootstrap asks every registered
   * plugin instead of calling `registerSlackHttpIngress` /
   * `registerFeishuHttpIngress` by name, so adding a platform stops requiring
   * an edit to `index.ts`.
   *
   * THE PLUGIN DECLARES ITS OWN PATHS, which is what makes the move a no-op:
   * public callback URLs are EXTERNAL contracts — baked into a platform app's
   * event-subscription config and into the deployment gateway's routing, and
   * this repo has already been bitten by a public/internal prefix mismatch
   * turning a live callback into a 404. `platforms/route-mounts.test.ts` pins
   * the resulting table by enumeration.
   *
   * Called once, before `listen()`. The plugin owns its own isolated Fastify
   * scope: both live ingests need raw-buffer content-type parsers (the HMAC is
   * over the exact request bytes) that must never leak onto the relay's other
   * JSON surfaces.
   */
  installRoutes(app: FastifyInstance, deps: RelayIngressRouteDeps): void
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
   * Authenticate one inbound delivery against a candidate ingest and return the
   * TYPED verified product, or `undefined` for a candidate that does not own
   * it. Core drives the lookup ladder (assignment-derived index fast paths,
   * then the bounded scan the assignment's identity scope permits) and calls
   * this per candidate; the plugin owns the cryptography (HMAC window, AES
   * decrypt, token compare) — and hands back the DECRYPTED result exactly once,
   * so handling never re-derives it.
   */
  verify(
    ingest: TIngest,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
    /** Host-clock "now" (ms) — HMAC replay windows are time-based, and the
     *  injection is what keeps verification testable under a fake clock. */
    now: number
  ): TVerified | undefined
  /**
   * Handle one verified delivery: decode events into normalized messages and
   * interactions, emit them through the host, and produce the synchronous HTTP
   * body when the platform demands one on this request's 200. The plugin owns
   * its response deadline (it races {@link RelayIngressHost.forwardAction}
   * against the platform's window on the host clock, degrading to an ack-only
   * body on timeout); core owns only the route's outer hard cap.
   *
   * DOCUMENTED EXCEPTION — pre-candidate challenges: Slack's unauthenticated
   * `url_verification` is answered by the plugin's ROUTE before any ingest
   * candidate exists, so it never reaches verify → handle. That stays
   * plugin-owned (§8: challenge ordering relative to verification differs per
   * platform and is a per-plugin hook, not a fixed pipeline step); Feishu's
   * challenge is encrypted, so it flows through verify → handle as a
   * `syncResponse`.
   */
  handle(ingest: TIngest, verified: TVerified, host: RelayIngressHost): Promise<HandledDelivery>
}

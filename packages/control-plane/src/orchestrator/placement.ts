/**
 * `Placement.reconcile` — the C3 convergence point (design §4.6, §4.11;
 * protocol §3.3).
 *
 * `register/ok` is the authoritative reconcile snapshot: the CP loads what THIS
 * daemon should own from the C6 routing table and tells the daemon to converge
 * its local cache to it. **CP wins all conflicts**, so re-issuing the same
 * snapshot is idempotent (reconnect is convergence, not replay).
 *
 * Phase 2 implements `reconcile` only (the placement/rebalance/fencing methods
 * land in Phase 3). It is transport-free and Prisma-free — it reads C6 through
 * repository ports.
 */
/**
 * `Placement` — the C3 routing brain (design §4.6, §4.9–§4.11; protocol §3.3,
 * §5.3). The ONLY reader/writer of the C6 routing table.
 *
 * Phase 2 implemented `reconcile` (the `register/ok` convergence snapshot). Phase
 * 3 adds the live placement surface — `placeSession` (least-loaded pick under a
 * bumped routingEpoch), `rebalanceFrom` (drain a daemon, then reassign its
 * sessions only AFTER `drain/done` — no double-assign window), and the watchdog
 * hooks (`freeze`, `onDaemonUnreachable`) — all transport-free (it issues control
 * via the injected {@link ControlSender}) and Prisma-free (it reads C6 through
 * repository ports).
 */
import type {
  RegisterReq,
  RegisterOk,
  RouteAssign,
  CronUpsert,
  SecretsGrant,
  BindRule,
  IntegrationSpec,
  IntegrationBindRule,
  IntegrationCoreEnvelope,
  McpServerSpec,
  MemoryConnectionSpec
} from '@agentconnect.md/protocol'
import { SessionRetentionSetting } from '@agentconnect.md/protocol'
import type {
  AgentRepo,
  AgentRecord,
  AssignmentRepo,
  AssignmentRecord,
  CronRepo,
  CronRecord,
  DaemonRepo,
  SecretLeaseRepo,
  LeaseRecord,
  IntegrationRepo,
  IntegrationRecord,
  BotSecretStore,
  BotSecretMaterial,
  BotRecord,
  BotRepo,
  IntegrationChannelRepo,
  IntegrationChannelRecord
} from '../persistence/ports.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import { servedAgents, type ServedAgents } from './servedAgents.js'
import {
  mcpDefsForAgents,
  memoryDefsForAgents,
  type McpDefinitionDeps,
  type MemoryDefinitionDeps
} from './agentDefinitions.js'
import { daemonSupportsAgent, encodeSpecWorkspaceForPeer, requiredDaemonFeatures } from '../domain/daemon-features.js'
import type { AgentId, DaemonId } from '../domain/ids.js'
import { AgentId as toAgentId, DaemonId as toDaemonId, IntegrationId as toIntegrationId } from '../domain/ids.js'
import { sessionKeyStr, type SessionKey } from '../domain/sessionKey.js'
import { toDbPlatform } from '../persistence/platform.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import { buildCollabSnapshot } from './collabSnapshot.js'
import type { ConnectionRegistry, DaemonConnState } from '../ws/registry.js'
import type { ControlSender } from './outbound.js'
import { PLACEMENT_ONLY, type PlacementResolver } from './placementResolver.js'
import type { EpochService } from './epoch.js'
import type { Clock } from '../domain/clock.js'

/** The narrow service the register handler depends on (design §2.3 `Orchestrator.reconcile`). */
export interface ReconcileService {
  reconcile(daemonId: DaemonId, req: RegisterReq): Promise<RegisterOk>
}

/** The live-orchestration collaborators Placement needs beyond the C6 repos. */
export interface PlacementOrchDeps {
  registry: ConnectionRegistry
  sender: ControlSender
  epoch: EpochService
  clock: Clock
  config: { REASSIGN_GRACE_SEC: number; ACK_TIMEOUT_MS: number }
  /** MCP-proxy reconcile bundle (centralized-tool-management.md §7): the org providers
   *  this daemon's agents enabled, their active grant keys, and the relay roster to pick
   *  a proxy base from. Grouped here (not positional repos) so the whole concern is one
   *  optional seam — absent (tests / no orch) ⇒ reconcile ships no MCP defs. */
  mcp?: McpDefinitionDeps
  memory?: MemoryDefinitionDeps
  /** The duty ledger read that makes the reconcile roster `pinned-to-me ∪ agents
   *  in the duties I hold`. Absent (tests / no pool) ⇒ placement alone. */
  duties?: { heldAgentIds(holder: DaemonId, now: Date): Promise<AgentId[]> }
  /** Resolves the peer directory's routing targets. Absent ⇒ placement alone. */
  placement?: Pick<PlacementResolver, 'resolveDirectory'>
  /** Optional structured logger for reconcile-time skips (no live relay). */
  log?: { warn(obj: object, msg: string): void }
  // NOTE: icon URL bases moved into the AgentSpecAssembler (it owns spec assembly).
}

/** Raised when no reachable daemon can host a session. */
export class NoCapacity extends Error {
  constructor(readonly key: SessionKey) {
    super(`no capacity to place session ${sessionKeyStr(key)}`)
    this.name = 'NoCapacity'
  }
}

function assignmentToRoute(a: AssignmentRecord): RouteAssign {
  const sessionKey: SessionKey = {
    platform: a.platform,
    channel: a.channel,
    ...(a.thread !== null ? { thread: a.thread } : {})
  }
  return {
    sessionKey,
    agentId: a.agentId,
    workspaceId: a.workspaceId,
    bindRules: (Array.isArray(a.bindRules) ? a.bindRules : []) as BindRule[]
  }
}

/** C6 CronDef row → wire `CronUpsert` (§5.4) — the one mapping site, shared by the
 *  register/ok snapshot and the live CRUD push (`http/routes/crons.ts`). Returns
 *  null for an orphaned row (agent deleted → SetNull): inert, never pushed. */
export function cronToUpsert(c: CronRecord): CronUpsert | null {
  if (!c.agentId) return null
  return {
    orgId: c.orgId,
    cronId: c.id,
    agentId: c.agentId,
    schedule: c.schedule,
    timezone: c.timezone,
    ...(c.targetChannel
      ? {
          target: {
            platform: toDbPlatform(c.targetPlatform),
            channel: c.targetChannel,
            ...(c.targetIntegrationId ? { integrationId: c.targetIntegrationId } : {})
          }
        }
      : {}),
    trigger: c.trigger,
    enabled: c.enabled
  }
}

function leaseToGrant(l: LeaseRecord): SecretsGrant {
  return {
    leaseId: l.id,
    scope: { platform: l.scopePlatform, workspaceId: l.scopeWorkspaceId },
    ref: l.ref,
    ttl: l.ttlSec,
    renewBeforeSec: l.renewBeforeSec
  }
}

/**
 * Default triggers for a console-installed integration: respond to @-mentions and
 * DMs. The console install flow does not (yet) collect channel bindings, so without
 * a default the bot would connect but never be routed to. Operators can still add
 * richer bindRules via a local agent.json integration.
 */
const DEFAULT_BIND_RULES: IntegrationBindRule[] = [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }]

/** Conversation gating (resource-visibility.md §14): derived from restricted
 *  visibility at spec-assembly time — no stored toggle, no identities on the wire. */
export const isGatedAgent = (a: { visibility: AgentRecord['visibility'] }): boolean => a.visibility === 'restricted'

/**
 * Conversation-scoped bind rules for a GATED integration (resource-visibility.md
 * §14.3): only explicitly enabled conversations produce rules — a Mention channel
 * gets a channel-scoped mention rule, an "All messages" channel a channel-scoped
 * auto rule, an enabled DM conversation a conversation-scoped dm rule. An
 * unknown/Off conversation matches no rule, so nothing routes (fail-closed,
 * including the window before a fresh channel is reported).
 */
function gatedBindRules(channels: IntegrationChannelRecord[]): IntegrationBindRule[] {
  const out: IntegrationBindRule[] = []
  for (const c of channels) {
    if (c.trigger === 'off') continue
    if (c.kind === 'im') out.push({ channel: c.channelId, match: { kind: 'dm' } })
    else if (c.trigger === 'any') out.push({ channel: c.channelId, match: { kind: 'auto' } })
    else out.push({ channel: c.channelId, match: { kind: 'mention' } })
  }
  return out
}

/**
 * The Off conversations of an UNGATED integration — its `mutedChannels` fence.
 *
 * An ungated integration reaches every conversation through unscoped defaults
 * (@-mention anywhere + DMs), which no channel-scoped rule can subtract from, so Off
 * has to be stated rather than merely omitted. A GATED integration needs none of
 * this: its rules are conversation-scoped already, so Off IS the missing rule, and
 * naming the channel here would only give the same fact two representations that can
 * disagree — hence the empty list.
 *
 * Direct rows use the same fence: their Off/On control is visible and effective for
 * every agent. A gated integration still expresses Off by omitting its scoped rule.
 */
function mutedChannelIds(channels: IntegrationChannelRecord[], gated: boolean): string[] {
  if (gated) return []
  return channels.filter((c) => c.trigger === 'off').map((c) => c.channelId)
}

/**
 * Assemble the wire {@link IntegrationSpec} the daemon opens its socket from —
 * metadata from the `integration` row + tokens from the {@link BotSecretStore}
 * (keyed by the integration's bot) + the per-channel trigger config folded into
 * `bindRules`. Shared by the reconcile roster (`register/ok.integrations`) and
 * the live `integration/upsert` REST emit. Token-bearing: NEVER log the result.
 *
 * Non-gated: bindRules = the defaults (@-mention anywhere + DMs) ∪ one
 * channel-scoped `auto` rule per channel the operator switched to "any message".
 * A 'mention' channel needs no extra rule — the unscoped mention default already
 * covers it. Gated (`gated`, derived from the owning agent's restricted
 * visibility): NO unscoped defaults — only {@link gatedBindRules}.
 */
export async function integrationToSpec(
  platforms: CpPlatformRegistry,
  i: IntegrationRecord,
  bot: BotRecord,
  secret: BotSecretMaterial,
  channels: IntegrationChannelRecord[] = [],
  gated = false
): Promise<IntegrationSpec> {
  // A 1:1 DM's On state is already covered by the unscoped dm default. A group DM
  // set to Any needs its own auto rule; Mention is covered by the default mention rule.
  const channelRules: IntegrationBindRule[] = channels
    .filter((c) => c.trigger === 'any' && c.kind !== 'im')
    .map((c) => ({ channel: c.channelId, match: { kind: 'auto' as const } }))
  const bindRules = gated ? gatedBindRules(channels) : [...DEFAULT_BIND_RULES, ...channelRules]
  const mutedChannels = mutedChannelIds(channels, gated)
  // §6.4 final shape: envelope + opaque config. The daemon takes the routing
  // knobs from `core` (its platform module validates `config` against its own
  // schema); the config payload never duplicates them.
  //
  // 'direct' (transport==='socket') — this daemon owns the long-lived inbound
  // connection (Slack Socket Mode, the Telegram long-poll, the Discord Gateway,
  // the Feishu WSClient). The 'shared' envelope is assembled by
  // {@link httpIntegrationToSpec}; the two differ ONLY in this envelope, which is
  // why the fork stays core and the payload behind it does not.
  const core = { mode: 'direct' as const, bindRules, mutedChannels, gated }
  return projectSpec(platforms, i, bot, core, secret)
}

/**
 * Assemble the send-only {@link IntegrationSpec} for a member agent of an HTTP bot
 * (shared-bot-relay.md §7.3). The wire keeps `mode: 'shared'` for compatibility.
 * The daemon keeps provider API credentials for send/download operations, but
 * opens no inbound socket. The relay arbitrates callback ingress and delivers
 * it pre-addressed. Token-bearing — NEVER log.
 *
 * GATED exception (resource-visibility.md §14.3): a restricted agent's install
 * ships its conversation-scoped rules + `gated: true` even in relay-managed mode — the
 * relay is still the arbiter, but the daemon uses these for its last-hop
 * admission backstop in `handleRelayIm` (it must not trust a stale relay route
 * snapshot to keep a private agent fail-closed). `mutedChannels` rides along for the
 * same reason and for every install, gated or not: an Off channel must survive a
 * relay snapshot that has not caught up yet.
 */
export async function httpIntegrationToSpec(
  platforms: CpPlatformRegistry,
  i: IntegrationRecord,
  bot: BotRecord,
  secret: BotSecretMaterial,
  channels: IntegrationChannelRecord[] = [],
  gated = false
): Promise<IntegrationSpec> {
  // §6.4 final shape (see integrationToSpec): envelope + opaque config only.
  // The shared-mode payload's remaining inputs — `shareable` (the daemon's
  // in-thread "Switch agent" control), the provider app id, the bot's own user
  // id — all live on the BOT row, so the projector reads them there instead of
  // taking them positionally from each call site (§9: the bot row is a required
  // projector input, and passing it whole is what stopped three call sites from
  // disagreeing about which of its fields to forward).
  const httpCore = {
    mode: 'shared' as const,
    bindRules: gated ? gatedBindRules(channels) : [],
    mutedChannels: mutedChannelIds(channels, gated),
    gated
  }
  return projectSpec(platforms, i, bot, httpCore, secret)
}

/**
 * The §9 projector seam: core has finished the part it owns (the envelope — the
 * routing compile, the gating fold, the ingress mode) and hands the row + the
 * decrypted secrets to the platform's provider, which returns the opaque
 * `config` payload (§6.4). ONE await, no platform branch — `bot.transport` is
 * the direct-vs-shared fork the provider itself applies, and it always agrees
 * with the envelope's `mode` because every call site picks the assembler from
 * that same field.
 *
 * ONE fail-closed fence remains core's, unreachable today: a registered
 * provider is required. Writes are fenced by `toDbPlatform` and the create
 * route admits only registered platform ids, so a row with an unregistered
 * platform cannot exist — refusing here is the fail-closed statement of that,
 * not a live branch. (`IntegrationSpec.platform` is the OPEN id since the S3
 * flatten, so the row's own platform rides the wire verbatim; the pre-flatten
 * `toDbPlatform` narrowing back to the closed wire union is gone with the
 * union.)
 *
 * Token-bearing — NEVER log the result.
 */
async function projectSpec(
  platforms: CpPlatformRegistry,
  i: IntegrationRecord,
  bot: BotRecord,
  core: IntegrationCoreEnvelope,
  secret: BotSecretMaterial
): Promise<IntegrationSpec> {
  const provider = platforms.get(i.platform)
  if (!provider) throw new Error(`no control-plane platform provider registered for ${i.platform}`)
  const config = await provider.projectIntegrationConfig(i, bot, core, secret)
  return { orgId: i.orgId, integrationId: i.id, agentId: i.agentId, platform: i.platform, core, config }
}

/** Union two roster halves by row id, keeping the first occurrence — the placement
 *  half and the duty half legitimately overlap when a member holds what it hosts. */
function dedupeById<T extends { id: string }>(first: readonly T[], second: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of [...first, ...second]) if (!byId.has(row.id)) byId.set(row.id, row)
  return [...byId.values()]
}

/** A session to re-home: its key + the agent/workspace that should own it. */
function recordToSessionKey(a: AssignmentRecord): SessionKey {
  return {
    platform: a.platform,
    channel: a.channel,
    ...(a.thread !== null ? { thread: a.thread } : {})
  }
}

export class Placement implements ReconcileService {
  private readonly orch?: PlacementOrchDeps

  constructor(
    private readonly daemons: DaemonRepo,
    private readonly agents: AgentRepo,
    private readonly assignments: AssignmentRepo,
    private readonly crons: CronRepo,
    private readonly leases: SecretLeaseRepo,
    private readonly integrations: IntegrationRepo,
    private readonly botSecrets: BotSecretStore,
    private readonly specs: AgentSpecAssembler,
    private readonly integrationChannels: IntegrationChannelRepo,
    private readonly bots: BotRepo,
    /** §9 platform providers — the ONLY source of an `IntegrationSpec.config`
     *  payload. Late-bound in the composition root (the providers are built
     *  with the route-dep bundle, which does not exist yet when Placement is
     *  constructed); every read happens at reconcile time. */
    private readonly platforms: CpPlatformRegistry,
    orch?: PlacementOrchDeps
  ) {
    this.orch = orch
  }

  private must(): PlacementOrchDeps {
    if (!this.orch) throw new Error('Placement: orchestration deps not configured')
    return this.orch
  }

  /** The agents this member currently holds a duty for. No ledger wired ⇒ none,
   *  which is exactly the pre-duty roster. */
  private async servedAgents(daemonId: DaemonId): Promise<ServedAgents> {
    return servedAgents(daemonId, {
      agents: this.agents,
      ...(this.orch?.duties ? { duties: this.orch.duties } : {}),
      now: new Date(this.orch?.clock.now() ?? Date.now())
    })
  }

  async reconcile(daemonId: DaemonId, req: RegisterReq): Promise<RegisterOk> {
    // Daemon trust domain: reconcile runs for the registering connection's own
    // daemon (org-scoped-data-layer.md §4).
    const daemon = await this.daemons.getUnscoped(daemonId)
    if (!daemon) {
      // Should not happen — auth created the row — but stay defensive.
      throw new Error(`reconcile: unknown daemon ${daemonId}`)
    }

    // The roster is `pinned-to-me ∪ agents in the duties I hold`. A duty grant is
    // how a pool member comes to serve an agent it is not the placement of, and
    // its install (`duty/fetch`) has to survive a reconnect: an agent absent from
    // the desired set is a stale-replica candidate below and would be PRUNED,
    // undoing the install. Its integrations and crons ride along for the same
    // reason — a served group whose sockets the reconcile dropped serves nothing.
    const { heldAgentIds, agents: ownedAgents } = await this.servedAgents(daemonId)
    const [activeAssignments, daemonCrons, heldCrons, activeLeases, daemonIntegrations, heldIntegrations] =
      await Promise.all([
        this.assignments.activeForDaemon(daemonId),
        this.crons.listForDaemon(daemonId),
        this.crons.listForAgents(heldAgentIds),
        this.leases.activeForDaemon(daemonId),
        this.integrations.activeForDaemon(daemonId),
        this.integrations.activeForAgents(heldAgentIds)
      ])
    const activeIntegrations = dedupeById(daemonIntegrations, heldIntegrations)
    const ownedCrons = dedupeById(daemonCrons, heldCrons)

    const quarantinedAgentIds = new Set<string>()
    // §17.3 snapshot projection gate: a spec this daemon cannot decode is withheld
    // from its snapshot entirely (spec, assignments, integrations, crons) instead of
    // shipped as a frame-fatal union value. The local replica, if any, is deliberately
    // NOT pruned — the durable row still names this daemon until an operator moves it.
    for (const agent of ownedAgents) {
      if (daemonSupportsAgent(agent, req.capabilities.features)) continue
      quarantinedAgentIds.add(agent.id)
      this.orch?.log?.warn(
        { agentId: agent.id, daemonId, required: requiredDaemonFeatures(agent) },
        'withholding agent from snapshot: daemon lacks a required feature'
      )
    }
    const deliverableAgents = ownedAgents.filter((a) => !quarantinedAgentIds.has(a.id))
    // Conversation gating (§14): derived per-agent from restricted visibility. This
    // is a data-plane read of the DERIVED boolean only — identities never ride the
    // wire, and the roster itself stays unfiltered (§9 graceful degradation).
    const gatedAgentIds = new Set(ownedAgents.filter((a) => a.visibility === 'restricted').map((a) => a.id))
    const [assembledAgents, assembledIntegrations] = await Promise.all([
      this.specs.assembleAll(deliverableAgents, (agent) => {
        quarantinedAgentIds.add(agent.id)
        this.orch?.log?.warn({ agentId: agent.id }, 'quarantining agent with an unsafe historical git repository')
      }),
      Promise.all(
        activeIntegrations.map(async (i) => {
          const [secret, channels, bot] = await Promise.all([
            this.botSecrets.get(i.orgId, i.botId),
            this.integrationChannels.listForIntegration(i.id),
            // The bot behind one of the reconciling daemon's integration rows.
            this.bots.getUnscoped(i.botId)
          ])
          // A spec needs BOTH halves of its identity: the bot row (the projector's
          // required input — credentials shape, transport, demux identity) and the
          // decrypted secret. Either missing ⇒ no deliverable spec, and the roster
          // prunes the replica below. The bot row cannot actually be absent (the
          // integration→bot FK is non-null and `onDelete: Restrict`); the guard is
          // the fail-closed statement of that, not a live branch.
          if (!secret || !bot) return null
          // An http-transport bot's ingest is on the relay pool — the daemon
          // reconciles it send-only (no Socket Mode). Socket bots reconcile as direct.
          // Both arms await the SAME provider projector; only the envelope differs.
          const gated = gatedAgentIds.has(i.agentId)
          return bot.transport === 'http'
            ? await httpIntegrationToSpec(this.platforms, i, bot, secret, channels, gated)
            : await integrationToSpec(this.platforms, i, bot, secret, channels, gated)
        })
      )
    ])

    // Integrations FILTERED to the agents this daemon serves (placed on it or held
    // by it) — each carries plaintext tokens, so this must never be the org-wide
    // set, and the duty half is exactly what the ledger says this member won.
    // Tokens are pulled
    // from the secret store (the only decrypt/read seam); NEVER log this array.
    // ALL platforms belong in the roster (Slack + Telegram): the roster is the
    // backstop when the live integration/upsert was skipped (daemon offline) or
    // no-op'd (agent.json not on disk yet), so filtering to one platform silently
    // strands the others' tokens off the daemon. integrationToSpec emits the
    // right per-platform variant.
    // Second pass on the ASSEMBLED spec: the additional-repository allowlist and the
    // §24.4 host live only there, so the domain-record pass above cannot see either.
    const desiredAgents = assembledAgents.filter((spec) => {
      if (daemonSupportsAgent(spec, req.capabilities.features)) return true
      quarantinedAgentIds.add(spec.agentId)
      this.orch?.log?.warn(
        { agentId: spec.agentId, daemonId, required: requiredDaemonFeatures(spec) },
        'withholding agent from snapshot: daemon lacks a feature its assembled spec requires'
      )
      return false
    })

    const desiredIntegrations = assembledIntegrations.filter(
      (spec): spec is IntegrationSpec => spec !== null && !quarantinedAgentIds.has(spec.agentId)
    )

    const desiredAssignments = activeAssignments
      .filter((assignment) => !quarantinedAgentIds.has(assignment.agentId))
      .map(assignmentToRoute)
    // The agent-config replica for THIS daemon: the agents placed on it, plus the
    // agents whose duty it holds. A daemon never receives specs for agents that
    // are neither. Unplaced, unheld agents go to no daemon. The daemon converges
    // its replica to this set (CP wins); live edits ride `agent/upsert`/
    // `agent/remove` over the same union; this snapshot is the reconnect backstop.
    // The assembler owns secret loading + icon bases — same spec shape as the
    // live agent/upsert emit, structurally. Historical unsafe repository rows
    // are quarantined above without stranding the rest of this daemon's roster.
    // Crons scoped the same way — a cron drives one agent, so its def lands on the
    // daemons that serve that agent. Orphaned rows map to null and are never pushed.
    const desiredCrons = ownedCrons
      .map(cronToUpsert)
      .filter((cron): cron is CronUpsert => cron !== null && !quarantinedAgentIds.has(cron.agentId))
    const desiredLeases = activeLeases.map(leaseToGrant)

    // Bot-agnostic collaboration routing snapshot (agent-collaboration §2.3/§6.2/§6.5) —
    // the org-wide channel placement/policy set, so THIS daemon can terminal-verify a
    // REMOTE agent caller (§2.5 #4). Org-scoped, bodiless. `generation` reuses the
    // routingEpoch as a monotonic version hook (fuller lifecycle is a follow-up, §6.5).
    // `orgDirectory` is the flat companion: policy-only rows for EVERY org agent,
    // including the integration-less ones no channel placement can express. One
    // org-scoped query, not a per-agent fan-out.
    const collabRoutes: RegisterOk['collabRoutes'] = {
      generation: Number(daemon.routingEpoch),
      channels: [],
      agents: [],
      platformKinds: []
    }
    for (const orgId of new Set(ownedAgents.map((agent) => agent.orgId))) {
      const [placements, orgDirectory] = await Promise.all([
        this.integrations.channelPlacements(orgId),
        this.agents.orgDirectory(orgId)
      ])
      const snapshot = buildCollabSnapshot(
        orgId,
        placements,
        Number(daemon.routingEpoch),
        // Placement names the target for a machine-placed peer; the ledger names it for a pool
        // one, and marks a pool agent nobody may be addressed at yet as pending. The resolver is
        // the only producer of that shape, so a graph without one still goes through it.
        await (this.orch?.placement ?? PLACEMENT_ONLY).resolveDirectory(orgDirectory)
      )
      collabRoutes.channels.push(...snapshot.channels)
      collabRoutes.agents.push(...snapshot.agents)
      collabRoutes.platformKinds = snapshot.platformKinds
    }

    // drop = localState − desired. Agent/integration replicas need an explicit
    // ownership proof so hand-authored local config survives. A legacy replica
    // has origin=unknown; prune it only while its durable CP row still proves it
    // belongs elsewhere (the backstop for moves missed while this daemon was
    // disconnected). New replicas carry origin=cp and can also converge a missed
    // delete after the durable row is gone.
    // The desired sets are the UNION computed above, so a duty-held replica is
    // never a candidate here at all — its CP row names another daemon, which is
    // exactly the `record.daemonId !== daemonId` detach below. That is the whole
    // pruning bug: subtracting from the placement-only set undid the install.
    // An agent the ledger still names but whose row is gone stays a candidate and
    // is removed on its own merits — a deleted agent must not keep being served.
    const desiredKeySet = new Set(desiredAssignments.map((a) => sessionKeyStr(a.sessionKey)))
    const desiredCronSet = new Set(desiredCrons.map((c) => c.cronId))
    const desiredAgentSet = new Set(desiredAgents.map((a) => a.agentId))
    const desiredIntegrationSet = new Set(desiredIntegrations.map((i) => i.integrationId))

    const dropAssignments = req.localState.assignments.filter((k) => !desiredKeySet.has(k))
    const dropCrons = req.localState.crons.filter((id) => !desiredCronSet.has(id))
    const staleAgentCandidates = req.localState.agents.filter((a) => !desiredAgentSet.has(a.agentId))
    const staleIntegrationCandidates = req.localState.integrations.filter(
      (i) => !desiredIntegrationSet.has(i.integrationId)
    )
    // One org-scoped lookup per resource kind avoids turning an arbitrary local
    // inventory into an N-query fan-out at register time.
    const [orgAgents, orgIntegrations] = await Promise.all([
      staleAgentCandidates.length
        ? daemon.orgId
          ? this.agents.list(daemon.orgId)
          : Promise.all(staleAgentCandidates.map((local) => this.agents.getUnscoped(toAgentId(local.agentId)))).then(
              (rows) => rows.filter((row): row is AgentRecord => row !== null)
            )
        : Promise.resolve([]),
      staleIntegrationCandidates.some((i) => i.origin === 'unknown')
        ? daemon.orgId
          ? this.integrations.listForOrg(daemon.orgId)
          : Promise.all(
              staleIntegrationCandidates.map((local) =>
                this.integrations.getUnscoped(toIntegrationId(local.integrationId))
              )
            ).then((rows) => rows.filter((row): row is IntegrationRecord => row !== null))
        : Promise.resolve([])
    ])
    const orgAgentById = new Map(orgAgents.map((agent) => [agent.id as string, agent]))
    const orgIntegrationIds = new Set(orgIntegrations.map((integration) => integration.id as string))
    const dropAgents: RegisterOk['drop']['agents'] = []
    for (const local of staleAgentCandidates) {
      if (quarantinedAgentIds.has(local.agentId)) {
        dropAgents.push({ agentId: local.agentId, action: 'detach' })
        continue
      }
      const record = orgAgentById.get(local.agentId)
      // An unplaced CP row (daemonId=null) belongs on no daemon, so detach its
      // preserved local workspace just like a replica moved to another daemon.
      if (record && record.daemonId !== daemonId) {
        dropAgents.push({ agentId: local.agentId, action: 'detach' })
        continue
      }
      if (local.origin === 'cp' && !record) {
        dropAgents.push({ agentId: local.agentId, action: 'remove' })
      }
    }
    // A CP-owned integration omitted from the deliverable roster is pruned,
    // including when its secret is unavailable. Future non-active statuses must
    // make an explicit retain-versus-remove choice here.
    const dropIntegrations = staleIntegrationCandidates
      .filter((local) => local.origin === 'cp' || orgIntegrationIds.has(local.integrationId))
      .map((local) => local.integrationId)

    // Console-set finished-session retention — the daemon's reconnect baseline for
    // the config/push hot update. Parsed defensively: an unexpected stored value
    // (never written by the validated PATCH route) is simply omitted, which the
    // daemon reads as "keep local config".
    const sessionRetention = SessionRetentionSetting.safeParse(daemon.sessionRetention)

    return {
      routingEpoch: Number(daemon.routingEpoch), // re-issue same — convergence, not bump
      ...(sessionRetention.success ? { sessionRetention: sessionRetention.data } : {}),
      // Transport capabilities are connection-level and register.ts replaces
      // this neutral snapshot value immediately before register/ok is sent.
      serverFeatures: [],
      assignments: desiredAssignments,
      // Full spec-set the daemon replicates (direct-edge launch needs a local replica).
      // Workspace dual-encoded per the registering daemon's advertised features (§8).
      agents: desiredAgents.map((spec) => encodeSpecWorkspaceForPeer(spec, req.capabilities.features)),
      crons: desiredCrons,
      integrations: desiredIntegrations, // daemon-scoped platform integrations (token-bearing)
      // Both definition kinds are scoped by the SAME roster union as the agents
      // above — an AgentSpec only names its MCP servers and its memory
      // connection, so a duty-held replica whose definitions were resolved by
      // placement would come up with neither. `ownedAgents`, not a second read.
      mcpServers: await this.desiredMcpServers(daemonId, ownedAgents), // token-bearing (relay url + grant key)
      memoryConnections: await this.desiredMemoryConnections(daemonId, ownedAgents),
      leases: desiredLeases,
      relays: [], // relay roster — populated once CP relay orchestration lands (shared-bot-relay.md A2)
      collabRoutes, // bot-agnostic collaboration routing snapshot (agent-collaboration P2)
      drop: {
        assignments: dropAssignments,
        crons: dropCrons,
        agents: dropAgents,
        integrations: dropIntegrations
      }
    }
  }

  /**
   * The proxied MCP defs THIS daemon should hold, keyed on the agents it SERVES
   * (placed on it or held by duty) rather than on placement — see
   * `orchestrator/agentDefinitions.ts` for the projector and its security note.
   */
  private async desiredMcpServers(daemonId: DaemonId, agents: readonly AgentRecord[]): Promise<McpServerSpec[]> {
    return mcpDefsForAgents(agents, this.orch?.mcp, this.orch?.log, { daemonId })
  }

  /** Connection defs referenced by the agents this daemon serves — same union. */
  private async desiredMemoryConnections(
    daemonId: DaemonId,
    agents: readonly AgentRecord[]
  ): Promise<MemoryConnectionSpec[]> {
    return memoryDefsForAgents(agents, this.orch?.memory, this.orch?.log, { daemonId })
  }

  // ── Live placement / rebalance (Phase 3) ──────────────────────────────────

  /** Candidate pool: reachable, READY daemons with spare capacity, least-loaded first. */
  private candidates(): DaemonConnState[] {
    return this.must()
      .registry.reachableDaemons()
      .filter((d) => d.state === 'READY' && d.load.agents < d.maxAgents)
      .sort((a, b) => a.load.agents - b.load.agents)
  }

  /**
   * Place (or keep) a session on a daemon. Affinity: if a reachable daemon
   * already owns the active row, keep it. Otherwise pick the least-loaded
   * candidate, bump ITS routingEpoch, write the C6 row under that epoch, and
   * issue the fenced `route/assign`. Returns the owning daemonId.
   */
  async placeSession(key: SessionKey, agentId: string, workspaceId: string): Promise<string> {
    const orch = this.must()

    const existingOwner = orch.registry.ownerOf(key)
    if (existingOwner?.reachable && existingOwner.state === 'READY') return existingOwner.daemonId

    const cand = this.candidates()[0]
    if (!cand) throw new NoCapacity(key)

    const routingEpoch = await orch.epoch.bumpRoutingEpoch(toDaemonId(cand.daemonId))
    await this.assignments.assign(
      key,
      toAgentId(agentId),
      toDaemonId(cand.daemonId),
      workspaceId,
      BigInt(cand.sessionEpoch),
      routingEpoch
    )
    orch.registry.bindSession(key, cand.daemonId)
    // Reflect the added load so a second placement in the same tick balances.
    cand.load.agents += 1
    await orch.sender.routeAssign(cand.daemonId, {
      sessionKey: key,
      agentId,
      workspaceId,
      bindRules: []
    })
    return cand.daemonId
  }

  /** Watchdog freeze: hold a daemon's active assignments (no reassignment yet, §4.9). */
  async freeze(daemonId: DaemonId): Promise<void> {
    await this.assignments.freeze(daemonId)
    const c = this.orch?.registry.get(daemonId)
    if (c) c.reachable = false
  }

  /**
   * Watchdog hook: a daemon missed its beats. Freeze its routing (do NOT reassign
   * yet — the daemon may still be serving from its local cache). Rebalancing is
   * deferred to `rebalanceFrom` after the reassign grace (§4.9, split-brain guard).
   */
  onDaemonUnreachable(daemonId: DaemonId): void {
    void this.freeze(daemonId)
  }

  /**
   * Rebalance every session off `daemonId`. If the daemon is still reachable,
   * `daemon/drain` it and reassign **only after** `drain/done` (no double-assign
   * window, §5.3). If it is already unreachable (watchdog grace elapsed), the
   * frozen sessions are reassigned straight away under a new epoch.
   */
  async rebalanceFrom(daemonId: DaemonId): Promise<void> {
    const orch = this.must()
    const owned = await this.assignments.activeForDaemon(daemonId)
    if (owned.length === 0) return

    const conn = orch.registry.get(daemonId)
    const reachable = conn?.reachable === true

    if (reachable) {
      // Graceful path: freeze, drain, and only THEN reassign the released set.
      await this.assignments.freeze(daemonId)
      const deadline = new Date(orch.clock.now() + orch.config.ACK_TIMEOUT_MS).toISOString()
      const done = await orch.sender.drain(daemonId, { kind: 'daemon' }, deadline)
      const releasedKeys = new Set(done.released.map(sessionKeyStr))
      // Reassign each released session under a fresh epoch on a new owner.
      for (const a of owned) {
        const key = recordToSessionKey(a)
        if (!releasedKeys.has(sessionKeyStr(key))) continue
        await this.reassign(key, a)
      }
    } else {
      // Forced path: the daemon is gone (grace elapsed). Reassign the frozen set.
      for (const a of owned) {
        await this.reassign(recordToSessionKey(a), a)
      }
    }
    orch.registry.remove(daemonId)
  }

  /** Release a session in C6, then place it fresh on a new owner under a new epoch. */
  private async reassign(key: SessionKey, a: AssignmentRecord): Promise<void> {
    const orch = this.must()
    await this.assignments.release(key, new Date(orch.clock.now()))
    orch.registry.releaseSession(key)
    await this.placeSession(key, a.agentId, a.workspaceId)
  }
}

// Re-export the legacy alias used by the original module name.
export { Placement as PlacementService }

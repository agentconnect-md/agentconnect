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
  McpServerSpec,
  MemoryConnectionSpec,
  RelayRosterEntry
} from '@agentconnect.md/protocol'
import { RESERVED_MCP_SERVER_NAME } from '@agentconnect.md/protocol'
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
  BotRepo,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  McpProviderRepo,
  McpGrantRepo,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryGrantRepo,
  MemoryPluginInstallationRepo
} from '../persistence/ports.js'
import { isDirectConversationKind } from '../persistence/ports.js'
import { mcpProxyDef, relayHttpOrigin } from './mcpProvider.js'
import { memoryConnectionSpec, stdioMemoryConnectionSpec } from './memoryConnection.js'
import type { DaemonId } from '../domain/ids.js'
import { AgentId as toAgentId, DaemonId as toDaemonId } from '../domain/ids.js'
import { sessionKeyStr, type SessionKey } from '../domain/sessionKey.js'
import { toDbPlatform } from '../persistence/platform.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import { buildCollabSnapshot } from './collabSnapshot.js'
import type { ConnectionRegistry, DaemonConnState } from '../ws/registry.js'
import type { ControlSender } from './outbound.js'
import type { EpochService } from './epoch.js'
import type { Clock } from '../domain/clock.js'

/** The narrow service the register handler depends on (design §2.3 `Orchestrator.reconcile`). */
export interface ReconcileService {
  reconcile(daemonId: DaemonId, req: RegisterReq): Promise<RegisterOk>
}

/** Minimal view of the relay roster the reconcile MCP block picks a proxy base from. */
export interface RelayRosterView {
  entries(): Promise<RelayRosterEntry[]>
}

/** The live-orchestration collaborators Placement needs beyond the C6 repos. */
export interface PlacementOrchDeps {
  registry: ConnectionRegistry
  sender: ControlSender
  epoch: EpochService
  clock: Clock
  config: { REASSIGN_GRACE_SEC: number; ACK_TIMEOUT_MS: number }
  /** MCP-proxy reconcile bundle (centralized-tool-management.md §7): the org providers
   *  a daemon's agents enabled, their active grant keys, and the relay roster to pick a
   *  proxy base from. Grouped here (not positional repos) so the whole concern is one
   *  optional seam — absent (tests / no orch) ⇒ reconcile ships no MCP defs. */
  mcp?: { providers: McpProviderRepo; grants: McpGrantRepo; relayRoster: RelayRosterView }
  memory?: {
    connections: ExternalMemoryConnectionRepo
    installations: MemoryPluginInstallationRepo
    secrets: ExternalMemoryConnectionSecretStore
    grants: ExternalMemoryGrantRepo
    relayRoster: RelayRosterView
  }
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
 * The Off channels of an UNGATED integration — its `mutedChannels` fence.
 *
 * An ungated integration reaches every conversation through unscoped defaults
 * (@-mention anywhere + DMs), which no channel-scoped rule can subtract from, so Off
 * has to be stated rather than merely omitted. A GATED integration needs none of
 * this: its rules are conversation-scoped already, so Off IS the missing rule, and
 * naming the channel here would only give the same fact two representations that can
 * disagree — hence the empty list.
 *
 * DIRECT rows never mute. A preserved one is inert on an ungated integration (§14.4 —
 * the console hides it), and a gated integration expresses its Off DMs the same way it
 * expresses every other Off conversation.
 */
function mutedChannelIds(channels: IntegrationChannelRecord[], gated: boolean): string[] {
  if (gated) return []
  return channels.filter((c) => c.trigger === 'off' && !isDirectConversationKind(c.kind)).map((c) => c.channelId)
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
export function integrationToSpec(
  i: IntegrationRecord,
  secret: BotSecretMaterial,
  channels: IntegrationChannelRecord[] = [],
  gated = false
): IntegrationSpec {
  // A preserved DIRECT row (§14.4) is inert here. Its "any message" was an editor's
  // choice while the agent was restricted, and the console hides the row once it is
  // not — honouring it would leave an org-visible agent answering every message in a
  // conversation with no visible control to turn it off. Such an agent reaches its DMs
  // through the unscoped dm default and a group DM through the unscoped mention default.
  const channelRules: IntegrationBindRule[] = channels
    .filter((c) => c.trigger === 'any' && !isDirectConversationKind(c.kind))
    .map((c) => ({ channel: c.channelId, match: { kind: 'auto' as const } }))
  const bindRules = gated ? gatedBindRules(channels) : [...DEFAULT_BIND_RULES, ...channelRules]
  const mutedChannels = mutedChannelIds(channels, gated)
  // §6.4 emission flip (gate 2 closed): the legacy nested block is no longer
  // emitted — the fleet's dual-shape reader (write-integration.ts) validates the
  // opaque `config` against the same wire schema and takes the routing knobs
  // from `core`. The nested members stay OPTIONAL in the wire schema until the
  // legacy readers retire.
  const core = { mode: 'direct' as const, bindRules, mutedChannels, gated }
  if (i.platform === 'telegram') {
    const telegram = { botToken: secret.botToken, bindRules, mutedChannels, gated }
    return { integrationId: i.id, agentId: i.agentId, platform: 'telegram', core, config: telegram }
  }
  if (i.platform === 'discord') {
    // Discord authenticates the Gateway with the single bot token (no appToken).
    const discord = { botToken: secret.botToken, bindRules, mutedChannels, gated }
    return { integrationId: i.id, agentId: i.agentId, platform: 'discord', core, config: discord }
  }
  if (i.platform === 'feishu') {
    // Feishu authenticates the WSClient with an appId + appSecret pair, stored in the
    // two-slot bot_secret: botToken = appSecret (the secret), appToken = appId. The
    // region (feishu.cn vs larksuite.com) rides on the integration row; NULL ⇒ 'feishu'.
    const feishu = {
      mode: 'direct' as const,
      appId: secret.appToken ?? '',
      appSecret: secret.botToken,
      region: i.feishuRegion ?? 'feishu',
      bindRules,
      mutedChannels,
      gated
    }
    return { integrationId: i.id, agentId: i.agentId, platform: 'feishu', core, config: feishu }
  }
  // 'direct' (transport==='socket') — this daemon owns the Socket Mode connection.
  // The 'shared' wire variant (transport==='http', xoxb-only, no appToken/bindRules)
  // is assembled by the HTTP-bot path, which reads the bot's `transport`; this mapper
  // is always direct. A socket bot is single-agent, so it is never shareable. Slack
  // always stores an app-level token (Socket Mode).
  const slack = {
    mode: 'direct' as const,
    shareable: false,
    botToken: secret.botToken,
    appToken: secret.appToken ?? '',
    bindRules,
    mutedChannels,
    gated
  }
  return { integrationId: i.id, agentId: i.agentId, platform: 'slack', core, config: slack }
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
export function httpIntegrationToSpec(
  i: IntegrationRecord,
  secret: BotSecretMaterial,
  shareable: boolean,
  channels: IntegrationChannelRecord[] = [],
  gated = false,
  providerAppId?: string,
  botUserId?: string
): IntegrationSpec {
  // §6.4 emission flip (see integrationToSpec): envelope + opaque config only.
  const httpCore = {
    mode: 'shared' as const,
    bindRules: gated ? gatedBindRules(channels) : [],
    mutedChannels: mutedChannelIds(channels, gated),
    gated
  }
  if (i.platform === 'feishu') {
    const feishu = {
      mode: 'shared' as const,
      appId: secret.appToken ?? '',
      appSecret: secret.botToken,
      ...(botUserId ? { botOpenId: botUserId } : {}),
      region: i.feishuRegion ?? 'feishu',
      bindRules: httpCore.bindRules,
      mutedChannels: httpCore.mutedChannels,
      gated
    }
    return { integrationId: i.id, agentId: i.agentId, platform: 'feishu', core: httpCore, config: feishu }
  }
  // `shareable` gates the daemon's in-thread "Switch agent" control: an HTTP bot
  // routes through the relay either way, but only a multi-agent (shareable) bot has
  // something to switch to.
  const slack = {
    mode: 'shared' as const,
    shareable,
    botToken: secret.botToken,
    ...(providerAppId ? { appId: providerAppId } : {}),
    bindRules: httpCore.bindRules,
    mutedChannels: httpCore.mutedChannels,
    gated
  }
  return { integrationId: i.id, agentId: i.agentId, platform: 'slack', core: httpCore, config: slack }
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
    orch?: PlacementOrchDeps
  ) {
    this.orch = orch
  }

  private must(): PlacementOrchDeps {
    if (!this.orch) throw new Error('Placement: orchestration deps not configured')
    return this.orch
  }

  async reconcile(daemonId: DaemonId, req: RegisterReq): Promise<RegisterOk> {
    const daemon = await this.daemons.get(daemonId)
    if (!daemon) {
      // Should not happen — auth created the row — but stay defensive.
      throw new Error(`reconcile: unknown daemon ${daemonId}`)
    }

    const [activeAssignments, ownedAgents, daemonCrons, activeLeases, activeIntegrations] = await Promise.all([
      this.assignments.activeForDaemon(daemonId),
      this.agents.listForDaemon(daemonId),
      this.crons.listForDaemon(daemonId),
      this.leases.activeForDaemon(daemonId),
      this.integrations.activeForDaemon(daemonId)
    ])

    const quarantinedAgentIds = new Set<string>()
    // Conversation gating (§14): derived per-agent from restricted visibility. This
    // is a data-plane read of the DERIVED boolean only — identities never ride the
    // wire, and the roster itself stays unfiltered (§9 graceful degradation).
    const gatedAgentIds = new Set(ownedAgents.filter((a) => a.visibility === 'restricted').map((a) => a.id))
    const [desiredAgents, assembledIntegrations] = await Promise.all([
      this.specs.assembleAll(ownedAgents, (agent) => {
        quarantinedAgentIds.add(agent.id)
        this.orch?.log?.warn({ agentId: agent.id }, 'quarantining agent with an unsafe historical git repository')
      }),
      Promise.all(
        activeIntegrations.map(async (i) => {
          const [secret, channels, bot] = await Promise.all([
            this.botSecrets.get(i.botId),
            this.integrationChannels.listForIntegration(i.id),
            this.bots.get(i.botId)
          ])
          if (!secret) return null
          // An http-transport bot's ingest is on the relay pool — the daemon
          // reconciles it send-only (no Socket Mode). Socket bots reconcile as direct.
          const gated = gatedAgentIds.has(i.agentId)
          return bot?.transport === 'http'
            ? httpIntegrationToSpec(
                i,
                secret,
                bot.shareable,
                channels,
                gated,
                bot.slackAppId ?? undefined,
                bot.botUserId ?? undefined
              )
            : integrationToSpec(i, secret, channels, gated)
        })
      )
    ])

    // Integrations FILTERED to this daemon (via agent.daemonId) — each carries
    // plaintext tokens, so this must never be the org-wide set. Tokens are pulled
    // from the secret store (the only decrypt/read seam); NEVER log this array.
    // ALL platforms belong in the roster (Slack + Telegram): the roster is the
    // backstop when the live integration/upsert was skipped (daemon offline) or
    // no-op'd (agent.json not on disk yet), so filtering to one platform silently
    // strands the others' tokens off the daemon. integrationToSpec emits the
    // right per-platform variant.
    const desiredIntegrations = assembledIntegrations.filter(
      (spec): spec is IntegrationSpec => spec !== null && !quarantinedAgentIds.has(spec.agentId)
    )

    const desiredAssignments = activeAssignments
      .filter((assignment) => !quarantinedAgentIds.has(assignment.agentId))
      .map(assignmentToRoute)
    // The agent-config replica for THIS daemon: only the agents placed on it
    // (1 agent : 1 machine). A daemon never receives specs for agents owned by
    // other machines. Unplaced agents (daemonId null) go to no daemon. The daemon
    // converges its replica to this set (CP wins); live edits ride
    // `agent/upsert`/`agent/remove`; this snapshot is the reconnect backstop.
    // The assembler owns secret loading + icon bases — same spec shape as the
    // live agent/upsert emit, structurally. Historical unsafe repository rows
    // are quarantined above without stranding the rest of this daemon's roster.
    // Crons FILTERED to this daemon (via agent.daemonId) — a cron drives one
    // agent, so its def lands only on that agent's daemon (same rule as
    // integrations above). Orphaned rows map to null and are never pushed.
    const desiredCrons = daemonCrons
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
    const [placements, orgDirectory] = await Promise.all([
      this.integrations.channelPlacements(daemon.orgId),
      this.agents.orgDirectory(daemon.orgId)
    ])
    const collabRoutes = buildCollabSnapshot(daemon.orgId, placements, Number(daemon.routingEpoch), orgDirectory)

    // drop = localState − desired. Agent/integration replicas need an explicit
    // ownership proof so hand-authored local config survives. A legacy replica
    // has origin=unknown; prune it only while its durable CP row still proves it
    // belongs elsewhere (the backstop for moves missed while this daemon was
    // disconnected). New replicas carry origin=cp and can also converge a missed
    // delete after the durable row is gone.
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
      staleAgentCandidates.length ? this.agents.list(daemon.orgId) : Promise.resolve([]),
      staleIntegrationCandidates.some((i) => i.origin === 'unknown')
        ? this.integrations.listForOrg(daemon.orgId)
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

    return {
      routingEpoch: Number(daemon.routingEpoch), // re-issue same — convergence, not bump
      // Transport capabilities are connection-level and register.ts replaces
      // this neutral snapshot value immediately before register/ok is sent.
      serverFeatures: [],
      assignments: desiredAssignments,
      agents: desiredAgents, // full spec-set the daemon replicates (direct-edge launch needs a local replica)
      crons: desiredCrons,
      integrations: desiredIntegrations, // daemon-scoped platform integrations (token-bearing)
      mcpServers: await this.desiredMcpServers(daemonId), // proxied MCP defs (relay url + grant key; token-bearing)
      memoryConnections: await this.desiredMemoryConnections(daemonId),
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
   * The proxied MCP defs THIS daemon should hold: for every org provider one of its
   * placed agents enabled by name (`activeForDaemon`), a relay-proxied `http` def
   * carrying the RELAY proxy URL + the provider's active plaintext grant key —
   * NEVER the upstream url or its secret (centralized-tool-management.md §7).
   * Token-bearing result: NEVER log it. Reserved name excluded (the daemon injects
   * its own `agentconnect` server). No relay live ⇒ skip (backstop is the next
   * register once a relay appears).
   */
  private async desiredMcpServers(daemonId: DaemonId): Promise<McpServerSpec[]> {
    const mcp = this.orch?.mcp
    if (!mcp) return []
    const providers = (await mcp.providers.activeForDaemon(daemonId)).filter((p) => p.name !== RESERVED_MCP_SERVER_NAME)
    if (providers.length === 0) return []
    const relay = (await mcp.relayRoster.entries())[0]
    if (!relay) {
      this.orch?.log?.warn({ daemonId }, 'reconcile: MCP providers enabled but no live relay — skipping MCP defs')
      return []
    }
    // The roster url is the relay's rd/* WS dial address; the MCP proxy is HTTP on the
    // same origin — normalize wss→https so the `http` def points at a reachable endpoint.
    const relayBaseUrl = relayHttpOrigin(relay.url)
    const specs: McpServerSpec[] = []
    for (const p of providers) {
      const grant = (await mcp.grants.activeForProvider(p.id))[0]
      if (grant) specs.push(mcpProxyDef(p, grant.key, relayBaseUrl))
    }
    return specs
  }

  /** Daemon-private connection defs referenced by agents placed on this daemon. */
  private async desiredMemoryConnections(daemonId: DaemonId): Promise<MemoryConnectionSpec[]> {
    const memory = this.orch?.memory
    if (!memory) return []
    const connections = await memory.connections.activeForDaemon(daemonId)
    if (connections.length === 0) return []
    const relay = (await memory.relayRoster.entries())[0]
    const relayBaseUrl = relay ? relayHttpOrigin(relay.url) : undefined
    const specs: MemoryConnectionSpec[] = []
    let skippedRemote = false
    for (const connection of connections) {
      const installation = await memory.installations.get(connection.installationId)
      if (!installation) continue
      if (installation.transport === 'stdio') {
        const secrets = (await memory.secrets.get(connection.id)) ?? {}
        specs.push(stdioMemoryConnectionSpec(connection, installation, secrets))
        continue
      }
      if (!relayBaseUrl) {
        skippedRemote = true
        continue
      }
      const [grant, secretKeys] = await Promise.all([
        // Rotation overlaps old+new grants until every projection has the fresh
        // key. Prefer the newest active grant so a reconnect in that window does
        // not receive the key that is about to be retired.
        memory.grants.activeForConnection(connection.id).then((rows) => rows.at(-1)),
        memory.secrets.keys(connection.id)
      ])
      if (!grant) continue
      specs.push(memoryConnectionSpec(connection, installation, secretKeys, grant.key, relayBaseUrl))
    }
    if (skippedRemote) {
      this.orch?.log?.warn(
        { daemonId },
        'reconcile: remote external memory connections have no live relay — local stdio definitions remain available'
      )
    }
    return specs
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

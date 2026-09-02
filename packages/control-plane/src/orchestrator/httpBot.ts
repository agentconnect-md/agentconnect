/**
 * `HttpBotOrchestrator` (shared-bot-relay.md §4.2 / §5 / §10) — the CP convergence
 * seam for HTTP-transport bots. It broadcasts each bot's ingress assignment to the
 * relay pool, compiles the ATTRIBUTED routing table (conversation ownership → keyword →
 * default agent), and delivers the send-only integration spec (wire mode `shared`)
 * to each member agent's daemon.
 *
 * It is invoked on every event that can change an HTTP bot's assignment or routes:
 * an install / uninstall, a transport or shareable toggle, a
 * per-conversation default-agent change, and — for failover — a relay (re)register or
 * sweep. Every method is idempotent: it recomputes from the DB and pushes the
 * result, so a missed push self-heals on the next call.
 *
 * "CP never sees message content" is preserved: this only ever ships credentials
 * + routing tables to relays and send-only specs to daemons — never a message.
 * Secret material (`secrets`, tokens) MUST NEVER be logged.
 */
import type {
  AttributedRoute,
  RcBotAssign,
  RcConversationDefault,
  BindMatch,
  RcThreadAssign,
  RcThreadParticipant,
  RcThreadLookup,
  RcThreadLookupOk
} from '@agentconnect.md/protocol'
import { manifestFor } from '@agentconnect.md/protocol'
import type {
  BotRepo,
  BotRecord,
  BotSecretStore,
  BotCredentialWriter,
  BotSecretMaterial,
  IntegrationRepo,
  IntegrationRecord,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  ChannelTrigger,
  ConversationKind,
  ReportedChannel,
  AgentRepo,
  AgentRecord,
  ThreadAffinityStore,
  SessionRepo
} from '../persistence/ports.js'
import type { RelayChannel, RelayRegistry } from '../ws/relay-registry.js'
import { ControlSender, NoConnection } from './outbound.js'
import { isGatedAgent, httpIntegrationToSpec } from './placement.js'
import type { GatedDmSeedResolver } from './linkedDm.js'
import type { AgentDelivery } from './agentDelivery.js'
import { PLACEMENT_ONLY, type PlacementResolver } from './placementResolver.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import { AgentId, BotId, DaemonId } from '../domain/ids.js'

export interface HttpBotLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  debug?(obj: unknown, msg?: string): void
}

/** The compiled routing table for one HTTP bot (relay-agnostic). */
interface Compiled {
  /** The bot row's own OPEN platform id (S1a `Platform` policy) — rides
   *  `rc/bot-assign.platform` verbatim; the relay's assign handler refuses an
   *  id it has no ingress plugin for, gracefully. */
  platform: string
  members: { daemonId: string; agentIds: string[] }[]
  /** Member directory (id→name→daemon) for the relay's config-modal selector. */
  agents: { agentId: string; name: string; daemonId: string; integrationId: string }[]
  routes: AttributedRoute[]
  defaultAgentId?: string
  defaultDaemonId?: string
  /** Members whose ingress is conversation-gated (resource-visibility.md §14). */
  gatedAgentIds: string[]
  /** Every Off conversation — the relay's subtractive fence over the rungs no missing
   *  route can suppress (keyword, `defaultAgentId`, thread continuity). */
  mutedChannels: string[]
  /** The muted conversations whose owner is GATED: Off because §14 has not enabled them,
   *  so they keep the one-time notice. Every other muted channel is silent. */
  gatedOffChannels: string[]
  /** Every membership row of the bot, read once for the compile and reused by the
   *  spec push (both need the per-install trigger state). */
  botChannels: IntegrationChannelRecord[]
  /** DM conversation ids whose §14.3 notice was ACTUALLY DELIVERED — the
   *  pool-wide latch for single-copy DM messages (never row-derived: discovery
   *  without delivery must not latch). */
  noticedDmConversations: string[]
  /** Placed member integrations (spec push targets: daemonId + integration). */
  placed: { integration: IntegrationRecord; agent: AgentRecord; daemonId: string; gated: boolean }[]
  /** Per-conversation defaults (linear-integration.md §6.2): each row's owner, on a
   *  platform whose rows compile to the relay's default rung instead of to an ownership
   *  route. Empty everywhere else, where the owner is a channel-scoped route. */
  conversationDefaults: RcConversationDefault[]
  /** Whether that projection is what this platform does with a row's owner — carried on
   *  the assignment so the relay picks the terminal affinity refusal without a platform name. */
  ownerAsDefault: boolean
}

/** Resolve a persisted owner marker to its active integration, falling back to
 * the earliest active install for new or legacy ownerless conversations. */
export function pickConversationOwner(
  installs: IntegrationRecord[],
  rows: IntegrationChannelRecord[]
): IntegrationRecord | undefined {
  const assigned = new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))
  return installs.find((integration) => assigned.has(integration.agentId)) ?? installs[0]
}

export function conversationOwnerRow(
  owner: IntegrationRecord | undefined,
  rows: IntegrationChannelRecord[]
): IntegrationChannelRecord | undefined {
  return owner
    ? (rows.find((row) => row.agentId === owner.agentId) ??
        rows.find((row) => row.integrationId === owner.id) ??
        rows[0])
    : undefined
}

export class HttpBotOrchestrator {
  private readonly conversationMutationChains = new Map<string, Promise<unknown>>()

  constructor(
    /** Every bot read here is `getUnscoped`: this is the orchestration trust
     *  domain (org-scoped-data-layer.md §4) — convergence is driven by a bot id
     *  that arrived from relay ingress, a relay-reported lifecycle event, or a
     *  route that already resolved the row through its own org fence, and the
     *  organization is derived from the row itself. */
    private readonly bots: BotRepo,
    private readonly botSecret: BotSecretStore,
    private readonly botCredential: BotCredentialWriter,
    private readonly integrations: IntegrationRepo,
    private readonly channels: IntegrationChannelRepo,
    private readonly agents: AgentRepo,
    private readonly relayReg: RelayRegistry,
    private readonly control: ControlSender,
    private readonly threads: ThreadAffinityStore,
    private readonly sessions: SessionRepo,
    private readonly log: HttpBotLog,
    /** §9 platform providers — the ONLY source of the `rc/bot-assign` credential
     *  and demux bags, and (through `httpIntegrationToSpec`) of a send-only
     *  spec's payload. Late-bound in the composition root; every read happens at
     *  sync/replay time. */
    private readonly platforms: CpPlatformRegistry,
    /** Resolves where a dependent of an agent goes (placement ∪ duty holders).
     *  Used ONLY for the send-only spec and its removal — the relay's own
     *  `rc/assign` target is one member, resolved below. */
    private readonly agentDelivery: AgentDelivery,
    /** Names the one member the relay addresses ingress to. Placement when it names a machine;
     *  for a pool agent, the member currently holding its duty — placement names none. */
    private readonly placement: Pick<PlacementResolver, 'routableDaemon'> = PLACEMENT_ONLY,
    /** §14.8: which of a gated install's reported DMs seed to the ordinary DM default
     *  because their counterpart is in the agent's own audience. Late-bound in the
     *  composition root; absent ⇒ every gated conversation keeps the §14.2 Off default. */
    private readonly gatedDmSeeds?: GatedDmSeedResolver
  ) {}

  /**
   * Converge one bot: BROADCAST `rc/bot-assign` to every connected relay (whole-pool
   * ingress — any pod may receive an inbound Events API POST via the stable
   * PUBLIC_RELAY_URL LB) + deliver the send-only spec to each member daemon. A
   * non-http / empty bot is released. Safe to call for a socket bot (no-op after
   * the release check).
   */
  async syncBot(botId: string): Promise<void> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    if (!bot) return
    if (bot.transport !== 'http' || bot.agentIds.length === 0) {
      await this.unassign(bot)
      return
    }
    const compiled = await this.compile(bot)
    if (!compiled) {
      await this.unassign(bot)
      return
    }
    const secret = await this.botSecret.get(bot.orgId, bot.id)
    if (!secret) {
      this.log.warn({ botId }, 'http-bot: no secret for http bot — cannot assign')
      return
    }
    const missing = this.missingAssignSecrets(bot, secret)
    if (missing.length > 0) {
      // The relay would arm an ingress it cannot verify. Which slots are load-
      // bearing is the platform's declaration (§9 `secretShape.httpAssignRequires`),
      // not core's knowledge.
      this.log.warn(
        { botId, platform: bot.platform, missing },
        'http-bot: incomplete callback credentials — cannot assign'
      )
      return
    }

    if (this.relayReg.all().length === 0) {
      // No connected relay to host the ingest — the register replay re-fans when one
      // (re)connects (reconcileAll / replayTo).
      this.log.warn({ botId }, 'http-bot: no connected relay available — deferring placement')
      return
    }

    const assign = await this.buildAssign(bot, compiled, secret)
    if (!assign) {
      // No `projectBotAssign` ⇒ no relay path for this platform (§9). Nothing to
      // broadcast, and no send-only spec either: an unassigned bot has no ingress.
      this.log.warn({ botId, platform: bot.platform }, 'http-bot: platform contributes no relay ingress — skipping')
      return
    }
    this.broadcast((ch) => ch.send('rc/bot-assign', assign))
    this.log.info(
      { botId: bot.id, members: compiled.members.length, routes: compiled.routes.length },
      'http-bot: broadcast assign to relay pool'
    )
    await this.pushSpecs(compiled, secret, bot)
  }

  /**
   * A routes-only change (a per-conversation default agent, a trigger flip) on an
   * already-placed bot: hot-update the relay's table via `rc/routes` (no ingest
   * re-open). Falls back to a full `syncBot` if the bot isn't placed on a
   * connected relay yet.
   */
  async syncRoutes(botId: string): Promise<void> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    if (!bot || bot.transport !== 'http' || bot.agentIds.length === 0) return this.syncBot(botId)
    if (this.relayReg.all().length === 0) return this.syncBot(botId) // nobody connected → defer
    const compiled = await this.compile(bot)
    if (!compiled) return this.unassign(bot)
    this.broadcast((ch) =>
      ch.send('rc/routes', {
        botId: bot.id,
        members: compiled.members,
        agents: compiled.agents,
        routes: compiled.routes,
        ...(compiled.defaultAgentId ? { defaultAgentId: compiled.defaultAgentId } : {}),
        ...(compiled.defaultDaemonId ? { defaultDaemonId: compiled.defaultDaemonId } : {}),
        gatedAgentIds: compiled.gatedAgentIds,
        mutedChannels: compiled.mutedChannels,
        gatedOffChannels: compiled.gatedOffChannels,
        noticedDmConversations: compiled.noticedDmConversations,
        // An owner edit converges here without a re-assign, so the defaults must ride the hot
        // update too — otherwise a connected relay keeps the old default, and the old grant.
        conversationDefaults: compiled.conversationDefaults,
        ...(this.noticeAuthorityFor(bot.id) ? { noticeAuthority: this.noticeAuthorityFor(bot.id) } : {})
      })
    )
    const secret = await this.botSecret.get(bot.orgId, bot.id)
    if (secret) await this.pushSpecs(compiled, secret, bot)
  }

  /** Release a bot from the relay pool (transport flipped / uninstalled / last
   *  install removed): broadcast `rc/bot-unassign` to every connected relay. */
  async unassign(bot: BotRecord, opts?: { credentialRevision?: number }): Promise<void> {
    this.broadcast((ch) =>
      ch.send('rc/bot-unassign', {
        botId: bot.id,
        // Only a REVOCATION stamps this: it is the one release that races a
        // re-install, and the relay drops it if it already holds a newer
        // assignment. Transport flips / un-shares / last-install-removed are
        // unconditional (they do not describe a credential generation).
        ...(opts?.credentialRevision !== undefined ? { credentialRevision: opts.credentialRevision } : {})
      })
    )
  }

  /**
   * `rc/bot-revoked` — the workspace uninstalled the app / revoked its tokens
   * (preset-agents.md §5.3 lifecycle). The bot's credential is dead: mark the Bot
   * + its installs revoked, release the relay ingest, and pull the send-only
   * specs from member daemons (mirrors the integration DELETE route's push).
   * Idempotent — a duplicate report finds no active installs and only re-stamps.
   *
   * GENERATION-FENCED. Slack does not order `app_uninstalled`/`tokens_revoked`,
   * so a delayed event from a prior install can arrive after the workspace has
   * re-installed; applying it would revoke a live, freshly-authorized bot and
   * silently kill its integrations. The compare-and-set refuses that report, and
   * the rest of this method — which is what actually tears the bot down — is
   * skipped with it.
   *
   * The decision and the integration flip are ONE transaction serialized on the
   * bot row (`BotCredentialWriter.revoke`). Committing them separately let a
   * re-install slip in between: it would bump to N+1 and re-activate an install,
   * and the flip would then revoke that FRESH install, leaving a live bot with
   * nothing installed. The external effects below run only after that commit,
   * and re-check the generation first — a re-install that won the row lock
   * broadcasts its own assign, which our `bot-unassign` must not race past.
   */
  async revokeBot(
    botId: string,
    reason: 'app_uninstalled' | 'tokens_revoked',
    fence: { revision?: number; eventAtMs?: number } = {}
  ): Promise<{ applied: boolean }> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    // Unknown bot: nothing to apply and nothing that will ever change that, so
    // this is terminal for the reporting relay — not a reason to keep retrying.
    if (!bot) return { applied: false }
    // Snapshot members BEFORE the flip — listForBot is active-only.
    const installs = await this.integrations.listForBot(bot.id)
    const { applied } = await this.botCredential.revoke(bot.id, new Date(), {
      ...(fence.revision !== undefined ? { revision: fence.revision } : {}),
      ...(fence.eventAtMs !== undefined ? { eventAt: new Date(fence.eventAtMs) } : {})
    })
    if (!applied) {
      this.log.info(
        { botId: bot.id, reason, reportedRevision: fence.revision, currentRevision: bot.credentialRevision },
        'http-bot: stale revoke ignored — credential was replaced since the event'
      )
      return { applied: false }
    }
    // Re-check after the commit: a re-install may have taken the row lock the
    // moment we released it, in which case IT owns the live state and has
    // already broadcast a fresh assign. Emitting the teardown now would tear
    // down a credential we no longer describe.
    const after = await this.bots.getUnscoped(bot.id)
    if (after && after.credentialRevision !== bot.credentialRevision) {
      this.log.info(
        { botId: bot.id, reason, from: bot.credentialRevision, to: after.credentialRevision },
        'http-bot: revoke committed but the credential was replaced — skipping teardown effects'
      )
      // The revocation itself DID commit, so the report is settled.
      return { applied: true }
    }
    // The re-read above narrows the race but cannot close it: a re-install can
    // still commit N+1 and broadcast its assign between that read and this send.
    // Stamping the revoked generation moves the decision to the point of
    // APPLICATION — the relay drops this release if it already holds a newer
    // assignment, so a stale teardown can never kill a live ingest.
    await this.unassign(bot, { credentialRevision: bot.credentialRevision })
    for (const integration of installs) {
      const agent = await this.agents.getUnscoped(integration.agentId)
      if (!agent) continue
      await this.agentDelivery.integrationRemove(agent, integration.id, integration.orgId, (err) => {
        if (!(err instanceof NoConnection)) throw err
        this.log.debug?.({ integrationId: integration.id }, 'http-bot: revoke spec removal skipped — daemon offline')
      })
    }
    this.log.info({ botId: bot.id, reason, installs: installs.length }, 'http-bot: bot revoked by workspace')
    return { applied: true }
  }

  /** Converge EVERY http+active bot — the failover / broad-change worklist. */
  async reconcileAll(): Promise<void> {
    const http = await this.bots.listHttpActive()
    for (const b of http) await this.syncBot(b.id)
  }

  /**
   * Per-relay register replay (whole-pool seed): send `rc/bot-assign` for every
   * http bot with ≥1 active install, plus each persisted thread binding, to ONLY the
   * freshly-registered relay `ch` (no re-broadcast to the whole pool). Sibling of
   * `HookService.replayTo`.
   *
   * KNOWN (low-severity, self-healing): this reads a `listForBot` snapshot and a
   * concurrent live `rc/assign` broadcast to the same just-registered relay could
   * interleave, transiently leaving it one version behind for a thread whose owner
   * changed mid-replay. It re-converges on that thread's next report / this relay's
   * next reconnect; not worth a per-binding version on the wire.
   */
  async replayTo(ch: RelayChannel): Promise<void> {
    const bots = await this.bots.listHttpActive()
    for (const bot of bots) {
      const compiled = await this.compile(bot)
      if (!compiled) continue
      const secret = await this.botSecret.get(bot.orgId, bot.id)
      if (!secret) continue
      if (this.missingAssignSecrets(bot, secret).length > 0) continue
      // Built OUTSIDE the try on purpose: the catch below means "dead socket",
      // and a projector rejection swallowed there would be a lost error rather
      // than a dropped send. A null assign is the platform having no relay path
      // (§9) — nothing to replay for this bot.
      const assign = await this.buildAssign(bot, compiled, secret)
      if (!assign) continue
      try {
        ch.send('rc/bot-assign', assign)
        for (const t of await this.threads.listForBot(bot.id)) {
          ch.send('rc/assign', { botId: bot.id, sessionKey: t.sessionKey, agentId: t.agentId, daemonId: t.daemonId })
        }
        for (const t of await this.threads.participantsForBot(bot.id)) {
          ch.send('rc/participant-assign', {
            botId: bot.id,
            sessionKey: t.sessionKey,
            agentId: t.agentId,
            daemonId: t.daemonId
          })
        }
      } catch {
        // dead socket — its onClose removes it from the registry
      }
    }
  }

  /**
   * Durable thread-affinity REPORT leg (§10 step 3): persist the (botId, sessionKey)
   * → {agentId, daemonId} binding a relay just reported (rc/thread-assign) and
   * BROADCAST it back to every relay (rc/assign) so any pool pod routes the same
   * thread to the same agent. The CP is the single writer.
   */
  async recordThreadAssign(m: RcThreadAssign): Promise<void> {
    await this.threads.upsert(BotId(m.botId), m.sessionKey, AgentId(m.agentId), DaemonId(m.daemonId))
    await this.threads.upsertParticipant(BotId(m.botId), m.sessionKey, AgentId(m.agentId), DaemonId(m.daemonId))
    this.broadcast((ch) =>
      ch.send('rc/assign', { botId: m.botId, sessionKey: m.sessionKey, agentId: m.agentId, daemonId: m.daemonId })
    )
  }

  /** Persist and broadcast one room member without changing single-owner affinity. */
  async recordThreadParticipant(m: RcThreadParticipant): Promise<void> {
    await this.threads.upsertParticipant(BotId(m.botId), m.sessionKey, AgentId(m.agentId), DaemonId(m.daemonId))
    this.broadcast((ch) =>
      ch.send('rc/participant-assign', {
        botId: m.botId,
        sessionKey: m.sessionKey,
        agentId: m.agentId,
        daemonId: m.daemonId
      })
    )
  }

  /** Pull-on-miss BACKSTOP leg (§10): answer a relay's `rc/thread-lookup` from the
   *  persisted binding (`target: null` ⇒ the CP holds none). A binding to a GATED
   *  agent is honoured only while its conversation is still enabled (§14) — a
   *  thread bound before the gate was applied must not keep re-seeding relay
   *  affinity forever.
   *
   *  `mode: 'stop'` answers GRANT-BLIND (linear-integration.md §9.3): a stop can only end
   *  work, so it must still reach the runtime that holds the session after a conversation's
   *  default moved off its gated holder. It also carries the holder's `integrationId` on
   *  this bot, because the relay pre-addresses the interaction it builds from the answer.
   *  Participants stay out of it: a stop is delivered to the one holder, never fanned. */
  async lookupThread(m: RcThreadLookup): Promise<RcThreadLookupOk> {
    if (m.mode === 'stop') return this.lookupBoundThread(m)
    const channel = m.sessionKey.slice(0, Math.max(m.sessionKey.indexOf('/'), 0)) || m.sessionKey
    const participants = (
      await Promise.all(
        (await this.threads.participants(BotId(m.botId), m.sessionKey)).map(async (participant) =>
          (await this.threadTargetAllowed(m.botId, channel, participant.agentId)) ? participant : null
        )
      )
    ).filter((participant): participant is NonNullable<typeof participant> => participant !== null)
    const t = await this.threads.get(BotId(m.botId), m.sessionKey)
    if (t) {
      if (!(await this.threadTargetAllowed(m.botId, channel, t.agentId))) {
        return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants }
      }
      return {
        botId: m.botId,
        sessionKey: m.sessionKey,
        target: { agentId: t.agentId, daemonId: t.daemonId },
        participants
      }
    }
    // Affinity miss: fall back to session metadata. A session an agent created directly on the
    // daemon (e.g. its own channel-root post, session-concept §7.2 case 2a) never went through
    // the relay's mention/switch REPORT leg, so no `thread-assign` seeded the affinity store —
    // but the daemon reported the session's (channel, thread, agentId, daemonId). Resolve it so an
    // un-mentioned follow-up in that thread still routes to the owning agent instead of dropping.
    // sessionKey is `channel/thread` (relay `sessionKeyOf`); split on the FIRST '/'.
    const slash = m.sessionKey.indexOf('/')
    if (slash > 0) {
      const channel = m.sessionKey.slice(0, slash)
      const thread = m.sessionKey.slice(slash + 1)
      const owner = await this.sessions.findThreadOwner(BotId(m.botId), channel, thread)
      const ambiguous = owner ? await this.sessionOwnerHasSiblingBot(m.botId, owner.agentId) : false
      if (ambiguous && owner) {
        this.log.debug?.(
          { botId: m.botId, agentId: owner.agentId, channel },
          'http-bot: SessionMeta thread owner is ambiguous across bots — leaving the thread unowned'
        )
      }
      // The session names the agent; the member serving it is resolved live, so this fallback
      // covers a pool agent — whose row names no machine — as well as a machine-placed one.
      const target = owner && !ambiguous ? await this.threadOwnerTarget(m.botId, channel, owner.agentId) : null
      if (target) {
        return {
          botId: m.botId,
          sessionKey: m.sessionKey,
          target,
          participants: participants.some((participant) => participant.agentId === target.agentId)
            ? participants
            : [...participants, target]
        }
      }
    }
    return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants }
  }

  /** The Stop-mode answer: the same affinity → `session_meta` ladder, with the §14 grant
   *  check skipped and the holder's install on this bot attached. */
  private async lookupBoundThread(m: RcThreadLookup): Promise<RcThreadLookupOk> {
    const bound = await this.threads.get(BotId(m.botId), m.sessionKey)
    let agentId: string | undefined = bound?.agentId
    if (agentId === undefined) {
      // sessionKey is `channel/thread` (relay `sessionKeyOf`); split on the FIRST '/'.
      const slash = m.sessionKey.indexOf('/')
      if (slash <= 0) return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants: [] }
      const owner = await this.sessions.findThreadOwner(
        BotId(m.botId),
        m.sessionKey.slice(0, slash),
        m.sessionKey.slice(slash + 1)
      )
      // The cross-bot ambiguity guard survives the grant-blind mode: it protects against
      // naming the wrong bot's holder, which no stop may do either.
      if (!owner || (await this.sessionOwnerHasSiblingBot(m.botId, owner.agentId))) {
        return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants: [] }
      }
      agentId = owner.agentId
    }
    const agent = await this.agents.getUnscoped(AgentId(agentId))
    const daemonId = agent ? await this.placement.routableDaemon({ ...agent, id: agent.id }) : null
    if (!daemonId) return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants: [] }
    const install = (await this.integrations.listForBot(BotId(m.botId))).find((i) => i.agentId === agentId)
    return {
      botId: m.botId,
      sessionKey: m.sessionKey,
      target: { agentId, daemonId, ...(install ? { integrationId: install.id } : {}) },
      participants: []
    }
  }

  /** Refuse a bot-agnostic SessionMeta fallback when another live bot can route the same agent in this tenant. */
  private async sessionOwnerHasSiblingBot(botId: string, agentId: string): Promise<boolean> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    if (!bot) return false
    const provider = this.platforms.get(bot.platform)
    const realmOf = (candidate: BotRecord): string | null =>
      provider?.threadFallbackRealm
        ? provider.threadFallbackRealm(candidate)
        : (candidate.externalTenantId ?? candidate.workspaceId ?? candidate.teamId)
    const realm = realmOf(bot)
    if (!realm) return false
    return (await this.bots.listForOrg(bot.orgId)).some((candidate) => {
      return (
        candidate.id !== bot.id &&
        candidate.revokedAt === null &&
        candidate.platform === bot.platform &&
        realmOf(candidate) === realm &&
        candidate.agentIds.some((id) => id === agentId)
      )
    })
  }

  /** The addressable target for a thread owner, or null when the gate refuses it or nothing is
   *  routable. `routableDaemon` and not `servingDaemon`: this seeds relay ingress affinity, so a
   *  member that holds the agent but has not yet reported it must not be named. */
  private async threadOwnerTarget(
    botId: string,
    channel: string,
    agentId: string
  ): Promise<{ agentId: string; daemonId: string } | null> {
    if (!(await this.threadTargetAllowed(botId, channel, agentId))) return null
    const agent = await this.agents.getUnscoped(AgentId(agentId))
    if (!agent) return null
    const daemonId = await this.placement.routableDaemon({ ...agent, id: agent.id })
    return daemonId ? { agentId, daemonId } : null
  }

  /** §14 conversation-gating check for the thread-lookup backstop: a non-gated
   *  target is always allowed; a gated target needs its install's row for this
   *  conversation to be enabled (trigger ≠ off). Fail-closed on missing rows. */
  private async threadTargetAllowed(botId: string, channel: string, agentId: string): Promise<boolean> {
    const agent = await this.agents.getUnscoped(AgentId(agentId))
    if (!agent) return false
    if (!isGatedAgent(agent)) return true
    const installs = await this.integrations.listForBot(BotId(botId))
    const install = installs.find((i) => i.agentId === agentId)
    if (!install) return false
    const rows = await this.channels.listForBot(BotId(botId))
    const row = rows.find((c) => c.integrationId === install.id && c.channelId === channel)
    return !!row && row.trigger !== 'off'
  }

  /** Is at least one relay connected right now? The install-time gate: an HTTP
   *  install with no relay to host the ingest is a deployment misconfig (§6 409). */
  hasConnectedRelay(): boolean {
    return this.relayReg.all().length > 0
  }

  /** Apply the authoritative channel-membership snapshot reported by an HTTP
   *  ingest. Every active integration of the bot represents the same app-level
   *  membership, so fan the snapshot across them, preserving per-install
   *  trigger/owner fields in the repository, then hot-refresh relay routes.
   *
   *  Gated on the §5 manifest's `membershipEnumeration: 'authoritative'` — the
   *  declaration that a platform HAS one cheap whole-bot membership snapshot —
   *  rather than on the platform name. A platform whose set is discovered from
   *  traffic (`'observed'`) has no snapshot to apply and its rows must not be
   *  replaced wholesale; an unknown id gets the fail-closed default and is
   *  ignored, exactly as the retired `!== 'slack'` did.
   *
   *  For an HTTP bot, route compilation converges every reported channel to
   *  exactly one owner. A new or ownerless channel is assigned to the bot's
   *  creating (earliest active) agent, while an existing owner is preserved.
   */
  async replaceChannels(botId: string, channels: ReportedChannel[]): Promise<void> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    if (!bot || manifestFor(bot.platform).membershipEnumeration !== 'authoritative' || bot.transport !== 'http') {
      this.log.warn(
        { botId },
        'http-bot: channel snapshot for an unknown bot, a non-http transport, or a platform without authoritative membership — ignored'
      )
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const integration of installs) {
      // Conversation gating (§14): a gated install's fresh channels start Off — an
      // editor must enable them in the console before the compiler emits a route.
      const owner = await this.agents.getUnscoped(integration.agentId)
      const defaultTrigger = owner && isGatedAgent(owner) ? ('off' as const) : undefined
      await this.channels.replaceSnapshot(integration.id, channels, defaultTrigger ? { defaultTrigger } : undefined)
    }
    await this.syncRoutes(botId)
  }

  /** §14.3 DM notices ACTUALLY DELIVERED (`botId:channel`), reported via
   *  `rc/notice-posted`. Per CP lifetime (a restart allows one fresh notice —
   *  the daemon's own latch semantics); size-bounded. */
  private readonly noticedDms = new Set<string>()

  /** Record one delivered §14.3 DM notice and re-stamp the pool so every pod
   *  latches the conversation. Fire-and-forget from the relay's perspective. */
  async recordNoticePosted(m: { botId: string; channel: string }): Promise<void> {
    const key = `${m.botId}:${m.channel}`
    if (this.noticedDms.has(key)) return
    if (this.noticedDms.size >= 100_000) this.noticedDms.clear()
    this.noticedDms.add(key)
    await this.syncRoutes(m.botId)
  }

  /** §14.3: the relay DETERMINISTICALLY responsible for a bot's one-time gating
   *  notices, chosen from the CONNECTED roster at (re)assign/replay time — pure
   *  config-time orchestration, never a per-message CP round-trip (the CP stays
   *  off the message hot path). Stable while the roster is stable; a roster
   *  change re-broadcasts and moves the authority (its local latch moves too —
   *  per-lifetime notice semantics, matching the daemon). Undefined ⇒ no relay. */
  private noticeAuthorityFor(botId: string): string | undefined {
    const ids = this.relayReg
      .all()
      .map((ch) => ch.relayId)
      .sort()
    if (ids.length === 0) return undefined
    let h = 0
    for (const c of botId) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return ids[h % ids.length]
  }

  /**
   * What a GATED owner's conversation defaults to. Off is §14.2's answer for a room —
   * its membership is a place, and only an editor can vouch for it. A 1:1 DM with a
   * member of the agent's own `sharedWith` audience is §14.8's exception: that person
   * can already see, edit and run the agent in the Console, so closing their DM hides
   * it from someone it was explicitly shared with. Everything else, including every
   * unresolvable case, stays Off.
   */
  private async gatedConversationTrigger(
    agent: AgentRecord,
    bot: Pick<BotRecord, 'platform' | 'teamId'>,
    conversation: { id: string; kind?: ConversationKind; dmUserId?: string | null }
  ): Promise<ChannelTrigger> {
    if (!this.gatedDmSeeds || conversation.kind !== 'im' || !conversation.dmUserId) return 'off'
    const seeds = await this.gatedDmSeeds(
      [{ id: conversation.id, kind: 'im', dmUserId: conversation.dmUserId }],
      agent,
      bot
    )
    return seeds.get(conversation.id) ?? 'off'
  }

  /**
   * Fan an INCREMENTAL direct-conversation report across every install as a
   * `kind:'im'` / `kind:'mpim'` membership row. The shared bot converges the rows to
   * one owner and trigger, just like an enumerated channel; restricted installs still
   * start Off and public installs default a 1:1 DM On or a group DM to Mention.
   */
  async reportConversation(botId: string, conversation: ReportedChannel): Promise<void> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    // A conversation report can only originate from relay ingress, so the gate is
    // the same §9 signal the assign builder runs on: a platform with no
    // `projectBotAssign` has no relay path and no relay can be reporting for it.
    // (This retires the hand-written `slack | feishu` list that used to sit here.)
    if (!bot || !this.platforms.get(bot.platform)?.projectBotAssign || bot.transport !== 'http') {
      this.log.warn({ botId }, 'http-bot: conversation report for a non-http/unknown IM bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const install of installs) {
      const agent = await this.agents.getUnscoped(install.agentId)
      if (!agent) continue
      const kind = conversation.kind === 'mpim' ? ('mpim' as const) : ('im' as const)
      const reported = { ...conversation, kind }
      // Resolved per install, because a shared bot's installs are different agents with
      // different audiences — the same DM may be open for one and Off for the next.
      const defaultTrigger = isGatedAgent(agent)
        ? await this.gatedConversationTrigger(agent, bot, reported)
        : kind === 'im'
          ? ('any' as const)
          : ('mention' as const)
      await this.channels.upsertConversation(install.id, reported, { defaultTrigger })
    }
    await this.syncRoutes(botId)
  }

  /**
   * Update a multi-agent conversation through its bot-level ownership boundary. The selected
   * agent becomes the sole owner, and the conversation trigger follows the conversation when
   * ownership changes instead of reverting to a stale per-install value.
   */
  async updateConversation(
    botId: string,
    channelId: string,
    patch: { agentId?: string; trigger?: ChannelTrigger },
    options: { expectedOwnerAgentId?: string; source?: 'console' | 'slack' } = {}
  ): Promise<IntegrationChannelRecord | null> {
    return this.serializeConversationMutation(botId, channelId, async () => {
      const bot = await this.bots.getUnscoped(BotId(botId))
      if (bot?.transport !== 'http') {
        this.log.warn({ botId }, 'http-bot: update-channel for a non-http/unknown bot — ignored')
        return null
      }
      const installs = await this.integrations.listForBot(bot.id)
      if (installs.length === 0) return null
      const rows = (await this.channels.listForBot(bot.id)).filter((row) => row.channelId === channelId)
      const currentOwner = pickConversationOwner(installs, rows)
      if (options.expectedOwnerAgentId && currentOwner?.agentId !== options.expectedOwnerAgentId) {
        this.log.warn(
          { botId, channelId, expectedOwnerAgentId: options.expectedOwnerAgentId },
          'http-bot: conversation owner changed before update — ignored'
        )
        return null
      }
      const owner = patch.agentId ? installs.find((i) => i.agentId === patch.agentId) : currentOwner
      if (!owner) {
        this.log.warn(
          { botId, agentId: patch.agentId },
          'http-bot: update-conversation for a non-member agent — ignored'
        )
        return null
      }

      const currentRow = conversationOwnerRow(currentOwner, rows)
      const targetAgent = options.source === 'slack' ? await this.agents.getUnscoped(owner.agentId) : null
      let updated = await this.persistConversationOwner(installs, channelId, owner, rows[0])
      const trigger =
        targetAgent && isGatedAgent(targetAgent)
          ? ('off' as const)
          : (patch.trigger ?? currentRow?.trigger ?? rows[0]?.trigger ?? updated.trigger)
      // This call IS the human's action (console patch or the in-Slack modal), so the
      // resulting trigger is a decision on every sibling row, not a default (§14.8).
      await this.syncConversationTrigger(installs, channelId, trigger, rows, { chosen: true })
      updated = { ...updated, trigger }
      await this.syncRoutes(botId)
      return updated
    })
  }

  /** The in-Slack config modal changes only the owner. A workspace user must
   * never enable a restricted agent, so that target always starts Off. */
  async setChannelAgent(botId: string, channelId: string, agentId: string): Promise<void> {
    await this.updateConversation(botId, channelId, { agentId }, { source: 'slack' })
  }

  /** Preserve bot-scoped conversation state before an owner integration is deleted. */
  async prepareIntegrationRemoval(botId: string): Promise<void> {
    const bot = await this.bots.getUnscoped(BotId(botId))
    if (bot?.transport !== 'http') return
    const installs = await this.integrations.listForBot(bot.id)
    await this.ensureConversationOwners(bot.id, installs)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Serialize the owner check and write per conversation. Console authorization
   * happens before this boundary and supplies the owner it authorized; a queued
   * Slack move therefore makes that Console mutation fail closed. */
  private serializeConversationMutation<T>(botId: string, channelId: string, run: () => Promise<T>): Promise<T> {
    const key = `${botId}\u0000${channelId}`
    const previous = this.conversationMutationChains.get(key) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.conversationMutationChains.set(key, settled)
    void settled.finally(() => {
      if (this.conversationMutationChains.get(key) === settled) this.conversationMutationChains.delete(key)
    })
    return result
  }

  /** Store one canonical owner row and clear every sibling install's copy. */
  private async persistConversationOwner(
    installs: IntegrationRecord[],
    channelId: string,
    owner: IntegrationRecord,
    template?: IntegrationChannelRecord
  ): Promise<IntegrationChannelRecord> {
    const ownerAgent = await this.agents.getUnscoped(owner.agentId)
    const defaultTrigger = ownerAgent && isGatedAgent(ownerAgent) ? ('off' as const) : undefined
    const updated = await this.channels.upsertAgent(owner.id, channelId, owner.agentId, {
      ...(defaultTrigger ? { defaultTrigger } : {}),
      ...(template ? { kind: template.kind } : {})
    })
    // Establish the replacement before clearing stale markers: even if a later
    // cleanup write fails, the conversation never regresses to having no owner.
    for (const integration of installs) {
      if (integration.id === owner.id) continue
      await this.channels.setAgent(integration.id, channelId, null)
    }
    return updated
  }

  /** Keep the effective trigger on every active membership row, creating a
   * missing sibling from the best available conversation metadata. Ownership is
   * canonical, but complete repeated state lets owner deletion preserve the
   * channel and trigger even before a new install reports its own snapshot. */
  private async syncConversationTrigger(
    installs: IntegrationRecord[],
    channelId: string,
    trigger: ChannelTrigger,
    knownRows: IntegrationChannelRecord[],
    opts?: { chosen?: boolean }
  ): Promise<void> {
    const known = new Map(knownRows.map((row) => [row.integrationId, row]))
    // Conversation-level metadata, taken PER FIELD from whichever sibling knows it: one
    // row may carry the name while another carries the DM counterpart, and picking a
    // single template row would silently drop whatever that row happens not to know. A
    // committed direct kind wins over 'channel' for the same reason `replaceSnapshot`
    // never downgrades one.
    const first = <T>(get: (row: IntegrationChannelRecord) => T | null | undefined): T | undefined => {
      for (const row of knownRows) {
        const value = get(row)
        if (value !== null && value !== undefined) return value
      }
      return undefined
    }
    const template = {
      name: first((row) => row.name),
      spaceId: first((row) => row.spaceId),
      space: first((row) => row.space),
      dmUserId: first((row) => row.dmUserId),
      isPrivate: first((row) => row.isPrivate) ?? false,
      kind: knownRows.find((row) => row.kind !== 'channel')?.kind ?? knownRows[0]?.kind ?? 'channel'
    }
    for (const integration of installs) {
      const row = known.get(integration.id)
      // A human decision has to reach EVERY sibling row, including one that already
      // carries the value and one this call is about to create. `triggerChosen` is what
      // tells a decision from an untouched default later (§14.8), so under `chosen` a
      // trigger that needs no change is still a write — otherwise the marker would be
      // missing on exactly the rows the shared-bot paths converge, and a later catch-up
      // would read a deliberate Off as pending and reopen it.
      const marked = opts?.chosen !== true || row?.triggerChosen === true
      if (row?.trigger === trigger && marked) continue
      if (!row) {
        // The template carries the CONVERSATION's own metadata, so a sibling gets all
        // of it rather than a subset. `dmUserId` is the load-bearing one: it is the
        // whole §14.8 input, and a sibling that inherits `kind:'im'` without it becomes
        // a DM whose counterpart is unknown — so when owner removal leaves that sibling
        // as the only surviving row, a linked audience member re-derives to Off, and
        // the later report that finally supplies the id cannot reopen a row that
        // already exists.
        const backfilled = await this.channels.upsertConversation(
          integration.id,
          {
            id: channelId,
            ...(template.name ? { name: template.name } : {}),
            ...(template.spaceId ? { spaceId: template.spaceId } : {}),
            ...(template.space ? { space: template.space } : {}),
            ...(template.dmUserId ? { dmUserId: template.dmUserId } : {}),
            isPrivate: template.isPrivate,
            kind: template.kind
          },
          { defaultTrigger: trigger }
        )
        if (backfilled.trigger === trigger && opts?.chosen !== true) continue
      }
      await this.channels.setTrigger(integration.id, channelId, trigger, opts)
    }
  }

  /** Converge every observed conversation to one canonical owner. */
  private async ensureConversationOwners(botId: BotId, installs: IntegrationRecord[]): Promise<void> {
    if (installs.length === 0) return
    const rows = await this.channels.listForBot(botId)
    const conversationIds = [...new Set(rows.map((row) => row.channelId))]
    // Only the gated arm below reads it, and only for a conversation whose owner is
    // not yet persisted — so it is fetched once and lazily rather than per row.
    let bot: BotRecord | null | undefined
    for (const channelId of conversationIds) {
      const conversationRows = rows.filter((row) => row.channelId === channelId)
      const owner = pickConversationOwner(installs, conversationRows)
      if (!owner) continue
      const persistedOwner = conversationRows.some((row) => row.agentId === owner.agentId)
      const ownerRow = conversationOwnerRow(owner, conversationRows)
      // Provenance is CONVERSATION-level, exactly like the trigger it qualifies, and is
      // read from ANY row: a human decides a conversation once, but the decision is
      // repeated per install, and the row that recorded it can be deleted with its
      // integration while siblings survive. Reading it from the owner row alone would
      // lose the decision on precisely the owner-removal path this method exists for.
      const chosen = conversationRows.some((row) => row.triggerChosen)
      let trigger = ownerRow?.trigger
      // A decision outranks every default: a conversation a human has ruled on is not
      // re-derived, whoever ends up owning it. Only an undecided one falls through to
      // the gated rule below.
      if (!persistedOwner && !chosen) {
        const ownerAgent = await this.agents.getUnscoped(owner.agentId)
        // A gated agent inheriting a conversation it never owned fails closed — with
        // §14.8's one exception, re-derived here rather than trusted from the row: the
        // audience may have changed since the row was seeded, and this is the write
        // that would otherwise freeze a stale answer in as the owner's trigger.
        if (ownerAgent && isGatedAgent(ownerAgent)) {
          if (bot === undefined) bot = await this.bots.getUnscoped(botId)
          const direct = conversationRows.find((row) => row.kind === 'im' && row.dmUserId)
          trigger = bot
            ? await this.gatedConversationTrigger(ownerAgent, bot, {
                id: channelId,
                kind: direct?.kind,
                dmUserId: direct?.dmUserId
              })
            : 'off'
        }
      }
      const canonical = conversationRows.some((row) => row.integrationId === owner.id && row.agentId === owner.agentId)
      const conflicting = conversationRows.some(
        (row) => row.agentId !== null && (row.integrationId !== owner.id || row.agentId !== owner.agentId)
      )
      if (!canonical || conflicting)
        await this.persistConversationOwner(installs, channelId, owner, conversationRows[0])
      // Replicating, not introducing: `chosen` came from the rows themselves, so a
      // sibling backfilled here — including one added long after the decision — carries
      // the same provenance as the value it is given.
      if (trigger !== undefined)
        await this.syncConversationTrigger(installs, channelId, trigger, conversationRows, { chosen })
    }
  }

  /** Compile the attributed routing table after converging conversation ownership. */
  private async compile(bot: BotRecord): Promise<Compiled | null> {
    const integrations = await this.integrations.listForBot(bot.id)
    if (integrations.length === 0) return null
    await this.ensureConversationOwners(bot.id, integrations)
    const agentById = new Map<string, AgentRecord>()
    for (const i of integrations) {
      const a = await this.agents.getUnscoped(i.agentId)
      if (a) agentById.set(i.agentId, a)
    }
    // Only agents a daemon is currently SERVING can receive traffic. The relay addresses ingress
    // to one member, so a pool agent resolves to whichever member holds its duty — placement
    // names no machine and would strand the whole install.
    const placed: { integration: IntegrationRecord; agent: AgentRecord; daemonId: string; gated: boolean }[] = []
    for (const integration of integrations) {
      const agent = agentById.get(integration.agentId)
      if (!agent) continue
      const daemonId = await this.placement.routableDaemon(agent)
      if (!daemonId) continue
      // The ONE predicate decides the keyword rung, the default, and `gatedAgentIds` together.
      placed.push({ integration, agent, daemonId, gated: isGatedAgent(agent) })
    }
    if (placed.length === 0) return null
    // linear-integration.md §6.2: a row's owner rides the relay's PER-CONVERSATION default
    // rung instead of a channel-scoped route — which would otherwise shadow keyword selection
    // and thread continuity on a platform whose every event marks the app as mentioned.
    const ownerAsDefault = manifestFor(bot.platform).ownerAsDefault

    // members: daemonId → agentIds (the daemon connections the relay expects).
    const memberMap = new Map<string, Set<string>>()
    for (const p of placed) {
      const set = memberMap.get(p.daemonId) ?? new Set<string>()
      set.add(p.integration.agentId)
      memberMap.set(p.daemonId, set)
    }
    const members = [...memberMap].map(([daemonId, ids]) => ({ daemonId, agentIds: [...ids] }))

    const byAgent = new Map(placed.map((p) => [p.integration.agentId, p]))
    const routes: AttributedRoute[] = []

    // 1. conversation ownership (§10.1, the primary path): an observed conversation
    //    routes to one owner, respecting its trigger. Emit scoped rules first.
    const chans = await this.channels.listForBot(bot.id)
    const conversationOwner = new Map<string, AgentId>()
    for (const c of chans) {
      if (c.agentId && !conversationOwner.has(c.channelId)) conversationOwner.set(c.channelId, c.agentId)
    }
    // Off or unavailable ownership closes unscoped fallback rungs.
    const offConversationIds = new Set(chans.filter((c) => c.trigger === 'off').map((c) => c.channelId))
    const muted = new Set(offConversationIds)
    for (const [channelId, ownerId] of conversationOwner) {
      if (!byAgent.has(ownerId)) muted.add(channelId)
    }
    const gatedOff = new Set(
      chans
        .filter((c) => c.trigger === 'off')
        .filter((c) => {
          const agent = c.agentId ? agentById.get(c.agentId) : undefined
          return !!agent && isGatedAgent(agent)
        })
        .map((c) => c.channelId)
    )

    for (const c of chans) {
      if (!c.agentId) continue
      const p = byAgent.get(c.agentId)
      if (!p) continue
      if (c.trigger === 'off') continue
      // Such an owner is delivered as this conversation's default below; emitting a scoped rule
      // for it too would make the FIRST rung swallow every addressed message.
      if (ownerAsDefault) continue
      const match: BindMatch = c.trigger === 'any' ? { kind: 'auto' } : { kind: 'mention' }
      routes.push({
        agentId: p.integration.agentId,
        daemonId: p.daemonId,
        integrationId: p.integration.id,
        scope: { channel: c.channelId },
        match
      })
    }
    const mutedChannels = [...muted]
    const gatedOffChannels = [...gatedOff]

    // 2. keyword disambiguation (§10.2): one keyword rule per agent = its slug, so
    //    "@bot <slug> …" routes to that agent. No unscoped mention rule — that would
    //    starve keyword arbitration (§10.4).
    for (const p of placed) {
      const a = agentById.get(p.integration.agentId)
      if (!a) continue
      // Conversation gating (§14): no UNSCOPED rung may name a gated agent — the keyword slug
      // would make "@bot <slug>" fail-open in every conversation.
      if (p.gated) continue
      routes.push({
        agentId: p.integration.agentId,
        daemonId: p.daemonId,
        integrationId: p.integration.id,
        match: { kind: 'keyword', value: a.name }
      })
    }

    // 3. default agent (§10.3): the earliest NON-GATED install of the group catches
    //    a bare @bot + DMs. Delivered as `defaultAgentId` (the relay's fallback
    //    rung), not a route, so it never pre-empts keyword/channel arbitration. A
    //    gated agent must never be the fallback (§14: the bare-@bot/DM rungs are
    //    what make an HTTP bot fail-open); a group of only gated agents has none.
    const first = placed.find((p) => !p.gated)
    // Each row's owner as the relay's per-conversation default (§6.2) — the rung between the
    // keyword slug and `defaultAgentId`, and, for a gated owner, its grant in that channel.
    // An Off row contributes none: a muted channel resolves to nothing at every rung.
    const conversationDefaults: RcConversationDefault[] = ownerAsDefault
      ? chans.flatMap((c) => {
          if (!c.agentId || c.trigger === 'off') return []
          const p = byAgent.get(c.agentId)
          if (!p) return []
          return [
            {
              channel: c.channelId,
              agentId: p.integration.agentId,
              daemonId: p.daemonId,
              integrationId: p.integration.id
            }
          ]
        })
      : []
    const agents = placed.map((p) => {
      const a = agentById.get(p.integration.agentId)
      return {
        agentId: p.integration.agentId,
        name: a?.displayName || a?.name || p.integration.agentId,
        daemonId: p.daemonId,
        integrationId: p.integration.id
      }
    })
    const dmPrefix = `${bot.id}:`
    const noticedDmConversations = [...this.noticedDms]
      .filter((k) => k.startsWith(dmPrefix))
      .map((k) => k.slice(dmPrefix.length))
    return {
      // The row's own id, verbatim. The pre-flatten ternary narrowed it into the
      // closed wire enum and coerced anything unrecognized to 'feishu' — with the
      // open `Platform` (S1a) the honest value rides instead, and the relay's
      // plugin-registry lookup is the consumer that refuses an unserved id
      // (`relay-ingress-manager.assign`: warn + skip, never the socket). The arm
      // stays unreachable either way: the create route admits only registered ids.
      platform: bot.platform,
      members,
      agents,
      routes,
      ...(first ? { defaultAgentId: first.integration.agentId, defaultDaemonId: first.daemonId } : {}),
      gatedAgentIds: placed.filter((p) => p.gated).map((p) => p.integration.agentId),
      mutedChannels,
      gatedOffChannels,
      noticedDmConversations,
      conversationDefaults,
      ownerAsDefault,
      botChannels: chans,
      placed: placed.map((p) => ({
        integration: p.integration,
        agent: p.agent,
        daemonId: p.daemonId,
        gated: p.gated
      }))
    }
  }

  /** Deliver the HTTP-transport send-only spec to each member agent's daemon (best-effort).
   *  `shareable` rides each spec so the daemon knows whether to expose "Switch agent". */
  private async pushSpecs(compiled: Compiled, secret: BotSecretMaterial, bot: BotRecord): Promise<void> {
    // A gated install's spec carries its conversation-scoped rules for the daemon's
    // last-hop admission backstop (§14.3), and EVERY install carries its Off channels
    // for the same backstop. The compile already read the bot's rows; they are keyed
    // per install, so filter by integrationId.
    for (const { integration, agent, gated } of compiled.placed) {
      const channels = compiled.botChannels.filter((c) => c.integrationId === integration.id)
      const spec = await httpIntegrationToSpec(this.platforms, integration, bot, secret, channels, gated)
      // No deliverable spec ⇒ the provider's own credential for this bot is gone (a revoked or
      // swept grant). PULL the send-only bundle instead of leaving the daemon on the last good
      // one — the same teardown `revokeBot` performs for a credential the workspace revoked.
      if (!spec) {
        this.log.info(
          { integrationId: integration.id, botId: String(bot.id) },
          'http-bot: no deliverable spec — pulling the send-only bundle'
        )
        await this.agentDelivery.integrationRemove(agent, integration.id, integration.orgId, (err) => {
          if (!(err instanceof NoConnection)) throw err
          this.log.debug?.({ integrationId: integration.id }, 'http-bot: spec removal skipped — daemon offline')
        })
        continue
      }
      // The relay still addresses ingress to `daemonId`; the send-only credential
      // bundle goes to every daemon serving the agent, so a duty holder is not
      // left signing egress with a credential the workspace has since rotated.
      await this.agentDelivery.integrationUpsert(agent, spec, (err, target) => {
        if (!(err instanceof NoConnection)) throw err
        this.log.debug?.(
          { integrationId: integration.id, daemonId: target },
          'http-bot: spec push skipped — daemon offline'
        )
      })
    }
  }

  /**
   * The declared secret slots an `rc/bot-assign` needs that this bot's stored
   * credential does not have (§9 `secretShape.httpAssignRequires`) — the
   * completeness gate `syncBot` and `replayTo` run BEFORE asking the provider to
   * project the bags. It replaces the two hand-written platform arms core used to
   * hold (Slack ⇒ `signingSecret`, Feishu ⇒ `verificationToken` + `appToken`):
   * same slots, now read off the platform that owns them, so a fifth platform's
   * requirement arrives with its provider.
   *
   * A platform with no registered provider yields no requirements — exactly as
   * the old two-arm form did for a foreign row; `buildAssign` is the fence that
   * refuses it a moment later (no projector ⇒ no assign).
   */
  private missingAssignSecrets(bot: BotRecord, secret: BotSecretMaterial): string[] {
    const required = this.platforms.get(bot.platform)?.secretShape.httpAssignRequires ?? []
    return required.filter((slot) => !secret[slot])
  }

  /**
   * Assemble the `rc/bot-assign` frame (credentials + attributed routing table).
   * Secret — NEVER log the result.
   *
   * `null` ⇒ **this platform has no relay path** and no frame exists to send.
   * `projectBotAssign` is OPTIONAL by design (§9 erratum): a platform whose
   * inbound transport is a daemon-owned long-lived connection simply does not
   * declare it, and the create route already refuses `transport: 'http'` for
   * exactly those platforms on exactly this signal
   * (`http/routes/integrations.ts`). So no such bot row can carry the http
   * transport and this arm is unreachable — which is why absence must neither
   * fabricate an empty assign (the relay would arm an ingress it cannot verify)
   * nor throw (a composition-shaped platform set would take down `syncBot` for
   * every OTHER bot). It joins the two existing "cannot assign" outcomes below:
   * the caller logs and moves on, and the next reconcile retries.
   */
  private async buildAssign(
    bot: BotRecord,
    compiled: Compiled,
    secret: BotSecretMaterial
  ): Promise<RcBotAssign | null> {
    // §6.7: the opaque ingress bag is the ONE carrier of the demux identity —
    // the bag-preferring reader shipped first (#545), emission flipped with
    // #556, and the S3 protocol cleanup removed the legacy named top-level
    // fields from the wire schema outright.
    //
    // §9 projector adoption (S3): the two bags come from the platform provider,
    // so the four-way platform fork is gone — core assembles everything else on
    // the frame (the compiled routing table, the member directory, the gating
    // fences, `credentialRevision`) and merely awaits the provider's output.
    const bags = await this.platforms.get(bot.platform)?.projectBotAssign?.(bot, secret)
    if (!bags) return null
    const { secrets, ingress } = bags
    return {
      botId: bot.id,
      platform: compiled.platform,
      // §6.1: a bot assignment is always a CHAT platform; carried so an older
      // relay can classify an id a newer CP introduces.
      originKind: 'chat',
      ingress,
      // Generation of the credentials below — echoed back on `rc/bot-revoked` so a
      // revocation observed under a REPLACED credential cannot kill this one.
      credentialRevision: bot.credentialRevision,
      secrets,
      members: compiled.members,
      agents: compiled.agents,
      routes: compiled.routes,
      ...(compiled.defaultAgentId ? { defaultAgentId: compiled.defaultAgentId } : {}),
      ...(compiled.defaultDaemonId ? { defaultDaemonId: compiled.defaultDaemonId } : {}),
      gatedAgentIds: compiled.gatedAgentIds,
      mutedChannels: compiled.mutedChannels,
      gatedOffChannels: compiled.gatedOffChannels,
      noticedDmConversations: compiled.noticedDmConversations,
      conversationDefaults: compiled.conversationDefaults,
      ownerAsDefault: compiled.ownerAsDefault,
      ...(this.noticeAuthorityFor(bot.id) ? { noticeAuthority: this.noticeAuthorityFor(bot.id) } : {})
    }
  }

  /** Fan a C→R EVT to EVERY connected relay, per-socket isolated (a dead socket's
   *  error is swallowed; its onClose removes it from the registry). */
  private broadcast(send: (ch: RelayChannel) => void): void {
    for (const ch of this.relayReg.all()) {
      try {
        send(ch)
      } catch {
        // dead socket — its onClose removes it from the registry
      }
    }
  }
}

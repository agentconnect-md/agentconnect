/**
 * `HttpBotOrchestrator` (shared-bot-relay.md §4.2 / §5 / §10) — the CP convergence
 * seam for HTTP-transport bots. It broadcasts each bot's ingress assignment to the
 * relay pool, compiles the ATTRIBUTED routing table (channel ownership → keyword →
 * default agent), and delivers the send-only integration spec (wire mode `shared`)
 * to each member agent's daemon.
 *
 * It is invoked on every event that can change an HTTP bot's assignment or routes:
 * an install / uninstall, a transport or shareable toggle, a
 * per-channel default-agent change, and — for failover — a relay (re)register or
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
  BindMatch,
  RcThreadAssign,
  RcThreadParticipant,
  RcThreadLookup,
  RcThreadLookupOk
} from '@agentconnect.md/protocol'
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
  ReportedChannel,
  AgentRepo,
  AgentRecord,
  ThreadAffinityStore,
  SessionRepo
} from '../persistence/ports.js'
import type { RelayChannel, RelayRegistry } from '../ws/relay-registry.js'
import { ControlSender, NoConnection } from './outbound.js'
import { isDirectConversationKind } from '../persistence/ports.js'
import { isGatedAgent, httpIntegrationToSpec } from './placement.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import { AgentId, BotId, DaemonId } from '../domain/ids.js'

export interface HttpBotLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  debug?(obj: unknown, msg?: string): void
}

/** The compiled routing table for one HTTP bot (relay-agnostic). */
interface Compiled {
  platform: 'slack' | 'telegram' | 'discord' | 'feishu'
  members: { daemonId: string; agentIds: string[] }[]
  /** Member directory (id→name→daemon) for the relay's config-modal selector. */
  agents: { agentId: string; name: string; daemonId: string; integrationId: string }[]
  routes: AttributedRoute[]
  defaultAgentId?: string
  defaultDaemonId?: string
  /** Members whose ingress is conversation-gated (resource-visibility.md §14). */
  gatedAgentIds: string[]
  /** Every Off channel — the relay's subtractive fence over the rungs no missing
   *  route can suppress (keyword, `defaultAgentId`, thread continuity). */
  mutedChannels: string[]
  /** The muted channels whose owner is GATED: Off because §14 has not enabled them,
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
  placed: { integration: IntegrationRecord; daemonId: string; gated: boolean }[]
}

/** Resolve a persisted owner marker to its active integration, falling back to
 * the earliest active install for new or legacy ownerless channels. */
export function pickChannelOwner(
  installs: IntegrationRecord[],
  rows: IntegrationChannelRecord[]
): IntegrationRecord | undefined {
  const assigned = new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))
  return installs.find((integration) => assigned.has(integration.agentId)) ?? installs[0]
}

export class HttpBotOrchestrator {
  private readonly channelMutationChains = new Map<string, Promise<unknown>>()

  constructor(
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
    private readonly platforms: CpPlatformRegistry
  ) {}

  /**
   * Converge one bot: BROADCAST `rc/bot-assign` to every connected relay (whole-pool
   * ingress — any pod may receive an inbound Events API POST via the stable
   * PUBLIC_RELAY_URL LB) + deliver the send-only spec to each member daemon. A
   * non-http / empty bot is released. Safe to call for a socket bot (no-op after
   * the release check).
   */
  async syncBot(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
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
    const secret = await this.botSecret.get(bot.id)
    if (!secret) {
      this.log.warn({ botId }, 'http-bot: no secret for http bot — cannot assign')
      return
    }
    if (bot.platform === 'slack' && !secret.signingSecret) {
      // An http-mode Slack bot with no signing secret can't be verified by the relay.
      this.log.warn({ botId }, 'http-bot: no signing secret for http Slack bot — cannot assign')
      return
    }
    if (bot.platform === 'feishu' && (!secret.verificationToken || !secret.appToken)) {
      this.log.warn({ botId }, 'http-bot: incomplete Feishu callback credentials — cannot assign')
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
   * A routes-only change (a per-channel default agent, a trigger flip) on an
   * already-placed bot: hot-update the relay's table via `rc/routes` (no ingest
   * re-open). Falls back to a full `syncBot` if the bot isn't placed on a
   * connected relay yet.
   */
  async syncRoutes(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
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
        ...(this.noticeAuthorityFor(bot.id) ? { noticeAuthority: this.noticeAuthorityFor(bot.id) } : {})
      })
    )
    const secret = await this.botSecret.get(bot.id)
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
    const bot = await this.bots.get(BotId(botId))
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
    const after = await this.bots.get(bot.id)
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
      const agent = await this.agents.get(integration.agentId)
      if (!agent?.daemonId) continue
      try {
        await this.control.integrationRemove(agent.daemonId, { integrationId: integration.id })
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        this.log.debug?.({ integrationId: integration.id }, 'http-bot: revoke spec removal skipped — daemon offline')
      }
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
      const secret = await this.botSecret.get(bot.id)
      if (!secret) continue
      if (bot.platform === 'slack' && !secret.signingSecret) continue
      if (bot.platform === 'feishu' && (!secret.verificationToken || !secret.appToken)) continue
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
   *  affinity forever. */
  async lookupThread(m: RcThreadLookup): Promise<RcThreadLookupOk> {
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
      if (owner && (await this.threadTargetAllowed(m.botId, channel, owner.agentId))) {
        return {
          botId: m.botId,
          sessionKey: m.sessionKey,
          target: owner,
          participants: participants.some((participant) => participant.agentId === owner.agentId)
            ? participants
            : [...participants, owner]
        }
      }
    }
    return { botId: m.botId, sessionKey: m.sessionKey, target: null, participants }
  }

  /** §14 conversation-gating check for the thread-lookup backstop: a non-gated
   *  target is always allowed; a gated target needs its install's row for this
   *  conversation to be enabled (trigger ≠ off). Fail-closed on missing rows. */
  private async threadTargetAllowed(botId: string, channel: string, agentId: string): Promise<boolean> {
    const agent = await this.agents.get(AgentId(agentId))
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

  /** Apply the authoritative channel-membership snapshot reported by the Slack
   *  HTTP ingest. Every active integration of the bot represents the same Slack
   *  app membership, so fan the snapshot across them, preserving per-install
   *  trigger/owner fields in the repository, then hot-refresh relay routes.
   *
   *  For an HTTP bot, route compilation converges every reported channel to
   *  exactly one owner. A new or ownerless channel is assigned to the bot's
   *  creating (earliest active) agent, while an existing owner is preserved.
   */
  async replaceChannels(botId: string, channels: ReportedChannel[]): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || bot.platform !== 'slack' || bot.transport !== 'http') {
      this.log.warn({ botId }, 'http-bot: channel snapshot for a non-http/unknown Slack bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const integration of installs) {
      // Conversation gating (§14): a gated install's fresh channels start Off — an
      // editor must enable them in the console before the compiler emits a route.
      const owner = await this.agents.get(integration.agentId)
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
   * Fan an INCREMENTAL direct-conversation report across every install as an owned
   * `kind:'im'` / `kind:'mpim'` row. Restricted installs default Off; Everyone installs
   * default a 1:1 DM On and a group DM to Mention. The reported kind is preserved so a
   * group DM never accidentally receives an auto rule. Idempotent; route state is
   * recompiled because a newly observed public row is immediately active.
   */
  async reportConversation(botId: string, conversation: ReportedChannel): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || (bot.platform !== 'slack' && bot.platform !== 'feishu') || bot.transport !== 'http') {
      this.log.warn({ botId }, 'http-bot: conversation report for a non-http/unknown IM bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const install of installs) {
      const agent = await this.agents.get(install.agentId)
      if (!agent) continue
      const kind = conversation.kind === 'mpim' ? ('mpim' as const) : ('im' as const)
      await this.channels.upsertConversation(
        install.id,
        { ...conversation, kind },
        {
          agentId: AgentId(install.agentId),
          defaultTrigger: isGatedAgent(agent) ? 'off' : kind === 'im' ? 'any' : 'mention'
        }
      )
    }
    await this.syncRoutes(botId)
  }

  /**
   * Update a multi-agent channel through its bot-level ownership boundary. The selected
   * agent becomes the sole owner, and the channel trigger follows the channel when
   * ownership changes instead of reverting to a stale per-install value.
   */
  async updateChannel(
    botId: string,
    channelId: string,
    patch: { agentId?: string; trigger?: ChannelTrigger },
    options: { expectedOwnerAgentId?: string; source?: 'console' | 'slack' } = {}
  ): Promise<IntegrationChannelRecord | null> {
    return this.serializeChannelMutation(botId, channelId, async () => {
      const bot = await this.bots.get(BotId(botId))
      if (bot?.transport !== 'http') {
        this.log.warn({ botId }, 'http-bot: update-channel for a non-http/unknown bot — ignored')
        return null
      }
      const installs = await this.integrations.listForBot(bot.id)
      if (installs.length === 0) return null
      const rows = (await this.channels.listForBot(bot.id)).filter(
        (row) => row.kind === 'channel' && row.channelId === channelId
      )
      const currentOwner = pickChannelOwner(installs, rows)
      if (options.expectedOwnerAgentId && currentOwner?.agentId !== options.expectedOwnerAgentId) {
        this.log.warn(
          { botId, channelId, expectedOwnerAgentId: options.expectedOwnerAgentId },
          'http-bot: channel owner changed before update — ignored'
        )
        return null
      }
      const owner = patch.agentId ? installs.find((i) => i.agentId === patch.agentId) : currentOwner
      if (!owner) {
        this.log.warn({ botId, agentId: patch.agentId }, 'http-bot: update-channel for a non-member agent — ignored')
        return null
      }

      const currentRow = currentOwner
        ? (rows.find((row) => row.agentId === currentOwner.agentId) ??
          rows.find((row) => row.integrationId === currentOwner.id))
        : undefined
      const targetAgent = options.source === 'slack' ? await this.agents.get(owner.agentId) : null
      let updated = await this.persistChannelOwner(installs, channelId, owner)
      const trigger =
        targetAgent && isGatedAgent(targetAgent)
          ? ('off' as const)
          : (patch.trigger ?? currentRow?.trigger ?? rows[0]?.trigger ?? updated.trigger)
      await this.syncChannelTrigger(installs, channelId, trigger, rows)
      updated = { ...updated, trigger }
      await this.syncRoutes(botId)
      return updated
    })
  }

  /** The in-Slack config modal changes only the owner. A workspace user must
   * never enable a restricted agent, so that target always starts Off. */
  async setChannelAgent(botId: string, channelId: string, agentId: string): Promise<void> {
    await this.updateChannel(botId, channelId, { agentId }, { source: 'slack' })
  }

  /** Preserve bot-scoped channel state before an owner integration is deleted. */
  async prepareIntegrationRemoval(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (bot?.transport !== 'http') return
    const installs = await this.integrations.listForBot(bot.id)
    await this.ensureChannelOwners(bot.id, installs)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Serialize the owner check and write per channel. Console authorization
   * happens before this boundary and supplies the owner it authorized; a queued
   * Slack move therefore makes that Console mutation fail closed. */
  private serializeChannelMutation<T>(botId: string, channelId: string, run: () => Promise<T>): Promise<T> {
    const key = `${botId}\u0000${channelId}`
    const previous = this.channelMutationChains.get(key) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.channelMutationChains.set(key, settled)
    void settled.finally(() => {
      if (this.channelMutationChains.get(key) === settled) this.channelMutationChains.delete(key)
    })
    return result
  }

  /** Store one canonical owner row and clear every sibling install's copy. */
  private async persistChannelOwner(
    installs: IntegrationRecord[],
    channelId: string,
    owner: IntegrationRecord
  ): Promise<IntegrationChannelRecord> {
    const ownerAgent = await this.agents.get(owner.agentId)
    const defaultTrigger = ownerAgent && isGatedAgent(ownerAgent) ? ('off' as const) : undefined
    const updated = await this.channels.upsertAgent(
      owner.id,
      channelId,
      owner.agentId,
      defaultTrigger ? { defaultTrigger } : undefined
    )
    // Establish the replacement before clearing stale markers: even if a later
    // cleanup write fails, the channel never regresses to having no owner.
    for (const integration of installs) {
      if (integration.id === owner.id) continue
      await this.channels.setAgent(integration.id, channelId, null)
    }
    return updated
  }

  /** Keep the effective trigger on every active membership row, creating a
   * missing sibling from the best available channel metadata. Ownership is
   * canonical, but complete repeated state lets owner deletion preserve the
   * channel and trigger even before a new install reports its own snapshot. */
  private async syncChannelTrigger(
    installs: IntegrationRecord[],
    channelId: string,
    trigger: ChannelTrigger,
    knownRows: IntegrationChannelRecord[]
  ): Promise<void> {
    const known = new Map(knownRows.map((row) => [row.integrationId, row]))
    const template = knownRows.find((row) => row.name !== null) ?? knownRows[0]
    for (const integration of installs) {
      const row = known.get(integration.id)
      if (row?.trigger === trigger) continue
      if (!row) {
        const backfilled = await this.channels.upsertConversation(
          integration.id,
          {
            id: channelId,
            ...(template?.name ? { name: template.name } : {}),
            isPrivate: template?.isPrivate ?? false,
            kind: 'channel'
          },
          { defaultTrigger: trigger }
        )
        if (backfilled.trigger === trigger) continue
      }
      await this.channels.setTrigger(integration.id, channelId, trigger)
    }
  }

  /**
   * Converge every channel to one canonical owner. This repairs owner deletion,
   * legacy ownerless rows, and older Web writes that stored an owner on the wrong
   * integration. Direct rows are intentionally excluded because every install owns
   * its own trigger.
   */
  private async ensureChannelOwners(botId: BotId, installs: IntegrationRecord[]): Promise<void> {
    if (installs.length === 0) return
    const rows = (await this.channels.listForBot(botId)).filter((row) => row.kind === 'channel')
    const channelIds = [...new Set(rows.map((row) => row.channelId))]
    for (const channelId of channelIds) {
      const channelRows = rows.filter((row) => row.channelId === channelId)
      const owner = pickChannelOwner(installs, channelRows)
      if (!owner) continue
      const persistedOwner = channelRows.some((row) => row.agentId === owner.agentId)
      let trigger =
        channelRows.find((row) => row.agentId === owner.agentId)?.trigger ??
        channelRows.find((row) => row.integrationId === owner.id)?.trigger ??
        channelRows[0]?.trigger
      if (!persistedOwner) {
        const ownerAgent = await this.agents.get(owner.agentId)
        if (ownerAgent && isGatedAgent(ownerAgent)) trigger = 'off'
      }
      const canonical = channelRows.some((row) => row.integrationId === owner.id && row.agentId === owner.agentId)
      const conflicting = channelRows.some(
        (row) => row.agentId !== null && (row.integrationId !== owner.id || row.agentId !== owner.agentId)
      )
      if (!canonical || conflicting) await this.persistChannelOwner(installs, channelId, owner)
      if (trigger !== undefined) await this.syncChannelTrigger(installs, channelId, trigger, channelRows)
    }
  }

  /** Compile the attributed routing table after converging channel ownership. */
  private async compile(bot: BotRecord): Promise<Compiled | null> {
    const integrations = await this.integrations.listForBot(bot.id)
    if (integrations.length === 0) return null
    await this.ensureChannelOwners(bot.id, integrations)
    const agentById = new Map<string, AgentRecord>()
    for (const i of integrations) {
      const a = await this.agents.get(i.agentId)
      if (a) agentById.set(i.agentId, a)
    }
    // Only agents currently PLACED on a daemon can receive traffic.
    const placed = integrations
      .map((integration) => ({ integration, agent: agentById.get(integration.agentId) }))
      .filter((x): x is { integration: IntegrationRecord; agent: AgentRecord } => !!x.agent?.daemonId)
      .map((x) => ({
        integration: x.integration,
        agent: x.agent,
        daemonId: x.agent.daemonId!,
        gated: isGatedAgent(x.agent)
      }))
    if (placed.length === 0) return null

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

    // 1. channel ownership (§10.1, the primary path): a channel with a default agent
    //    routes to that agent, respecting the channel's trigger (any → auto rule,
    //    mention → mention rule). Emitted FIRST so a scoped rule wins arbitration.
    const chans = await this.channels.listForBot(bot.id)
    const channelRows = chans.filter((c) => !isDirectConversationKind(c.kind))
    // The channel's owning agent — the one row of the fan-out that carries it (§10.1).
    const channelOwner = new Map<string, string>()
    for (const c of channelRows) {
      if (c.agentId && !channelOwner.has(c.channelId)) channelOwner.set(c.channelId, c.agentId)
    }
    // Off conversations split into two facts the relay needs separately.
    //
    // ROUTING (`mutedChannels`): every Off channel, whoever owns it. The trigger is
    // bot-scoped — replicated across every membership row — so Off means this bot does
    // not answer here, and a route being absent is not enough to say so: the keyword slug
    // and `defaultAgentId` rungs are unscoped, and on a mixed bot they would hand a bare
    // @bot to the public default in a channel the console shows as Off. Any row states
    // the trigger, including one whose owner is not currently placed. Direct rows are
    // per-agent: the conversation is muted only when no placed install is enabled.
    //
    // NOTICE (`gatedOffChannels`): of those, the ones owned by a GATED agent. Their Off
    // is §14's fail-closed default for a conversation nobody has enabled yet, and it owns
    // the one-time "ask an admin to enable it" reply — someone who had no way to know the
    // agent is private must not meet a dead bot. An OPERATOR's Off says nothing: they
    // already decided, and that advice would be the opposite of what happened. The two
    // states share a trigger value, so only ownership tells them apart.
    const offChannels = channelRows.filter((c) => c.trigger === 'off')
    const ownerGated = (channelId: string): boolean => {
      const owner = channelOwner.get(channelId)
      const agent = owner ? agentById.get(owner) : undefined
      return !!agent && isGatedAgent(agent)
    }
    const muted = new Set(offChannels.map((c) => c.channelId))
    const gatedOff = new Set([...muted].filter(ownerGated))

    // Direct rows are independent per install. Once a conversation is observed, emit
    // scoped routes for every enabled 1:1 DM row so those controls outrank the public
    // keyword/default fallbacks. A missing public row keeps the pre-observation default
    // (On for a DM, Mention for a group DM); a missing restricted row stays Off.
    const directByConversation = new Map<string, IntegrationChannelRecord[]>()
    for (const c of chans) {
      if (!isDirectConversationKind(c.kind)) continue
      const rows = directByConversation.get(c.channelId)
      if (rows) rows.push(c)
      else directByConversation.set(c.channelId, [c])
    }
    for (const [channelId, rows] of directByConversation) {
      // Prefer the safer room classification if rolling reporters briefly disagree.
      const kind = rows.some((row) => row.kind === 'mpim') ? ('mpim' as const) : ('im' as const)
      const enabled = placed.flatMap((p) => {
        const row = rows.find((candidate) => candidate.integrationId === p.integration.id)
        const trigger = row?.trigger ?? (p.gated ? 'off' : kind === 'im' ? 'any' : 'mention')
        return trigger === 'off' ? [] : [{ p, trigger }]
      })
      if (enabled.length === 0) {
        muted.add(channelId)
        if (placed.some((p) => p.gated)) gatedOff.add(channelId)
        continue
      }
      // A group DM carries one shared @bot identity. Multiple identical mention routes
      // would make relay order choose silently, so its earliest enabled install owns it.
      const targets = kind === 'mpim' ? enabled.slice(0, 1) : enabled
      for (const { p, trigger } of targets) {
        const match: BindMatch = kind === 'im' || trigger === 'any' ? { kind: 'auto' } : { kind: 'mention' }
        routes.push({
          agentId: p.integration.agentId,
          daemonId: p.daemonId,
          integrationId: p.integration.id,
          scope: { channel: channelId },
          match
        })
        // A shared 1:1 DM may have several enabled installs. Emit every target's
        // scoped slug so arbitration can evaluate it ahead of scoped auto: naming a
        // non-default public agent still selects that agent, and gated targets use
        // the same disambiguation.
        if (kind === 'im') {
          const slug = p.agent.name
          if (slug) {
            routes.push({
              agentId: p.integration.agentId,
              daemonId: p.daemonId,
              integrationId: p.integration.id,
              scope: { channel: channelId },
              match: { kind: 'keyword', value: slug }
            })
          }
        }
      }
    }

    // Member channels have one bot-scoped owner and trigger.
    for (const c of channelRows) {
      if (!c.agentId) continue
      const p = byAgent.get(c.agentId)
      if (!p) continue // channel assigned to an agent not (yet) placed — skip
      // Off compiles no route for ANY owner. That alone does not make the channel
      // unreachable — `mutedChannels` above is what closes the unscoped rungs, for a
      // gated owner just as much as an ungated one (a mixed bot's public default
      // would otherwise answer a bare @bot in a channel the console shows as Off).
      if (c.trigger === 'off') continue
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
      // Conversation gating (§14): no UNSCOPED rung may name a gated agent — the
      // keyword slug would make "@bot <slug>" fail-open in every conversation.
      if (isGatedAgent(a)) continue
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
      platform:
        bot.platform === 'slack'
          ? 'slack'
          : bot.platform === 'telegram'
            ? 'telegram'
            : bot.platform === 'discord'
              ? 'discord'
              : 'feishu',
      members,
      agents,
      routes,
      ...(first ? { defaultAgentId: first.integration.agentId, defaultDaemonId: first.daemonId } : {}),
      gatedAgentIds: placed.filter((p) => p.gated).map((p) => p.integration.agentId),
      mutedChannels,
      gatedOffChannels,
      noticedDmConversations,
      botChannels: chans,
      placed: placed.map((p) => ({ integration: p.integration, daemonId: p.daemonId, gated: p.gated }))
    }
  }

  /** Deliver the HTTP-transport send-only spec to each member agent's daemon (best-effort).
   *  `shareable` rides each spec so the daemon knows whether to expose "Switch agent". */
  private async pushSpecs(compiled: Compiled, secret: BotSecretMaterial, bot: BotRecord): Promise<void> {
    // A gated install's spec carries its conversation-scoped rules for the daemon's
    // last-hop admission backstop (§14.3), and EVERY install carries its Off channels
    // for the same backstop. The compile already read the bot's rows; they are keyed
    // per install, so filter by integrationId.
    for (const { integration, daemonId, gated } of compiled.placed) {
      try {
        const channels = compiled.botChannels.filter((c) => c.integrationId === integration.id)
        await this.control.integrationUpsert(
          daemonId,
          await httpIntegrationToSpec(this.platforms, integration, bot, secret, channels, gated)
        )
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        this.log.debug?.({ integrationId: integration.id, daemonId }, 'http-bot: spec push skipped — daemon offline')
      }
    }
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
    // §6.7 emission flip (the last S1b dual-shape residue): the opaque ingress
    // bag is the ONE carrier of the demux identity — the relay's bag-preferring
    // reader shipped first (#545). The retired named top-level fields stay
    // OPTIONAL in the wire schema so an older relay's tolerant reader is not
    // broken by their absence; they leave the schema with the next cleanup.
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

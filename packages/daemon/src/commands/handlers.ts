/**
 * The daemon-side COMMAND EXECUTION layer: everything that happens AFTER
 * `parseCommand` recognizes an in-conversation control command (`!stop` `!cancel`
 * `!resume` `!queue` `/status` `/fast` `/models` `/effort` `/permission`), plus the
 * other chat-side session controls that share its cores — the Slack status-bar
 * interaction, the Discord select card, the Telegram callback tap, and the by-key
 * model / effort / permission / fast / output setters the webchat frames drive.
 *
 * The parser stays in `./commands.js` and the select projections in
 * `./select-projection.js`; this module is the stateful half that pairs with them.
 * It owns no daemon state — every read and every single-point write goes through
 * {@link CommandHost} — and the Daemon keeps thin same-name delegates for the
 * ingress paths (and the tests) that already call these by name.
 */
import type { AcpHost } from '../acp/acp-host.js'
import { permissionPresetSettings } from '../acp/permission-modes.js'
import { applySelect, selectCardText, selectDisplay, selectLabel, selectOptions } from './select-projection.js'
import type { SelectSetters } from './select-projection.js'
import type { AgentCommand } from './commands.js'
import type { Logger } from '../log.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { routeRules, type RouteVia } from '../router/routing-table.js'
import { conversationAdmitted, integrationRouting, type RoutingRule } from '../router/routing-rule.js'
import { sessionKey, type LocalStore, type SessionRecord } from '../store/local-store.js'
import {
  CommandChromeRegistry,
  type CommandChromeContext,
  type CommandChromeSurface,
  type SelectKind
} from '../platforms/command-chrome.js'
import { loopGuardScopesFor } from '../platforms/loop-guard.js'
import { loopGuardScope, loopGuardScopeFromCoords } from '../daemon/loop-guard-scope.js'
import type { PlatformConnection } from '../platforms/connection-reconciler.js'
import { parseTelegramSelect, telegramSelectButtons } from '../platforms/telegram/command-chrome.js'
import type { TelegramCallback, TelegramConnection } from '../telegram/connection.js'
import type { InteractionActor } from '../platforms/contract.js'
import type { StatusBarInfo } from '../slack/render.js'
import { buildDiscordSelectComponents, type DiscordComponents } from '../discord/render.js'
import { MAX_QUEUED_PER_SESSION } from '../daemon/constants.js'
import {
  pendingTurnKey,
  QueueFullError,
  type Pending,
  type QueueEntry,
  type TurnInterruptReason
} from '../daemon/turn-types.js'

/** Exactly what command execution touches on the Daemon — reads plus single-point writes. */
export interface CommandHost {
  log(): Logger
  store(): LocalStore
  /** The served agent roster; commands read integrations, admission and chat authority off it. */
  agents(): ReadonlyMap<string, LoadedAgent>
  /** Live turns keyed by (agentId, acpSessionId) — read for the status bar and loop-guard state. */
  pending(): ReadonlyMap<string, Pending>
  /** Session keys a turn currently owns, and the per-key queue behind them. */
  inflight(): ReadonlySet<string>
  serialQueue(): ReadonlyMap<string, QueueEntry[]>
  /** The gate's currently admitted entry per session key — a cold turn owns its key here. */
  activeGateEntries(): ReadonlyMap<string, QueueEntry>
  /** The §7.4 per-platform command presentation surfaces (reply / status / select card). */
  commandChrome(): CommandChromeRegistry<NormalizedMessage, StatusBarInfo>
  /** True when this session runs on its own credential host rather than the shared static one. */
  hasModelSessionHost(key: string): boolean
  modelCrossesHostProvider(key: string, agentId: string, model: string): boolean
  hostForStoredSession(agentId: string, acpSessionId: string): Promise<AcpHost | undefined>
  statusInfoFrom(agentId: string, sessionKey: string, acpSessionId?: string): Promise<StatusBarInfo>
  emitStatusBar(p: Pending): Promise<void>
  interruptTurn(
    agentId: string,
    key: string,
    reason: TurnInterruptReason,
    acpSessionId?: string,
    opts?: { actor?: InteractionActor }
  ): Promise<void>
  /** `!queue` admission through the unified per-sessionKey gate — it decides run-now vs enqueue. */
  dispatchQueueCommand(agentId: string, msg: NormalizedMessage, integrationId: string): Promise<void>
  replyConnFor(agentId: string, integrationId?: string): PlatformConnection | undefined
  /** Takes the session's OUTWARD id (session-concept.md §1.1), which {@link outwardSessionId} resolves. */
  sessionLink(sessionId: string, source?: string): string
  outwardSessionId(agentId: string, acpSessionId: string): Promise<string | undefined>
  sessionLinkSource(platform: string, integrationId?: string): string | undefined
  /** Thread affinity for the routing ladder a command reuses. */
  threadOwner(channel: string, thread: string, transportScope?: string | null): Promise<string | null>
  mergedRulesForSource(srcIntegrationIds?: readonly string[]): RoutingRule[]
  transportScopeForIntegrationIds(integrationIds?: readonly string[]): string | undefined
  integrationBelongsToSource(integrationId: string, srcIntegrationIds?: readonly string[]): boolean
  /** The integrations one live platform connection is bound to (a Telegram callback's source). */
  srcIntegrationIds(conn: unknown): string[]
  /** `!resume` re-arms this member's own loop-scope enforcement. */
  clearEnforcedLoopScope(scope: string): void
}

/** Everything `handleCommand`'s shared pre-dispatch resolves once, handed to the per-kind handler. */
/** The human behind a chat command, in the same shape a Block Kit click reports. */
function senderActor(msg: NormalizedMessage): InteractionActor {
  const name = msg.sender.name?.trim()
  return { userId: msg.sender.id, isBot: msg.sender.isBot, ...(name ? { name } : {}) }
}

interface CommandContext {
  msg: NormalizedMessage
  target: { agentId: string; integrationId: string; via: RouteVia }
  conn: PlatformConnection | undefined
  chrome: CommandChromeSurface<NormalizedMessage, StatusBarInfo>
  chromeCtx: CommandChromeContext
  /** Post a short control reply on the platform's own command-chrome surface. */
  reply: (text: string) => void
  /** The session the command ACTS on — key/thread follow the resolved session, not the reply anchor. */
  key: string
  thread: string
  /** Where the reply lands — the command message's own thread, kept separate from `thread`. */
  replyThread: string
  rec: SessionRecord | undefined
  acpSessionId: string | undefined
  /** A turn currently owns this logical session key (gate-owned or queued), per §6.9 #390. */
  inflight: boolean
}

/** One registry entry: the handler plus the shared guards dispatch applies before it. */
interface CommandEntry<K extends AgentCommand['kind']> {
  /** Kinds that write runtime settings and so need the Agent-level chat-changes permission. */
  readonly runtimeChange?: boolean
  readonly run: (command: Extract<AgentCommand, { kind: K }>, ctx: CommandContext) => Promise<boolean>
}

type CommandRegistry = { readonly [K in AgentCommand['kind']]: CommandEntry<K> }

export class CommandHandlers {
  constructor(private readonly host: CommandHost) {}

  /**
   * Record who drove one chat-side session action. The platform interaction is the only
   * place the acting user exists — the session key alone says what changed, never by whom —
   * so it is logged at every funnel point. `unknown` when an ingress could not report an
   * actor (today: relay-forwarded Slack actions, whose frame carries no user).
   */
  logSessionAction(verb: string, sessionKey: string, actor?: InteractionActor): void {
    const who = actor ? `${actor.userId}${actor.isBot ? ' (bot)' : ''}` : 'unknown'
    this.host.log().info(`session ${sessionKey}: "${verb}" by ${who}`)
  }

  /** Resolve a session only while its Agent explicitly permits chat-side runtime changes. */
  async chatRuntimeSession(key: string) {
    const rec = await this.host.store().getSession(key)
    return rec && this.host.agents().get(rec.agentId)?.allowRuntimeChangesInChat === true ? rec : undefined
  }

  /** Switch a session's model by its local key — the core shared by the webchat
   *  `set-model` frame and the Slack status-bar select. Records the sticky per-session
   *  override (re-applied on every turn by dispatch) and, if the ACP session is warm,
   *  applies it live now and re-pushes the status bar. Never changes the agent default. */
  async setModelByKey(key: string, model: string): Promise<boolean> {
    const rec = await this.chatRuntimeSession(key)
    if (!rec) return false
    const crossProvider = this.host.modelCrossesHostProvider(key, rec.agentId, model)
    // The shared static-credential host has no per-session restart to pick a new binding up,
    // so a cross-provider pick there could never be credentialed — refuse it outright rather
    // than storing an override that can only ever fail.
    if (crossProvider && !this.host.hasModelSessionHost(key)) {
      this.host.log().warn(`session ${key}: cross-provider model switch rejected — the static credential host is bound`)
      return false
    }
    await this.host.store().setModelOverride(key, model)
    this.host.log().info(`session ${key} model override → "${model}"`)
    // A running credential host keeps the provider it started with; the sticky override is
    // what the next start reads, so the switch lands there instead of live.
    if (crossProvider) {
      this.host.log().info(`session ${key}: provider change applies when its credential host next starts`)
      return true
    }
    const acpSessionId = rec.acpSessionId
    const host = acpSessionId ? await this.host.hostForStoredSession(rec.agentId, acpSessionId) : undefined
    if (!acpSessionId || !host?.hasSession(acpSessionId)) return true // no live session — applies next turn
    void host
      .setSessionModel(acpSessionId, model)
      .then(async (applied) => {
        const p = this.host.pending().get(pendingTurnKey(rec.agentId, acpSessionId))
        if (applied && p) await this.host.emitStatusBar(p) // reflect the new model on the status bar
      })
      .catch((err) => this.host.log().warn(`set-model failed: ${(err as Error).message}`))
    return true
  }

  /** Cancel the in-flight turn for a local session key — the `!cancel` core (interrupt,
   *  NO mute) shared by Slack's native Stop and webchat's cancel frame. No-op if nothing
   *  is running. */
  async cancelSessionByKey(key: string, actor?: InteractionActor): Promise<boolean> {
    const rec = await this.host.store().getSession(key)
    // Cancel a gate-owned/queued session even if it has no live ACP turn yet (§6.9 #390):
    // interruptTurn drains the queue by key and cancels the ACP turn only if one exists.
    if (!this.host.inflight().has(key)) return false
    // The cold head owns the key from the gate alone — no row, and not queued behind itself.
    const agentId =
      rec?.agentId ?? this.host.activeGateEntries().get(key)?.agentId ?? this.host.serialQueue().get(key)?.[0]?.agentId
    if (!agentId) return false
    await this.host.interruptTurn(agentId, key, 'cancel', rec?.acpSessionId ?? undefined, {
      ...(actor ? { actor } : {})
    })
    return true // reports whether a turn was actually interrupted (nothing else reads it)
  }

  /** Switch a session's reasoning effort by its local key — the effort counterpart of
   *  {@link setModelByKey}. Records the sticky override and, if the ACP session is warm,
   *  applies it live via the `thought_level` select. `ultracode` can't ride the select
   *  (setSessionEffort returns false); it's honored via session `_meta` when the session
   *  is next (re)created or resumed, and the override still shows on the bar meanwhile. */
  async setEffortByKey(key: string, effort: string): Promise<boolean> {
    const rec = await this.chatRuntimeSession(key)
    if (!rec) return false
    await this.host.store().setEffortOverride(key, effort)
    this.host.log().info(`session ${key} effort override → "${effort}"`)
    const acpSessionId = rec.acpSessionId
    const host = acpSessionId ? await this.host.hostForStoredSession(rec.agentId, acpSessionId) : undefined
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      await this.refreshStatusBarForKey(key)
      return true
    }
    void host
      .setSessionEffort(acpSessionId, effort)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.host.log().warn(`set-effort failed: ${(err as Error).message}`))
    return true
  }

  /** Apply one composite session permission value to a warm host. Older injected host
   * fakes retain the two-setter fallback; real AcpHosts own the validation/decomposition. */
  async applySessionPermissionPreset(host: AcpHost, sessionId: string, preset: string): Promise<void> {
    if (typeof host.setSessionPermissionPreset === 'function') {
      await host.setSessionPermissionPreset(sessionId, preset)
      return
    }
    const settings = permissionPresetSettings(preset)
    if (settings.approvalsReviewer === 'user' && typeof host.setSessionApprovalsReviewer === 'function') {
      await host.setSessionApprovalsReviewer(sessionId, 'user')
    }
    await host.setSessionPermissionMode(sessionId, settings.permissionMode)
    if (settings.approvalsReviewer === 'auto_review' && typeof host.setSessionApprovalsReviewer === 'function') {
      await host.setSessionApprovalsReviewer(sessionId, 'auto_review')
    }
  }

  /** Every chat-side permission-preset change funnels through the same Agent-level
   * guard before a sticky override can be written, including stale callbacks and
   * relay frames. */
  async setPermissionModeByKey(key: string, permissionPreset: string): Promise<boolean> {
    const rec = await this.chatRuntimeSession(key)
    if (!rec) return false
    await this.host.store().setPermissionModeOverride(key, permissionPreset)
    this.host.log().info(`session ${key} permission preset override → "${permissionPreset}"`)
    const acpSessionId = rec.acpSessionId
    const host = acpSessionId ? await this.host.hostForStoredSession(rec.agentId, acpSessionId) : undefined
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      await this.refreshStatusBarForKey(key)
      return true
    }
    void this.applySessionPermissionPreset(host, acpSessionId, permissionPreset)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.host.log().warn(`set-permission-preset failed: ${(err as Error).message}`))
    return true
  }

  /** Toggle a session's fast mode by its local key — the fast-mode counterpart of
   *  {@link setModelByKey}. Records the sticky override and applies it live when the
   *  current model offers a fast toggle. */
  async setFastByKey(key: string, fastMode: boolean): Promise<boolean> {
    const rec = await this.chatRuntimeSession(key)
    if (!rec) return false
    await this.host.store().setFastModeOverride(key, fastMode)
    this.host.log().info(`session ${key} fast-mode override → ${fastMode}`)
    const acpSessionId = rec.acpSessionId
    const host = acpSessionId ? await this.host.hostForStoredSession(rec.agentId, acpSessionId) : undefined
    if (!acpSessionId || !host?.hasSession(acpSessionId)) {
      await this.refreshStatusBarForKey(key)
      return true
    }
    void host
      .setSessionFastMode(acpSessionId, fastMode)
      .then(() => this.refreshStatusBarForKey(key))
      .catch((err) => this.host.log().warn(`set-fast failed: ${(err as Error).message}`))
    return true
  }

  /** Re-emit the status bar for a session's in-flight turn (if any) so a config change
   *  (model / effort / fast) is reflected. No-op when the session is idle. */
  async refreshStatusBarForKey(key: string): Promise<void> {
    const rec = await this.host.store().getSession(key)
    const p = rec?.acpSessionId ? this.host.pending().get(pendingTurnKey(rec.agentId, rec.acpSessionId)) : undefined
    if (p) await this.host.emitStatusBar(p)
  }

  /** Set a session's Slack output verbosity by its local key. Purely daemon-side (no ACP):
   *  the next turn's OutputConverger reads this override, so an in-flight turn keeps its
   *  current verbosity and the change takes effect from the next turn. */
  async setOutputModeByKey(key: string, mode: 'none' | 'minimal' | 'low' | 'medium' | 'high'): Promise<boolean> {
    if (!(await this.host.store().getSession(key))) return false
    await this.host.store().setOutputModeOverride(key, mode)
    this.host.log().info(`session ${key} output-mode override → "${mode}"`)
    await this.refreshStatusBarForKey(key)
    return true // reports whether the override was recorded (nothing else reads it)
  }
  /** Route a Slack status-bar Block Kit interaction (the model / effort / fast selects, or
   *  a cancel raised by the native Stop) to the shared key-based cores. `sessionKey` rides
   *  the block; no-op on an unknown key. */
  async handleStatusAction(a: {
    kind: 'set-model' | 'set-effort' | 'set-permission-mode' | 'set-fast' | 'set-output' | 'cancel'
    sessionKey: string
    actor?: InteractionActor
    model?: string
    effort?: string
    permissionMode?: string
    fastMode?: boolean
    outputMode?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  }): Promise<void> {
    // A status-bar tap carries no author in the transcript, so the operator behind a
    // cancelled turn or a switched model is otherwise unrecoverable. Record it here,
    // at the one point every ingress funnels through — but only when the verb actually
    // applied, so a refused or no-op click never reads as a change someone made.
    let applied = false
    if (a.kind === 'cancel') applied = await this.cancelSessionByKey(a.sessionKey, a.actor)
    else if (a.kind === 'set-model') {
      if (a.model) applied = await this.setModelByKey(a.sessionKey, a.model)
    } else if (a.kind === 'set-effort') {
      if (a.effort) applied = await this.setEffortByKey(a.sessionKey, a.effort)
    } else if (a.kind === 'set-permission-mode') {
      if (a.permissionMode) applied = await this.setPermissionModeByKey(a.sessionKey, a.permissionMode)
    } else if (a.kind === 'set-fast') {
      if (a.fastMode !== undefined) applied = await this.setFastByKey(a.sessionKey, a.fastMode)
    } else if (a.kind === 'set-output') {
      if (a.outputMode) applied = await this.setOutputModeByKey(a.sessionKey, a.outputMode)
    }
    if (applied) this.logSessionAction(a.kind, a.sessionKey, a.actor)
  }

  /**
   * A tapped Discord select-card button (`/models` `/effort` `/permission`): resolve the
   * session from the button's key, apply the chosen option, and return the re-rendered
   * card so the connection edits the message in place (new current flagged). Undefined
   * when the session is gone or the option index is stale (options changed) — the
   * connection then leaves the card as-is. Mirrors handleTelegramCallback.
   */
  async handleDiscordSelect(a: {
    kind: SelectKind
    index: number
    sessionKey: string
    actor?: InteractionActor
  }): Promise<{ text: string; components: DiscordComponents } | undefined> {
    const rec = await this.host.store().getSession(a.sessionKey)
    if (!rec) return undefined
    const info = await this.host.statusInfoFrom(rec.agentId, a.sessionKey, rec.acpSessionId ?? undefined)
    const { options } = selectOptions(a.kind, info)
    const value = options[a.index]
    if (value === undefined) return undefined
    // Recorded only once the choice actually applied — a refused or stale select
    // changes nothing and must not read as though someone had changed it. The card is
    // still re-rendered either way, as before.
    if (await applySelect(a.kind, a.sessionKey, value, this.selectSetters))
      this.logSessionAction(`select:${a.kind}`, a.sessionKey, a.actor)
    const components = buildDiscordSelectComponents(a.kind, value, options)
    if (!components) return undefined
    return { text: selectCardText(a.kind, value), components }
  }
  async isSessionMuted(key: string): Promise<boolean> {
    return await this.host.store().isSessionMuted(key)
  }

  async setSessionMuted(key: string, muted: boolean): Promise<void> {
    await this.host.store().setSessionMuted(key, muted)
  }

  /**
   * Resolve a command's target from the channel's latest session when the routing ladder
   * couldn't (no mention entity / thread / dm rule matched — e.g. a group `/status@bot`).
   * Picks the agent that owns the most-recent session in the channel and its integration
   * for this platform while preserving the conversation gate that routing would have
   * applied. Null when there's no session, no matching integration, or the conversation
   * is not admitted.
   */
  async resolveCommandTargetFromLatest(
    msg: NormalizedMessage,
    srcIntegrationIds?: readonly string[]
  ): Promise<{ agentId: string; integrationId: string; via: RouteVia } | null> {
    const transportScope = msg.transportScope ?? this.host.transportScopeForIntegrationIds(srcIntegrationIds)
    // Only where the thread coordinate identifies the session (Slack/Discord) does it
    // participate in the lookup; reply-threading platforms mint a fresh thread per
    // command, so their commands resolve through the channel's latest session.
    const thread = this.host.commandChrome().threadIdentifiesSession(msg.platform) ? msg.thread : undefined
    const candidates: Array<{
      agentId: string
      integrationId: string
      updatedAt: number
    }> = []
    for (const [agentId, agent] of this.host.agents()) {
      for (const integration of agent.integrations) {
        if (
          integration.platform !== msg.platform ||
          !this.host.integrationBelongsToSource(integration.id, srcIntegrationIds) ||
          !this.commandSenderAllowed(agentId, integration.id, msg)
        )
          continue
        const latest = await this.host.store().latestSessionForTransport(agentId, msg.channel, transportScope, thread)
        if (latest) candidates.push({ agentId, integrationId: integration.id, updatedAt: latest.updatedAt })
      }
    }
    candidates.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        a.agentId.localeCompare(b.agentId) ||
        a.integrationId.localeCompare(b.integrationId)
    )
    const latest = candidates[0]
    return latest ? { agentId: latest.agentId, integrationId: latest.integrationId, via: 'thread' } : null
  }

  /** Validate the relay-arbitrated command target against the local agent spec. Shared
   *  bot IMs bypass routeRules' arbitration, but must retain its bot rejection and
   *  conversation admission before executing a control command. */
  resolveExplicitCommandTarget(
    agentId: string,
    integrationId: string,
    msg: NormalizedMessage
  ): { agentId: string; integrationId: string; via: RouteVia } | null {
    if (!this.commandSenderAllowed(agentId, integrationId, msg)) return null
    return { agentId, integrationId, via: 'thread' }
  }

  /** Recovery path for a channel-wide Slack top-level loop latch. The triggering
   *  message itself was rejected, so its warning thread may have no thread owner or
   *  latest session to route a bare `!resume` through. Select only an integration
   *  that admits this conversation, preferring an explicitly mentioned bot. */
  async resolveTopLevelResumeTarget(
    msg: NormalizedMessage,
    srcIntegrationIds?: readonly string[]
  ): Promise<{ agentId: string; integrationId: string; via: RouteVia } | null> {
    const coarseScope = loopGuardScopesFor(msg).coarse
    if (!coarseScope || !(await this.host.store().isLoopGuardOpen(coarseScope))) return null
    const candidates: Array<{
      agentId: string
      integrationId: string
      via: RouteVia
      mentioned: boolean
    }> = []
    for (const [agentId, agent] of this.host.agents()) {
      for (const integration of agent.integrations) {
        // Only reachable when the message's platform has a coarse loop-guard
        // circuit (loopGuardScopesFor), so filtering by the MESSAGE's platform is
        // the platform-neutral statement of the old `!== 'slack'` literal.
        if (
          integration.platform !== msg.platform ||
          !this.host.integrationBelongsToSource(integration.id, srcIntegrationIds) ||
          !this.commandSenderAllowed(agentId, integration.id, msg)
        )
          continue
        const botUserId = integrationRouting(integration).staticBotUserId
        const mentioned = botUserId !== undefined && msg.mentionedBots.includes(botUserId)
        candidates.push({
          agentId,
          integrationId: integration.id,
          via: mentioned ? 'mention' : 'auto',
          mentioned
        })
      }
    }
    candidates.sort(
      (a, b) =>
        Number(b.mentioned) - Number(a.mentioned) ||
        a.agentId.localeCompare(b.agentId) ||
        a.integrationId.localeCompare(b.integrationId)
    )
    return candidates[0] ?? null
  }

  /** Final command admission at the concrete integration. Commands that resolve their
   *  target outside the routing ladder still repeat bot rejection and conversation gating. */
  commandSenderAllowed(agentId: string, integrationId: string, msg: NormalizedMessage): boolean {
    if (msg.sender.isBot) return false
    const integration = this.host
      .agents()
      .get(agentId)
      ?.integrations.find((candidate) => candidate.id === integrationId && candidate.platform === msg.platform)
    if (!integration) return false
    const routing = integrationRouting(integration)
    // Control commands resolve their target OUTSIDE routeRules' scope filter (latest-
    // session fallbacks), so they must repeat the admission check — a channel switched
    // Off, or an Off conversation of a gated integration, takes no commands either.
    return conversationAdmitted(routing, msg.channel)
  }

  /**
   * Handle an in-conversation control command. Resolves the target agent via the
   * same routing ladder as a normal message (so thread affinity and conversation
   * admission apply), then acts on that agent's session in this
   * (channel, thread).
   */
  async handleCommand(
    command: AgentCommand,
    msg: NormalizedMessage,
    explicitTarget?: { agentId: string; integrationId: string; via: RouteVia },
    srcIntegrationIds?: readonly string[]
  ): Promise<boolean> {
    let target: { agentId: string; integrationId: string; via: RouteVia } | null | undefined = explicitTarget
    if (!target) {
      // Prefetched for the ONE thread key `routeRules` can ask about — its own message's.
      const threadOwner = msg.thread ? await this.host.threadOwner(msg.channel, msg.thread, msg.transportScope) : null
      target = routeRules(msg, this.host.mergedRulesForSource(srcIntegrationIds), () => threadOwner)
    }
    if (!target) {
      // Routing found no agent — the common group case: a bare `/status@bot` carries no
      // mention entity, no reply, and its fresh thread has no session. Resolve the agent
      // from the channel's latest session so the command still lands on it (subject to
      // that agent's conversation admission).
      target = await this.resolveCommandTargetFromLatest(msg, srcIntegrationIds)
    }
    if (!target && command.kind === 'resume') target = await this.resolveTopLevelResumeTarget(msg, srcIntegrationIds)
    if (!target) {
      this.host.log().debug(`command: '${command.kind}' in ch=${msg.channel} — no agent resolved, ignoring`)
      return false
    }
    if (!this.commandSenderAllowed(target.agentId, target.integrationId, msg)) {
      this.host.log().warn(`command: '${command.kind}' rejected for unauthorized sender ${msg.sender.id}`)
      return false
    }
    const conn = this.host.replyConnFor(target.agentId, target.integrationId)
    // Where the command was sent — the reply lands here (Slack thread_ts; Telegram
    // replies to the command message via its chrome surface's reply anchor). Kept separate from the session the
    // command ACTS on, resolved just below.
    const replyThread = msg.thread ?? msg.msgId
    // Resolve the session the command acts on. A command that isn't in a session's own
    // thread — notably ANY bare Telegram command, which keys to its own fresh reply
    // thread — falls back to the agent's latest session in this channel, so /stop
    // /cancel /status /fast /models /effort /permission /queue all operate on it rather
    // than on a phantom empty thread. `thread`/`key` follow the resolved session so a
    // `/queue` dispatch continues it and the sticky overrides land on the right key.
    let thread = replyThread
    let key = sessionKey(msg.platform, msg.channel, thread, target.agentId, msg.transportScope)
    let rec = await this.host.store().getSession(key)
    // A cold turn owns its logical key before SessionManager persists the session row.
    // Prefer that exact live gate over the channel's latest historical session; otherwise
    // a `!stop` sent in the cold thread can mute/cancel an older thread and leave the
    // actual turn running. Check all gate representations because commands can race the
    // short hand-offs between them.
    let directGateActive = this.gateActiveFor(key)
    if (!rec && !directGateActive) {
      const latest = await this.host.store().latestSessionForTransport(target.agentId, msg.channel, msg.transportScope)
      if (latest) {
        rec = latest
        key = latest.key
        thread = latest.thread
        directGateActive = this.gateActiveFor(key)
      }
    }
    const acpSessionId = rec?.acpSessionId
    // §6.9 #390: liveness is observed on the LOGICAL sessionKey gate (a turn currently
    // owns the key), not just the ACP-id-keyed `pending` — so `!cancel`/`!stop`/`!queue`
    // also see a session that is gate-owned or queued (cold session with no ACP id yet).
    const inflight = directGateActive
    // Post a short control reply on the platform's own surface (§7.4 command
    // chrome): Slack threads on `thread_ts`; Telegram replies to the command
    // message (reply-based threading), which is also a non-numeric `tg:`/`dm`
    // thread so it never posts as a forum topic.
    const chrome = this.host.commandChrome().for(msg.platform)
    const chromeCtx = { channel: msg.channel, replyThread, sessionKey: key }
    const reply = (text: string): void => {
      if (!conn) return
      chrome.reply(conn, msg, chromeCtx, text)
    }
    const ctx: CommandContext = {
      msg,
      target,
      conn,
      chrome,
      chromeCtx,
      reply,
      key,
      thread,
      replyThread,
      rec,
      acpSessionId: acpSessionId ?? undefined,
      inflight
    }

    const entry = this.registry[command.kind]
    // The Agent-level chat-changes guard, applied for every runtime-setting command before its handler runs.
    if (entry.runtimeChange && this.host.agents().get(target.agentId)?.allowRuntimeChangesInChat !== true) {
      reply('Runtime settings can only be changed by an Agent editor from the Agent page.')
      return true
    }
    // The entry is the one registered for this exact kind; the union-keyed index can't narrow that.
    return await (entry.run as (c: AgentCommand, x: CommandContext) => Promise<boolean>)(command, ctx)
  }

  /** Per-kind command handlers, plus the shared guards dispatch applies ahead of each. */
  private readonly registry: CommandRegistry = {
    resume: { run: async (_command, ctx) => await this.runResume(ctx) },
    stop: { run: async (_command, ctx) => await this.runStop(ctx) },
    cancel: { run: async (_command, ctx) => await this.runCancel(ctx) },
    status: { run: async (_command, ctx) => await this.runStatus(ctx) },
    fast: { runtimeChange: true, run: async (command, ctx) => await this.runFast(command, ctx) },
    model: { runtimeChange: true, run: async (command, ctx) => await this.runSelect(command, ctx) },
    effort: { runtimeChange: true, run: async (command, ctx) => await this.runSelect(command, ctx) },
    permission: { runtimeChange: true, run: async (command, ctx) => await this.runSelect(command, ctx) },
    queue: { run: async (command, ctx) => await this.runQueue(command, ctx) }
  }

  /** `!resume` — reset the latched conversation loop guard and clear a standing thread mute. */
  private async runResume(ctx: CommandContext): Promise<boolean> {
    const { msg, key, thread, replyThread, reply } = ctx
    // Commands sent outside the session thread (notably bare Telegram commands)
    // may have resolved `thread` through latestSession above. Reset the scope the
    // command actually targets, not the fresh command-message thread.
    const directScope =
      thread === replyThread
        ? loopGuardScope(msg)
        : loopGuardScopeFromCoords(msg.platform, msg.channel, thread, msg.isDm, msg.transportScope)
    const topLevelScope = loopGuardScopesFor(msg).coarse
    // A top-level feedback loop posts its warning into the triggering root. A
    // trusted !resume from that warning thread (or elsewhere in the channel)
    // must reset the shared channel circuit, not a never-open per-thread key.
    const scope =
      topLevelScope && (await this.host.store().isLoopGuardOpen(topLevelScope)) ? topLevelScope : directScope
    const stillStopping =
      [...this.host.activeGateEntries().values()].some(
        (entry) => entry.cancelledReason === 'loop protection' && loopGuardScope(entry.msg) === scope
      ) ||
      [...this.host.pending().values()].some((pending) => {
        return pending.outputSuppressed === 'loop protection' && pending.plan.loopGuardScope === scope
      })
    if (stillStopping) {
      reply('Loop protection is still stopping the previous turn. Try `!resume` again in a moment.')
      return true
    }
    const wasOpen = await this.host.store().isLoopGuardOpen(scope)
    await this.host.store().resetLoopGuard(scope)
    this.host.clearEnforcedLoopScope(scope)
    const wasMuted = await this.isSessionMuted(key)
    if (wasMuted) await this.setSessionMuted(key, false)
    if (wasOpen || wasMuted) {
      this.host.log().info(`loop guard: explicitly reset ${scope} by ${msg.sender.id}`)
      reply('▶️ Resumed. Loop protection is reset; send a new message to continue.')
    } else {
      reply('Loop protection is not active in this conversation.')
    }
    return true
  }

  /** `!stop` — interrupt any in-flight turn AND mute the thread until the agent is @mentioned again. */
  private async runStop(ctx: CommandContext): Promise<boolean> {
    const { target, key, rec, acpSessionId, inflight, reply } = ctx
    // Mute the session's thread whether or not a turn is in flight: `!stop` is an
    // explicit stand-down — implicit routing (thread affinity / keyword / auto)
    // stays off until the user @mentions the agent again (onInbound clears it).
    if (rec || inflight) await this.setSessionMuted(key, true)
    const muteNote = 'Muted in this thread — @mention me to resume.'
    if (!inflight) {
      reply(rec ? `🔇 Nothing is running. ${muteNote}` : 'Nothing is running to stop.')
      return true
    }
    await this.host.interruptTurn(target.agentId, key, 'stop', acpSessionId ?? undefined, {
      actor: senderActor(ctx.msg)
    })
    reply(`🛑 Stopped. ${muteNote}`)
    return true
  }

  /** `!cancel` — interrupt the in-flight turn without muting the session. */
  private async runCancel(ctx: CommandContext): Promise<boolean> {
    const { target, key, acpSessionId, inflight, reply } = ctx
    // `!cancel` interrupts the in-flight turn but does NOT mute — the session stays
    // live so a follow-up message dispatches normally. No-op (with a note) when idle.
    if (!inflight) {
      reply('Nothing is running to cancel.')
      return true
    }
    await this.host.interruptTurn(target.agentId, key, 'cancel', acpSessionId ?? undefined, {
      actor: senderActor(ctx.msg)
    })
    reply('🛑 Cancelled.')
    return true
  }

  /** `/status` — reply with the session's model / context / tokens on the platform's own surface. */
  private async runStatus(ctx: CommandContext): Promise<boolean> {
    const { msg, target, conn, chrome, chromeCtx, key, rec, acpSessionId, reply } = ctx
    // `/status` — the on-demand replacement for Telegram's (removed) status bar:
    // reply with the session's model / context / tokens (the latest session in this
    // channel, per the resolution above). No-op note when there's none.
    if (!rec) {
      reply('No active session here yet — send me a message to start one.')
      return true
    }
    const info = this.host.statusInfoFrom(target.agentId, key, acpSessionId ?? undefined)
    // The View link goes to the console, which knows this session by its outward id (§1.1).
    const outward = acpSessionId ? await this.host.outwardSessionId(target.agentId, acpSessionId) : undefined
    const link = outward
      ? this.host.sessionLink(outward, this.host.sessionLinkSource(msg.platform, target.integrationId))
      : undefined
    // Presentation is the platform's (§7.4): HTML chrome + View link on Telegram,
    // markdown + a real link button on Discord, plain text + a 🔗 line on Feishu,
    // the compact pipe-linked status line on Slack.
    if (conn) chrome.status(conn, msg, chromeCtx, await info, link)
    return true
  }

  /** `/fast on|off` — toggle the session's fast mode. */
  private async runFast(command: Extract<AgentCommand, { kind: 'fast' }>, ctx: CommandContext): Promise<boolean> {
    const { key, rec, reply } = ctx
    // `/fast on|off` — toggle the session's fast mode (the control the status-bar
    // Fast button used to offer). Records the sticky override + applies live if warm.
    if (!rec) {
      reply('No active session here to configure.')
      return true
    }
    if (command.enable === null) {
      reply('Usage: `/fast on` or `/fast off`.')
      return true
    }
    await this.setFastByKey(key, command.enable)
    reply(command.enable ? '⚡ Fast mode on.' : '🐢 Fast mode off.')
    return true
  }

  /** `/models` `/effort` `/permission` — list the selectable values or apply the chosen one. */
  private async runSelect(command: Extract<AgentCommand, { kind: SelectKind }>, ctx: CommandContext): Promise<boolean> {
    const { msg, target, conn, chrome, chromeCtx, key, rec, acpSessionId, reply } = ctx
    // `/models`, `/effort`, `/permission` — on-demand session controls.
    // Telegram status-bar dropdowns. A bare command renders a tappable card on Telegram
    // AND Discord (numbered text list on Slack); an argument selects directly. Records
    // the sticky per-session override + applies it live when the ACP session is warm.
    if (!rec) {
      reply('No active session here to configure.')
      return true
    }
    // Platforms with tappable cards render one (§7.4), replied under the command;
    // false falls back to the numbered text list (Slack, or a Discord select over
    // its 25-button ceiling).
    const selectCard = chrome.selectCard?.bind(chrome)
    const renderCard =
      selectCard && conn
        ? (kind: SelectKind, current: string | undefined, options: string[]) =>
            selectCard(conn, msg, chromeCtx, { kind, current, options, header: selectCardText(kind, current) })
        : undefined
    await this.handleSelectCommand(
      command.kind,
      command.value,
      target.agentId,
      key,
      acpSessionId ?? undefined,
      reply,
      renderCard
    )
    return true
  }

  /** `!queue <text>` — admission through the unified per-sessionKey gate, with the queue ACK wording. */
  private async runQueue(command: Extract<AgentCommand, { kind: 'queue' }>, ctx: CommandContext): Promise<boolean> {
    const { msg, target, key, thread, inflight, reply } = ctx
    // queue — now just admission through the UNIFIED per-sessionKey gate (§6.9 #390): the
    // gate itself decides run-now vs enqueue-behind-the-turn; `!queue` only differs in the
    // ACK wording and the queue_full reply. Depth cap + queue-full fast-fail live in the
    // gate (dispatch → QueueFullError), so there is no second FIFO here anymore.
    if (!command.text) {
      reply('Usage: `!queue <message>` — runs when the current turn finishes.')
      return true
    }
    // Dispatch/queue into the resolved session's thread (the fallback may have retargeted
    // it from the bare command thread to the channel's latest session).
    const payload: NormalizedMessage = { ...msg, text: command.text, thread }
    // Reject fast (matching the old depth-cap ACK) before admitting so the user sees the
    // "queue full" note rather than a silent drop; the gate would reject identically.
    if (inflight && (this.host.serialQueue().get(key)?.length ?? 0) >= MAX_QUEUED_PER_SESSION) {
      this.host.log().warn(`command: queue → agent "${target.agentId}" session ${key} full, rejected`)
      reply(`Queue is full (${MAX_QUEUED_PER_SESSION} pending) — wait for the current turn to finish.`)
      return true
    }
    void this.host.dispatchQueueCommand(target.agentId, payload, target.integrationId).catch((err) => {
      if (err instanceof QueueFullError) return // already reported above; race-safe no-op
      this.host.log().error(`queued dispatch failed for agent "${target.agentId}": ${(err as Error).stack ?? err}`)
    })
    if (!inflight) {
      this.host.log().info(`command: queue → agent "${target.agentId}" idle, dispatching now`)
      reply(`▶️ Running now — the session was idle.`)
    } else {
      const depth = this.host.serialQueue().get(key)?.length ?? 0
      this.host.log().info(`command: queue → agent "${target.agentId}" session ${key} (depth ${depth})`)
      reply(`📥 Queued (#${depth}) — will run when the current turn finishes.`)
    }
    return true
  }

  /** Sticky-override setters handed to the pure select projections. */
  private readonly selectSetters: SelectSetters = {
    model: async (key, value) => await this.setModelByKey(key, value),
    effort: async (key, value) => await this.setEffortByKey(key, value),
    permission: async (key, value) => await this.setPermissionModeByKey(key, value)
  }

  /**
   * Back the `/models` `/effort` `/permission` commands. A bare command lists the current
   * selectable values — as a tappable inline-keyboard card when `card` is provided
   * (Telegram), else a numbered text list. An argument applies a choice, matched by exact
   * id, unique case-insensitive substring, or 1-based list index. Options come from the
   * live host's config selectors (statusInfoFrom); when the host is cold a given value is
   * accepted optimistically and takes effect on the next turn.
   */
  async handleSelectCommand(
    kind: SelectKind,
    value: string | null,
    agentId: string,
    key: string,
    acpSessionId: string | undefined,
    reply: (text: string) => void,
    renderCard?: (kind: SelectKind, current: string | undefined, options: string[]) => boolean
  ): Promise<void> {
    const label = selectLabel(kind)
    const info = this.host.statusInfoFrom(agentId, key, acpSessionId)
    const { current, options } = selectOptions(kind, await info)
    const cmd = kind === 'model' ? 'models' : kind

    const disp = (v: string) => selectDisplay(kind, v)

    if (value === null) {
      if (options.length === 0) {
        reply(
          current
            ? `${label}: ${disp(current)} (no other options offered${kind === 'effort' ? ' — the current model may not support effort' : ''}).`
            : `No ${label.toLowerCase()} options available yet — send me a message first, then try /${cmd} again.`
        )
        return
      }
      // A tappable card (Telegram / Discord) when available; false ⇒ fall back to text.
      if (renderCard?.(kind, current, options)) return
      const lines = options.map((o, i) => `${i + 1}. ${disp(o)}${o === current ? '  ✓ (current)' : ''}`)
      reply(`${label} — reply \`/${cmd} <name or number>\`:\n${lines.join('\n')}`)
      return
    }

    // Resolve the chosen value against the offered options (when we have them). Match
    // the raw value OR its display label, so `/permission full access` resolves too.
    let resolved: string | undefined
    if (options.length === 0) {
      resolved = value.trim() // host cold — accept optimistically, applies next turn
    } else {
      const v = value.trim()
      const idx = Number(v)
      if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) resolved = options[idx - 1]
      else {
        const lc = v.toLowerCase()
        const exact = (o: string) => o.toLowerCase() === lc || disp(o).toLowerCase() === lc
        const partial = (o: string) => o.toLowerCase().includes(lc) || disp(o).toLowerCase().includes(lc)
        resolved = options.find(exact) ?? (options.filter(partial).length === 1 ? options.find(partial) : undefined)
      }
    }
    if (!resolved) {
      reply(
        `Unknown ${label.toLowerCase()} "${value.trim()}".${options.length ? ` Options: ${options.map(disp).join(', ')}` : ''}`
      )
      return
    }
    if (!(await applySelect(kind, key, resolved, this.selectSetters))) {
      reply('Runtime settings can only be changed by an Agent editor from the Agent page.')
      return
    }
    reply(
      options.length === 0
        ? `${label} set to ${disp(resolved)} — applies on your next message.`
        : `✅ ${label} set to ${disp(resolved)}.`
    )
  }

  /**
   * Handle a tapped session-control card button (Telegram inline keyboard). Decodes
   * `<kindCode>:<optionIndex>`, resolves the channel's latest admitted session, applies
   * the picked value, acks the tap, and
   * re-renders the card with the new current marked. Best-effort throughout — a tap
   * must never throw out of the update pump.
   */
  async handleTelegramCallback(cb: TelegramCallback, conn: TelegramConnection): Promise<void> {
    const tap = parseTelegramSelect(cb.data)
    if (!tap) {
      void conn.answerCallback(cb.id)
      return
    }
    const { kind, index: idx } = tap
    const srcIntegrationIds = this.host.srcIntegrationIds(conn)
    const session = await this.commandSessionForLatest(
      cb.channel,
      srcIntegrationIds,
      this.host.transportScopeForIntegrationIds(srcIntegrationIds)
    )
    if (!session) {
      void conn.answerCallback(cb.id, 'No active session here.')
      return
    }
    if (this.host.agents().get(session.agentId)?.allowRuntimeChangesInChat !== true) {
      void conn.answerCallback(cb.id, 'Ask an Agent editor to change runtime settings.')
      return
    }
    const info = await this.host.statusInfoFrom(session.agentId, session.key, session.acpSessionId)
    const { options } = selectOptions(kind, info)
    const value = options[idx]
    if (value === undefined) {
      void conn.answerCallback(cb.id, 'Options changed — reopen the menu.')
      return
    }
    if (!(await applySelect(kind, session.key, value, this.selectSetters))) return
    // Telegram names the tapping user on the callback itself; record only the applied
    // change, matching the other funnels.
    this.logSessionAction(`select:${kind}`, session.key, { userId: cb.userId })
    void conn.answerCallback(cb.id, `${selectLabel(kind)} → ${value}`)
    void conn.editCard(
      cb.channel,
      cb.messageId,
      selectCardText(kind, value),
      telegramSelectButtons(kind, value, options)
    )
  }

  /** The newest addressable session for a platform-scoped interaction (a Telegram
   *  command/callback, a Slack message shortcut): scan the caller's own-platform
   *  integrations, retain conversation routing gates, newest first. The caller is
   *  already platform-specific — it names its platform as data, not as a branch. */
  async latestAdmittedSession(
    platform: string,
    channel: string,
    srcIntegrationIds: readonly string[],
    transportScope?: string,
    thread?: string
  ): Promise<SessionRecord | null> {
    return (await this.admittedSessions(platform, channel, srcIntegrationIds, transportScope, thread))[0] ?? null
  }

  /** A turn currently owns this logical key — the gate's admitted head, or the queue behind
   *  it. True through the cold window too, where no session row exists yet. */
  private gateActiveFor(key: string): boolean {
    return this.host.activeGateEntries().has(key) || (this.host.serialQueue().get(key)?.length ?? 0) > 0
  }

  /** The agents whose own-platform integrations admit this conversation — one entry each,
   *  whichever of its integrations qualified. */
  private admittedAgentIds(platform: string, channel: string, srcIntegrationIds: readonly string[]): string[] {
    const agentIds: string[] = []
    for (const [agentId, agent] of this.host.agents()) {
      for (const integration of agent.integrations) {
        if (integration.platform !== platform || !srcIntegrationIds.includes(integration.id)) continue
        if (!conversationAdmitted(integrationRouting(integration), channel)) continue
        agentIds.push(agentId)
        break
      }
    }
    return agentIds
  }

  /** Every admitted session in the conversation, one per participating agent, newest first. */
  private async admittedSessions(
    platform: string,
    channel: string,
    srcIntegrationIds: readonly string[],
    transportScope?: string,
    thread?: string
  ): Promise<SessionRecord[]> {
    const candidates: SessionRecord[] = []
    for (const agentId of this.admittedAgentIds(platform, channel, srcIntegrationIds)) {
      const session = await this.host.store().latestSessionForTransport(agentId, channel, transportScope, thread)
      if (session) candidates.push(session)
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.agentId.localeCompare(b.agentId))
    return candidates
  }

  /** The channel's latest admitted session for a Telegram command/callback. */
  async commandSessionForLatest(
    channel: string,
    srcIntegrationIds: readonly string[],
    transportScope?: string
  ): Promise<{ agentId: string; key: string; acpSessionId?: string } | null> {
    const latest = await this.latestAdmittedSession('telegram', channel, srcIntegrationIds, transportScope)
    return latest ? { agentId: latest.agentId, key: latest.key, acpSessionId: latest.acpSessionId ?? undefined } : null
  }

  /** Resolve a direct Slack message shortcut to the newest addressable session in
   *  that exact bot-scoped conversation, retaining conversation routing gates. */
  async slackShortcutSession(
    shortcut: { channel: string; thread: string },
    srcIntegrationIds: readonly string[]
  ): Promise<string | undefined> {
    const transportScope = this.host.transportScopeForIntegrationIds(srcIntegrationIds)
    return (
      await this.latestAdmittedSession('slack', shortcut.channel, srcIntegrationIds, transportScope, shortcut.thread)
    )?.key
  }

  /** Every addressable session in one Slack conversation, newest first — the native
   *  session-level Stop must interrupt ALL of the thread's in-flight turns, not one.
   *  A turn owns its logical key from admission, but its row is written only once the
   *  runtime answers `session/new`; the Stop control renders over that whole cold window,
   *  so the gate is read alongside the store or the first click cancels nothing. */
  async slackThreadSessions(
    shortcut: { channel: string; thread: string },
    srcIntegrationIds: readonly string[]
  ): Promise<string[]> {
    const transportScope = this.host.transportScopeForIntegrationIds(srcIntegrationIds)
    const sessions = await this.admittedSessions(
      'slack',
      shortcut.channel,
      srcIntegrationIds,
      transportScope,
      shortcut.thread
    )
    const keys = sessions.map((s) => s.key)
    for (const agentId of this.admittedAgentIds('slack', shortcut.channel, srcIntegrationIds)) {
      const cold = sessionKey('slack', shortcut.channel, shortcut.thread, agentId, transportScope)
      if (!keys.includes(cold) && this.gateActiveFor(cold)) keys.push(cold)
    }
    return keys
  }
}

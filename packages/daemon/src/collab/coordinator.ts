// Agent-to-agent collaboration — the A2A wake/reply/status path plus §3.4/§6.8 main-agent
// orchestration, hoisted out of `Daemon` verbatim. Every delivery here is DIRECT (never a
// visible channel post) and every ordering below — record-first, CAS, admission barrier — is
// load-bearing against a fast worker replying before its record exists.
import { randomUUID } from 'node:crypto'
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import {
  hasReachedAgentCallHopLimit,
  type ChildSessionStatus,
  type ExternalSessionAudience,
  type ChildSessionStatusProbe,
  type RdAgentMsgDeliveryKind
} from '@agentconnect.md/protocol'
import type { Logger } from '../log.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { DaemonEvaluationHooks } from '../evaluation/daemon-hooks.js'
import type { CpClient } from '../cp/client.js'
import type { CpAgentRegistry } from '../cp/cp-agent-registry.js'
import type { CpCollabRoutes } from '../cp/cp-collab-routes.js'
import type { RelayManager } from '../cp/relay-manager.js'
import { sendAgentMsgUntilReady } from '../cp/agentmsg-retry.js'
import {
  sessionKey,
  type LocalStore,
  type OrchestrationRow,
  type SessionRecord,
  type SubtaskRow
} from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'
import { isNoResponseBody } from '../session/no-response.js'
import { isPlatformMemberId } from '../platforms/member-id.js'
import { threadKeyForPost } from '../platforms/thread-keys.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { WebchatTransport } from '../webchat/transport.js'
import type { WebchatTurnContext } from '../webchat/types.js'
import { formatErr } from '../daemon/text.js'
import { ACTIVATION_PAIRING_TTL_MS, activationKey } from '../daemon/helpers.js'
import { pendingTurnKey, sdkLeaseKey, type CallMeta, type Pending, type QueueEntry } from '../daemon/turn-types.js'
import type {
  MessageAgentReq,
  MessageAgentResult,
  OrchestrationOwnerReq,
  ReplyToSessionReq,
  ReplyToSessionResult,
  SessionStatusReq,
  SessionStatusResult,
  StartOrchestrationReq,
  StartOrchestrationResult
} from '../mcp/ops.js'

/** Process-wide daemon state the collaboration path reads. */
export interface CollabCoreHost {
  log(): Logger
  clock(): Clock
  store(): LocalStore
  agents(): ReadonlyMap<string, LoadedAgent>
  evalHooks(): DaemonEvaluationHooks
  /** Live turns keyed by `pendingTurnKey(agentId, acpSessionId)`. */
  pending(): ReadonlyMap<string, Pending>
  /** Per-session call metadata of the turn running right now — the caller's live hop depth. */
  activeTurnCallMeta(): ReadonlyMap<string, CallMeta>
  /** Shutdown/pause: an A2A obligation must not be inferred while the daemon is draining. */
  draining(): boolean
  /** Serialized queue depth and the entry executing now, keyed by logical sessionKey. */
  serialQueue(): ReadonlyMap<string, readonly QueueEntry[]>
  activeGateEntries(): ReadonlyMap<string, QueueEntry>
  /** Background SDK tasks a child may still legitimately be waiting on. */
  sdkLease(): ReadonlyMap<string, { tasks: ReadonlyMap<string, unknown>; armedWakes: number }>
}

/** The CP/relay seam a cross-daemon call, peer lookup, or remote status read goes through. */
export interface CollabRoutingHost {
  cpClient(): CpClient | undefined
  cpAgents(): CpAgentRegistry | undefined
  cpCollab(): CpCollabRoutes
  relays(): RelayManager | undefined
  /** Peer directory names cached from `channelAgents`, the only local source for a remote label. */
  channelAgentNames(): ReadonlyMap<string, { name?: string; displayName?: string }>
  botUserIds(): Record<string, string>
  resolveCpAgent(
    agentId: string,
    platform?: string
  ): { integrationId: string; botUserId: string; platform: string; mutedChannels: string[] } | null
  transportScopeForIntegrationIds(integrationIds?: readonly string[]): string | undefined
  integrationIdForSessionTransport(
    agentId: string,
    platform: string,
    transportScope?: string | null
  ): string | undefined
  /** Whether this member serves the agent's ingress edges and sweeps: duty holder, or any local daemon. */
  servesAgent(agentId: string): boolean
}

/** The turn engine an admitted collaboration wake is handed to. */
export interface CollabTurnHost {
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: {
      requireDurable?: boolean
      onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
    }
  ): Promise<string | null>
  webchatTransport(): WebchatTransport
  externalOriginForSession(
    agentId: string,
    acpSessionId: string | undefined
  ): Promise<ExternalSessionAudience | undefined>
}

/** Everything the collaboration coordinator touches on the `Daemon`. */
export interface CollabHost extends CollabCoreHost, CollabRoutingHost, CollabTurnHost {}

export class CollabCoordinator {
  constructor(private readonly host: CollabHost) {}

  // Admission-idempotency for same-daemon agent→agent (`messageAgent`) delivery, keyed by
  // the stable `deliveryId` (design §6.3) — NOT msgId. A retry (P2) reuses the deliveryId,
  // so a second delivery of the same id returns the cached result WITHOUT a second dispatch
  // (no double-wake). Bounded like `relayMsgAcks`. Local path only; cross-daemon dedup is P2.
  readonly agentCallDeliveries = new Map<string, MessageAgentResult>()

  // Parent→child links recorded at wake ADMISSION, keyed by the child's logical sessionKey
  // (== the `childSessionId` handed back by `sendMessage`), valued by the waking session's stable
  // acpSessionId. Authorizes `viewSessionStatus` during the window where the child has been
  // admitted but its session row does not exist yet — dispatch is fire-and-forget, so the parent
  // can legitimately poll before the child's first turn reaches SessionManager. Once that row
  // exists its durable `originSessionId` is the authority, so this is a startup shim, not the
  // record: it is in-memory (a restart kills the in-flight wake it covers anyway) and bounded.
  //
  // `rowUpdatedAtAtAdmission` additionally fences a RE-wake of an already-finished child: the row
  // still reads `idle` + the PREVIOUS turn's `lastTurnOutcome` until SessionManager flips it to
  // `prompting`, so a parent polling right after re-delegating would otherwise be handed the old
  // `done`. Comparing the row's own `updatedAt` against its value at admission is clock-source
  // independent (the store stamps `Date.now()`, the daemon reads `this.clock`), so an unchanged
  // value means "has not acted on our wake yet" without comparing two clocks.
  //
  // `remote:true` marks a child admitted on ANOTHER daemon. Its row will never appear in this
  // store, so the link is the only record that the wake happened and who may follow it; the status
  // read for those is routed through the CP (§5.4) instead of the local store.
  readonly childSessionLinks = new Map<
    string,
    {
      parentSessionId: string
      agentId: string
      rowUpdatedAtAtAdmission: number | null
      replyRequested: boolean
      replyState: 'awaiting' | 'queued-for-parent' | 'failed'
      remote?: boolean
    }
  >()

  // §3.4/§6.8 orchestration deadline timers, keyed by orchestrationId. Held HERE
  // (daemon-owned), NOT in the Scheduler's per-agent map — Scheduler.sync is replace-all
  // and would wipe a per-orchestration one-shot on the next agent reconcile. The durable
  // SoT is the `orchestration.deadline` epoch; this map is just the live in-process timer,
  // re-armed from the store on startup. cancelOrchestration clears the timer idempotently.
  readonly orchestrationDeadlines = new Map<string, TimerHandle>()

  /** An agent's channel-directory display name, used to name the caller in the
   *  text delivered to a messaged agent. Resolution order:
   *  a LOCAL agent from `host.agents()`; else the collab snapshot the CP pushes to every daemon
   *  (`cpCollab`, authoritative + always present, so it resolves a REMOTE peer even in the
   *  reply direction where this daemon never listed the channel); else the name cached from a
   *  `channelAgents` (listAgents) response; else the raw agentId (keeps a cold lookup
   *  from throwing). */
  agentDisplayLabel(agentId: string): string {
    const local = this.host.agents().get(agentId)
    if (local) return local.displayName?.trim() || local.name || agentId
    const snap = this.host.cpCollab().nameOf(agentId)
    if (snap) return snap.displayName?.trim() || snap.name || agentId
    const cached = this.host.channelAgentNames().get(agentId)
    return cached?.displayName?.trim() || cached?.name || agentId
  }

  /**
   * Prepare an agent→agent delivery: the caller-framed text the target will see
   * plus a stable delivery id and thread. The message is delivered DIRECTLY to
   * the target (which wakes it in its own turn); it is deliberately NOT posted
   * as a visible channel/thread message and is not recorded in the shared
   * transcript. Agent-to-agent coordination (messageAgent / startOrchestration)
   * is no longer surfaced as channel chatter — only the target receives it.
   */
  prepareAgentDelivery(req: MessageAgentReq): {
    deliveryId: string
    thread: string
    /** The text DELIVERED to the target's turn. Names the caller so an isolated
     *  callee (§6.6), whose only view of the request is this handed text, knows
     *  who to reply to. */
    text: string
  } {
    const callerLabel = this.agentDisplayLabel(req.callerAgentId)
    // `@Caller:` reads like an instruction addressed TO the caller and can make
    // the callee's no-response rule suppress a legitimate direct call. Use an
    // explicit sender label instead; trusted CallMeta remains the authority.
    const deliverText = `From ${callerLabel}: ${req.text}`
    const deliveryId = monotonicTs()
    const thread = req.thread ?? deliveryId
    return { deliveryId, thread, text: deliverText }
  }

  /**
   * The channel a DAEMON-INITIATED channel-intro turn is bound to (issue #536), resolved
   * from the turn's trusted `CallMeta` — the same §6.7 active-turn lookup a nested
   * `messageAgent` uses to inherit hop/origin, keyed by the caller's LOGICAL sessionKey.
   * Returns undefined for every ordinary turn, which is what keeps `listAgents` org-wide
   * by default. The coordinates come from the trusted MCP session context, never tool input,
   * so an agent cannot fabricate (or escape) an intro scope.
   */
  introChannelForTurn(
    agentId: string,
    platform: string,
    coords: { channel?: string; thread?: string; transportScope?: string }
  ): string | undefined {
    if (coords.channel === undefined || coords.thread === undefined) return undefined
    const key = sessionKey(platform, coords.channel, coords.thread, agentId, coords.transportScope)
    return this.host.activeTurnCallMeta().get(key)?.introChannel
  }

  /**
   * Agent→agent attention routing behind the `messageAgent` MCP tool. The message is
   * delivered directly to the target and wakes it — there is no visible thread event.
   * Trusted `CallMeta` is a separate workflow projection for hop limits and
   * orchestration correlation.
   */
  /**
   * Side-effect-free authorization for a peer wake on the SAME-DAEMON path — the typed reason
   * {@link messageAgent} would reject it with for a LOCALLY-decidable cause, or, when it is
   * admitted, the CHANNEL the woken session may key off. `sendMessage` uses the rejection half
   * as a preflight, so it never leaves a visible channel post for a `toAgent`+`channel` wake
   * that will never be delivered; `messageAgent` uses BOTH halves, which is why they are one
   * method — a coordinate decided twice could be decided differently. MUST stay in sync with
   * the fail-closed guards in {@link messageAgent}: a reason added there but not here would let
   * a doomed wake still post. A remote target's LOCAL agent config is not readable here (that
   * verdict lives on the owning daemon) — but the org-scoped directory below covers a remote
   * target too, because the CP snapshot is org-wide rather than per-daemon.
   *
   * Two independent checks, in order: the directional call POLICY (`admits`, channel-free)
   * and the COORDINATE INTEGRITY of `req.channel` (`coordsDecision`). Dropping channel from
   * the policy predicate did not drop it as a session coordinate, and this is the
   * same-daemon twin of the relay/terminal-verify gate.
   */
  localWakeDecision(req: MessageAgentReq): { rejection: string } | { rejection: null; channel: string } {
    const caller = this.host.agents().get(req.callerAgentId)
    const channelRootSelfWake = req.toAgentId === req.callerAgentId && req.postless !== true
    if (
      !caller ||
      (!channelRootSelfWake &&
        caller.outboundPolicy === 'selected' &&
        !caller.allowedTargetAgentIds.includes(req.toAgentId))
    ) {
      return { rejection: 'not_allowed' }
    }

    // A local id is not sufficient authority: the org-scoped directional call policy must
    // admit caller→target (CpCollabRoutes.admits). Channel membership is NOT consulted —
    // A2A delivery is already postless (#854), so `channel` is only a session coordinate,
    // and a session with no IM integration must still be able to collaborate. Evaluated
    // BEFORE the local-target lookup so it also decides a REMOTE target and an id that is
    // in no directory at all (previously the latter fell through to a misleading
    // 'offline'). Fails closed on an absent/stale snapshot, as before.
    // A visible channel-root self wake is not an inter-agent policy edge. The successful
    // platform post proves the caller can write the named conversation; coordinate integrity
    // below still proves the resulting child may be keyed there. Postless self calls never
    // reach this branch — the explicit self guard rejects those before authorization.
    if (!channelRootSelfWake && !this.host.cpCollab().admits(req.callerAgentId, req.toAgentId)) {
      return { rejection: 'not_allowed' }
    }

    // COORDINATE INTEGRITY — the SAME decision the relay's ingress and this daemon's
    // `rd/agentmsg` terminal-verify apply, so all three wake paths enforce one rule. Channel
    // stopped AUTHORIZING the call, but `req.channel` (a model-supplied `channel`, or the
    // turn's own channel) is still the woken peer's session coordinate, so without this a
    // model could name a channel its agent cannot reach and RESUME a co-located peer's
    // session there. Org comes from the caller's own directory entry, never from the
    // request; `admits` above already proved the entry exists, so undefined is unreachable
    // and fails closed anyway.
    //
    // The platform is the RAW trusted session platform — the same value session keys now
    // use everywhere (the old `narrowPlatform` fold that turned `dream` and unknown values
    // into 'slack' is deleted, §6.3). A fold here would classify a genuinely channel-free
    // session as a persisted IM coordinate and fail it closed. Only the branch-2/branch-3
    // split reads the platform at all — the row lookup itself stays platform-free — so
    // passing the raw value cannot re-open the platform-relabelling dodge.
    const callerOrg = this.host.cpCollab().orgForAgent(req.callerAgentId)
    if (callerOrg === undefined) return { rejection: 'not_allowed' }
    const coords = this.host.cpCollab().coordsDecision(callerOrg, req.platform, req.channel, req.callerAgentId)
    if (coords.verdict === 'reject') return { rejection: 'not_allowed' }

    const target = this.host.agents().get(req.toAgentId)
    if (
      !channelRootSelfWake &&
      target?.callPolicy === 'selected' &&
      !target.allowedCallerAgentIds.includes(req.callerAgentId)
    ) {
      return { rejection: 'not_allowed' }
    }
    // Branch 3 substitutes the coordinate rather than refusing the wake; branch 1 hands back
    // `req.channel` untouched so a wake into a shared channel still lands in the thread a
    // human sees.
    return { rejection: null, channel: coords.verdict === 'synthetic' ? coords.channel : req.channel }
  }

  wakeRejectionReason(req: MessageAgentReq): string | null {
    const platform = req.platform
    if (isPlatformMemberId(platform, req.toAgentId)) {
      return 'invalid_target'
    }
    // `sendMessage(toAgent=self, channel=...)` preflights before the root post exists, so
    // absence of the postless marker is the trusted indication that this is the visible form.
    // messageAgent performs the stronger post-ts + pairing-id check before dispatch.
    if (req.toAgentId === req.callerAgentId && req.postless === true) return 'self'
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    if (inbound !== undefined && hasReachedAgentCallHopLimit(inbound.hopCount + 1)) return 'hop_limit'
    return this.localWakeDecision(req).rejection
  }

  async messageAgent(req: MessageAgentReq): Promise<MessageAgentResult> {
    const platform = req.platform
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const observe = async (
      type:
        'collaboration.delivery.admitted' | 'collaboration.delivery.rejected' | 'collaboration.delivery.deduplicated',
      result: MessageAgentResult,
      deliveryId?: string
    ): Promise<MessageAgentResult> => {
      const caller = await this.host.store().getSession(callerKey)
      const pending = caller?.acpSessionId
        ? this.host.pending().get(pendingTurnKey(req.callerAgentId, caller.acpSessionId))
        : undefined
      this.host.evalHooks().emit({
        type,
        agentId: req.callerAgentId,
        ...(caller?.acpSessionId ? { sessionId: caller.acpSessionId } : {}),
        ...(pending?.plan.evaluationTurnId ? { turnId: pending.plan.evaluationTurnId } : {}),
        platform,
        channel: req.channel,
        data: {
          toAgentId: req.toAgentId,
          targetSession: result.targetSession,
          ...(deliveryId ? { deliveryId } : {}),
          ...(result.reason ? { reason: result.reason } : {})
        }
      })
      return result
    }
    // `toAgentId` is an AgentConnect id from listAgents / the trusted agent-call
    // envelope, never a platform member id. In particular, accepting Slack's U…/W… ids
    // here produces a visible `@U…` fallback before the relay can reject the unknown
    // target. Fail before publishing so a model that copied the human-facing Slack
    // mention cannot leave a misleading thread event.
    if (isPlatformMemberId(platform, req.toAgentId)) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:invalid-target`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'invalid_target'
      })
    }
    // A self wake is valid only when `sendMessage` has already published the paired channel-root
    // post and can anchor the child to its real provider coordinate. Postless self calls — and
    // any internal caller that merely omits the marker without proving a post — remain loops.
    const pairedChannelRootSelfWake =
      req.toAgentId === req.callerAgentId &&
      req.postless !== true &&
      req.transcriptTs !== undefined &&
      !req.transcriptTs.startsWith('local-') &&
      req.agentCallDeliveryId !== undefined
    if (req.toAgentId === req.callerAgentId && !pairedChannelRootSelfWake) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:self`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'self'
      })
    }

    // Trusted source-turn metadata is independent from the delivered message. Both
    // local and relay paths inherit reply correlation identically.
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    const sourceHopCount = inbound?.hopCount ?? 0
    // session-concept §5.3: capture the CALLER's own session as the woken child's origin, so
    // the child can reply into it via `sendMessage`'s SessionTarget (across thread/platform/
    // daemon). The lineage id is the caller's OUTWARD one (§1.1) — an ACP id names a session
    // only inside its own runtime, and this one travels to another agent, another daemon and
    // the CP. originCoords are its landing coords for cross-daemon reply routing.
    const callerSession = await this.host.store().getSession(callerKey)
    const originSessionId = callerSession
      ? await this.host.store().ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    // These two read the caller's LOCAL rows, which are keyed by the runtime's id.
    const callerAcpSessionId = callerSession?.acpSessionId ?? undefined
    const externalOrigin = await this.host.externalOriginForSession(req.callerAgentId, callerAcpSessionId)
    const originCoordPlatform = platform
    const originCoords: CallMeta['originCoords'] = {
      platform: originCoordPlatform,
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    if (inbound !== undefined && hasReachedAgentCallHopLimit(sourceHopCount + 1)) {
      const fallbackThread = req.thread ?? `agentcall:${req.channel}:hop-limit`
      return observe('collaboration.delivery.rejected', {
        delivered: false,
        targetSession: sessionKey(platform, req.channel, fallbackThread, req.toAgentId),
        reason: 'hop_limit'
      })
    }
    const isReply = inbound !== undefined && req.toAgentId === inbound.callFrom
    const correlationId =
      req.correlationId !== undefined ? req.correlationId : isReply ? inbound.correlationId : undefined

    const target = this.host.agents().get(req.toAgentId)
    const resolved = target ? this.host.resolveCpAgent(req.toAgentId, platform) : null
    const integrationId = resolved?.integrationId
    const targetTransportScope =
      integrationId !== undefined ? this.host.transportScopeForIntegrationIds([integrationId]) : undefined
    // The same side-effect-free authorization sendMessage's preflight ran (caller existence +
    // outbound policy, the org-scoped directional call policy, a local target's inbound policy,
    // and COORDINATE INTEGRITY). It is resolved BEFORE the coordinate is minted because it also
    // decides WHICH channel may be minted: a channel-free coordinate the snapshot knows nothing
    // about is admitted but must not become the session key, so `localWakeDecision` hands back a
    // caller-derived channel (`a2a:<callerAgentId>`) that cannot alias any platform session. The
    // rejection path keeps reporting the ASSERTED channel — nothing was opened, and the reason,
    // not the coordinate, is what the caller acts on.
    const wake = this.localWakeDecision(req)
    const coordChannel = wake.rejection === null ? wake.channel : req.channel
    // A2A delivery is direct and postless (#854): the woken peer receives a caller-framed
    // message and nothing is left in any channel. session-concept case 2c (pure wake) is thus
    // the default — a `sendMessage` with `toAgent` never posts, regardless of `channel`.
    const event = this.prepareAgentDelivery(req)
    const { deliveryId } = event
    const msgId = `agentcall:${coordChannel}:${deliveryId}`
    const targetSession = sessionKey(platform, coordChannel, event.thread, req.toAgentId, targetTransportScope)

    const prior = this.agentCallDeliveries.get(deliveryId)
    if (prior) return observe('collaboration.delivery.deduplicated', prior, deliveryId)
    const record = (result: MessageAgentResult): Promise<MessageAgentResult> => {
      if (this.agentCallDeliveries.size >= 2000) this.agentCallDeliveries.clear()
      this.agentCallDeliveries.set(deliveryId, result)
      return observe(
        result.delivered ? 'collaboration.delivery.admitted' : 'collaboration.delivery.rejected',
        result,
        deliveryId
      )
    }

    if (wake.rejection !== null) {
      this.host.log().info(`messageAgent: ${req.callerAgentId} not allowed to call ${req.toAgentId} in ${req.channel}`)
      return record({ delivered: false, targetSession, reason: 'not_allowed' })
    }

    // Local presence: if absent, route the delivery over the relay. The relay
    // decides whether the target is allowed to be woken by this caller.
    if (!target) {
      const coordPlatform = platform
      const remote = await this.routeAgentMsgCrossDaemon(
        { ...req, text: event.text, thread: event.thread },
        {
          platform: coordPlatform,
          // The ASSERTED coordinate, not `coordChannel`: the relay validates what the caller
          // named, and the OWNING daemon mints the session key (and any channel-free
          // substitution) — we take that canonical key back off the ACK below.
          channel: req.channel,
          thread: event.thread,
          deliveryId,
          targetSession,
          sourceHopCount,
          correlationId,
          ...(originSessionId !== undefined ? { originSessionId } : {}),
          ...(callerAcpSessionId !== undefined ? { originAcpSessionId: callerAcpSessionId } : {}),
          originCoords,
          ...(externalOrigin ? { externalOrigin } : {})
        }
      )
      // §5.4: an ADMITTED remote wake is still a child this session may follow — its row lives on
      // the owning daemon, so mark the link remote and let viewSessionStatus route through the CP.
      if (remote.delivered && originSessionId !== undefined) {
        if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
        // Key it by the CANONICAL key the target returned (`remote.targetSession`), not our
        // pre-ACK guess — that canonical value is what we hand the agent, so it is what a later
        // `viewSessionStatus` will look up.
        this.childSessionLinks.set(remote.targetSession, {
          parentSessionId: originSessionId,
          agentId: req.toAgentId,
          rowUpdatedAtAtAdmission: null,
          replyRequested: req.needsReply === true,
          replyState: 'awaiting',
          remote: true
        })
      }
      return record(remote)
    }

    // Trusted call metadata for the target's turn (§3.3a/§6.6/§6.7): kept daemon-private
    // (Pending.callMeta), never in the model-visible prompt. DAEMON-MANAGED auto-inheritance
    // from the CURRENT turn's trusted callMeta (never trusting the agent to hand-copy it):
    //   • hopCount / originId: ALWAYS inherit (current hopCount + 1) for loop protection,
    //     regardless of target. A call made from a plain human/platform turn (no active
    //     callMeta) starts at hopCount 0.
    //   • correlationId: inherit ONLY on a REPLY — i.e. when the worker is messaging back the
    //     agent that tasked it (toAgentId === the current turn's inbound callFrom) AND the
    //     tool caller did not pass one explicitly. An explicit args.correlationId is honored
    //     as a manual override (advanced use); otherwise the auto-inherit-on-reply is what
    //     makes N-of-N orchestration close without the agent ever knowing the id. A message
    //     to a THIRD agent (not the caller) does NOT inherit correlation — it's a fresh call.
    const hopCount = inbound ? inbound.hopCount + 1 : 0
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      ...(correlationId !== undefined ? { correlationId } : {}),
      hopCount,
      deliveryId,
      // §5.3: hand the child its origin so it can reply back with `sendMessage({sessionId})`.
      ...(originSessionId !== undefined ? { originSessionId } : {}),
      originCoords,
      ...(externalOrigin ? { externalOrigin } : {}),
      // §5.3: `toAgent.needsReply` — tell the child to report its outcome back to that origin.
      // Meaningless without an origin to reply into, so it rides the same condition.
      ...(req.needsReply === true && originSessionId !== undefined ? { needsReply: true } : {}),
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId !== undefined &&
      (await this.host.store().isCaptureExcluded(req.callerAgentId, callerAcpSessionId))
        ? { parentPrivate: true }
        : {})
    }

    const normalized: NormalizedMessage = {
      msgId,
      traceId: deliveryId,
      source: 'agent',
      // `coordChannel`, so the dispatched turn lands on exactly the key `targetSession`
      // reports (identical to `req.channel` outside the channel-free branch).
      platform,
      channel: coordChannel,
      thread: event.thread,
      ...(targetTransportScope !== undefined ? { transportScope: targetTransportScope } : {}),
      sender: { id: req.callerAgentId, isBot: true },
      text: event.text,
      mentionedBots: resolved?.botUserId ? [resolved.botUserId] : [],
      isDm: false,
      // A `toAgent`+`channel` wake was preceded by a visible post; carry its real ts so the
      // wake's transcript row collapses onto the recorded post's (channel, thread, ts) PK
      // (no duplicate hand-off) and the session cursor stays canonical (mirrors the
      // spawnChannelRootSession seed). Absent ⇒ transcriptCoords derives ts from the msgId.
      ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
      // Self-introduce-on-join (#536): a fan-out from an intro turn wakes each peer
      // HEADLESS so it records the newcomer silently, never posting to the channel.
      // send-message-routing-rework.md §3.1 adds the second case: the POSTLESS `toAgent`
      // form. Nothing is posted to announce the call, so letting the child's own answer
      // surface in the caller's channel would reintroduce exactly the interruption that
      // form exists to avoid. The child stays fully followable (lineage, correlation,
      // `needsReply`, `viewSessionStatus`) and reports back through the session reply.
      ...(inbound?.deliverHeadless || req.postless ? { headless: true } : {})
    }

    // Fire-and-forget dispatch — mirror handleRelayIm. The wake is async: the tool returns
    // `delivered:true` on ADMISSION (the target processes the turn in its own time), not on
    // the peer's reply. dispatch() drops the turn (returns null) if the target is paused/
    // draining; that still counts as admitted for P1 (a reason-typed NAK on those gates is
    // P2's admission protocol, §6.4).
    // Record the lineage BEFORE the fire-and-forget dispatch, so a parent that polls
    // `viewSessionStatus` the instant sendMessage returns is already authorized.
    if (originSessionId !== undefined) {
      if (this.childSessionLinks.size >= 2000) this.childSessionLinks.clear()
      this.childSessionLinks.set(targetSession, {
        parentSessionId: originSessionId,
        agentId: req.toAgentId,
        // Snapshot the child row as it stands BEFORE the wake runs (null when it has never run),
        // so a re-wake of a finished child can't be reported with its previous turn's outcome.
        rowUpdatedAtAtAdmission: (await this.host.store().getSession(targetSession))?.updatedAt ?? null,
        replyRequested: req.needsReply === true,
        replyState: 'awaiting'
      })
    }
    // send-message-routing-rework.md §3.2/§8.6 — the "internal wake first" arrival order
    // of a PAIRED `toAgent + channel` call. The wake is the SEMANTIC AUTHORITY (it alone
    // carries lineage, correlation, needsReply, external origin, and the privacy gate),
    // so it attaches the envelope and admits. The platform echo of the same post then
    // reconciles onto this record instead of opening a second child — whenever it
    // arrives, including after a restart, which is why the record is durable.
    let pairingKey: string | undefined
    if (req.transcriptTs !== undefined) {
      const key = activationKey(platform, targetTransportScope, req.transcriptTs, req.toAgentId)
      const claimed = await this.host
        .store()
        .attachActivationEnvelope(
          key,
          JSON.stringify(callMeta),
          this.host.clock().now() + ACTIVATION_PAIRING_TTL_MS,
          callMeta.deliveryId
        )
      if (!claimed.dispatch) {
        // Already admitted (a retry reusing this delivery id, or a replay). Hand back the
        // SAME child rather than dispatching again — exactly-once is the contract.
        this.host
          .log()
          .info(
            `messageAgent: paired delivery ${req.agentCallDeliveryId ?? deliveryId} already claimed — reusing the existing child`
          )
        return record({ delivered: true, targetSession: claimed.record.childSessionId ?? targetSession })
      }
      this.host
        .log()
        .debug(
          `messageAgent: paired call ${req.agentCallDeliveryId ?? deliveryId} claimed the rendezvous for "${req.toAgentId}" at ${req.transcriptTs}`
        )
      // §8.6: settled centrally in `dispatch` off `callMeta.activationKey`, which is
      // persisted with the inbox row — so a replayed turn completes this rendezvous itself.
      pairingKey = key
      callMeta.activationKey = key
    }
    void this.host
      .dispatch(
        req.toAgentId,
        normalized,
        integrationId,
        this.host.webchatTransport().webchatWakeContext(platform, coordChannel),
        callMeta,
        { ...(pairingKey !== undefined ? { requireDurable: true } : {}) }
      )
      .catch(async (err) => {
        if (pairingKey !== undefined) await this.host.store().releaseActivation(pairingKey)
        this.host.log().error(`messageAgent dispatch failed for agent "${req.toAgentId}": ${formatErr(err)}`)
      })
    this.host
      .log()
      .info(`messageAgent: ${req.callerAgentId} → ${req.toAgentId} (${targetSession}) delivery=${deliveryId}`)
    return record({ delivered: true, targetSession })
  }

  /**
   * Reply into an existing session addressed by its stable id (session-concept §5.2 —
   * `sendMessage`'s SessionTarget). Unlike `messageAgent` this does NOT create a new session
   * or publish a visible thread event: it inserts a `{type:system, from:<caller>}` message
   * into the ORIGIN session and continues/wakes it.
   *
   * AUTHORIZATION (origin-only, fail-closed, §5.3): the only session a caller may reply into
   * is the origin the CURRENT turn was woken from. The caller identity comes from the trusted
   * session context; `sessionId` is the sole tool input and is validated to equal the turn's
   * `originSessionId`. A root/human turn (no active call metadata) or any other sessionId is
   * refused — an agent can never inject into an arbitrary session.
   */
  /**
   * The #800 inferred reply — the mechanism half the parked directive fix (#905) could not
   * substitute for, measured on the webchat night-collection cell: a COLD needsReply child
   * mostly answers its delegation as its ordinary assistant response (a correct answer,
   * delivered to nobody) and never reaches for any messaging tool. The pi-intercom pattern:
   * when a delegation turn ends cleanly without the child having sent its
   * `sendMessage {sessionId}` report, deliver the child's final ordinary output TO the parent
   * as the report, explicitly marked inferred — a headless child's answer is never silently
   * dropped.
   *
   * Exactly-one-obligation scoping (the niche boundary):
   *  - only turns whose OWN trusted CallMeta carries `needsReply` + an origin — i.e. the
   *    delegation wake itself (and a re-delegation into the same child). Human follow-ups,
   *    plain calls, continuations, and unrelated turns of the child session never infer;
   *  - only when the obligation is still open (`replyState === 'awaiting'`) — a report the
   *    child actually sent this turn, or one that terminally failed, is respected;
   *  - only clean completions: failed/suppressed turns keep their own semantics
   *    (`viewSessionStatus` reports those);
   *  - deferred when the session still has live background tasks — the bg-task wake exists
   *    precisely to let the child report AFTER its task settles, and that wake turn (which
   *    carries no CallMeta) will not re-infer; the obligation then resolves through the
   *    child's own report or stays visibly `awaiting`.
   *
   * A child whose final output is empty or the no-response sentinel produced NOTHING to
   * infer — the parent gets an explicit "finished without reporting" wake instead of
   * silence. Delivery reuses `replyToSession` verbatim (origin authorization, hop charge,
   * queue/coalesce semantics, `markChildParentReply`), so an inferred report is
   * indistinguishable from a real one on every axis EXCEPT the marker the parent (and the
   * artifacts) see. Runs while the turn's activeTurnCallMeta is still installed.
   */
  async maybeInferParentReply(
    childKey: string,
    agentId: string,
    msg: NormalizedMessage,
    callMeta: CallMeta | undefined,
    p: { reply: { text: string }; outputSuppressed?: string | undefined }
  ): Promise<void> {
    if (this.host.draining()) return
    if (!callMeta?.needsReply || callMeta.originSessionId === undefined) return
    if (p.outputSuppressed) return
    const link = this.childSessionLinks.get(childKey)
    if (link && (link.parentSessionId !== callMeta.originSessionId || link.replyState !== 'awaiting')) return
    // Live background tasks: the child may legitimately be waiting to report until its
    // task settles (see wakeOnBackgroundTaskDone). Do not preempt that with a premature
    // inference of "I started the task…" narration. `armedWakes` closes the settle race
    // (review): a task that just SETTLED leaves `tasks` before its wake timer fires —
    // and that wake is deferred while this very dispatch finalizes — so a tasks-only
    // check would see zero and infer the narration while the bg wake is still owed.
    const sessionId = (await this.host.store().getSession(childKey))?.acpSessionId ?? undefined
    const lease = sessionId !== undefined ? this.host.sdkLease().get(sdkLeaseKey(agentId, sessionId)) : undefined
    if (lease !== undefined && (lease.tasks.size > 0 || lease.armedWakes > 0)) return
    const finalOutput = p.reply.text.trim()
    const text =
      finalOutput && !isNoResponseBody(finalOutput)
        ? `[inferred reply] The delegated session finished its turn without sending its report ` +
          `(no sendMessage {"sessionId"} call). This is its final output, delivered on its behalf:\n\n${finalOutput}`
        : `[inferred reply] The delegated session finished its turn without sending its report and ` +
          `produced no final output. Treat the delegation as ended without a result.`
    this.host
      .log()
      .info(
        `inferred parent reply: ${agentId} (${childKey}) → session ${callMeta.originSessionId} ` +
          `(turn ended with obligation open; output ${finalOutput ? `${finalOutput.length} chars` : 'empty'})`
      )
    void this.replyToSession({
      callerAgentId: agentId,
      platform: msg.platform,
      ...(msg.transportScope !== undefined ? { callerTransportScope: msg.transportScope } : {}),
      callerChannel: msg.channel,
      callerThread: msg.thread ?? msg.msgId,
      sessionId: callMeta.originSessionId,
      text
    })
      .then((result) => {
        if (!result.delivered) {
          this.host
            .log()
            .warn(
              `inferred parent reply not delivered for ${childKey}: ${result.reason ?? 'unknown'} — obligation stays visible via viewSessionStatus`
            )
        }
      })
      .catch((err) => this.host.log().error(`inferred parent reply dispatch failed for ${childKey}: ${formatErr(err)}`))
  }

  private async markChildParentReply(
    childSessionKey: string,
    parentSessionId: string,
    state: 'queued-for-parent' | 'failed'
  ): Promise<void> {
    const existing = this.childSessionLinks.get(childSessionKey)
    if (existing && existing.parentSessionId !== parentSessionId) return
    const child = await this.host.store().getSession(childSessionKey)
    // Track an unsolicited reply too: `requested` stays false, while the parent can still see
    // that a real reply was queued instead of mistaking it for an outstanding request.
    this.childSessionLinks.set(childSessionKey, {
      parentSessionId,
      agentId: existing?.agentId ?? child?.agentId ?? '',
      // This is a reply observation, not a fresh wake. `null` keeps the re-wake fence inactive
      // once the durable child row exists.
      rowUpdatedAtAtAdmission: existing?.rowUpdatedAtAtAdmission ?? null,
      replyRequested: existing?.replyRequested ?? child?.needsParentReply === 1,
      replyState: state,
      ...(existing?.remote ? { remote: true } : {})
    })
  }

  async replyToSession(req: ReplyToSessionReq): Promise<ReplyToSessionResult> {
    const platform = req.platform
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(callerKey)
    const callerRec = await this.host.store().getSession(callerKey)
    // Origin authorization is DURABLE (§5.3): a session spawned by a parent may reply into it on
    // ANY turn, not just the one agent-call turn that woke it. Prefer this turn's trusted CallMeta
    // origin (present on the wake turn), else the origin PERSISTED on the caller session (set once
    // at spawn). A human-triggered follow-up turn carries no CallMeta, so without the persisted
    // fallback the reply would be wrongly refused (`not_authorized`) after the first turn.
    const authorizedOrigin = inbound?.originSessionId ?? callerRec?.originSessionId ?? undefined
    if (!authorizedOrigin || req.sessionId !== authorizedOrigin) {
      return { delivered: false, reason: 'not_authorized' }
    }
    // A reply is an agent-call — bound it by the same hop cap so a reply ping-pong can't run away.
    // A human-triggered turn has no inbound depth, so it starts the chain at 0.
    const sourceHopCount = inbound?.hopCount ?? 0
    if (hasReachedAgentCallHopLimit(sourceHopCount + 1)) {
      return { delivered: false, reason: 'hop_limit' }
    }
    // §5.3 step 3: replying into the origin inherits the origin turn's correlationId when present
    // (so a main-agent's orchestration closes without the worker knowing the id). Explicit wins;
    // a human-triggered reply simply has none.
    const correlationId = req.correlationId !== undefined ? req.correlationId : inbound?.correlationId

    const deliveryId = randomUUID()
    // Hand the origin owner a turn whose origin points back at the REPLIER's session, so the
    // origin could reply again (symmetric lineage). callFrom = the replier.
    const replyCoordPlatform = platform
    // Symmetric lineage: what we hand the origin is the REPLIER's outward id (§1.1), while the
    // replier's own local rows stay keyed by the runtime's.
    const replierAcpSessionId = callerRec?.acpSessionId ?? undefined
    const replierSessionId = callerRec
      ? await this.host.store().ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    const externalOrigin = await this.host.externalOriginForSession(req.callerAgentId, replierAcpSessionId)
    const replyOriginCoords: CallMeta['originCoords'] = {
      platform: replyCoordPlatform,
      channel: req.callerChannel,
      ...(req.callerThread ? { thread: req.callerThread } : {})
    }
    const callMeta: CallMeta = {
      callFrom: req.callerAgentId,
      ...(correlationId !== undefined ? { correlationId } : {}),
      hopCount: sourceHopCount + 1,
      deliveryId,
      ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
      originCoords: replyOriginCoords,
      ...(externalOrigin ? { externalOrigin } : {}),
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(replierSessionId !== undefined &&
      (await this.host.store().isCaptureExcluded(req.callerAgentId, replierAcpSessionId))
        ? { parentPrivate: true }
        : {})
    }

    // Resolve where the origin session lives. Local ⇒ dispatch straight into it through the
    // per-session serial gate (satisfies §5.3 concurrency vs. a running origin turn). Not
    // local ⇒ the origin is on another daemon; route over the relay using the origin coords
    // carried on the inbound turn (the relay has no sessionId→daemon registry).
    const local = await this.host.store().getSessionByOutwardId(req.sessionId)
    if (local) {
      const originOwner = local.agentId
      const originPlatform = local.platform
      // Resolve the reply's output transport by the ORIGIN session's platform, not the
      // agent's default integration. A multi-platform agent (e.g. Slack + Telegram) would
      // otherwise post the reply through integrations[0]'s client, and a Telegram chat id
      // sent via the Slack client fails with channel_not_found (the reply turn runs but its
      // answer never reaches the origin channel).
      // A channel-free hook/dream child's stored transportScope was derived from whichever
      // integration the spawn side picked (requested-platform preferred, else the agent's
      // FIRST integration), so the session-transport helper matches the scope across ALL
      // integrations for those rows. Only the session KEY and the synthesized message are raw.
      const integrationId = this.host.integrationIdForSessionTransport(
        originOwner,
        originPlatform,
        local.transportScope
      )
      if (local.transportScope && !integrationId) {
        return { delivered: false, targetSession: local.key, reason: 'not_found' }
      }
      const resolved = this.host.resolveCpAgent(originOwner, originPlatform)
      // §7: what stays invisible is the REPORT ITSELF — the child's body is injected into the
      // parent session's transcript and is never published to the platform (this function
      // makes no gateway call at all). That is structural, not a flag: nothing in the daemon
      // publishes inbound delivery content.
      //
      // So the message below carries NO `headless` stamp and the resumed parent runs an
      // ORDINARY turn, keeping its reply connection. Stamping it used to silence that turn,
      // which only ever cost visibility: the humans watching the parent's own thread saw
      // nothing at all — not even that the delegated work had come back — whenever the child
      // had answered somewhere else (its own channel-root thread) or nowhere (a postless
      // child). The original worry, a second copy of an answer the child already delivered
      // into the SAME conversation, is editorial: the standing "don't restate" guidance owns
      // it, and it is not worth muting every report-back to prevent.
      const normalized: NormalizedMessage = {
        msgId: `agentcall:${local.channel}:${deliveryId}`,
        traceId: deliveryId,
        source: 'agent',
        platform: originPlatform,
        channel: local.channel,
        ...(local.thread ? { thread: local.thread } : {}),
        ...(local.transportScope ? { transportScope: local.transportScope } : {}),
        // A monotonic "now" ts so the reply is ordered as a NEW message in the origin session.
        // Without it, transcriptCoords derives the ts from the msgId's random UUID, which the
        // origin's dedup mis-orders — the parent turn then runs with no new content and the reply
        // never actually lands. (deliveryId stays a UUID for CallMeta/agent-call dedup.)
        transcriptTs: monotonicTs(),
        sender: { id: req.callerAgentId, isBot: true },
        text: req.text,
        // #966: a report resumes the parent session-only — never a live
        // conversation post (postAgentWakeInbound skips report deliveries).
        parentReport: true,
        mentionedBots: integrationId
          ? this.host.botUserIds()[integrationId]
            ? [this.host.botUserIds()[integrationId]!]
            : []
          : resolved?.botUserId
            ? [resolved.botUserId]
            : [],
        isDm: false
      }
      let settleAdmission!: (result: { accepted: boolean; reason?: string }) => void
      const admitted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
        settleAdmission = resolve
      })
      const turn = this.host.dispatch(
        originOwner,
        normalized,
        integrationId,
        this.host.webchatTransport().webchatWakeContext(originPlatform, local.channel),
        callMeta,
        { onAdmission: (result) => settleAdmission(result) }
      )
      void turn.catch((err) => {
        this.host.log().error(`replyToSession dispatch failed for session "${req.sessionId}": ${formatErr(err)}`)
        // A dispatch that rejected before admission settled must still release this barrier.
        settleAdmission({ accepted: false, reason: 'error' })
      })
      // Await the admission barrier, never the model. Do not promise that the reply is
      // queued when pause/drain, loop protection, or backpressure rejected it.
      const admission = await admitted
      if (!admission.accepted) {
        await this.markChildParentReply(callerKey, req.sessionId, 'failed')
        return {
          delivered: false,
          targetSession: local.key,
          reason: admission.reason === 'queue_full' ? 'queue_full' : 'busy'
        }
      }
      await this.markChildParentReply(callerKey, req.sessionId, 'queued-for-parent')
      this.host
        .log()
        .info(`replyToSession: ${req.callerAgentId} → ${originOwner} (${local.key}) delivery=${deliveryId}`)
      return { delivered: true, targetSession: local.key }
    }

    // Cross-daemon: the origin lives elsewhere. Route by its coords + owner (inbound.callFrom).
    // Only available from a live agent-call turn's CallMeta; a human-triggered follow-up whose
    // origin is on another daemon has no coords to route by (getSessionByAcpId missed) → not_found.
    const coords = inbound?.originCoords
    if (!coords || !inbound) return { delivered: false, reason: 'not_found' }
    const targetSession = sessionKey(coords.platform, coords.channel, coords.thread ?? '', inbound.callFrom)
    const res = await this.routeAgentMsgCrossDaemon(
      {
        callerAgentId: req.callerAgentId,
        platform: coords.platform,
        callerChannel: req.callerChannel,
        callerThread: req.callerThread,
        toAgentId: inbound.callFrom,
        text: req.text,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {}),
        ...(correlationId !== undefined ? { correlationId } : {})
      },
      {
        platform: coords.platform,
        channel: coords.channel,
        ...(coords.thread !== undefined ? { thread: coords.thread } : {}),
        deliveryId,
        targetSession,
        sourceHopCount: inbound.hopCount,
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(replierSessionId !== undefined ? { originSessionId: replierSessionId } : {}),
        ...(replierAcpSessionId !== undefined ? { originAcpSessionId: replierAcpSessionId } : {}),
        originCoords: replyOriginCoords,
        ...(externalOrigin ? { externalOrigin } : {}),
        // §5.3: this is a REPLY into the validated origin session, not a wake — the
        // target dispatches into that exact session (a channel-free origin's
        // coordinate would otherwise be substituted and the reply would mint a
        // different synthetic session).
        lineageReplyTo: req.sessionId,
        // send-message-routing-rework.md §7/§8.4: mark the delivery kind so the target
        // dispatches into `lineageReplyTo`, and so a relay refuses to hand it to a daemon
        // too old to understand it. Failing the reply is correct there: such a daemon would
        // key it by coordinates and mint a different session instead.
        deliveryKind: 'session-reply'
      }
    )
    await this.markChildParentReply(callerKey, req.sessionId, res.delivered ? 'queued-for-parent' : 'failed')
    return {
      delivered: res.delivered,
      targetSession: res.targetSession,
      ...(res.reason !== undefined ? { reason: res.reason as ReplyToSessionResult['reason'] } : {})
    }
  }

  /**
   * Read the progress of a session the caller STARTED (backs the `viewSessionStatus` tool). The
   * read counterpart of {@link replyToSession}: a child may reply UP its lineage, a parent may
   * read DOWN it, and neither can reach sideways into an unrelated session.
   *
   * AUTHORIZATION (child-only, fail-closed): `sessionId` must name a session whose parent is the
   * CALLING session. Two sources, in order — the child's DURABLE `originSessionId` (authoritative
   * once the child's row exists), else the in-memory {@link childSessionLinks} entry written at
   * wake admission (covers the window before the child's first turn creates that row). Anything
   * else — an unknown id, a sibling, the caller's own session, a grandchild — returns null, which
   * the tool surfaces as one indistinguishable error so the caller cannot probe for sessions it
   * may not read.
   *
   * The reported `status` collapses the §7.3 lifecycle plus the last turn's outcome: a turn in
   * flight (or admitted-but-not-yet-open) is `in-progress`; otherwise the last completed turn's
   * outcome decides `done` vs `failed`. Note `done` means "its turn ended", not "it reported
   * back" — that is what `needsReply` is for.
   */
  async viewSessionStatus(req: SessionStatusReq): Promise<SessionStatusResult | null> {
    const platform = req.platform
    const callerKey = sessionKey(
      platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    // The caller names ITSELF the way lineage does — outwardly (§1.1) — because that is what the
    // durable parent link, the admission link and the CP's ownership check are all written in.
    const callerSessionId = (await this.host.store().getSession(callerKey))
      ? await this.host.store().ensureOutwardSessionId(callerKey, req.callerAgentId, this.host.clock().now())
      : undefined
    // A caller with no session id of its own has no lineage to check against — refuse rather than
    // fall through to a link lookup that could match an `undefined` parent.
    if (!callerSessionId) return null
    // Addressed ONLY by the logical sessionKey `sendMessage` handed back. An ACP-id lookup is
    // deliberately not offered: ACP ids are minted per runtime and are not unique across agents,
    // so `getSessionByAcpId` can return a row belonging to a different agent — an ambiguous status
    // read for no benefit, since the parent always has the key we gave it.
    const child = await this.host.store().getSession(req.sessionId)
    if (!child) {
      // No local row. Either the wake was admitted and dispatch is still in flight, or the child
      // lives on another daemon. Both are only answerable to the parent that actually woke it.
      const link = this.childSessionLinks.get(req.sessionId)
      if (!link || link.parentSessionId !== callerSessionId) return null
      if (link.remote) return await this.remoteChildStatus(req.sessionId, callerSessionId, link.agentId)
      return {
        sessionId: req.sessionId,
        agentId: link.agentId,
        status: 'in-progress',
        state: 'starting',
        ...this.childStatusGuidance('in-progress', link.replyRequested, link.replyState)
      }
    }
    if (!this.isAuthorizedChildParent(child, callerSessionId)) return null
    // A session cannot be its own child; guard the degenerate case where a caller passes its own
    // id and a stale link would otherwise vouch for it.
    if (child.key === callerKey) return null
    const collapsed = this.collapseChildStatus(child, callerSessionId)
    return { sessionId: req.sessionId, ...collapsed }
  }

  private childStatusGuidance(
    status: SessionStatusResult['status'],
    replyRequested: boolean,
    trackedReplyState?: 'awaiting' | 'queued-for-parent' | 'failed'
  ): Pick<SessionStatusResult, 'reply' | 'nextAction' | 'message'> {
    if (trackedReplyState === 'queued-for-parent') {
      return {
        reply: { requested: replyRequested, state: 'queued-for-parent' },
        nextAction: 'finish-turn-and-wait',
        message:
          'The agent replied. Its reply is queued for this session and will arrive in your next turn. End this turn; do not retry or ask the agent to repeat it.'
      }
    }
    if (trackedReplyState === 'failed') {
      return {
        reply: { requested: replyRequested, state: 'failed' },
        nextAction: 'report-failure',
        message: 'The agent tried to reply, but delivery failed. Do not retry automatically; report the failure.'
      }
    }
    if (!replyRequested) {
      return {
        reply: { requested: false, state: 'not-requested' },
        nextAction: status === 'in-progress' ? 'wait' : status === 'failed' ? 'report-failure' : 'none',
        message:
          status === 'in-progress'
            ? 'Message delivered; the agent is still working. No reply was requested.'
            : status === 'failed'
              ? 'The child turn failed. No reply was requested.'
              : 'The child turn finished cleanly. No reply was requested.'
      }
    }
    if (status === 'in-progress') {
      return {
        reply: { requested: true, state: 'awaiting' },
        nextAction: 'finish-turn-and-wait',
        message:
          'Message delivered; the agent is still working. End this turn and wait for its reply; do not retry or poll tightly.'
      }
    }
    if (status === 'failed') {
      return {
        reply: { requested: true, state: 'not-sent' },
        nextAction: 'report-failure',
        message:
          'The child turn failed before sending the requested reply. Do not retry automatically; report the failure.'
      }
    }
    if (trackedReplyState === 'awaiting') {
      return {
        reply: { requested: true, state: 'not-sent' },
        nextAction: 'report-missing-reply',
        message:
          'The child turn finished without sending the requested parent-session reply. Do not retry automatically; report this outcome or wait for user direction.'
      }
    }
    return {
      reply: { requested: true, state: 'unknown' },
      nextAction: 'finish-turn-and-wait',
      message:
        'The child turn finished, but reply-delivery state is unavailable. End this turn and wait; do not retry or ask the agent to repeat it.'
    }
  }

  /**
   * Collapse one child session row into the coarse §5.4 progress triple. Shared by the local
   * `viewSessionStatus` and the CP-forwarded {@link childSessionStatusProbe} so a parent gets the
   * same answer whichever daemon its child landed on.
   *
   * Work is outstanding when a turn is running, queued behind one, or admitted by a wake the child
   * has not picked up yet (its row has not moved since we admitted it — see the
   * `rowUpdatedAtAtAdmission` note on childSessionLinks). Reporting the previous turn's outcome in
   * any of those windows would tell the parent its NEW delegation had already finished.
   */
  private collapseChildStatus(
    child: SessionRecord,
    parentSessionId: string
  ): {
    agentId: string
    status: SessionStatusResult['status']
    state: SessionStatusResult['state']
    updatedAt: number
    reply: SessionStatusResult['reply']
    nextAction: SessionStatusResult['nextAction']
    message: string
  } {
    const candidateLink = this.childSessionLinks.get(child.key)
    const link = candidateLink?.parentSessionId === parentSessionId ? candidateLink : undefined
    const queuedOrRunning =
      this.host.activeGateEntries().has(child.key) || (this.host.serialQueue().get(child.key)?.length ?? 0) > 0
    const admittedNotStarted = link !== undefined && child.updatedAt === link.rowUpdatedAtAtAdmission
    const inFlight = child.state === 'prompting' || child.state === 'cancelling' || child.state === 'resuming'
    const status: SessionStatusResult['status'] =
      inFlight || queuedOrRunning || admittedNotStarted
        ? 'in-progress'
        : child.lastTurnOutcome === 'failed'
          ? 'failed'
          : child.lastTurnOutcome === 'done'
            ? 'done'
            : // Idle/closed with no recorded outcome: the row exists but its first turn has not
              // finished (or predates outcome tracking) — treat as still working, never as done.
              'in-progress'
    const replyRequested = link?.replyRequested ?? child.needsParentReply === 1
    return {
      agentId: child.agentId,
      status,
      state: child.state,
      updatedAt: child.updatedAt,
      ...this.childStatusGuidance(status, replyRequested, link?.replyState)
    }
  }

  /**
   * §5.4 cross-daemon leg: ask the CP for the status of a child that lives on ANOTHER daemon.
   * The daemon has no way to address another daemon directly (the relay carries message delivery,
   * not queries), and the CP is the placement authority — so it resolves the owning daemon and
   * forwards the lineage pair there. This is a bounded metadata read: no message bodies, and the
   * CP persists nothing.
   *
   * Distinguishes three outcomes for the caller: a status, `null` (unknown / not your child — one
   * indistinguishable verdict, as locally), or a THROWN error for a transport problem, so the tool
   * says "temporarily unavailable" instead of implying the parent has no such child.
   */
  private async remoteChildStatus(
    childSessionId: string,
    parentSessionId: string,
    childAgentId: string
  ): Promise<SessionStatusResult | null> {
    const client = this.host.cpClient()
    // Degraded mode (§ graceful degradation): established sessions keep running with no CP, but a
    // cross-daemon lookup genuinely cannot be answered — say so rather than deny the lineage.
    if (!client)
      throw new Error(
        'the status of a session on another daemon is unavailable while the control plane is disconnected'
      )
    const parentAgentId = (await this.host.store().getSessionByOutwardId(parentSessionId))?.agentId
    const orgId = parentAgentId ? this.host.cpAgents()?.orgForAgent(parentAgentId) : undefined
    const res = await client.childSessionStatus({ parentSessionId, childSessionId, childAgentId }, orgId)
    if (res.reason === 'offline') {
      throw new Error(`the daemon running ${childSessionId} is not currently reachable — try again shortly`)
    }
    if (!res.found) return null
    const link = this.childSessionLinks.get(childSessionId)
    const fallback = this.childStatusGuidance(res.status ?? 'in-progress', link?.replyRequested ?? false, undefined)
    return {
      sessionId: childSessionId,
      agentId: res.agentId ?? childAgentId,
      status: res.status ?? 'in-progress',
      state: res.state ?? 'starting',
      ...(res.updatedAt !== undefined ? { updatedAt: res.updatedAt } : {}),
      reply: res.reply ?? fallback.reply,
      nextAction: res.nextAction ?? fallback.nextAction,
      message: res.message ?? fallback.message
    }
  }

  /**
   * §5.4 owning-daemon leg: answer a CP-forwarded status probe for a child WE own. This is where
   * the real lineage rule is enforced — exactly the same check as the local path, deliberately
   * duplicated here rather than trusted from the CP: the CP proves the asking daemon owns the
   * claimed parent session, and this proves the child is actually that parent's child.
   *
   * Returns the wire shape. `found:false` covers unknown-session AND not-your-child so a caller
   * cannot probe for sessions it may not read.
   */
  async childSessionStatusProbe(probe: ChildSessionStatusProbe): Promise<ChildSessionStatus> {
    const child = await this.host.store().getSession(probe.childSessionId)
    if (!child) {
      // Pre-row window: we ACKed admission immediately and dispatch is fire-and-forget, so a probe
      // can legitimately arrive before SessionManager creates the row. The admission link recorded
      // at ACK time is the only record — and the only authority — until then.
      const link = this.childSessionLinks.get(probe.childSessionId)
      if (!link || link.parentSessionId !== probe.parentSessionId) return { found: false }
      return {
        found: true,
        agentId: link.agentId,
        status: 'in-progress',
        state: 'starting',
        ...this.childStatusGuidance('in-progress', link.replyRequested, link.replyState)
      }
    }
    if (!this.isAuthorizedChildParent(child, probe.parentSessionId)) return { found: false }
    return { found: true, ...this.collapseChildStatus(child, probe.parentSessionId) }
  }

  /**
   * Whether `parentSessionId` is a parent this child may be reported to. A logical child session
   * can be woken by MORE THAN ONE parent over its life, and both are legitimate: the durable
   * first-wins `originSessionId`, and the most recent waker recorded at admission (the one whose
   * `sendMessage` just handed that caller the handle). Accepting only the durable link would deny a
   * second parent the child it just started — the read-side mirror of naming the current waker in
   * the report-back directive.
   */
  private isAuthorizedChildParent(child: SessionRecord, parentSessionId: string): boolean {
    if (child.originSessionId === parentSessionId) return true
    return this.childSessionLinks.get(child.key)?.parentSessionId === parentSessionId
  }

  /**
   * Whether a channel-ROOT post just made by `caller` FORKED a conversation that session is
   * ALREADY part of — its parent's, its own, or neither. Backs `sendMessage`'s root-post notice.
   *
   * Forking, not merely landing on: a post whose thread key IS the conversation's own thread
   * joined it, which is what a root post does on Discord and in Telegram / Feishu DMs (see
   * {@link threadKeyForPost}). Warning there would tell an agent its message went nowhere when
   * the reader has it, and talk it into sending a second copy.
   *
   * Conversation identity is the daemon's to decide, which is why this lives here and not in ops:
   * a channel id is only unique within one physical bot, so two integrations can name the same id
   * and mean different conversations. The comparison therefore includes the transport scope on
   * both sides, and the caller's session key uses its platform string verbatim.
   *
   * The parent link is read from the CURRENT turn's trusted call metadata when present, else from
   * the DURABLE origin on the session row (§5.3) — the load-bearing half, since relaying an answer
   * happens on a later human-triggered turn with no metadata. Coords come from the parent's own
   * row wherever one exists, because only a row records a transport scope; the cross-daemon case
   * and its deliberate imprecision are spelled out at the branch below. This widens nothing — it
   * answers about coordinates the caller itself just named.
   */
  async rootPostRelation(req: {
    callerAgentId: string
    platform: string
    callerTransportScope?: string
    callerChannel: string
    callerThread: string
    targetPlatform: string
    targetChannel: string
    targetThread: string
    targetIntegrationId?: string
  }): Promise<{ kind: 'parent'; sessionId: string } | { kind: 'self' } | undefined> {
    const targetScope = this.host.transportScopeForIntegrationIds(
      req.targetIntegrationId !== undefined ? [req.targetIntegrationId] : undefined
    )
    // Same conversation AND a different thread: only then did the post FORK it. Discord guild
    // roots are materialized as native threads before reaching this comparison. In continuous
    // DMs whose post key IS the conversation ({@link threadKeyForPost}), the message simply
    // landed in it and there is nothing to warn about.
    const isForkOf = (platform: string, channel: string, thread: string, scope?: string | null): boolean =>
      platform === req.targetPlatform &&
      channel === req.targetChannel &&
      thread !== req.targetThread &&
      (scope ?? undefined) === (targetScope ?? undefined)

    const key = sessionKey(
      req.platform,
      req.callerChannel,
      req.callerThread,
      req.callerAgentId,
      req.callerTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(key)
    const parentSessionId =
      inbound?.originSessionId ?? (await this.host.store().getSession(key))?.originSessionId ?? undefined
    const parent = parentSessionId ? await this.host.store().getSessionByOutwardId(parentSessionId) : undefined
    // A LOCAL parent's row records its transport scope, so its identity is exact.
    if (parentSessionId && parent && isForkOf(parent.platform, parent.channel, parent.thread, parent.transportScope)) {
      return { kind: 'parent', sessionId: parentSessionId }
    }
    // A CROSS-DAEMON parent has no row here, and its scope cannot be obtained: the value is
    // derived from the owning daemon's live credential and deliberately never crosses the wire
    // (see the note on the durable scope in protocol telemetry) — it would also rotate with that
    // daemon's tokens, so a forwarded copy could not be compared reliably anyway. Identity here is
    // therefore COORDINATES ONLY, which can over-match where one channel id is reachable through
    // two bots. That trade is deliberate: the cost of over-matching is a hint naming the caller's
    // real parent — where a relayed answer belongs regardless — while staying silent would drop
    // the hint for precisely the escalation shape the relay exists to serve.
    if (parentSessionId && !parent && inbound?.originCoords) {
      const { platform, channel, thread } = inbound.originCoords
      // An origin without a thread (a legacy peer omits it) cannot be shown to have been forked,
      // and the notice's whole claim is that it was — stay silent rather than guess.
      if (thread !== undefined && platform === req.targetPlatform && channel === req.targetChannel) {
        if (thread !== req.targetThread) return { kind: 'parent', sessionId: parentSessionId }
        return undefined
      }
    }
    if (isForkOf(req.platform, req.callerChannel, req.callerThread, req.callerTransportScope)) {
      return { kind: 'self' }
    }
    return undefined
  }

  /**
   * session-concept case 2a: an agent's channel-ROOT post seeds a NEW session owned by the same
   * agent. The post already happened (ops.ts); here the daemon initializes the new-thread session
   * (keyed by the post's ts) so the top-level message starts its own context,
   * with `Parent session` = the origin session. This is initialization only: the root is recorded
   * for replay with the first real reply, but no model turn runs. `headless` remains a transport
   * backstop, and the hop count remains a defense for replay from an older durable inbox row.
   */
  async spawnChannelRootSession(req: {
    agentId: string
    platform: string
    integrationId?: string
    channel: string
    /** The post's session-thread key, already canonicalized by {@link threadKeyForPost} at the
     *  one seam that converts a platform ts into a thread segment — the same key an inbound
     *  reply to this post resolves to, so the reply meets this session instead of opening a
     *  second one. */
    thread: string
    /** The post's RAW platform ts, which on Telegram differs from `thread`. */
    postTs: string
    text: string
    originPlatform?: string
    originTransportScope?: string
    originChannel: string
    originThread: string
  }): Promise<boolean> {
    const platform = req.platform
    // The origin session may live on a DIFFERENT platform than this post (e.g. a Telegram
    // turn posting to Slack). Key the origin lookup by the ORIGIN's platform, not the target's,
    // or the caller session is never found and the new session loses its parent lineage.
    const originPlatform = req.originPlatform ?? req.platform
    const originKey = sessionKey(
      originPlatform,
      req.originChannel,
      req.originThread,
      req.agentId,
      req.originTransportScope
    )
    const inbound = this.host.activeTurnCallMeta().get(originKey)
    // A self-post from a plain human/platform turn (no active callMeta) starts the self-chain at 1.
    const hopCount = inbound ? inbound.hopCount + 1 : 1
    if (hasReachedAgentCallHopLimit(hopCount)) {
      this.host.log().info(`channel-root session: hop limit reached for agent "${req.agentId}" — not spawning`)
      return false
    }
    const originRec = await this.host.store().getSession(originKey)
    const originAcpSessionId = originRec?.acpSessionId ?? undefined
    const originSessionId = originRec
      ? await this.host.store().ensureOutwardSessionId(originKey, req.agentId, this.host.clock().now())
      : undefined
    const externalOrigin = await this.host.externalOriginForSession(req.agentId, originAcpSessionId)
    const originCoordPlatform = originPlatform
    const deliveryId = randomUUID()
    const callMeta: CallMeta = {
      callFrom: req.agentId,
      hopCount,
      deliveryId,
      initializeOnly: true,
      ...(originSessionId ? { originSessionId } : {}),
      ...(externalOrigin ? { externalOrigin } : {}),
      originCoords: {
        platform: originCoordPlatform,
        channel: req.originChannel,
        ...(req.originThread ? { thread: req.originThread } : {})
      },
      // §5.1: seal the child's capture gate when the waking session is private.
      // Tighten-only — see CallMeta.parentPrivate.
      ...(originSessionId && (await this.host.store().isCaptureExcluded(req.agentId, originAcpSessionId))
        ? { parentPrivate: true }
        : {})
    }
    const transportScope = this.host.transportScopeForIntegrationIds(
      req.integrationId !== undefined ? [req.integrationId] : undefined
    )
    const normalized: NormalizedMessage = {
      msgId: `agentcall:${req.channel}:${deliveryId}`,
      traceId: deliveryId,
      source: 'agent',
      platform,
      channel: req.channel,
      thread: req.thread,
      ...(transportScope !== undefined ? { transportScope } : {}),
      // The seed's transcript ts MUST be the post's real ts (the new thread's root), not the
      // random deliveryId — otherwise the session's lastDeliveredTs becomes a non-ts string and
      // a later real reply in this thread is mis-compared and wrongly skipped as already-delivered.
      // On Telegram that raw ts is NOT the thread key, hence the separate field.
      transcriptTs: req.postTs,
      sender: { id: req.agentId, isBot: true },
      text: req.text,
      mentionedBots: [],
      isDm: false,
      // No model turn runs for this seed; headless is retained as a transport backstop.
      headless: true
    }
    const targetSession = sessionKey(platform, req.channel, req.thread, req.agentId, transportScope)
    void this.host
      .dispatch(req.agentId, normalized, req.integrationId, undefined, callMeta)
      .catch((err) =>
        this.host.log().error(`channel-root session spawn failed for agent "${req.agentId}": ${formatErr(err)}`)
      )
    this.host
      .log()
      .info(
        `channel-root session: "${req.agentId}" initialized new session ${targetSession} (origin ${originSessionId ?? 'none'}, hop ${hopCount})`
      )
    return true
  }

  /**
   * Route a cross-daemon `messageAgent` over the relay data plane (agent-collaboration
   * §2.3/§6.2/§6.4, P2) and map the relay's typed admission verdict to a
   * {@link MessageAgentResult}. The `claimedFromAgentId` is our trusted caller — the
   * relay re-validates it against our authenticated daemonId (a forged claim is
   * rejected there). `sourceHopCount` is the trusted source turn's depth; the relay
   * increments it (+1, capped at MAX_AGENT_CALL_HOPS). The body never touches the CP —
   * only the relay.
   */
  private async routeAgentMsgCrossDaemon(
    req: MessageAgentReq,
    ctx: {
      platform: Exclude<NormalizedMessage['platform'], 'hook'>
      channel: string
      thread?: string
      deliveryId: string
      targetSession: string
      sourceHopCount: number
      correlationId?: string
      /** §5.3: the caller's origin session, forwarded so the remote child can reply back — its
       *  OUTWARD id (§1.1), since it travels to another daemon. */
      originSessionId?: string
      /** The same session's runtime-local id, for the gates this daemon keys by it. */
      originAcpSessionId?: string
      originCoords?: CallMeta['originCoords']
      externalOrigin?: CallMeta['externalOrigin']
      /** §5.3 lineage reply: the EXISTING target session this delivery replies into, by its
       *  outward id — the target dispatches into it instead of coordinate keying. */
      lineageReplyTo?: string
      /** send-message-routing-rework.md §8.3. Marks the delivery as a parent-session reply
       *  so the target dispatches it into `lineageReplyTo` instead of coordinate keying.
       *  The relay still refuses to forward this kind to a daemon that has not advertised
       *  `headless-agent-delivery-v1`; that gate is now a LEGACY fence — the resumed parent
       *  runs an ordinary turn on every current daemon (§7). Absent ⇒ `wake`, an ordinary
       *  postless call. */
      deliveryKind?: RdAgentMsgDeliveryKind
    }
  ): Promise<MessageAgentResult> {
    const relays = this.host.relays()
    if (!relays) {
      return { delivered: false, targetSession: ctx.targetSession, reason: 'not_local' }
    }
    try {
      // #987: `not_ready` re-sends the SAME deliveryId for a bounded window; only a terminal verdict is recorded below.
      const ack = await sendAgentMsgUntilReady(
        {
          claimedFromAgentId: req.callerAgentId,
          // Tighten-only privacy hint for the remote child's capture gate (§5.1). The gate is
          // keyed by the runtime's id, so read it from the caller's own slot — `originSessionId`
          // is the lineage id, which is outward (§1.1).
          ...(ctx.originSessionId !== undefined &&
          ctx.originAcpSessionId !== undefined &&
          (await this.host.store().isCaptureExcluded(req.callerAgentId, ctx.originAcpSessionId))
            ? { parentPrivate: true }
            : {}),
          toAgentId: req.toAgentId,
          text: req.text,
          coords: {
            platform: ctx.platform,
            channel: ctx.channel,
            ...(ctx.thread !== undefined ? { thread: ctx.thread } : {})
          },
          ...(ctx.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
          hopCount: ctx.sourceHopCount,
          deliveryId: ctx.deliveryId,
          // Visible-post ts (if this wake was a `toAgent`+`channel` send) so the remote target
          // dedups the wake against the post it fetches from the shared thread and keeps a
          // canonical read cursor — same guarantee as the same-daemon path.
          ...(req.transcriptTs !== undefined ? { transcriptTs: req.transcriptTs } : {}),
          ...(ctx.originSessionId !== undefined ? { originSessionId: ctx.originSessionId } : {}),
          ...(ctx.originCoords !== undefined ? { originCoords: ctx.originCoords } : {}),
          ...(ctx.externalOrigin !== undefined ? { externalOrigin: ctx.externalOrigin } : {}),
          ...(ctx.lineageReplyTo !== undefined ? { lineageReplyTo: ctx.lineageReplyTo } : {}),
          // §5.4: ask the remote child to report its outcome back into our origin session. Gated on
          // having an origin for exactly the reason the local path is — there is nothing to report to
          // without one, and the target ignores it in that case anyway.
          ...(req.needsReply === true && ctx.originSessionId !== undefined ? { needsReply: true } : {}),
          ...(ctx.deliveryKind !== undefined ? { deliveryKind: ctx.deliveryKind } : {})
        },
        {
          send: (payload) => relays.sendAgentMsg(payload),
          clock: this.host.clock(),
          onRetry: (attempt, delayMs) =>
            this.host
              .log()
              .info(
                `messageAgent: ${req.toAgentId} not routable yet (attempt ${attempt}) — retrying delivery ${ctx.deliveryId} in ${delayMs}ms`
              )
        }
      )
      // §5.4: prefer the CANONICAL key the target computed — its transport scope depends on the
      // reply integration the relay chose, which we cannot derive. Fall back to our own guess only
      // for an older target daemon that returns none (it then simply won't be followable).
      if (ack.delivered) return { delivered: true, targetSession: ack.childSessionId ?? ctx.targetSession }
      return { delivered: false, targetSession: ctx.targetSession, ...(ack.reason ? { reason: ack.reason } : {}) }
    } catch (err) {
      // No READY relay / forward failed → undeliverable (offline). Retransmit is a follow-up.
      this.host.log().warn(`messageAgent: cross-daemon route failed for ${req.toAgentId}: ${formatErr(err)}`)
      return { delivered: false, targetSession: ctx.targetSession, reason: 'offline' }
    }
  }

  // ══════════════════════════ §3.4/§6.8 main-agent orchestration ══════════════════════════

  /**
   * Start an orchestration (§3.4/§6.8). ATOMIC ordering per §3.4:
   *   (a) RECORD-FIRST — persist the orchestration header + every subtask (status
   *       'pending') in one transaction BEFORE any delivery, so a fast worker's reply can
   *       never arrive before the record exists (§3.3 would otherwise drop it);
   *   (b) deliver each subtask via the existing `messageAgent` path, CAS-recording
   *       pending→sending→delivered | pending→sending→(delivered rollback)failed per subtask;
   *   (c) schedule the one-shot, session-anchored, cancelable cron deadline (if requested)
   *       — but only when at least one subtask actually delivered (all-failed ⇒ no wait).
   * The main identity + coords are the TRUSTED SessionContext (never tool input).
   */
  async startOrchestration(req: StartOrchestrationReq): Promise<StartOrchestrationResult> {
    const orchestrationId = randomUUID()
    const platform = req.platform
    // The main's session key is the exact coords its tool call ran under, so a deadline
    // fire and a worker report both key to the SAME session as the caller.
    const mainSessionKey = sessionKey(platform, req.channel, req.thread, req.mainAgentId, req.transportScope)
    const now = this.host.clock().now()
    const deadline =
      req.deadlineMs !== undefined && req.deadlineMs > 0 ? now + Math.min(req.deadlineMs, 2_147_483_647) : null

    const subtaskRows: SubtaskRow[] = req.subtasks.map((s, idx) => ({
      orchestrationId,
      correlationId: `${orchestrationId}.${idx}`,
      idx,
      toAgentId: s.toAgentId,
      text: s.text,
      status: 'pending',
      updatedAt: monotonicTs()
    }))

    const orch: OrchestrationRow = {
      orchestrationId,
      mainSessionKey,
      mainAgentId: req.mainAgentId,
      platform,
      channel: req.channel,
      thread: req.thread,
      integrationId: req.integrationId ?? null,
      replyTarget: req.replyTarget ?? null,
      deadline, // recorded up front (durable SoT); cleared to null if nothing delivers
      status: 'active',
      createdAt: now,
      updatedAt: now
    }

    // (a) RECORD-FIRST: must fully persist before we deliver anything.
    await this.host.store().createOrchestration(orch, subtaskRows)
    this.host.evalHooks().emit({
      type: 'orchestration.state',
      agentId: req.mainAgentId,
      sessionId: (await this.host.store().getSession(mainSessionKey))?.acpSessionId ?? undefined,
      platform,
      channel: req.channel,
      data: {
        orchestrationId,
        state: 'created',
        subtaskCount: subtaskRows.length,
        deadlineConfigured: deadline !== null
      }
    })

    // (b) Deliver each subtask, atomically recording delivered|failed.
    const delivered: string[] = []
    const failed: { correlationId: string; reason: string }[] = []
    for (const s of subtaskRows) {
      await this.host.store().setSubtaskStatus(orchestrationId, s.correlationId, ['pending'], 'sending', monotonicTs())
      let result: MessageAgentResult
      try {
        result = await this.messageAgent({
          callerAgentId: req.mainAgentId,
          platform: req.platform,
          ...(req.integrationId !== undefined ? { callerIntegrationId: req.integrationId } : {}),
          ...(req.transportScope !== undefined ? { callerTransportScope: req.transportScope } : {}),
          callerChannel: req.channel,
          callerThread: req.thread,
          toAgentId: s.toAgentId,
          text: s.text,
          channel: req.channel,
          thread: req.thread,
          correlationId: s.correlationId
        })
      } catch (err) {
        result = { delivered: false, targetSession: '', reason: 'error' }
        this.host
          .log()
          .warn(`orchestration ${orchestrationId}: delivery of ${s.correlationId} threw: ${formatErr(err)}`)
      }
      if (result.delivered) {
        await this.host
          .store()
          .setSubtaskStatus(orchestrationId, s.correlationId, ['sending'], 'delivered', monotonicTs())
        delivered.push(s.correlationId)
      } else {
        const reason = result.reason ?? 'undeliverable'
        // A failed delivery is terminal for this subtask (§3.4): it does NOT occupy a
        // "waiting" slot. Recorded as worker_error with the delivery reason.
        await this.host
          .store()
          .setSubtaskStatus(orchestrationId, s.correlationId, ['sending'], 'worker_error', monotonicTs(), {
            deliveryReason: reason
          })
        failed.push({ correlationId: s.correlationId, reason })
      }
    }

    // (c) Deadline: only arm when something is actually pending a reply. If everything
    // failed to deliver, there is nothing to wait for — clear the deadline (§3.4).
    if (deadline !== null && delivered.length > 0) {
      this.armOrchestrationDeadline(orchestrationId, deadline)
    } else if (deadline !== null) {
      await this.host.store().setOrchestrationDeadline(orchestrationId, null, this.host.clock().now())
    }

    this.host
      .log()
      .info(
        `orchestration ${orchestrationId}: ${delivered.length} delivered, ${failed.length} failed` +
          (deadline !== null && delivered.length > 0 ? `, deadline in ${deadline - now}ms` : '')
      )
    this.host.evalHooks().emit({
      type: 'orchestration.state',
      agentId: req.mainAgentId,
      sessionId: (await this.host.store().getSession(mainSessionKey))?.acpSessionId ?? undefined,
      platform,
      channel: req.channel,
      data: { orchestrationId, state: 'dispatched', delivered: delivered.length, failed: failed.length }
    })
    return { orchestrationId, delivered, failed }
  }

  /** Arm (or re-arm) the one-shot, session-anchored deadline for an orchestration. On fire
   *  it wakes the main's session DIRECTLY (dispatch to mainSessionKey) — NOT via fireTrigger
   *  (which would post a channel anchor / open a new thread). Idempotent: replaces any
   *  existing timer for this id. Clamped to setTimeout's 32-bit ceiling. */
  private armOrchestrationDeadline(orchestrationId: string, deadlineEpoch: number): void {
    const existing = this.orchestrationDeadlines.get(orchestrationId)
    if (existing !== undefined) this.host.clock().clearTimeout(existing)
    const delay = Math.min(Math.max(0, deadlineEpoch - this.host.clock().now()), 2_147_483_647)
    const handle = this.host.clock().setTimeout(async () => {
      this.orchestrationDeadlines.delete(orchestrationId)
      await this.fireOrchestrationDeadline(orchestrationId)
    }, delay)
    this.orchestrationDeadlines.set(orchestrationId, handle)
  }

  /** Deadline fired (§3.5): mark every still-open subtask timed_out, then WAKE the main's
   *  session so it re-reads getOrchestration and summarizes the partial result. The wake is
   *  a direct dispatch to the stored session coords — no platform post, no new thread.
   *  Every pool member sharing the store may have a timer for this id, so the fire is gated
   *  twice: the duty check (a dispatch binds the agent's sandbox, so only its holder may wake
   *  it) and a CAS claim on the stored deadline, which makes a handoff race fire once. */
  async fireOrchestrationDeadline(orchestrationId: string): Promise<void> {
    const orch = await this.host.store().getOrchestration(orchestrationId)
    if (!orch || orch.status !== 'active' || orch.deadline == null) return // cancelled / completed / already fired
    if (!this.host.servesAgent(orch.mainAgentId)) {
      this.host
        .log()
        .debug(`orchestration ${orchestrationId}: deadline reached but ${orch.mainAgentId} is served elsewhere`)
      return
    }
    if (
      !(await this.host.store().claimOrchestrationDeadline(orchestrationId, orch.deadline, this.host.clock().now()))
    ) {
      this.host.log().debug(`orchestration ${orchestrationId}: deadline already claimed by another member`)
      return
    }
    // Mark unreported (delivered but not yet reported, or still sending/pending) as timed_out.
    for (const s of await this.host.store().getSubtasks(orchestrationId)) {
      await this.host
        .store()
        .setSubtaskStatus(
          orchestrationId,
          s.correlationId,
          ['pending', 'sending', 'delivered'],
          'timed_out',
          monotonicTs()
        )
    }
    this.host.evalHooks().emit({
      type: 'orchestration.state',
      agentId: orch.mainAgentId,
      sessionId: (await this.host.store().getSession(orch.mainSessionKey))?.acpSessionId ?? undefined,
      platform: orch.platform,
      channel: orch.channel,
      data: { orchestrationId, state: 'timed_out' }
    })
    this.wakeOrchestrationMain(orch, `orchestration ${orchestrationId} deadline reached — summarize what you have`)
  }

  /** Wake the orchestration's owning main session with a synthetic agent-source turn keyed
   *  to the exact stored coords (so it lands in the same session that started it). Headless
   *  is NOT set — the main needs its reply transport to post the summary. */
  private wakeOrchestrationMain(orch: OrchestrationRow, text: string): void {
    const platform = orch.platform
    const msgId = `orchestration:${orch.orchestrationId}:${monotonicTs()}`
    const msg: NormalizedMessage = {
      msgId,
      traceId: orch.orchestrationId,
      source: 'agent',
      platform,
      channel: orch.channel,
      thread: orch.thread,
      sender: { id: `orchestration:${orch.orchestrationId}`, isBot: true },
      text,
      mentionedBots: [],
      isDm: false
    }
    void this.host
      .dispatch(orch.mainAgentId, msg, orch.integrationId ?? undefined)
      .catch((err) =>
        this.host.log().error(`orchestration ${orch.orchestrationId}: deadline wake dispatch failed: ${formatErr(err)}`)
      )
  }

  /** §3.3 correlation-recording hook, called from dispatchOne when the MAIN receives a
   *  messageAgent turn carrying a correlationId. Records the worker's result into the
   *  orchestration ONLY if ALL four safety checks hold; any failure drops the report
   *  (debug log) and never corrupts completion. Uses ONLY trusted values (callMeta.callFrom,
   *  the receiving session key) — never a frame/prompt field. */
  async recordWorkerReport(receivingSessionKey: string, callMeta: CallMeta, reportText: string): Promise<void> {
    const correlationId = callMeta.correlationId
    if (correlationId === undefined) return
    // correlationId = "<orchestrationId>.<idx>" — the orchestrationId is everything before
    // the final '.' (a UUID contains no '.', and idx is a trailing integer).
    const dot = correlationId.lastIndexOf('.')
    if (dot <= 0) return
    const orchestrationId = correlationId.slice(0, dot)
    const orch = await this.host.store().getOrchestration(orchestrationId)
    if (!orch) return // (b) unknown orchestration
    // (a) owning session: the report must arrive in the SAME session that owns it.
    if (orch.mainSessionKey !== receivingSessionKey) {
      this.host.log().debug(`orchestration ${orchestrationId}: report dropped — session mismatch`)
      return
    }
    if (orch.status !== 'active') {
      this.host.log().debug(`orchestration ${orchestrationId}: report dropped — orchestration ${orch.status}`)
      return
    }
    const sub = await this.host.store().getSubtaskByCorrelation(orchestrationId, correlationId)
    if (!sub) return // (b) correlationId maps to no subtask
    // (c) the reporter IS the tasked worker — TRUSTED callFrom, not a frame field.
    if (callMeta.callFrom !== sub.toAgentId) {
      this.host
        .log()
        .debug(
          `orchestration ${orchestrationId}: report for ${correlationId} dropped — ` +
            `reporter "${callMeta.callFrom}" ≠ tasked worker "${sub.toAgentId}"`
        )
      return
    }
    // (d) idempotent: only an OPEN subtask (sending|delivered|timed_out) is recorded. A
    // duplicate report (already succeeded/worker_error) is a no-op. A late report AFTER
    // timeout IS allowed to update the summary (timed_out → succeeded), idempotently.
    const ok = await this.host
      .store()
      .setSubtaskStatus(
        orchestrationId,
        correlationId,
        ['sending', 'delivered', 'timed_out'],
        'succeeded',
        monotonicTs(),
        { result: reportText }
      )
    if (ok) {
      this.host
        .log()
        .info(`orchestration ${orchestrationId}: recorded result for ${correlationId} from ${callMeta.callFrom}`)
      this.host.evalHooks().emit({
        type: 'orchestration.state',
        agentId: orch.mainAgentId,
        sessionId: (await this.host.store().getSession(orch.mainSessionKey))?.acpSessionId ?? undefined,
        platform: orch.platform,
        channel: orch.channel,
        data: { orchestrationId, correlationId, state: 'worker_reported', workerAgentId: callMeta.callFrom }
      })
    } else {
      this.host.log().debug(`orchestration ${orchestrationId}: duplicate/late report for ${correlationId} — no-op`)
    }
  }

  async getOrchestrationForOwner(req: OrchestrationOwnerReq): Promise<unknown | null> {
    const orch = await this.ownedOrchestration(req)
    if (!orch) return null
    return {
      orchestrationId: orch.orchestrationId,
      status: orch.status,
      deadline: orch.deadline ?? null,
      replyTarget: orch.replyTarget ?? null,
      createdAt: orch.createdAt,
      subtasks: (await this.host.store().getSubtasks(orch.orchestrationId)).map((s) => ({
        correlationId: s.correlationId,
        toAgentId: s.toAgentId,
        status: s.status,
        result: s.result ?? null,
        ...(s.deliveryReason ? { deliveryReason: s.deliveryReason } : {})
      }))
    }
  }

  async cancelOrchestrationForOwner(req: OrchestrationOwnerReq): Promise<boolean> {
    const orch = await this.ownedOrchestration(req)
    if (!orch) return false
    // Idempotent: cancel the deadline timer (if any) + write the cancelled tombstone. The
    // record is KEPT (not deleted). Already-delivered workers aren't recalled — a late report
    // after cancellation is ignored (recordWorkerReport drops on status !== 'active').
    const handle = this.orchestrationDeadlines.get(orch.orchestrationId)
    if (handle !== undefined) {
      this.host.clock().clearTimeout(handle)
      this.orchestrationDeadlines.delete(orch.orchestrationId)
    }
    await this.host.store().setOrchestrationDeadline(orch.orchestrationId, null, this.host.clock().now())
    await this.host.store().setOrchestrationStatus(orch.orchestrationId, 'cancelled', this.host.clock().now())
    this.host.evalHooks().emit({
      type: 'orchestration.state',
      agentId: orch.mainAgentId,
      sessionId: (await this.host.store().getSession(orch.mainSessionKey))?.acpSessionId ?? undefined,
      platform: orch.platform,
      channel: orch.channel,
      data: { orchestrationId: orch.orchestrationId, state: 'cancelled' }
    })
    return true
  }

  /** Resolve an orchestration IFF the requesting main+session OWNS it (§3.5a owner check).
   *  Returns undefined on unknown id or any owner mismatch. */
  private async ownedOrchestration(req: OrchestrationOwnerReq): Promise<OrchestrationRow | undefined> {
    const orch = await this.host.store().getOrchestration(req.orchestrationId)
    if (!orch) return undefined
    const requesterKey = sessionKey(req.platform, req.channel, req.thread, req.mainAgentId, req.transportScope)
    if (orch.mainSessionKey !== requesterKey || orch.mainAgentId !== req.mainAgentId) return undefined
    return orch
  }

  /** Re-derive which deadlines this member arms from the durable `deadline` epochs (§3.5): arm
   *  the held agents' still-active orchestrations, disarm what moved to another member. Runs at
   *  startup and after every duty change; idempotent, and a stale timer is harmless because the
   *  fire re-checks the duty and claims the deadline through the store. A deadline already in
   *  the past fires ~immediately. */
  async syncOrchestrationDeadlines(): Promise<void> {
    let active: OrchestrationRow[]
    try {
      active = await this.host.store().listActiveOrchestrations()
    } catch (err) {
      this.host.log().warn(`orchestration: deadline re-arm read failed: ${(err as Error).message}`)
      return
    }
    let armed = 0
    let disarmed = 0
    for (const orch of active) {
      const held = this.host.servesAgent(orch.mainAgentId)
      const handle = this.orchestrationDeadlines.get(orch.orchestrationId)
      if (held && orch.deadline != null && handle === undefined) {
        this.armOrchestrationDeadline(orch.orchestrationId, orch.deadline)
        armed++
      } else if (!held && handle !== undefined) {
        this.host.clock().clearTimeout(handle)
        this.orchestrationDeadlines.delete(orch.orchestrationId)
        disarmed++
      }
    }
    if (armed || disarmed) this.host.log().info(`orchestration: armed ${armed} and disarmed ${disarmed} deadline(s)`)
  }
}

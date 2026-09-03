/**
 * The daemon's evaluation-harness seam (docs/designs/collaboration-arena.md §4–§7):
 * observer emission, the virtual environment install, and the §7.1 delivery
 * handles behind `injectPlatformEvent` / `deliverRefereeEvent` /
 * `runEvaluationTurn` / `waitForEvaluationIdle`. The Daemon keeps thin delegates
 * with unchanged signatures; everything here reaches back through the narrow
 * {@link DaemonEvaluationHost} port, so no product path gains an evaluation branch.
 */
import { randomUUID } from 'node:crypto'
import type { CollabRoutesSnapshot, WebchatDone, WebchatEvent } from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import { ALL_TOOL_NAMES } from '../mcp/tools.js'
import { stableTurnId, type NormalizedMessage } from '../messages/normalized.js'
import { sessionKey } from '../store/local-store.js'
import type { CallMeta } from '../daemon/turn-types.js'
import type { WebchatSink, WebchatTurnContext } from '../webchat/types.js'
import type {
  DaemonEvaluationOptions,
  DaemonEvaluationTurnInput,
  DaemonEvaluationTurnResult
} from '../daemon/evaluation-types.js'
import {
  EvaluationCapabilityProfileSchema,
  EvaluationEventEmitter,
  type EvaluationCapabilityProfile,
  type EvaluationEventInput
} from './events.js'
import {
  compileEvaluationIntegration,
  evaluationBotRoutingIdentity,
  type DeliveryAdmission,
  type DeliveryCompletion,
  type DeliveryHandle,
  type DeliveryRejectionReason,
  type EvaluationPlatformEvent,
  type RefereeEvent
} from './environment.js'
import type { VirtualPlatform, VirtualPlatformConnection } from './virtual-connections.js'

/** Extra dispatch options the evaluation seam needs; a subset of the daemon's own. */
export interface EvaluationDispatchOptions {
  /** A rendezvous-backed activation must not go terminal without a durable row. */
  requireDurable?: boolean
  /** Stable target-scoped inbox id for one physical event delivered to several local agents. */
  deliveryId?: string
  /** Synchronous admission barrier, settled before any turn can start. */
  onAdmission?: (result: { accepted: boolean; reason?: string; duplicate?: boolean }) => void
}

/** Exactly what the evaluation hooks touch on the Daemon — nothing wider. */
export interface DaemonEvaluationHost {
  info(message: string): void
  warn(message: string): void
  now(): number
  agents(): Map<string, LoadedAgent>
  /** integrationId → physical-bot routing identity, written for virtual integrations too. */
  botUserIds(): Record<string, string>
  /** Project a virtual connection into the per-platform connection map that owns it. */
  setVirtualConnection(platform: VirtualPlatform, integrationId: string, connection: VirtualPlatformConnection): void
  replaceCollaborationRoutes(routes: CollabRoutesSnapshot): void
  /** Dynamic memory-provider tool names for one agent; may throw before start. */
  memoryToolNames(agentId: string): string[]
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    callMeta?: CallMeta,
    opts?: EvaluationDispatchOptions
  ): Promise<string | null>
  integrationConfigById(integrationId: string): Integration | undefined
  connForIntegration(integrationId: string): unknown
  srcIntegrationIds(conn: unknown): string[]
  onInboundOutcome(
    msg: NormalizedMessage,
    srcIntegrationIds?: string[]
  ): Promise<{ kind: 'rejected'; reason: DeliveryRejectionReason } | { kind: 'dispatched'; handle: DeliveryHandle }>
  /** Live turn work: `pending` is non-zero while anything is queued or running. */
  inflightWork(): { pending: number; active: Promise<void>[] }
  memoryPostTurnChain(agentId: string): Promise<void> | undefined
  memoryPostTurnChains(): Promise<void>[]
}

/** Map dispatch's internal admission verdict onto the §7.1 taxonomy. */
function deliveryRejectionReason(result: {
  reason?: string
  duplicate?: boolean
}): Exclude<DeliveryAdmission, { admitted: true }>['reason'] {
  if (result.duplicate) return 'deduplicated'
  if (result.reason === 'queue_full') return 'queue_full'
  if (result.reason === 'durability') return 'error'
  return 'gated'
}

export class DaemonEvaluationHooks {
  private readonly emitter: EvaluationEventEmitter
  readonly profile: EvaluationCapabilityProfile
  /** Integration ids owned by the evaluation environment (collaboration-arena §5).
   *  They live in `agent.integrations` and the connection maps like any other
   *  integration, but are EXCLUDED from physical platform reconcile so the daemon
   *  never opens (or evicts) a real connection for a virtual transport. */
  readonly integrationIds = new Set<string>()

  constructor(
    private readonly host: DaemonEvaluationHost,
    private readonly opts: DaemonEvaluationOptions | undefined
  ) {
    if (opts?.capabilityProfile && !opts.observer) {
      throw new Error('evaluation capability profile requires an evaluation observer')
    }
    this.profile = EvaluationCapabilityProfileSchema.parse(opts?.capabilityProfile ?? { memory: 'configured' })
    this.emitter = new EvaluationEventEmitter({
      observer: opts?.observer,
      runId: opts?.runId,
      now: () => host.now(),
      onObserverError: (error) => {
        host.warn(`evaluation observer failed: ${error instanceof Error ? error.name : 'unknown'}`)
        opts?.onObserverError?.(error)
      }
    })
  }

  get enabled(): boolean {
    return this.emitter.enabled
  }

  emit(input: EvaluationEventInput): void {
    this.emitter.emit(input)
  }

  /**
   * Install the Collaboration Arena environment (collaboration-arena.md §5): one
   * effective-integration registry, two projections. Every existing consumer —
   * ordinary replies (`replyConnFor`), MCP ops (`gatewayFor`), transport-scope
   * derivation, Slack realm classification, tool advertising — resolves through
   * the SAME maps and `agent.integrations` entries it already consults, so no
   * daemon call site changes. The synthetic collaboration topology loads into the
   * existing `CpCollabRoutes` table a live CP would replace.
   */
  installEnvironment(): void {
    const environment = this.opts?.environment
    if (!environment) return
    if (!this.enabled) throw new Error('daemon evaluation environment requires an evaluation observer')
    const agents = this.host.agents()
    for (const eff of environment.integrations) {
      const agent = agents.get(eff.agentId)
      if (!agent) throw new Error(`evaluation integration ${eff.integrationId} names unknown agent "${eff.agentId}"`)
      if (agent.integrations.some((integration) => integration.id === eff.integrationId)) {
        throw new Error(`evaluation integration ${eff.integrationId} collides with a configured integration`)
      }
      agent.integrations.push(compileEvaluationIntegration(eff))
      this.integrationIds.add(eff.integrationId)
      this.host.botUserIds()[eff.integrationId] = evaluationBotRoutingIdentity(eff)
      this.host.setVirtualConnection(eff.platform, eff.integrationId, eff.connection)
    }
    this.host.replaceCollaborationRoutes(environment.collaborationRoutes)
    // §6 evaluation tool registry: name-collision rejection at startup — an
    // evaluation tool may never shadow a product tool, and the registry itself
    // may not carry duplicates.
    const registryTools = environment.tools ?? []
    if (registryTools.length > 0) {
      // The COMPLETE stable product namespace, not just what this composition
      // happens to request: `executeTool` dispatches evaluation tools BEFORE the
      // product handlers, so a name it never composes (e.g. `viewSessionStatus`,
      // which `executeTool` handles directly) would still be shadowed. Only a
      // full-registry check makes "never shadow a product tool" exact.
      const productNames = new Set<string>(ALL_TOOL_NAMES)
      for (const agent of agents.values()) {
        // Memory PROVIDER tools are dynamic, so they are not in the static list.
        try {
          for (const name of this.host.memoryToolNames(agent.id)) productNames.add(name)
        } catch {
          /* a memory provider that cannot enumerate pre-start never shadows */
        }
      }
      const seen = new Set<string>()
      for (const definition of registryTools) {
        const name = definition.descriptor.name
        if (productNames.has(name)) throw new Error(`evaluation tool "${name}" shadows a product tool`)
        if (seen.has(name)) throw new Error(`duplicate evaluation tool "${name}"`)
        seen.add(name)
      }
    }
    this.host.info(
      `evaluation: installed ${environment.integrations.length} virtual integration(s) and ${registryTools.length} evaluation tool(s) from the evaluation environment`
    )
  }

  /**
   * Build the §7.1 DeliveryHandle around one dispatch: `admission` settles at the
   * admission decision (synchronously for the claim/enqueue paths), `completion`
   * when the resulting turn reaches a terminal state. Neither promise ever
   * rejects — outcomes are typed values.
   */
  dispatchHandle(
    agentId: string,
    msg: NormalizedMessage,
    integrationId?: string,
    webchat?: WebchatTurnContext,
    /** Trusted call metadata for a delivery that IS an agent call — today, a verified
     *  agent-authored platform mention, whose already-computed hop depth must reach the
     *  admitted turn (§4.1). Absent for ordinary human ingress. */
    callMeta?: CallMeta,
    /** Extra dispatch options for the caller's delivery contract. */
    dispatchOpts?: Omit<EvaluationDispatchOptions, 'onAdmission'>
  ): { handle: DeliveryHandle; turn: Promise<string | null> } {
    const turnId = stableTurnId(agentId, msg)
    let settleAdmission!: (admission: DeliveryAdmission) => void
    const admission = new Promise<DeliveryAdmission>((resolve) => (settleAdmission = resolve))
    const turn = this.host.dispatch(agentId, msg, integrationId, webchat, callMeta, {
      ...dispatchOpts,
      onAdmission: (result) => {
        if (result.accepted && !result.duplicate) {
          const key = sessionKey(msg.platform, msg.channel, msg.thread ?? msg.msgId, agentId, msg.transportScope)
          settleAdmission({ admitted: true, agentId, sessionKey: key, turnId })
        } else {
          settleAdmission({ admitted: false, reason: deliveryRejectionReason(result) })
        }
      }
    })
    const completion: Promise<DeliveryCompletion> = turn.then(
      async (sessionId) => {
        const decided = await admission
        if (!decided.admitted || sessionId === null) return { status: 'not_admitted' }
        return { status: 'completed', sessionId, turnId }
      },
      async (error: unknown) => {
        // The dispatch itself rejected before admission could settle (e.g. a
        // durability failure) — make sure the admission barrier still resolves.
        settleAdmission({ admitted: false, reason: 'error' })
        const decided = await admission
        if (!decided.admitted) return { status: 'not_admitted' }
        const message = error instanceof Error ? error.message : String(error)
        const status: 'failed' | 'cancelled' | 'timeout' = /cancel/i.test(message)
          ? 'cancelled'
          : /time(?:d\s*)?out/i.test(message)
            ? 'timeout'
            : 'failed'
        return { status, sessionId: null, turnId, error: message }
      }
    )
    // The turn promise is also settled through `completion`; keep the raw
    // rejection observed so unawaited handles never surface as unhandled.
    turn.catch(() => {})
    return { handle: { admission, completion }, turn }
  }

  /**
   * §4.1: enter the SAME suppression → deduplication → thread-canonicalization →
   * command → trigger-routing → gating → dispatch path as a live platform
   * callback, from a platform-shaped payload on a virtual integration. No target
   * agent is supplied; routing decides. Duplicate, reordered, and delayed
   * injections are legitimate inputs handled by the production ingress logic.
   */
  async injectPlatformEvent(event: EvaluationPlatformEvent): Promise<DeliveryHandle> {
    if (!this.enabled) throw new Error('daemon evaluation observer is not enabled')
    if (!this.integrationIds.has(event.integrationId)) {
      throw new Error(`injectPlatformEvent requires an evaluation integration (got ${event.integrationId})`)
    }
    const integration = this.host.integrationConfigById(event.integrationId)
    const conn = this.host.connForIntegration(event.integrationId)
    if (!integration || !conn) throw new Error(`evaluation integration ${event.integrationId} is not installed`)
    const payload = event.payload
    const msg: NormalizedMessage = {
      msgId: payload.messageId,
      traceId: randomUUID(),
      source: 'user',
      platform: integration.platform,
      channel: payload.channel,
      ...(payload.thread !== undefined ? { thread: payload.thread } : {}),
      sender: {
        id: payload.sender.id,
        isBot: payload.sender.isBot ?? false,
        ...(payload.sender.appId !== undefined ? { appId: payload.sender.appId } : {})
      },
      text: payload.text,
      mentionedBots: payload.mentions ?? [],
      ...(payload.agentAuthorship !== undefined ? { agentAuthorship: payload.agentAuthorship } : {}),
      ...(payload.ingressEventTag !== undefined ? { ingressEventTag: payload.ingressEventTag } : {}),
      isDm: payload.isDm ?? false
    }
    // Same source resolution as a live connection callback: all integrations
    // consolidated onto this physical (virtual) connection.
    const outcome = await this.host.onInboundOutcome(msg, this.host.srcIntegrationIds(conn))
    if (outcome.kind === 'dispatched') return outcome.handle
    const admission: DeliveryAdmission = { admitted: false, reason: outcome.reason }
    return {
      admission: Promise.resolve(admission),
      completion: Promise.resolve({ status: 'not_admitted' })
    }
  }

  /**
   * §4.2: trusted, pre-addressed game control. Skips trigger routing (the target
   * is authoritative) but still traverses the dispatch admission queue,
   * per-session FIFO, SessionManager, and ACP — referee traffic cannot corrupt
   * session-state invariants. Referee deliveries are environment machinery and
   * are excluded from ingress-invariant scoring by their producers.
   */
  async deliverRefereeEvent(event: RefereeEvent): Promise<DeliveryHandle> {
    if (!this.enabled) throw new Error('daemon evaluation observer is not enabled')
    if (!this.host.agents().has(event.targetAgentId)) throw new Error(`unknown evaluation agent ${event.targetAgentId}`)
    const msg: NormalizedMessage = {
      msgId: event.messageId,
      traceId: randomUUID(),
      source: 'user',
      platform: event.platform,
      channel: event.channel,
      ...(event.thread !== undefined ? { thread: event.thread } : {}),
      sender: { id: event.sender?.id ?? 'evaluation-referee', isBot: event.sender?.isBot ?? false },
      text: event.text,
      mentionedBots: [],
      isDm: event.isDm,
      ...(event.isDm ? { trigger: 'dm' as const } : {})
    }
    return (await this.dispatchHandle(event.targetAgentId, msg, event.integrationId)).handle
  }

  /** Drive a real daemon turn through the same SessionManager, ACP host, memory,
   * permission, MCP, serial-gate, and transcript path as relay webchat. This is the
   * only product-specific surface the Promptfoo adapter needs. Retained as a
   * compatibility wrapper over the referee-delivery path (collaboration-arena §4.2)
   * with a synthetic webchat coordinate — the add-on suite's behavior is unchanged. */
  async runTurn(input: DaemonEvaluationTurnInput): Promise<DaemonEvaluationTurnResult> {
    if (!this.enabled) throw new Error('daemon evaluation observer is not enabled')
    if (!this.host.agents().has(input.agentId)) throw new Error(`unknown evaluation agent ${input.agentId}`)

    const turnId = input.turnId?.trim() || randomUUID()
    const events: WebchatEvent[] = []
    let terminal: WebchatDone | undefined
    const sink: WebchatSink = {
      output: (output) => {
        if (output.event) events.push(output.event)
      },
      done: (done) => {
        terminal = done
      }
    }
    const message: NormalizedMessage = {
      msgId: `webchat:${input.conversationId}`,
      traceId: turnId,
      source: 'user',
      platform: 'webchat',
      channel: input.conversationId,
      sender: { id: input.user?.trim() || 'evaluation-user', isBot: false },
      text: input.text,
      mentionedBots: [],
      isDm: true,
      trigger: 'dm'
    }
    const { turn } = this.dispatchHandle(input.agentId, message, undefined, {
      conversationId: input.conversationId,
      turnId,
      sink,
      evaluation: true
    })
    const sessionId = await turn
    // Product turns intentionally enqueue post-turn memory work. Evaluation waits
    // for this agent's chain so the returned artifact has a terminal capture event.
    await (this.host.memoryPostTurnChain(input.agentId) ?? Promise.resolve())
    return {
      turnId,
      sessionId,
      output: events
        .filter((event): event is Extract<WebchatEvent, { kind: 'message' }> => event.kind === 'message')
        .map((event) => event.text)
        .join(''),
      events,
      ...(terminal?.stopReason ? { stopReason: terminal.stopReason } : {}),
      ...(terminal?.usage ? { usage: terminal.usage } : {})
    }
  }

  /** Wait until turns spawned asynchronously by collaboration have left the real
   * serial gate and all provider-neutral post-turn memory chains have settled. */
  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    if (!this.enabled) throw new Error('daemon evaluation observer is not enabled')
    const deadline = Date.now() + Math.max(1, timeoutMs)
    for (;;) {
      const work = this.host.inflightWork()
      if (work.pending === 0) break
      if (Date.now() >= deadline) throw new Error(`evaluation daemon did not become idle within ${timeoutMs}ms`)
      if (work.active.length > 0) {
        const remaining = Math.max(1, deadline - Date.now())
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          Promise.allSettled(work.active),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`evaluation daemon did not become idle within ${timeoutMs}ms`)),
              remaining
            )
          })
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    await Promise.all(this.host.memoryPostTurnChains())
  }
}

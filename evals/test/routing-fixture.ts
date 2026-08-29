/**
 * Routing acceptance fixture for the sendMessage routing rework
 * (docs/designs/send-message-routing-rework.md, PR #503).
 *
 * Boots a REAL daemon against one mention-gated Slack-shaped room (the
 * production shared-channel convention: activation needs an explicit mention or
 * thread affinity — never channel `auto`), with per-agent SCRIPTED hosts that
 * can issue real product tool calls (sendMessage) over the daemon's MCP
 * control socket mid-turn.
 *
 * Platform echo fidelity: every DELIVERED agent reply/post is fanned back to
 * every other member integration as real platform ingress under the author's
 * managed bot identity — exactly what production Slack does — with
 * platform-native `<@U…>` mention tokens parsed into the payload's mention
 * list. Whether such an echo activates anyone is decided by the DAEMON's
 * routing (the thing under test), never by this fixture.
 *
 * Assertions read invariant-level records only: turn activations per agent
 * (evaluation events), delivered/attempted world outbound effects, and thread
 * coordinates — not mechanism internals.
 */
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '../../packages/message/src/index.js'
import type {
  DeliveryAdmission,
  DeliveryHandle,
  EvaluationEvent,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import { DaemonEvaluationHarness } from '../../packages/daemon/src/evaluation/index.js'
import {
  callDaemonTool,
  daemonMcpBinding,
  type DaemonMcpBinding,
  type DaemonToolCallResult
} from '../games/mcp-client.js'
import { prepareScriptedSubject } from '../games/subject.js'
import { compileTopology } from '../games/topology.js'
import type { CompiledRoom, CompiledTopology } from '../games/types.js'
import { ArenaWorld } from '../games/world.js'

export interface RoutingScriptContext {
  sessionId: string
  /** Full prompt text of this turn. */
  text: string
  /** Issue a REAL product tool call bound to this session's trusted context. */
  callTool(name: string, args: Record<string, unknown>): Promise<DaemonToolCallResult>
  /** Emit this turn's ordinary reply (current-room speech). */
  reply(text: string): void
}

/** Per-agent behavior. Runs once per turn; may reply, call tools, or both. */
export type RoutingScript = (context: RoutingScriptContext) => Promise<void> | void

export interface RoutingFixtureOptions {
  agents: string[]
  scripts: Record<string, RoutingScript>
  seed?: number
}

export class RoutingFixture {
  readonly topology: CompiledTopology
  readonly world: ArenaWorld
  readonly room: CompiledRoom
  private readonly harness: DaemonEvaluationHarness
  private readonly subjectCleanup: () => void
  // The async store made inject() Promise-returning; the fixture carries the pending handles.
  private readonly echoHandles: Promise<DeliveryHandle>[] = []
  private readonly echoAdmissionRecords: {
    messageId: string
    /** Set on a `message_changed` closing edit; absent on an ordinary post. */
    ingressEventTag?: string
    /** The claim's delivery state — `final` marks the ONE routable event of a response,
     *  whether it arrived as a born-final post (§5.5) or as the closing edit. */
    deliveryState?: 'streaming' | 'final'
    integrationId: string
    admission: Promise<DeliveryAdmission>
  }[] = []
  /** Thread each delivered message lives in (root posts anchor themselves). */
  private readonly threadByMessageId = new Map<string, string>()
  private readonly aliasByAgentId = new Map<string, string>()

  private constructor(
    topology: CompiledTopology,
    world: ArenaWorld,
    harness: DaemonEvaluationHarness,
    subjectCleanup: () => void
  ) {
    this.topology = topology
    this.world = world
    this.room = topology.rooms[0]!
    this.harness = harness
    this.subjectCleanup = subjectCleanup
    for (const agent of topology.agents) this.aliasByAgentId.set(agent.agentId, agent.alias)
  }

  static async start(options: RoutingFixtureOptions): Promise<RoutingFixture> {
    const seed = options.seed ?? 42
    const topology = compileTopology({
      game: 'routing-acceptance',
      seed,
      agents: options.agents.map((alias) => ({ id: alias })),
      rooms: [{ id: 'room', platform: 'slack', members: options.agents }]
    })
    const world = new ArenaWorld(topology)
    // Production shared-channel convention: mention-gated, never `auto`.
    const environment = world.buildEnvironment({ bindMatch: 'mention' })
    const subject = prepareScriptedSubject(topology)
    const scriptByAgentId = new Map<string, RoutingScript>()
    for (const [alias, script] of Object.entries(options.scripts)) {
      const agent = topology.agents.find((candidate) => candidate.alias === alias)
      if (!agent) throw new Error(`script for unknown agent alias "${alias}"`)
      scriptByAgentId.set(agent.agentId, script)
    }
    const harness = new DaemonEvaluationHarness({
      root: subject.root,
      environment,
      runId: `routing-${seed}`,
      capabilityProfile: { memory: 'off' },
      hostFactory: ((agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
        let sessions = 0
        const bindings = new Map<string, DaemonMcpBinding>()
        return {
          start: async () => {},
          newSession: async (_cwd: string, mcpServers?: unknown) => {
            const sessionId = `routing-${agent.id.slice(0, 8)}-${(sessions += 1)}`
            const binding = daemonMcpBinding(mcpServers)
            if (binding) bindings.set(sessionId, binding)
            return sessionId
          },
          hasSession: () => true,
          modelOptions: () => ({ current: 'scripted-routing', models: ['scripted-routing'] }),
          prompt: async (sessionId: string, blocks: { text?: string }[]) => {
            const text = blocks.map((block) => block.text ?? '').join('\n')
            const script = scriptByAgentId.get(agent.id)
            let replied = false
            const context: RoutingScriptContext = {
              sessionId,
              text,
              callTool: async (name, args) => {
                const binding = bindings.get(sessionId)
                if (!binding) throw new Error('session has no daemon tool binding')
                return callDaemonTool(binding, name, args)
              },
              reply: (value) => {
                replied = true
                onUpdate(sessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: value }
                })
              }
            }
            if (script) await script(context)
            if (!replied) {
              // An empty turn posts nothing — the scripted stand-in for a
              // production agent that chooses silence.
              onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })
            }
            return { stopReason: 'end_turn' }
          },
          cancel: async () => {},
          stop: async () => {}
        }
      }) as never
    })
    const fixture = new RoutingFixture(topology, world, harness, subject.cleanup)
    // Production Slack echo: every delivered agent post fans back to the OTHER
    // member integrations under the author's managed bot identity.
    world.onDelivered((effect) => fixture.echoDeliveredPost(effect))
    await harness.start()
    return fixture
  }

  private echoDeliveredPost(effect: RecordedOutboundEffect): void {
    if (effect.status !== 'delivered') return
    if (effect.channel !== this.room.channel || effect.agentId === undefined) return
    if (effect.kind !== 'reply' && effect.kind !== 'finalize') return
    const botUserId = this.world.botUserIdFor(effect.integrationId)
    if (botUserId === undefined || effect.messageId === undefined) return
    const appId = this.world.botAppIdFor(effect.integrationId)
    // Slack normalizes a top-level message with thread = its own ts; the finalized
    // `message_changed` edit keeps the ORIGINAL post's coordinates — msgId included,
    // because that id also carries the platform ts — and is told apart from the post it
    // edits by `ingressEventTag`, which is the extra per-connection dedup dimension
    // (packages/message SLACK_RESPONSE_FINAL_EVENT_TAG).
    let thread: string
    let ingressEventTag: string | undefined
    if (effect.kind === 'reply') {
      thread = effect.thread ?? effect.messageId
      this.threadByMessageId.set(effect.messageId, thread)
    } else {
      thread = this.threadByMessageId.get(effect.messageId) ?? effect.thread ?? effect.messageId
      ingressEventTag = SLACK_RESPONSE_FINAL_EVENT_TAG
    }
    const echoMessageId = effect.messageId
    const mentions = [...effect.text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!)
    // The authorship CLAIM travels exactly as the platform normalizer would surface it:
    // streaming on mid-answer posts (unroutable), final on the ONE response-closing
    // event — the terminal post itself when the response closes at post time (§5.5),
    // or the `message_changed` edit. Verification stays entirely in the daemon.
    const authorAgentId = effect.identity?.agentAuthorId ?? effect.agentId
    const claim =
      effect.response !== undefined
        ? {
            authorAgentId,
            responseId: effect.response.responseId,
            deliveryState: effect.response.deliveryState,
            hopCount: effect.response.hopCount,
            mentionedAgentIds: effect.response.mentionedAgentIds,
            ...(effect.response.agentCallDeliveryId !== undefined
              ? { agentCallDeliveryId: effect.response.agentCallDeliveryId }
              : {})
          }
        : undefined
    for (const integrationId of this.room.memberIntegrationIds) {
      if (integrationId === effect.integrationId) continue
      const handle = this.harness.inject({
        integrationId,
        payload: {
          channel: this.room.channel,
          thread,
          messageId: echoMessageId,
          ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
          text: effect.text,
          sender: { id: botUserId, isBot: true, ...(appId !== undefined ? { appId } : {}) },
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(claim !== undefined ? { agentAuthorship: claim } : {})
        }
      })
      this.echoHandles.push(handle)
      this.echoAdmissionRecords.push({
        messageId: echoMessageId,
        ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
        ...(claim !== undefined ? { deliveryState: claim.deliveryState } : {}),
        integrationId,
        admission: handle.then((settled) => settled.admission)
      })
    }
  }

  /** Admission outcome of every platform echo injected so far, in order. */
  async echoAdmissions(): Promise<
    {
      messageId: string
      ingressEventTag?: string
      deliveryState?: 'streaming' | 'final'
      integrationId: string
      admission: DeliveryAdmission
    }[]
  > {
    return Promise.all(
      this.echoAdmissionRecords.map(async (record) => ({
        messageId: record.messageId,
        ...(record.ingressEventTag !== undefined ? { ingressEventTag: record.ingressEventTag } : {}),
        ...(record.deliveryState !== undefined ? { deliveryState: record.deliveryState } : {}),
        integrationId: record.integrationId,
        admission: await record.admission
      }))
    )
  }

  agentId(alias: string): string {
    const agent = this.topology.agents.find((candidate) => candidate.alias === alias)
    if (!agent) throw new Error(`unknown agent alias "${alias}"`)
    return agent.agentId
  }

  botUserId(alias: string): string {
    const integration = this.topology.integrations.find((candidate) => candidate.agentAlias === alias)
    if (!integration) throw new Error(`unknown agent alias "${alias}"`)
    return integration.botUserId
  }

  /** Inject one HUMAN platform message, fanned to every member integration
   *  (the same channel:ts each dedicated Slack app receives). */
  injectHuman(
    text: string,
    options: { thread?: string; mentions?: string[]; sender?: string } = {}
  ): { messageId: string; handles: Promise<DeliveryHandle>[] } {
    const messageId = this.world.mintMessageId('slack')
    this.world.registerRoomMessage(this.room.channel, messageId)
    this.world.recordThreadMessage(this.room.channel, options.thread ?? messageId, {
      ts: messageId,
      text,
      sender: options.sender ?? 'W-HUMAN',
      isBot: false
    })
    const handles = this.room.memberIntegrationIds.map((integrationId) =>
      this.harness.inject({
        integrationId,
        payload: {
          channel: this.room.channel,
          thread: options.thread ?? messageId,
          messageId,
          text,
          sender: { id: options.sender ?? 'W-HUMAN', isBot: false },
          ...(options.mentions !== undefined ? { mentions: options.mentions } : {})
        }
      })
    )
    return { messageId, handles }
  }

  /** Inject one THIRD-PARTY bot platform message — a bot user this deployment
   *  does not manage, carrying NO AgentConnect authorship claim. What (if
   *  anything) it activates is the daemon's decision, the thing under test. */
  injectThirdPartyBot(
    text: string,
    options: { thread?: string; mentions?: string[]; sender?: string } = {}
  ): { messageId: string; handles: Promise<DeliveryHandle>[] } {
    const sender = options.sender ?? 'UEXTBOT9'
    const messageId = this.world.mintMessageId('slack')
    this.world.registerRoomMessage(this.room.channel, messageId)
    this.world.recordThreadMessage(this.room.channel, options.thread ?? messageId, {
      ts: messageId,
      text,
      sender,
      isBot: true
    })
    const handles = this.room.memberIntegrationIds.map((integrationId) =>
      this.harness.inject({
        integrationId,
        payload: {
          channel: this.room.channel,
          thread: options.thread ?? messageId,
          messageId,
          text,
          sender: { id: sender, isBot: true },
          ...(options.mentions !== undefined ? { mentions: options.mentions } : {})
        }
      })
    )
    return { messageId, handles }
  }

  /** Settle everything in flight: await injected handles, drain echo cascades
   *  generation by generation, then wait for daemon idleness. */
  async settle(handles: Promise<DeliveryHandle>[] = []): Promise<void> {
    let pending = [...handles, ...this.echoHandles.splice(0)]
    let generations = 0
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map(async (handle) => (await handle).completion))
      pending = this.echoHandles.splice(0)
    }
    await this.harness.waitUntilIdle()
    // Idle turns may have delivered posts whose echoes are still unsettled.
    pending = this.echoHandles.splice(0)
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map(async (handle) => (await handle).completion))
      await this.harness.waitUntilIdle()
      pending = this.echoHandles.splice(0)
    }
  }

  events(): readonly EvaluationEvent[] {
    return this.harness.events()
  }

  /** How many real turns an agent ran (turn.started — admissions that reached
   *  the runtime, not queued duplicates). */
  activations(alias: string): number {
    const agentId = this.agentId(alias)
    return this.events().filter((event) => event.type === 'turn.started' && event.agentId === agentId).length
  }

  /** The prompt inputs of an agent's turns, in order. */
  turnInputs(alias: string): string[] {
    const agentId = this.agentId(alias)
    return this.events()
      .filter((event) => event.type === 'turn.started' && event.agentId === agentId)
      .map((event) => String(event.data.input ?? ''))
  }

  /** Delivered, visible IM posts (agent speech — chrome excluded). */
  deliveredPosts(): RecordedOutboundEffect[] {
    return this.world.allEffects().filter((effect) => effect.kind === 'reply' && effect.status === 'delivered')
  }

  /** Every delivered outbound effect including delivery chrome. */
  deliveredEffects(): RecordedOutboundEffect[] {
    return this.world.allEffects().filter((effect) => effect.status === 'delivered')
  }

  /** EVERY outbound effect an agent's integration attempted — delivered or
   *  rejected, reply or chrome. The full-accounting input for
   *  "zero implicit IM outbound" invariants. */
  effectsOf(alias: string): RecordedOutboundEffect[] {
    const agentId = this.agentId(alias)
    return this.world.allEffects().filter((effect) => effect.agentId === agentId)
  }

  aliasOf(agentId: string): string {
    return this.aliasByAgentId.get(agentId) ?? agentId
  }

  async stop(): Promise<void> {
    try {
      await this.harness.stop()
    } finally {
      this.subjectCleanup()
    }
  }
}

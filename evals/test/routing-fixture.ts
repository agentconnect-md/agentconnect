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
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { type GameSubjectSpec, prepareGameSubject, preflightRealSubject } from '../games/subject.js'
import { compileTopology } from '../games/topology.js'
import type { CompiledRoom, CompiledTopology } from '../games/types.js'
import { ArenaWorld } from '../games/world.js'

/** Scripted turns settle in milliseconds; a real ACP runtime does not. */
const DEFAULT_SETTLE_TIMEOUT_MS = 30_000

/**
 * Rewrite the prepared agents' `description` — the agent's own standing prompt
 * seed, which the daemon renders into the `# Agent` block. This is the only
 * per-seat lever a REAL-subject scenario gets: the model is never scripted, so
 * a fixed counterpart persona has to be configuration, exactly as an operator
 * would write it in `agent.json`.
 */
function applyAgentDescriptions(root: string, topology: CompiledTopology, descriptions: Record<string, string>): void {
  for (const [alias, description] of Object.entries(descriptions)) {
    const agent = topology.agents.find((candidate) => candidate.alias === alias)
    if (!agent) throw new Error(`description for unknown agent alias "${alias}"`)
    const agentPath = join(root, 'agents', agent.agentId, 'agent.json')
    const config = JSON.parse(readFileSync(agentPath, 'utf8')) as Record<string, unknown>
    writeFileSync(agentPath, `${JSON.stringify({ ...config, description }, null, 2)}\n`, { mode: 0o600 })
  }
}

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
  /** Per-alias scripted behavior. Ignored entirely for a `real` subject: the
   *  runtime is the model, and nothing may script it. */
  scripts: Record<string, RoutingScript>
  seed?: number
  /** Who plays (games/subject.ts §8.1). Defaults to the credential-free
   *  scripted hosts every gate case uses. */
  subject?: GameSubjectSpec
  /** Per-alias `description` override written onto the prepared agent.json.
   *  This is the agent's own standing prompt seed (it becomes part of the
   *  `# Agent` block), so it is the seam a real-subject scenario uses to give
   *  one seat a fixed persona without scripting its model. */
  agentDescriptions?: Record<string, string>
  /** Idleness budget for {@link RoutingFixture.settle}. Real runtimes need far
   *  more than the scripted default. */
  settleTimeoutMs?: number
}

/** One model turn, reassembled from the ordered evaluation events: what was
 *  delivered into it, which tools it called IN THAT TURN, and what it said. */
export interface RoutingTurnTrace {
  turnId?: string
  agentAlias: string
  sessionId?: string
  input: string
  toolCalls: { id?: string; name: string; arguments: unknown }[]
  output: string
}

export class RoutingFixture {
  readonly topology: CompiledTopology
  readonly world: ArenaWorld
  readonly room: CompiledRoom
  /** Template values that must never reach an artifact this fixture's caller writes. */
  readonly secrets: readonly string[]
  private readonly harness: DaemonEvaluationHarness
  private readonly subjectCleanup: () => void
  private readonly echoHandles: DeliveryHandle[] = []
  private readonly echoAdmissionRecords: {
    messageId: string
    /** Set on the response-closing arrival; absent on the post it edits. */
    ingressEventTag?: string
    integrationId: string
    admission: Promise<DeliveryAdmission>
  }[] = []
  /** Thread each delivered message lives in (root posts anchor themselves). */
  private readonly threadByMessageId = new Map<string, string>()
  private readonly aliasByAgentId = new Map<string, string>()
  private readonly settleTimeoutMs: number

  private constructor(
    topology: CompiledTopology,
    world: ArenaWorld,
    harness: DaemonEvaluationHarness,
    subjectCleanup: () => void,
    settleTimeoutMs: number,
    secrets: readonly string[]
  ) {
    this.topology = topology
    this.world = world
    this.room = topology.rooms[0]!
    this.harness = harness
    this.subjectCleanup = subjectCleanup
    this.settleTimeoutMs = settleTimeoutMs
    this.secrets = secrets
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
    const subjectSpec: GameSubjectSpec = options.subject ?? { kind: 'scripted' }
    const subject = prepareGameSubject(topology, subjectSpec)
    if (options.agentDescriptions) {
      applyAgentDescriptions(subject.root, topology, options.agentDescriptions)
    }
    // A real runtime reaches `sendMessage` through the `mcp-bridge` SUBPROCESS,
    // and an unlaunchable runtime stalls silently. Both are refused up front.
    if (subjectSpec.kind === 'real') await preflightRealSubject(subject.root)
    const scriptByAgentId = new Map<string, RoutingScript>()
    for (const [alias, script] of Object.entries(options.scripts)) {
      const agent = topology.agents.find((candidate) => candidate.alias === alias)
      if (!agent) throw new Error(`script for unknown agent alias "${alias}"`)
      scriptByAgentId.set(agent.agentId, script)
    }
    // A real subject gets NO hostFactory: the daemon spawns the template's own
    // ACP runtimes, exactly as it does in production.
    const scriptedHostFactory = (agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
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
    }
    const harness = new DaemonEvaluationHarness({
      root: subject.root,
      environment,
      runId: `routing-${seed}`,
      capabilityProfile: { memory: 'off', collaboration: 'configured' },
      secrets: subject.secrets,
      ...(subjectSpec.kind === 'scripted' ? { hostFactory: scriptedHostFactory as never } : {})
    })
    const fixture = new RoutingFixture(
      topology,
      world,
      harness,
      subject.cleanup,
      options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      subject.secrets
    )
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
    // The authorship CLAIM travels exactly as the platform normalizer would
    // surface it: streaming on ordinary posts (unroutable), final only on the
    // response-closing edit. Verification stays entirely in the daemon.
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
        integrationId,
        admission: handle.admission
      })
    }
  }

  /** Admission outcome of every platform echo injected so far, in order. */
  async echoAdmissions(): Promise<
    { messageId: string; ingressEventTag?: string; integrationId: string; admission: DeliveryAdmission }[]
  > {
    return Promise.all(
      this.echoAdmissionRecords.map(async (record) => ({
        messageId: record.messageId,
        ...(record.ingressEventTag !== undefined ? { ingressEventTag: record.ingressEventTag } : {}),
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
  ): { messageId: string; handles: DeliveryHandle[] } {
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

  /** Settle everything in flight: await injected handles, drain echo cascades
   *  generation by generation, then wait for daemon idleness. */
  async settle(handles: DeliveryHandle[] = []): Promise<void> {
    let pending = [...handles, ...this.echoHandles.splice(0)]
    let generations = 0
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map((handle) => handle.completion))
      pending = this.echoHandles.splice(0)
    }
    await this.harness.waitUntilIdle(this.settleTimeoutMs)
    // Idle turns may have delivered posts whose echoes are still unsettled.
    pending = this.echoHandles.splice(0)
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map((handle) => handle.completion))
      await this.harness.waitUntilIdle(this.settleTimeoutMs)
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

  /**
   * Every model turn, reassembled from the ordered evaluation events.
   *
   * The per-turn TOOL CALL list is what a same-turn behavioral invariant needs
   * ("did it poll the child in the very turn that started it?"), and it is only
   * available here: `acp.update` carries the daemon's own `turnId`, so a call is
   * attributed to the turn the daemon was running, never guessed from timing.
   */
  turnTraces(alias?: string): RoutingTurnTrace[] {
    const wanted = alias !== undefined ? this.agentId(alias) : undefined
    const traces: RoutingTurnTrace[] = []
    const byTurnId = new Map<string, RoutingTurnTrace>()
    const openByAgent = new Map<string, RoutingTurnTrace>()
    for (const event of this.events()) {
      if (event.agentId === undefined) continue
      if (wanted !== undefined && event.agentId !== wanted) continue
      if (event.type === 'turn.started') {
        const trace: RoutingTurnTrace = {
          ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
          agentAlias: this.aliasOf(event.agentId),
          ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
          input: String(event.data.input ?? ''),
          toolCalls: [],
          output: ''
        }
        traces.push(trace)
        if (event.turnId !== undefined) byTurnId.set(event.turnId, trace)
        openByAgent.set(event.agentId, trace)
        continue
      }
      if (event.type !== 'acp.update') continue
      const trace =
        (event.turnId !== undefined ? byTurnId.get(event.turnId) : undefined) ?? openByAgent.get(event.agentId)
      if (!trace) continue
      const update = event.data.update as Record<string, unknown> | undefined
      if (!update) continue
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = (update.content as { text?: unknown } | undefined)?.text
        if (typeof text === 'string') trace.output += text
        continue
      }
      if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
      // A runtime may announce the call before its arguments are known and fill
      // them in on the following `tool_call_update` for the same `toolCallId`
      // (Claude Code's adapter does exactly that), so the two are merged. The
      // NAME comes from `rawInput.tool` when the runtime reports MCP call
      // structure and from the human `title` otherwise.
      const rawInput = update.rawInput as Record<string, unknown> | undefined
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
      const existing = callId !== undefined ? trace.toolCalls.find((call) => call.id === callId) : undefined
      const name =
        (typeof rawInput?.tool === 'string' ? rawInput.tool : undefined) ??
        (typeof update.title === 'string' ? update.title : undefined)
      const args = rawInput?.arguments ?? (rawInput !== undefined && rawInput.tool === undefined ? rawInput : undefined)
      if (existing) {
        if (name !== undefined) existing.name = name
        if (args !== undefined) existing.arguments = args
        continue
      }
      if (update.sessionUpdate !== 'tool_call') continue
      trace.toolCalls.push({
        ...(callId !== undefined ? { id: callId } : {}),
        name: name ?? 'unknown_tool',
        arguments: args ?? {}
      })
    }
    return traces
  }

  /**
   * Peer wakes an agent ISSUED, as the daemon recorded them
   * (`collaboration.delivery.*`, stamped with the CALLER's agent id and the
   * caller's own evaluation turn id).
   *
   * This is the authoritative answer to "which turn delegated": it comes from
   * the daemon's delivery path rather than from the runtime's tool-call
   * reporting, which is advisory and may announce a call before its arguments
   * are known.
   */
  peerWakesIssued(alias: string): { turnId?: string; admitted: boolean }[] {
    const agentId = this.agentId(alias)
    return this.events()
      .filter(
        (event) =>
          event.agentId === agentId &&
          (event.type === 'collaboration.delivery.admitted' || event.type === 'collaboration.delivery.rejected')
      )
      .map((event) => ({
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        admitted: event.type === 'collaboration.delivery.admitted'
      }))
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

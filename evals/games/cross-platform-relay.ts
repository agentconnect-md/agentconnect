import { isDeepStrictEqual } from 'node:util'
import {
  CollaborationGameRunner,
  type CollaborationGameWorld,
  type GameWave,
  type GameWaveRecord,
  type RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import { NO_RESPONSE_SENTINEL } from '../../packages/daemon/src/session/no-response.js'
import { callDaemonTool, daemonMcpBinding, type DaemonMcpBinding } from './mcp-client.js'
import { relayFixture, scoreRelayReport, scriptedRelayReport, type RelayVariant } from './relay-feedback.js'
import { prepareGameSubject, preflightRealSubject, type GameSubjectSpec } from './subject.js'
import { compileTopology } from './topology.js'
import type { CompiledRoom, GameTopologyManifest } from './types.js'
import { ArenaWorld } from './world.js'

export function relayManifest(seed: number): GameTopologyManifest {
  return {
    game: 'cross-platform-relay',
    seed,
    agents: [{ id: 'bridge' }, { id: 'reviewer' }],
    rooms: [
      { id: 'discord-origin', platform: 'discord', members: ['bridge'] },
      { id: 'slack-review', platform: 'slack', members: ['bridge', 'reviewer'] }
    ]
  }
}

// JSON occupies its own line so prose around a packet cannot silently change its fields.
function packet(text: string, marker: string): unknown {
  const line = text.split('\n').find((entry) => entry.startsWith(`${marker} `))
  if (!line) return undefined
  try {
    return JSON.parse(line.slice(marker.length + 1))
  } catch {
    return undefined
  }
}

export class CrossPlatformRelayGame implements CollaborationGameWorld {
  readonly environment
  readonly fixture
  private readonly origin: CompiledRoom
  private readonly review: CompiledRoom
  private readonly bridgeId: string
  private readonly reviewerId: string
  private phase: 'start' | 'request' | 'feedback' | 'report' | 'done' = 'start'
  private readonly pending: GameWave[] = []
  private reason?: string
  private readonly metrics = {
    requestDelivered: 0,
    feedbackDelivered: 0,
    reportDelivered: 0,
    malformedPackets: 0,
    wrongAddress: 0,
    invalidReports: 0,
    requirementsSatisfied: 0,
    evidenceCorrect: 0,
    sourceCorrect: 0,
    statusCorrect: 0
  }
  private successful = false

  constructor(
    readonly world: ArenaWorld,
    readonly variant: RelayVariant
  ) {
    this.origin = world.topology.rooms.find((room) => room.alias === 'discord-origin')!
    this.review = world.topology.rooms.find((room) => room.alias === 'slack-review')!
    this.bridgeId = world.topology.agents.find((agent) => agent.alias === 'bridge')!.agentId
    this.reviewerId = world.topology.agents.find((agent) => agent.alias === 'reviewer')!.agentId
    this.fixture = relayFixture(world.topology, variant)
    this.environment = world.buildEnvironment()
  }

  private delivery(room: CompiledRoom, alias: string, text: string): GameWave {
    const integration = this.world.topology.integrations.find(
      (i) => i.agentAlias === alias && i.platform === room.platform
    )!
    const messageId = this.world.mintMessageId(room.platform)
    this.world.registerRoomMessage(room.channel, messageId)
    this.world.appendEvent({
      type: 'relay.ingress',
      origin: 'referee',
      roomId: room.alias,
      agentAlias: alias,
      messageId,
      text
    })
    return {
      platformEvents: [
        {
          integrationId: integration.integrationId,
          payload: {
            channel: room.channel,
            messageId,
            text,
            sender: { id: 'W-RELAY-REFEREE', isBot: false }
          }
        }
      ],
      refereeEvents: []
    }
  }

  nextDeliveries(): GameWave {
    if (this.phase === 'start') {
      this.phase = 'request'
      const integration = this.world.topology.integrations.find(
        (i) => i.agentAlias === 'bridge' && i.platform === 'slack'
      )!
      const target = { platform: 'slack', integrationId: integration.integrationId, channel: this.review.channel }
      return this.delivery(
        this.origin,
        'bridge',
        'Forward the exact request packet to the review channel using sendMessage with the given target. ' +
          'Use channel-root sends; do not invent a thread. Wait for reviewer feedback before reporting completion.\n' +
          `RELAY_TARGET ${JSON.stringify(target)}\nRELAY_REQUEST ${JSON.stringify(this.fixture.task)}`
      )
    }
    return this.pending.shift() ?? { platformEvents: [], refereeEvents: [] }
  }

  applyEffects(effects: readonly RecordedOutboundEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== 'reply' || effect.status !== 'delivered') continue
      const request = packet(effect.text, 'RELAY_REQUEST')
      const feedback = packet(effect.text, 'RELAY_FEEDBACK')
      const report = packet(effect.text, 'RELAY_REPORT')
      if (request === undefined && feedback === undefined && report === undefined) {
        if (/RELAY_(REQUEST|FEEDBACK|REPORT) /.test(effect.text)) this.metrics.malformedPackets += 1
        continue
      }
      if (this.phase === 'request' && request !== undefined && effect.agentId === this.bridgeId) {
        if (!this.addressed(effect, this.review, 'bridge')) {
          this.metrics.wrongAddress += 1
          continue
        }
        if (!isDeepStrictEqual(request, this.fixture.task)) {
          this.metrics.malformedPackets += 1
          continue
        }
        this.metrics.requestDelivered += 1
        this.phase = 'feedback'
        this.pending.push(
          this.delivery(
            this.review,
            'reviewer',
            'Review this actually delivered request. Reply with the supplied feedback packet verbatim; do not forward it yourself.\n' +
              `RELAY_REQUEST ${JSON.stringify(request)}\nRELAY_REVIEW_FIXTURE ${JSON.stringify(this.fixture.feedback)}`
          )
        )
        this.world.appendEvent({ type: 'relay.request', origin: 'agent_effect', effectSequence: effect.sequence })
      } else if (this.phase === 'feedback' && feedback !== undefined && effect.agentId === this.reviewerId) {
        // Reviewer replies may be in the ingress-created Slack thread; the bridge sends use channel roots.
        if (effect.platform !== 'slack' || effect.channel !== this.review.channel) {
          this.metrics.wrongAddress += 1
          continue
        }
        if (!isDeepStrictEqual(feedback, this.fixture.feedback)) {
          this.metrics.malformedPackets += 1
          continue
        }
        this.metrics.feedbackDelivered += 1
        this.phase = 'report'
        this.pending.push(
          this.delivery(
            this.review,
            'bridge',
            'The reviewer delivered the following feedback. Use the highest revision; deduplicate identical IDs. ' +
              'Conflicting highest-revision values require needs_clarification; omit quantity/format in that case. ' +
              'Otherwise report completed with the revised quantity and format. Include caseId, sourceId and all unique ' +
              'highest-revision evidenceIds. Send RELAY_REPORT JSON to the request returnTarget using sendMessage. ' +
              'Never claim approval absent from the feedback.\n' +
              `RELAY_REQUEST ${JSON.stringify(this.fixture.task)}\nRELAY_FEEDBACK ${JSON.stringify(feedback)}`
          )
        )
        this.world.appendEvent({ type: 'relay.feedback', origin: 'agent_effect', effectSequence: effect.sequence })
      } else if (this.phase === 'report' && report !== undefined && effect.agentId === this.bridgeId) {
        if (!this.addressed(effect, this.origin, 'bridge')) {
          this.metrics.wrongAddress += 1
          continue
        }
        this.metrics.reportDelivered += 1
        const score = scoreRelayReport(this.fixture.task, this.fixture.feedback, this.variant, report)
        for (const key of ['requirementsSatisfied', 'evidenceCorrect', 'sourceCorrect', 'statusCorrect'] as const) {
          this.metrics[key] = Number(score[key])
        }
        this.successful = score.successful
        this.metrics.invalidReports += Number(!score.successful)
        this.world.appendEvent({
          type: 'relay.report',
          origin: 'agent_effect',
          effectSequence: effect.sequence,
          ...score
        })
        this.phase = 'done'
        this.reason = score.successful ? 'completed' : 'incorrect_report'
      }
    }
  }

  private addressed(effect: RecordedOutboundEffect, room: CompiledRoom, alias: string): boolean {
    const integration = this.world.topology.integrations.find(
      (i) => i.agentAlias === alias && i.platform === room.platform
    )!
    return (
      effect.platform === room.platform &&
      effect.integrationId === integration.integrationId &&
      effect.channel === room.channel &&
      effect.thread === undefined
    )
  }

  isTerminal(): boolean {
    return this.reason !== undefined
  }
  drainOutboundEffects() {
    return this.world.drainOutboundEffects()
  }
  noteWave(record: GameWaveRecord): void {
    this.world.appendEvent({
      type: 'wave',
      origin: 'world',
      step: record.step,
      phase: this.phase,
      admissions: [...record.admissions]
    })
  }
  terminate(reason: string): void {
    this.reason ??= reason
  }
  verdict() {
    return {
      terminalReason: this.reason ?? 'incomplete',
      refereeConsistent: true,
      invariants: { ...this.world.invariantCounters(), privateLeaks: 0 },
      outcome: {
        completed: this.successful,
        variant: this.variant,
        taskCompleted: this.successful && this.variant !== 'conflict',
        clarificationReported: this.successful && this.variant === 'conflict',
        target: 3,
        acceptedPrefix: this.metrics.requestDelivered + this.metrics.feedbackDelivered + Number(this.successful)
      },
      metrics: { ...this.metrics }
    }
  }
  worldEventRecords() {
    return this.world.events()
  }
  topologyArtifact() {
    return this.world.topology
  }
}

function scriptedRelayHostFactory() {
  return (agent: { id: string; name?: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
    let sessions = 0
    const bindings = new Map<string, DaemonMcpBinding>()
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: unknown) => {
        const id = `relay-${agent.id}-${++sessions}`
        const binding = daemonMcpBinding(mcpServers)
        if (binding) bindings.set(id, binding)
        return id
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-relay', models: ['scripted-relay'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        const task = packet(text, 'RELAY_REQUEST') as ReturnType<typeof relayFixture>['task'] | undefined
        const review = packet(text, 'RELAY_REVIEW_FIXTURE')
        const feedback = packet(text, 'RELAY_FEEDBACK') as ReturnType<typeof relayFixture>['feedback'] | undefined
        let output = NO_RESPONSE_SENTINEL
        if (agent.name === 'reviewer' && review !== undefined) output = `RELAY_FEEDBACK ${JSON.stringify(review)}`
        else if (agent.name === 'bridge' && task) {
          const target = feedback ? task.returnTarget : packet(text, 'RELAY_TARGET')
          const binding = bindings.get(sessionId)
          if (target && binding) {
            const message = feedback
              ? `RELAY_REPORT ${JSON.stringify(scriptedRelayReport(task, feedback))}`
              : `RELAY_REQUEST ${JSON.stringify(task)}`
            const result = await callDaemonTool(binding, 'sendMessage', {
              ...(target as Record<string, unknown>),
              message
            })
            if (!result.ok) output = `relay send failed: ${result.error}`
          }
        }
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } })
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }
}

export async function runCrossPlatformRelay(options: {
  seed?: number
  variant?: RelayVariant
  artifactDir: string
  subject?: GameSubjectSpec
  timeoutMs?: number
}) {
  const seed = options.seed ?? 42
  const spec = options.subject ?? { kind: 'scripted' }
  const topology = compileTopology(relayManifest(seed))
  const game = new CrossPlatformRelayGame(new ArenaWorld(topology), options.variant ?? 'clean')
  const subject = prepareGameSubject(topology, spec)
  try {
    if (spec.kind === 'real') await preflightRealSubject(subject.root)
    return await new CollaborationGameRunner({
      root: subject.root,
      world: game,
      artifactDir: options.artifactDir,
      game: topology.game,
      seed,
      mode: 'deterministic',
      subjectKind: spec.kind,
      ...(spec.kind === 'scripted' ? { hostFactory: scriptedRelayHostFactory() as never } : {}),
      capabilityProfile: { memory: 'off' },
      limits: { maxSteps: 10, timeoutMs: options.timeoutMs ?? 180_000 },
      agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias })),
      secrets: subject.secrets
    }).run()
  } finally {
    subject.cleanup()
  }
}

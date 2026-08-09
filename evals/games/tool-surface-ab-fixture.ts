/**
 * The tool-surface A/B's runnable environment — one fixture, two arms.
 *
 * Boots a REAL daemon against the three-room A/B topology (see `abManifest`)
 * with production mention-gated routing and full platform-echo fidelity. The
 * ONLY thing the `arm` option changes is the messaging surface the sessions
 * carry:
 *
 *   arm A  the product `sendMessage`, production guidance text — as shipped;
 *   arm B  the `post` façade (post-facade.ts), `sendMessage` withheld from the
 *          descriptor list, and the arm-B guidance texts — while every façade
 *          call still EXECUTES through the product `sendMessage` on the same
 *          trusted session context.
 *
 * Everything else — model, topology, seeds, routing, activation, policy — is
 * byte-identical across arms, which is what makes a measured difference
 * attributable to the surface.
 *
 * The subject seam is the arena's own (`GameSubjectSpec`): scripted hosts for
 * credential-free contract tests, or a real-runtime subject template for the
 * behavioral runs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '../../packages/message/src/index.js'
import type {
  DeliveryHandle,
  EvaluationEvent,
  RecordedOutboundEffect
} from '../../packages/daemon/src/evaluation/index.js'
import { DaemonEvaluationHarness } from '../../packages/daemon/src/evaluation/index.js'
import { POST_COLLAB_GUIDANCE, postFacadeTool, postParentReplyAppend } from './post-facade.js'
import { prepareGameSubject, preflightRealSubject, type GameSubjectSpec } from './subject.js'
import { compileTopology } from './topology.js'
import type { CompiledRoom, CompiledTopology, GameTopologyManifest } from './types.js'
import { ArenaWorld } from './world.js'

export type AbArm = 'A' | 'B'

/** One recorded façade call (arm B only): what the model asked for and what it
 *  compiled to. The qualitative "HOW was the surface misused" evidence. */
export interface PostCallRecord {
  agentId: string
  input: Record<string, unknown>
  outcome: 'compiled' | 'invalid'
  form?: string
  error?: string
}

/**
 * The A/B topology. `briefing` is where the subject receives its task (subject
 * alone, so the task text stays out of every measured room), `plaza` is the
 * shared target channel the scenarios point at, and `peer-briefing` is where
 * scenario 4's caller receives the instruction to delegate. One Slack
 * integration per agent reaches all of its rooms, exactly as in production.
 */
export function abManifest(seed: number): GameTopologyManifest {
  return {
    game: 'tool-surface-ab',
    seed,
    agents: [{ id: 'runner' }, { id: 'peer' }],
    rooms: [
      { id: 'briefing', platform: 'slack', members: ['runner'] },
      { id: 'peer-briefing', platform: 'slack', members: ['peer'] },
      { id: 'plaza', platform: 'slack', members: ['runner', 'peer'] }
    ]
  }
}

export interface AbFixtureOptions {
  seed: number
  arm: AbArm
  /** Who plays: scripted hosts (contract tests) or a real subject template. */
  subject: GameSubjectSpec
  /** Scripted-host seam, passed through to the daemon (subject kind 'scripted'). */
  hostFactory?: ConstructorParameters<typeof DaemonEvaluationHarness>[0]['hostFactory']
  /** Patch the prepared agents' `description` (a real peer gets its persona by
   *  CONFIGURATION, never by scripting). Keyed by agent alias. */
  agentDescriptions?: Record<string, string>
}

export class AbFixture {
  readonly topology: CompiledTopology
  readonly world: ArenaWorld
  readonly arm: AbArm
  readonly secrets: readonly string[]
  /** Shared with the façade's onCall hook — records appear here live (arm B). */
  readonly facadeCalls: PostCallRecord[]
  private readonly harness: DaemonEvaluationHarness
  private readonly subjectCleanup: () => void
  private readonly echoHandles: DeliveryHandle[] = []
  private readonly threadByMessageId = new Map<string, string>()

  private constructor(args: {
    topology: CompiledTopology
    world: ArenaWorld
    arm: AbArm
    harness: DaemonEvaluationHarness
    secrets: readonly string[]
    facadeCalls: PostCallRecord[]
    subjectCleanup: () => void
  }) {
    this.topology = args.topology
    this.world = args.world
    this.arm = args.arm
    this.harness = args.harness
    this.secrets = args.secrets
    this.facadeCalls = args.facadeCalls
    this.subjectCleanup = args.subjectCleanup
  }

  static async start(options: AbFixtureOptions): Promise<AbFixture> {
    const topology = compileTopology(abManifest(options.seed))
    const world = new ArenaWorld(topology)
    // Production shared-channel convention: activation needs a mention or
    // thread affinity — the same rung the scenarios' correct calls rely on.
    const base = world.buildEnvironment({ bindMatch: 'mention' })
    const facadeCalls: PostCallRecord[] = []
    const environment =
      options.arm === 'B'
        ? {
            ...base,
            tools: [postFacadeTool({ onCall: (record) => facadeCalls.push(record) })],
            hideProductTools: ['sendMessage'],
            collaborationGuidance: {
              collabAppend: POST_COLLAB_GUIDANCE,
              parentReplyAppend: postParentReplyAppend
            }
          }
        : base
    const subject = prepareGameSubject(topology, options.subject)
    try {
      if (options.agentDescriptions) {
        for (const [alias, description] of Object.entries(options.agentDescriptions)) {
          const agent = topology.agents.find((candidate) => candidate.alias === alias)
          if (!agent) throw new Error(`agentDescriptions names unknown alias "${alias}"`)
          const path = join(subject.root, 'agents', agent.agentId, 'agent.json')
          const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
          writeFileSync(path, `${JSON.stringify({ ...record, description }, null, 2)}\n`)
        }
      }
      if (options.subject.kind === 'real') await preflightRealSubject(subject.root)
    } catch (error) {
      subject.cleanup()
      throw error
    }
    const harness = new DaemonEvaluationHarness({
      root: subject.root,
      environment,
      runId: `ab-${options.seed}-${options.arm}`,
      capabilityProfile: { memory: 'off' },
      secrets: subject.secrets,
      ...(options.hostFactory ? { hostFactory: options.hostFactory } : {})
    })
    const fixture = new AbFixture({
      topology,
      world,
      arm: options.arm,
      harness,
      secrets: subject.secrets,
      facadeCalls,
      subjectCleanup: subject.cleanup
    })
    world.onDelivered((effect) => fixture.echoDeliveredPost(effect))
    await harness.start()
    return fixture
  }

  room(alias: string): CompiledRoom {
    const room = this.topology.rooms.find((candidate) => candidate.alias === alias)
    if (!room) throw new Error(`unknown room alias "${alias}"`)
    return room
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

  /** Production Slack echo, generalized to every room: a delivered agent post
   *  fans back to the OTHER member integrations of that room as real platform
   *  ingress. Whether an echo activates anyone stays the daemon's decision. */
  private echoDeliveredPost(effect: RecordedOutboundEffect): void {
    if (effect.status !== 'delivered' || effect.agentId === undefined) return
    if (effect.kind !== 'reply' && effect.kind !== 'finalize') return
    const room = this.topology.rooms.find((candidate) => candidate.channel === effect.channel)
    if (!room) return
    const botUserId = this.world.botUserIdFor(effect.integrationId)
    if (botUserId === undefined || effect.messageId === undefined) return
    const appId = this.world.botAppIdFor(effect.integrationId)
    let thread: string
    let ingressEventTag: string | undefined
    if (effect.kind === 'reply') {
      thread = effect.thread ?? effect.messageId
      this.threadByMessageId.set(effect.messageId, thread)
    } else {
      thread = this.threadByMessageId.get(effect.messageId) ?? effect.thread ?? effect.messageId
      ingressEventTag = SLACK_RESPONSE_FINAL_EVENT_TAG
    }
    const mentions = [...effect.text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]!)
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
    for (const integrationId of room.memberIntegrationIds) {
      if (integrationId === effect.integrationId) continue
      this.echoHandles.push(
        this.harness.inject({
          integrationId,
          payload: {
            channel: room.channel,
            thread,
            messageId: effect.messageId,
            ...(ingressEventTag !== undefined ? { ingressEventTag } : {}),
            text: effect.text,
            sender: { id: botUserId, isBot: true, ...(appId !== undefined ? { appId } : {}) },
            ...(mentions.length > 0 ? { mentions } : {}),
            ...(claim !== undefined ? { agentAuthorship: claim } : {})
          }
        })
      )
    }
  }

  /** Inject one HUMAN platform message into a room, fanned to every member
   *  integration (the same channel:ts each dedicated Slack app receives). */
  injectHuman(
    roomAlias: string,
    text: string,
    options: { mentions?: string[]; sender?: string } = {}
  ): { messageId: string; handles: DeliveryHandle[] } {
    const room = this.room(roomAlias)
    const messageId = this.world.mintMessageId('slack')
    this.world.registerRoomMessage(room.channel, messageId)
    this.world.recordThreadMessage(room.channel, messageId, {
      ts: messageId,
      text,
      sender: options.sender ?? 'W-HUMAN',
      isBot: false
    })
    const handles = room.memberIntegrationIds.map((integrationId) =>
      this.harness.inject({
        integrationId,
        payload: {
          channel: room.channel,
          thread: messageId,
          messageId,
          text,
          sender: { id: options.sender ?? 'W-HUMAN', isBot: false },
          ...(options.mentions !== undefined ? { mentions: options.mentions } : {})
        }
      })
    )
    return { messageId, handles }
  }

  /** Settle everything in flight: injected handles, echo cascades generation by
   *  generation, then daemon idleness (which covers agent-call child turns). */
  async settle(handles: DeliveryHandle[] = [], timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())
    let pending = [...handles, ...this.echoHandles.splice(0)]
    let generations = 0
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map((handle) => handle.completion))
      pending = this.echoHandles.splice(0)
    }
    await this.harness.waitUntilIdle(remaining())
    pending = this.echoHandles.splice(0)
    while (pending.length > 0 && generations < 32) {
      generations += 1
      await Promise.all(pending.map((handle) => handle.completion))
      await this.harness.waitUntilIdle(remaining())
      pending = this.echoHandles.splice(0)
    }
  }

  events(): readonly EvaluationEvent[] {
    return this.harness.events()
  }

  /** The event subset attributable to ONE agent — what scopes the A/B metrics
   *  to the subject instead of averaging the peer's turns into them. */
  eventsOf(agentAlias: string): EvaluationEvent[] {
    const agentId = this.agentId(agentAlias)
    return this.events().filter((event) => event.agentId === agentId)
  }

  eventCollector() {
    return this.harness.eventCollector()
  }

  async stop(): Promise<void> {
    try {
      await this.harness.stop()
    } finally {
      this.subjectCleanup()
    }
  }
}

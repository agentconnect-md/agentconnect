import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import {
  EvaluationEventCollector,
  VirtualSlackConnection,
  type DaemonEvaluationEnvironment,
  type OutboundEffectInput,
  type OutboundEffectResult,
  type VirtualConnectionWorldPort
} from '../src/evaluation/index.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT_ID = 'game-agent'
const OTHER_AGENT_ID = 'other-agent'
const INTEGRATION_ID = 'virtual-integration-1'
const OTHER_INTEGRATION_ID = 'virtual-integration-2'
const CHANNEL = 'CGAMEROOM01'
const THREAD = '1700000001.000100'

function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-game-ingress-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { test: { command: 'node', args: ['unused'] } }
    })
  )
  for (const agentId of agentIds) {
    const agentDir = join(root, 'agents', agentId)
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: agentId,
        status: 'active',
        runtime: 'test',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'low', showFooter: false, showStatusBar: false }
      })
    )
  }
  return root
}

class RecordingWorld implements VirtualConnectionWorldPort {
  readonly effects: (OutboundEffectInput & { sequence: number })[] = []
  private sequence = 0

  async recordOutbound(effect: OutboundEffectInput): Promise<OutboundEffectResult> {
    this.sequence += 1
    this.effects.push({ ...effect, sequence: this.sequence })
    return {
      status: 'delivered',
      messageId: `1700000009.${String(this.sequence).padStart(6, '0')}`,
      sequence: this.sequence
    }
  }

  channelInfo(channel: string) {
    return channel === CHANNEL ? { id: CHANNEL, name: 'game-room' } : undefined
  }

  members() {
    return [{ id: AGENT_ID, isBot: true }]
  }

  channels() {
    return [{ id: CHANNEL, name: 'game-room' }]
  }

  profile(user: string) {
    return { id: user }
  }
}

function environment(world: RecordingWorld): DaemonEvaluationEnvironment {
  return {
    integrations: [
      {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'slack',
        transportScope: 'game-scope-1',
        tenant: { workspaceId: 'TGAME1' },
        bindRules: [{ channel: CHANNEL, match: { kind: 'auto' } }],
        connection: new VirtualSlackConnection(INTEGRATION_ID, { workspaceId: 'TGAME1' }, world, {
          botUserId: 'UGAMEBOT1'
        })
      },
      {
        integrationId: OTHER_INTEGRATION_ID,
        agentId: OTHER_AGENT_ID,
        platform: 'slack',
        transportScope: 'game-scope-2',
        tenant: { workspaceId: 'TGAME1' },
        bindRules: [{ channel: CHANNEL, match: { kind: 'auto' } }],
        connection: new VirtualSlackConnection(OTHER_INTEGRATION_ID, { workspaceId: 'TGAME1' }, world, {
          botUserId: 'UGAMEBOT2'
        })
      }
    ],
    collaborationRoutes: { generation: 1, channels: [], agents: [], platformKinds: [] },
    listAgents: async (request) => ({
      platform: request.platform,
      ...(request.channel !== undefined ? { channel: request.channel } : {}),
      agents: []
    })
  }
}

function echoHostFactory() {
  return (_agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
    let sessions = 0
    return {
      start: async () => {},
      newSession: async () => `game-session-${(sessions += 1)}`,
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted', models: ['scripted'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('')
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } })
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    } as never
  }
}

let daemon: Daemon | undefined

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
})

async function startDaemon(world: RecordingWorld): Promise<Daemon> {
  daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold([AGENT_ID, OTHER_AGENT_ID]),
    hostFactory: echoHostFactory(),
    evaluation: {
      observer: new EvaluationEventCollector(),
      runId: 'game-ingress-run',
      environment: environment(world)
    }
  })
  await daemon.start()
  return daemon
}

describe('collaboration-arena ingress seams (§4/§5/§7)', () => {
  it('injectPlatformEvent enters real routing, admits via the bind rule, and the ordinary reply lands in the world sink', async () => {
    const world = new RecordingWorld()
    const d = await startDaemon(world)
    const handle = await d.injectPlatformEvent({
      integrationId: INTEGRATION_ID,
      payload: {
        channel: CHANNEL,
        thread: THREAD,
        messageId: '1700000001.000200',
        text: 'hello room',
        sender: { id: 'W-REFEREE' }
      }
    })
    const admission = await handle.admission
    expect(admission).toMatchObject({ admitted: true, agentId: AGENT_ID })
    if (!admission.admitted) throw new Error('unreachable')
    expect(admission.sessionKey).toContain(`slack:${CHANNEL}:${THREAD}:${AGENT_ID}`)
    const completion = await handle.completion
    expect(completion.status).toBe('completed')
    await d.waitForEvaluationIdle()
    // The agent's ordinary reply reached the world through the virtual
    // connection with the trusted author identity, into the same thread.
    const replies = world.effects.filter((effect) => effect.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      integrationId: INTEGRATION_ID,
      channel: CHANNEL,
      thread: THREAD,
      identity: { agentAuthorId: AGENT_ID }
    })
    expect(replies[0]!.text).toContain('echo:')
  })

  it('fans one room message id out to both integrations — each is admitted once, duplicates are rejected as deduplicated', async () => {
    const world = new RecordingWorld()
    const d = await startDaemon(world)
    const payload = {
      channel: CHANNEL,
      thread: THREAD,
      messageId: '1700000001.000300',
      text: 'count now',
      sender: { id: 'W-REFEREE' }
    }
    const handles = [
      d.injectPlatformEvent({ integrationId: INTEGRATION_ID, payload }),
      d.injectPlatformEvent({ integrationId: OTHER_INTEGRATION_ID, payload })
    ]
    const admissions = await Promise.all(handles.map(async (handle) => (await handle).admission))
    // Same channel:ts, two transports — production per-connection dedup admits both.
    expect(admissions.map((admission) => admission.admitted)).toEqual([true, true])
    expect(new Set(admissions.map((admission) => (admission.admitted ? admission.agentId : '')))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID])
    )
    // A literal duplicate on the SAME transport is deduplicated by production ingress.
    const duplicate = await d.injectPlatformEvent({ integrationId: INTEGRATION_ID, payload })
    await expect(duplicate.admission).resolves.toEqual({ admitted: false, reason: 'deduplicated' })
    await expect(duplicate.completion).resolves.toEqual({ status: 'not_admitted' })
    await Promise.all(handles.map(async (handle) => (await handle).completion))
    await d.waitForEvaluationIdle()
  })

  it('rejects an event no routing rule serves as unrouted, and a managed-bot echo as suppressed', async () => {
    const world = new RecordingWorld()
    const d = await startDaemon(world)
    const unrouted = await d.injectPlatformEvent({
      integrationId: INTEGRATION_ID,
      payload: {
        channel: 'CUNBOUNDROOM',
        messageId: '1700000001.000400',
        text: 'nobody listens here',
        sender: { id: 'W-REFEREE' }
      }
    })
    await expect(unrouted.admission).resolves.toEqual({ admitted: false, reason: 'unrouted' })
    // A message authored by one of the daemon's own (virtual) bot identities is
    // never an activation path (§4.1: no fabricated agent senders).
    const suppressed = await d.injectPlatformEvent({
      integrationId: INTEGRATION_ID,
      payload: {
        channel: CHANNEL,
        thread: THREAD,
        messageId: '1700000001.000500',
        text: 'echo of ourselves',
        sender: { id: 'UGAMEBOT2', isBot: true }
      }
    })
    await expect(suppressed.admission).resolves.toEqual({ admitted: false, reason: 'suppressed' })
  })

  it('deliverRefereeEvent is pre-addressed: no routing rule needed, still a full real turn', async () => {
    const world = new RecordingWorld()
    const d = await startDaemon(world)
    const handle = await d.deliverRefereeEvent({
      targetAgentId: AGENT_ID,
      platform: 'slack',
      integrationId: INTEGRATION_ID,
      channel: CHANNEL,
      thread: THREAD,
      messageId: '1700000001.000600',
      text: 'your role: counter',
      isDm: false
    })
    const admission = await handle.admission
    expect(admission).toMatchObject({ admitted: true, agentId: AGENT_ID })
    const completion = await handle.completion
    expect(completion.status).toBe('completed')
    if (completion.status !== 'completed') throw new Error('unreachable')
    expect(completion.sessionId).toMatch(/^game-session-/)
    await d.waitForEvaluationIdle()
  })

  it('keeps the add-on compatibility wrapper intact: runEvaluationTurn still drives a webchat-shaped turn', async () => {
    const world = new RecordingWorld()
    const d = await startDaemon(world)
    const result = await d.runEvaluationTurn({
      agentId: AGENT_ID,
      conversationId: 'compat-case',
      turnId: 'compat-turn',
      text: 'ping'
    })
    expect(result.turnId).toBe('compat-turn')
    expect(result.sessionId).toMatch(/^game-session-/)
    expect(result.output).toContain('echo:')
    // Webchat turns never touch the virtual platform transport.
    expect(world.effects).toHaveLength(0)
  })
})

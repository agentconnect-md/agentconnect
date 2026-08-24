import net from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import {
  EvaluationEventCollector,
  VirtualSlackConnection,
  type DaemonEvaluationEnvironment,
  type EvaluationToolDefinition,
  type OutboundEffectInput,
  type OutboundEffectResult,
  type VirtualConnectionWorldPort
} from '../src/evaluation/index.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const PLAYER_A = 'player-a'
const PLAYER_B = 'player-b'
const INTEGRATION_A = 'virtual-int-a'
const INTEGRATION_B = 'virtual-int-b'
const CHANNEL = 'CGAMETOOLS1'
const THREAD = '1700000002.000100'

function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-game-tools-'))
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

class SilentWorld implements VirtualConnectionWorldPort {
  private sequence = 0

  async recordOutbound(_effect: OutboundEffectInput): Promise<OutboundEffectResult> {
    this.sequence += 1
    return { status: 'delivered', messageId: `170.${this.sequence}`, sequence: this.sequence }
  }

  channelInfo(channel: string) {
    return channel === CHANNEL ? { id: CHANNEL, name: 'game-room' } : undefined
  }

  members() {
    return []
  }

  channels() {
    return [{ id: CHANNEL, name: 'game-room' }]
  }

  profile(user: string) {
    return { id: user }
  }
}

function environment(world: SilentWorld, tools: EvaluationToolDefinition[]): DaemonEvaluationEnvironment {
  return {
    integrations: [
      {
        integrationId: INTEGRATION_A,
        agentId: PLAYER_A,
        platform: 'slack',
        transportScope: 'tools-scope-a',
        tenant: { workspaceId: 'TTOOLS' },
        bindRules: [{ channel: CHANNEL, match: { kind: 'auto' } }],
        connection: new VirtualSlackConnection(INTEGRATION_A, { workspaceId: 'TTOOLS' }, world, { botUserId: 'UTOOLA' })
      },
      {
        integrationId: INTEGRATION_B,
        agentId: PLAYER_B,
        platform: 'slack',
        transportScope: 'tools-scope-b',
        tenant: { workspaceId: 'TTOOLS' },
        bindRules: [{ channel: CHANNEL, match: { kind: 'auto' } }],
        connection: new VirtualSlackConnection(INTEGRATION_B, { workspaceId: 'TTOOLS' }, world, { botUserId: 'UTOOLB' })
      }
    ],
    collaborationRoutes: { generation: 1, channels: [], agents: [], platformKinds: [] },
    listAgents: async (request) => ({ platform: request.platform, agents: [] }),
    tools
  }
}

interface CapturedBinding {
  endpoint: string
  token: string
}

/** Scripted host that captures the bridge MCP binding per session, exactly as
 *  a real runtime receives it at `session/new`, and performs the tool call
 *  DURING its turn (the only window the daemon's turn gate admits). */
function bindingCapturingHostFactory(
  bindings: Map<string, CapturedBinding>,
  duringTurn?: (agentId: string, binding: CapturedBinding | undefined) => Promise<unknown>
) {
  return (agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
    let sessions = 0
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: { env?: { name: string; value: string }[] }[]) => {
        const sessionId = `tools-session-${agent.id}-${(sessions += 1)}`
        const env = mcpServers?.find((server) => server.env?.some((entry) => entry.name === 'AC_MCP_TOKEN'))?.env
        if (env) {
          bindings.set(agent.id, {
            endpoint: env.find((entry) => entry.name === 'AC_MCP_ENDPOINT')!.value,
            token: env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
          })
        }
        return sessionId
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted', models: ['scripted'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        if (duringTurn && /act now/.test(text)) await duringTurn(agent.id, bindings.get(agent.id))
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    } as never
  }
}

function ipcCall(binding: CapturedBinding, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(binding.endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: binding.token, ...request })}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
    })
    socket.on('error', reject)
  })
}

let daemon: Daemon | undefined

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
})

describe('evaluation tool registry (§6)', () => {
  it('merges role-visible descriptors into the session tool set and dispatches with trusted identity', async () => {
    const world = new SilentWorld()
    const calls: { agentId: string; input: unknown; sessionChannel: string }[] = []
    const tools: EvaluationToolDefinition[] = [
      {
        descriptor: {
          name: 'gameAction',
          description: 'structured game action',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
        },
        visibleTo: (agentId) => agentId === PLAYER_A,
        handler: async ({ agentId, sessionContext, input }) => {
          calls.push({ agentId, input, sessionChannel: sessionContext.channel })
          return { disposition: 'accepted' }
        }
      }
    ]
    const bindings = new Map<string, CapturedBinding>()
    const inTurnResults = new Map<string, Record<string, unknown>>()
    daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold([PLAYER_A, PLAYER_B]),
      hostFactory: bindingCapturingHostFactory(bindings, async (agentId, binding) => {
        // Dispatch binds the TRUSTED session identity, never tool input.
        const response = await ipcCall(binding!, {
          id: 2,
          op: 'callTool',
          name: 'gameAction',
          args: { agentId: 'forged-identity', anything: 1 }
        })
        inTurnResults.set(agentId, response)
      }),
      evaluation: {
        observer: new EvaluationEventCollector(),
        runId: 'tools-run',
        environment: environment(world, tools)
      }
    })
    await daemon.start()
    for (const [agentId, integrationId] of [
      [PLAYER_A, INTEGRATION_A],
      [PLAYER_B, INTEGRATION_B]
    ] as const) {
      const handle = await daemon.deliverRefereeEvent({
        targetAgentId: agentId,
        platform: 'slack',
        integrationId,
        channel: CHANNEL,
        thread: THREAD,
        messageId: `1700000002.${agentId}`,
        text: 'act now',
        isDm: false
      })
      await handle.completion
    }
    await daemon.waitForEvaluationIdle()
    const bindingA = bindings.get(PLAYER_A)!
    const bindingB = bindings.get(PLAYER_B)!

    // Descriptor merge follows visibility (listTools is not turn-gated).
    const listA = (await ipcCall(bindingA, { id: 1, op: 'listTools' })) as {
      result: { tools: { name: string }[] }
    }
    const listB = (await ipcCall(bindingB, { id: 1, op: 'listTools' })) as {
      result: { tools: { name: string }[] }
    }
    expect(listA.result.tools.map((tool) => tool.name)).toContain('gameAction')
    expect(listB.result.tools.map((tool) => tool.name)).not.toContain('gameAction')

    // PLAYER_A's in-turn call succeeded with the trusted identity.
    const callA = inTurnResults.get(PLAYER_A)!
    expect(callA.ok).toBe(true)
    expect(callA.result).toEqual({ disposition: 'accepted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ agentId: PLAYER_A, sessionChannel: CHANNEL })

    // For PLAYER_B the tool is invisible — indistinguishable from unknown.
    const callB = inTurnResults.get(PLAYER_B)!
    expect(callB.ok).toBe(false)
    expect(String(callB.error)).toContain('unknown tool')
  })

  it('rejects an evaluation tool that shadows a product tool at startup, before any session exists', async () => {
    const world = new SilentWorld()
    const tools: EvaluationToolDefinition[] = [
      {
        descriptor: {
          name: 'sendMessage',
          description: 'shadowing attempt',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
        },
        visibleTo: () => true,
        handler: async () => ({})
      }
    ]
    daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold([PLAYER_A, PLAYER_B]),
      hostFactory: bindingCapturingHostFactory(new Map()),
      evaluation: {
        observer: new EvaluationEventCollector(),
        runId: 'tools-run',
        environment: environment(world, tools)
      }
    })
    await expect(daemon.start()).rejects.toThrow(/shadows a product tool/)
    daemon = undefined
  })

  it('rejects duplicate evaluation tool names at startup', async () => {
    const world = new SilentWorld()
    const definition: EvaluationToolDefinition = {
      descriptor: {
        name: 'vote',
        description: 'vote',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      },
      visibleTo: () => true,
      handler: async () => ({})
    }
    daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold([PLAYER_A, PLAYER_B]),
      hostFactory: bindingCapturingHostFactory(new Map()),
      evaluation: {
        observer: new EvaluationEventCollector(),
        runId: 'tools-run',
        environment: environment(world, [definition, { ...definition }])
      }
    })
    await expect(daemon.start()).rejects.toThrow(/duplicate evaluation tool/)
    daemon = undefined
  })
})

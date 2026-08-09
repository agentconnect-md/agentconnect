/**
 * A/B fixture contract, credential-free: each arm must present EXACTLY its own
 * surface — descriptors and prompt alike — while both execute through the one
 * product implementation. This is the fairness precondition of the behavioral
 * A/B: if arm B's sessions still listed `sendMessage`, or its prompt still
 * taught `sendMessage` call shapes, a behavioral difference would measure a
 * mixed surface rather than the design under test.
 *
 * Scripted hosts, real daemon: the assertions read the daemon's own control
 * socket (listTools), the session's actual prompt text, and the world's
 * delivered effects — never fixture internals.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { callDaemonTool, daemonMcpBinding, listDaemonTools, type DaemonMcpBinding } from '../games/mcp-client.js'
import { AbFixture } from '../games/tool-surface-ab-fixture.js'

let fixture: AbFixture | undefined

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

interface CapturedSession {
  agentAlias: string
  prompts: string[]
  binding?: DaemonMcpBinding
}

/** Scripted host seam that records every prompt and the session's MCP binding,
 *  and runs an optional per-turn script with real daemon-tool access. */
function capturingHostFactory(
  fixtureAliasOf: (agentId: string) => string,
  captured: CapturedSession[],
  script?: (context: {
    agentAlias: string
    text: string
    callTool: (name: string, args: Record<string, unknown>) => ReturnType<typeof callDaemonTool>
    reply: (text: string) => void
  }) => Promise<void> | void
) {
  return ((agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
    let sessions = 0
    const byId = new Map<string, CapturedSession>()
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: unknown) => {
        const sessionId = `ab-${agent.id.slice(0, 8)}-${(sessions += 1)}`
        const record: CapturedSession = { agentAlias: fixtureAliasOf(agent.id), prompts: [] }
        const binding = daemonMcpBinding(mcpServers)
        if (binding) record.binding = binding
        byId.set(sessionId, record)
        captured.push(record)
        return sessionId
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-ab', models: ['scripted-ab'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const record = byId.get(sessionId)!
        const text = blocks.map((block) => block.text ?? '').join('\n')
        record.prompts.push(text)
        let replied = false
        const reply = (value: string) => {
          replied = true
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
        }
        if (script) {
          await script({
            agentAlias: record.agentAlias,
            text,
            callTool: (name, args) => {
              if (!record.binding) throw new Error('session has no daemon tool binding')
              return callDaemonTool(record.binding, name, args)
            },
            reply
          })
        }
        if (!replied) {
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
        }
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }) as never
}

async function startArm(
  arm: 'A' | 'B',
  captured: CapturedSession[],
  script?: Parameters<typeof capturingHostFactory>[2]
) {
  let aliasOf: (agentId: string) => string = () => 'unknown'
  const started = await AbFixture.start({
    seed: 4242,
    arm,
    subject: { kind: 'scripted' },
    hostFactory: capturingHostFactory((agentId) => aliasOf(agentId), captured, script)
  })
  aliasOf = (agentId) => started.topology.agents.find((agent) => agent.agentId === agentId)?.alias ?? agentId
  return started
}

describe('tool-surface A/B fixture — each arm presents exactly one surface', () => {
  it('arm A: the session carries `sendMessage` and the production guidance, and no `post`', async () => {
    const captured: CapturedSession[] = []
    fixture = await startArm('A', captured)
    const kick = fixture.injectHuman('briefing', `<@${fixture.botUserId('runner')}> hello`, {
      mentions: [fixture.botUserId('runner')]
    })
    await fixture.settle(kick.handles)
    const runner = captured.find((session) => session.agentAlias === 'runner')
    expect(runner, 'runner session was created').toBeDefined()
    expect(runner!.binding, 'runner session has daemon tools').toBeDefined()
    const tools = await listDaemonTools(runner!.binding!)
    expect(tools).toContain('sendMessage')
    expect(tools).not.toContain('post')
    const prompt = runner!.prompts.join('\n')
    expect(prompt).toContain('# Collaborating with other agents')
    expect(prompt).toContain('sendMessage')
    expect(prompt).not.toContain('"kind":"channel"')
  })

  it('arm B: `post` replaces `sendMessage` in descriptors AND in the prompt, and still executes through the product', async () => {
    const captured: CapturedSession[] = []
    let listed: string[] = []
    let postResult: Awaited<ReturnType<typeof callDaemonTool>> | undefined
    const plazaChannel = () => fixture!.room('plaza').channel
    fixture = await startArm('B', captured, async (context) => {
      if (context.agentAlias !== 'runner' || postResult !== undefined) return
      const runner = captured.find((session) => session.agentAlias === 'runner')!
      listed = await listDaemonTools(runner.binding!)
      postResult = await context.callTool('post', {
        conversation: { kind: 'channel', channel: plazaChannel() },
        message: 'deploy finished'
      })
      context.reply('posted')
    })
    const kick = fixture.injectHuman('briefing', `<@${fixture.botUserId('runner')}> hello`, {
      mentions: [fixture.botUserId('runner')]
    })
    await fixture.settle(kick.handles)

    // The descriptor list: one surface, not two.
    expect(listed).toContain('post')
    expect(listed).not.toContain('sendMessage')
    // The prompt: arm B's guidance, no `sendMessage` teaching anywhere.
    const runner = captured.find((session) => session.agentAlias === 'runner')!
    const prompt = runner.prompts.join('\n')
    expect(prompt).toContain('# Collaborating with other agents')
    expect(prompt).toContain('`post`')
    expect(prompt).not.toContain('sendMessage')
    // The execution: the façade compiled and the PRODUCT delivered a real,
    // world-authorized channel post (§7.2 path, not a shortcut).
    expect(postResult?.ok, JSON.stringify(postResult)).toBe(true)
    expect(fixture.facadeCalls).toEqual([expect.objectContaining({ outcome: 'compiled', form: 'channel-bare' })])
    const delivered = fixture.world
      .allEffects()
      .filter((effect) => effect.status === 'delivered' && effect.channel === fixture!.room('plaza').channel)
    expect(delivered.some((effect) => effect.text.includes('deploy finished'))).toBe(true)
  })

  it("arm B: a parent-session wake's report-back append teaches the `post` parent form", async () => {
    const captured: CapturedSession[] = []
    let wakeResult: Awaited<ReturnType<typeof callDaemonTool>> | undefined
    fixture = await startArm('B', captured, async (context) => {
      if (context.agentAlias === 'runner' && wakeResult === undefined) {
        wakeResult = await context.callTool('post', {
          conversation: { kind: 'private' },
          address: [fixture!.agentId('peer')],
          visibility: 'session-only',
          expectReply: true,
          message: 'what is your status?'
        })
        context.reply('asked')
      }
    })
    const kick = fixture.injectHuman('briefing', `<@${fixture.botUserId('runner')}> hello`, {
      mentions: [fixture.botUserId('runner')]
    })
    await fixture.settle(kick.handles)
    expect(wakeResult?.ok, JSON.stringify(wakeResult)).toBe(true)
    const peer = captured.find((session) => session.agentAlias === 'peer')
    expect(peer, 'the postless wake created a peer session').toBeDefined()
    const prompt = peer!.prompts.join('\n')
    expect(prompt).toContain('# Reporting back to your parent session')
    expect(prompt).toContain('"kind":"parent"')
    expect(prompt).not.toContain('sendMessage')
    // And nothing about the EXCHANGE reached any channel: the runner's ordinary
    // turn reply in its own briefing thread is legitimate visible speech, but
    // the postless wake and its question must have no platform projection.
    const delivered = fixture.world.allEffects().filter((effect) => effect.status === 'delivered')
    expect(delivered.filter((effect) => effect.channel !== fixture!.room('briefing').channel)).toEqual([])
    expect(delivered.some((effect) => effect.text.includes('what is your status?'))).toBe(false)
  })
})

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-turn-output-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

const msg = (ts: string, body: string): NormalizedMessage => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text: body,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

function connect(daemon: Daemon, overrides: Record<string, unknown> = {}) {
  const agent = (daemon as any).agents.get('bot-a')
  agent.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  let post = 0
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn<(channel: string, text: string, thread?: string, options?: unknown) => Promise<string>>(
      async () => `reply-${++post}`
    ),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {}),
    ...overrides
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

describe('TurnOutputWorkflow', () => {
  it('offers a final-fence provider snapshot only where the Layer-1 thread-history port exists', async () => {
    // The gate is the read port (`getThreadReplies`), asked by name — not a
    // `pending.plan.platform !== 'slack'` test and not a `Partial<SlackConnection>`
    // cast that only looks like one. A connection without the port contributes
    // no provider snapshot and the fence falls back to daemon-observed rows.
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () =>
        ({
          start: vi.fn(async () => {}),
          newSession: vi.fn(async () => 'acp-1'),
          hasSession: vi.fn(() => true),
          prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
          cancel: vi.fn(async () => {}),
          stop: vi.fn(async () => {})
        }) as any
    })
    await daemon.start()
    const pending = {
      plan: {
        agentId: 'bot-a',
        integrationId: 'int-a',
        channel: 'C1',
        statusThread: 'T1',
        transcriptChannel: transcriptChannelKey('C1', undefined),
        platform: 'slack'
      }
    }

    connect(daemon)
    expect((daemon as any).finalThreadSnapshot(pending)).toBeUndefined()

    connect(daemon, { getThreadReplies: vi.fn(async () => []) })
    expect(typeof (daemon as any).finalThreadSnapshot(pending)).toBe('function')

    // Port presence, not platform identity: a NON-Slack pending whose connection
    // answers the port still gets a snapshot, and a Slack one that doesn't, doesn't.
    expect(typeof (daemon as any).finalThreadSnapshot({ plan: { ...pending.plan, platform: 'telegram' } })).toBe(
      'function'
    )
    connect(daemon)
    expect((daemon as any).finalThreadSnapshot({ plan: { ...pending.plan, platform: 'telegram' } })).toBeUndefined()

    // No connection at all is the same fail-closed answer.
    ;(daemon as any).connByIntegration.delete('int-a')
    expect((daemon as any).finalThreadSnapshot(pending)).toBeUndefined()

    await daemon.stop()
  })

  it('discards a stale candidate, regenerates in the same ACP session, and publishes only the replacement', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'stale candidate' }
          })
          await firstBlocked
        } else {
          onUpdate(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fresh replacement' }
          })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon)
    const queueMemoryPostTurn = vi.spyOn(daemon as any, 'queueMemoryPostTurn')

    const firstMessage = msg('100.1', 'original request')
    const first = (daemon as any).dispatch('bot-a', firstMessage, 'int-a')
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    expect(conn.postMessage).not.toHaveBeenCalled()

    const clarificationMessage = msg('100.2', 'important clarification')
    clarificationMessage.quoted = {
      messageId: '99.9',
      sender: 'U2',
      text: 'the deployment failed with ECONNRESET'
    }
    const clarification = (daemon as any).dispatch('bot-a', clarificationMessage, 'int-a')
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', firstMessage.transportScope)
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1))
    releaseFirst()

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
    await expect(first).resolves.toBe('acp-1')
    await expect(clarification).resolves.toBe('acp-1')

    expect(prompts[1]).toContain('AgentConnect context update')
    expect(prompts[1]).toContain('important clarification')
    expect(prompts[1]!.indexOf('the deployment failed with ECONNRESET')).toBeLessThan(
      prompts[1]!.indexOf('[U1] important clarification')
    )
    const publishedBodies = conn.postMessage.mock.calls.map((call) => String(call[1]))
    expect(publishedBodies).toContain('fresh replacement')
    expect(publishedBodies.join('\n')).not.toContain('stale candidate')
    const replies = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey('C1', firstMessage.transportScope), 'T1', null)
    )
      .filter((row: any) => row.sender === 'bot-a')
      .map((row: any) => row.text)
    expect(replies).toEqual(['fresh replacement'])
    expect((daemon as any).serialQueue.has(key)).toBe(false)
    expect(String(queueMemoryPostTurn.mock.calls[0]?.[3])).toContain('original request')
    expect(String(queueMemoryPostTurn.mock.calls[0]?.[3])).toContain('important clarification')

    await daemon.stop()
  })

  it('commits a staged segment at a tool boundary, as its own message, while the turn is still running', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releasePrompt!: () => void
    const blocked = new Promise<void>((resolve) => (releasePrompt = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
        onUpdate(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'sleep 5',
          status: 'in_progress'
        })
        await blocked // the boundary has arrived; the turn itself is far from over
        onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi again' } })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon)

    const turn = (daemon as any).dispatch('bot-a', msg('100.1', 'say hi twice'), 'int-a')
    // The first segment posts when the tool boundary arrives — mid-turn, not at commit.
    await vi.waitFor(() => {
      expect(conn.postMessage.mock.calls.map((call) => String(call[1]))).toContain('hi')
    }, WAIT)
    releasePrompt()
    await turn

    const bodies = conn.postMessage.mock.calls.map((call) => String(call[1]))
    expect(bodies.filter((body) => body === 'hi')).toHaveLength(1)
    expect(bodies).toContain('hi again') // the closing segment commits at the fence
    await daemon.stop()
  })

  it('keeps a committed segment through regeneration and replaces only the closing segment', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'committed lead' }
          })
          onUpdate(sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'check',
            status: 'in_progress'
          })
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale tail' } })
          await firstBlocked
        } else {
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh tail' } })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon)

    const firstMessage = msg('100.1', 'original request')
    const first = (daemon as any).dispatch('bot-a', firstMessage, 'int-a')
    await vi.waitFor(() => {
      expect(conn.postMessage.mock.calls.map((call) => String(call[1]))).toContain('committed lead')
    }, WAIT)

    const clarification = (daemon as any).dispatch('bot-a', msg('100.2', 'important clarification'), 'int-a')
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', firstMessage.transportScope)
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1))
    releaseFirst()

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
    await expect(first).resolves.toBe('acp-1')
    await expect(clarification).resolves.toBe('acp-1')

    // The replacement prompt admits the delivered prefix instead of claiming nothing landed.
    expect(prompts[1]).toContain('already delivered and stand')
    expect(prompts[1]).not.toContain('Your previous candidate answer was not delivered')
    const bodies = conn.postMessage.mock.calls.map((call) => String(call[1]))
    expect(bodies.filter((body) => body === 'committed lead')).toHaveLength(1) // stands, never re-posted
    expect(bodies).toContain('fresh tail')
    expect(bodies.join('\n')).not.toContain('stale tail') // only the closing segment was regenerable
    await daemon.stop()
  })

  it('coalesces a clarification represented in the first prompt before initiating it', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    // The session opens only once both clarifications are queued: the window this test is
    // about is the one BEFORE the first prompt is initiated.
    let openSession!: () => void
    const sessionReady = new Promise<void>((resolve) => (openSession = resolve))
    const host = {
      start: vi.fn(async () => {
        await sessionReady
      }),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'one combined answer' }
        })
        await blocked
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    connect(daemon)

    const firstMessage = msg('100.1', 'original request')
    const first = (daemon as any).dispatch('bot-a', firstMessage, 'int-a')
    const firstClarification = msg('100.2', 'first pre-prompt clarification')
    firstClarification.quoted = {
      messageId: '99.9',
      sender: 'U2',
      text: 'the deployment failed with ECONNRESET'
    }
    const secondClarification = msg('100.3', 'second pre-prompt clarification')
    secondClarification.quoted = {
      messageId: '99.8',
      sender: 'U3',
      text: 'the rollback is still running'
    }
    // The first turn is already initializing — its gate entry is what makes the thread live —
    // and its host is held open, so both clarifications land in the window this test is
    // about: queued and observed BEFORE the first prompt is initiated.
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledOnce(), WAIT)
    const clarification = (daemon as any).dispatch('bot-a', firstClarification, 'int-a')
    const second = (daemon as any).dispatch('bot-a', secondClarification, 'int-a')
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', firstMessage.transportScope)
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(2), WAIT)
    openSession()
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledOnce(), WAIT)
    expect(prompts[0]).toContain('original request')
    const firstQuote = prompts[0]!.indexOf('[U2] the deployment failed with ECONNRESET')
    const firstReply = prompts[0]!.indexOf('[U1] first pre-prompt clarification')
    const secondQuote = prompts[0]!.indexOf('[U3] the rollback is still running')
    const secondReply = prompts[0]!.indexOf('[U1] second pre-prompt clarification')
    expect(firstQuote).toBeGreaterThanOrEqual(0)
    expect(firstQuote).toBeLessThan(firstReply)
    expect(firstReply).toBeLessThan(secondQuote)
    expect(secondQuote).toBeLessThan(secondReply)
    expect((daemon as any).serialQueue.has(key)).toBe(false)
    await expect(clarification).resolves.toBe('acp-1')
    await expect(second).resolves.toBe('acp-1')

    release()
    await expect(first).resolves.toBe('acp-1')
    expect(host.prompt).toHaveBeenCalledOnce()
    expect(await (daemon as any).store.listInboxBySessionKeyFifo()).toEqual([])

    await daemon.stop()
  })

  it('starts the retry budget with replacement work and excludes explicit approval waits', async () => {
    const clock = new FakeClock()
    const context = {} as { daemon: Daemon; firstMessage: NormalizedMessage }
    let onUpdate!: (sessionId: string, update: unknown) => void
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        const generation = host.prompt.mock.calls.length
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: generation === 3 ? 'fresh replacement' : 'stale candidate' }
        })
        if (generation === 1) {
          clock.advance(120_001)
          const clarification = msg('100.2', 'late clarification')
          clarification.transportScope = context.firstMessage.transportScope
          clarification.quoted = { messageId: '99.9', sender: 'U2', text: 'peer-only quoted source' }
          await (context.daemon as any).recordObservedInbound(clarification, 'bot-a')
        } else if (generation === 2) {
          const approval = (context.daemon as any).permissions.onAcpPermission('bot-a', sessionId, {
            sessionId,
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ],
            toolCall: { toolCallId: 'tc-1', title: 'Bash' }
          })
          await vi.waitFor(() => expect((context.daemon as any).permissions.pendingEditorPermissions.size).toBe(1))
          const [requestId] = (context.daemon as any).permissions.pendingEditorPermissions.keys()
          clock.advance(120_001)
          await (context.daemon as any).permissions.decideEditorPermission({
            agentId: 'bot-a',
            requestId,
            decision: 'allow'
          })
          await approval
          const clarification = msg('100.3', 'clarification after approval')
          clarification.transportScope = context.firstMessage.transportScope
          await (context.daemon as any).recordObservedInbound(clarification, 'bot-a')
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      clock,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    context.daemon = daemon
    await daemon.start()
    const conn = connect(daemon)
    const firstMessage = msg('100.1', 'original request')
    context.firstMessage = firstMessage

    await expect((daemon as any).dispatch('bot-a', firstMessage, 'int-a')).resolves.toBe('acp-1')

    expect(host.prompt).toHaveBeenCalledTimes(3)
    expect(prompts[1]).toContain('peer-only quoted source')
    expect(prompts[1]!.indexOf('peer-only quoted source')).toBeLessThan(prompts[1]!.indexOf('[U1] late clarification'))
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'fresh replacement', 'T1', expect.anything())
    await daemon.stop()
  })

  it('restores an unrouted quoted observation as model context after daemon restart', async () => {
    const root = scaffold()
    let onFirstUpdate!: (sessionId: string, update: unknown) => void
    const firstHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onFirstUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'initial answer' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const firstDaemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onFirstUpdate = update
        return firstHost as any
      }
    })
    await firstDaemon.start()
    connect(firstDaemon)
    const firstMessage = msg('100.1', 'original request')
    await expect((firstDaemon as any).dispatch('bot-a', firstMessage, 'int-a')).resolves.toBe('acp-1')

    const unrouted = msg('100.2', 'apply this')
    unrouted.transportScope = firstMessage.transportScope
    unrouted.quoted = {
      messageId: '99.9',
      sender: 'U2',
      text: 'durable quote: keep the compatibility branch'
    }
    await (firstDaemon as any).recordObservedInbound(unrouted)
    const transcriptChannel = transcriptChannelKey('C1', firstMessage.transportScope)
    expect(
      (await (firstDaemon as any).store.transcriptSince(transcriptChannel, 'T1', '100.1')).find(
        (row: any) => row.ts === '100.2'
      )
    ).toMatchObject({ recipient: null, quoteJson: expect.stringContaining('durable quote') })
    await firstDaemon.stop()

    let onRestartedUpdate!: (sessionId: string, update: unknown) => void
    const prompts: string[] = []
    const restartedHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-2'),
      hasSession: vi.fn(() => false),
      loadSupported: vi.fn(() => true),
      loadSession: vi.fn(async () => {}),
      prompt: vi.fn(async (sessionId: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
        onRestartedUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'answer after restart' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const restarted = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: (_agent, update) => {
        onRestartedUpdate = update
        return restartedHost as any
      }
    })
    await restarted.start()
    connect(restarted)
    const next = msg('100.3', 'continue after restart')
    next.transportScope = firstMessage.transportScope
    await expect((restarted as any).dispatch('bot-a', next, 'int-a')).resolves.toBe('acp-1')

    expect(restartedHost.loadSession).toHaveBeenCalledWith(
      'acp-1',
      expect.any(String),
      expect.any(Array),
      undefined,
      undefined,
      []
    )
    expect(prompts).toHaveLength(1)
    const durableQuote = prompts[0]!.indexOf('[U2] durable quote: keep the compatibility branch')
    const unroutedReply = prompts[0]!.indexOf('[U1] apply this')
    expect(durableQuote).toBeGreaterThanOrEqual(0)
    expect(durableQuote).toBeLessThan(unroutedReply)
    await restarted.stop()
  })

  it('delivers context-churn exhaustion as non-recording chrome', async () => {
    const context = {} as { daemon: Daemon; firstMessage: NormalizedMessage }
    let onUpdate!: (sessionId: string, update: unknown) => void
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        const generation = host.prompt.mock.calls.length
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `discarded candidate ${generation}` }
        })
        const change = msg(`100.${generation + 1}`, `change ${generation}`)
        change.transportScope = context.firstMessage.transportScope
        ;(context.daemon as any).recordObservedInbound(change, 'bot-a')
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    context.daemon = daemon
    await daemon.start()
    const conn = connect(daemon)
    const firstMessage = msg('100.1', 'original request')
    context.firstMessage = firstMessage

    await expect((daemon as any).dispatch('bot-a', firstMessage, 'int-a')).resolves.toBeNull()

    expect(host.prompt).toHaveBeenCalledTimes(4)
    const churnNotice = conn.postMessage.mock.calls.find((call) =>
      String(call[1]).includes('conversation kept changing')
    )
    expect(churnNotice?.[3]).toMatchObject({ chrome: true })
    const replies = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey('C1', firstMessage.transportScope), 'T1', null)
    ).filter((row: any) => row.sender === 'bot-a')
    expect(replies).toEqual([])
    await daemon.stop()
  })

  it('does not commit a staged candidate when cancellation arrives during the final snapshot', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    let releaseSnapshot!: () => void
    let snapshotStarted!: () => void
    const snapshotBlocked = new Promise<void>((resolve) => (releaseSnapshot = resolve))
    const snapshotPending = new Promise<void>((resolve) => (snapshotStarted = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        onUpdate(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'must remain private' }
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as any
      }
    })
    await daemon.start()
    const conn = connect(daemon, {
      getThreadReplies: vi.fn(async () => {
        snapshotStarted()
        await snapshotBlocked
        return []
      })
    })

    const message = msg('100.1', 'original request')
    const turn = (daemon as any).dispatch('bot-a', message, 'int-a')
    await snapshotPending
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a', message.transportScope)
    ;(daemon as any).interruptTurn('bot-a', key, 'cancel', 'acp-1')
    releaseSnapshot()

    await expect(turn).resolves.toBeNull()
    expect(conn.postMessage).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('must remain private'))

    await daemon.stop()
  })
})

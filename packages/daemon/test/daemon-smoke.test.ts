import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'

function scaffold(displayName?: string, memoryProvider?: 'none' | 'managed', iconUrl?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      ...(displayName !== undefined ? { displayName } : {}),
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      status: 'active',
      runtime: 'claude',
      ...(memoryProvider ? { memory: { provider: memoryProvider } } : {}),
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('Daemon (no Slack, injected ACP host)', () => {
  it('refuses daemon startup when sandbox policy is required but the host has no mechanism', async () => {
    const root = scaffold()
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, security: { requireSandbox: true } })
    )

    await expect(new Daemon({ root, sandboxMechanism: null }).start()).rejects.toThrow(
      /daemon startup refused.*requireSandbox.*no bwrap\/sandbox-exec/
    )
  })

  it('boots and routes a synthetic message through to a prompt', async () => {
    const root = scaffold()
    const prompts: string[] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts.push(blocks.map((b) => b.text).join(''))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // directly exercise dispatch via the scheduler path
    await (daemon as any).dispatch('bot-a', {
      msgId: 'cron:x:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:1',
      sender: { id: 'cron:x', isBot: false },
      text: 'run report',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    expect(prompts.join('')).toContain('run report')
    await daemon.stop()
  }, 15_000)

  it('injects the memory MCP server even for a no-Slack agent (memory tools are universal)', async () => {
    const root = scaffold() // scaffolded agent has integrations: []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-mem-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:1',
      traceId: '1',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    })
    // newSession(cwd, mcpServers, …) — a no-Slack agent must still get the memory MCP
    // server (regression: previously mcpServersFor returned [] without an integration).
    const mcpServers = fakeHost.newSession.mock.calls[0]![1] as unknown[]
    expect(mcpServers.length).toBe(1)
    await daemon.stop()
  }, 15_000)

  it('does not inject the memory MCP server when persistent memory is disabled', async () => {
    const root = scaffold(undefined, 'none')
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-none-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:1',
      traceId: '1',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '1',
      sender: { id: 'U1', isBot: false },
      text: 'hi',
      mentionedBots: [],
      isDm: false
    })
    const mcpServers = fakeHost.newSession.mock.calls[0]![1] as Array<{
      env: Array<{ name: string; value: string }>
    }>
    const token = mcpServers[0]!.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
    const session = (daemon as any).mcp.sessions.get(token)
    expect(session.tools.map((tool: { name: string }) => tool.name)).not.toEqual(
      expect.arrayContaining(['listMemory', 'readMemory', 'writeMemory'])
    )
    await daemon.stop()
  }, 15_000)

  it('emits session metadata snapshots on create and turn completion', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-sess-1'),
      hasSession: (id: string) => id === 'acp-sess-1',
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // Inject a fake CP client so the fire-and-forget emit is observable (no real WS).
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    const mk = (ts: string, text: string) => ({
      msgId: `slack:C1:${ts}`,
      traceId: ts,
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      sender: { id: 'U1', isBot: false },
      text,
      mentionedBots: [],
      isDm: false
    })

    await (daemon as any).dispatch('bot-a', mk('100.1', 'first'))
    // Second turn on the SAME session must NOT re-emit start, but it still emits
    // a completion snapshot so CP metadata stays fresh.
    await (daemon as any).dispatch('bot-a', mk('100.2', 'second'))

    expect(emitEventSession).toHaveBeenCalledTimes(3)
    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'end', 'end'])
    const start = emitEventSession.mock.calls[0]![0]
    expect(start).toMatchObject({
      sessionId: 'acp-sess-1',
      agentId: 'bot-a',
      phase: 'start',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      title: 'first',
      status: 'prompting',
      triggeredBy: 'U1',
      // Execution-config snapshot: the agent's runtime + schema-defaulted
      // permission/output modes; no explicit model/effort/fast configured ⇒
      // those fields are omitted (runtime default), never fabricated.
      runtime: 'claude',
      permissionMode: 'default',
      outputMode: 'medium'
    })
    expect(start.model).toBeUndefined()
    expect(start.effort).toBeUndefined()
    expect(start.fastMode).toBeUndefined()
    expect(start.link).toContain('/sessions/acp-sess-1')
    expect(typeof start.lastActivityAt).toBe('string')
    expect(typeof start.ts).toBe('string')
    expect(start.launchId).toBeUndefined() // Slack/Discord path — no CP launch fence
    const final = emitEventSession.mock.calls[2]![0]
    expect(final).toMatchObject({ sessionId: 'acp-sess-1', phase: 'end', status: 'idle', title: 'first' })
    await daemon.stop()
  }, 15_000)

  it('re-emits session metadata when a runtime session title update arrives', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-1'),
      hasSession: (id: string) => id === 'acp-title-1',
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, { sessionUpdate: 'session_info_update', title: 'Runtime summary' })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const setTitle = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:200.1',
      traceId: 'title',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '200.1',
      sender: { id: 'U1', isBot: false },
      text: 'first fallback',
      mentionedBots: [],
      isDm: true
    })

    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'plan', 'end'])
    expect(emitEventSession.mock.calls[1]![0]).toMatchObject({
      sessionId: 'acp-title-1',
      phase: 'plan',
      title: 'Runtime summary',
      status: 'prompting'
    })
    expect(emitEventSession.mock.calls[2]![0]).toMatchObject({
      sessionId: 'acp-title-1',
      phase: 'end',
      title: 'Runtime summary',
      status: 'idle'
    })
    expect(setTitle).toHaveBeenCalledWith('C1', '200.1', 'Runtime summary')
    await daemon.stop()
  }, 15_000)

  it('drops a runtime title that echoes the inlined standing context', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-echo'),
      hasSession: (id: string) => id === 'acp-title-echo',
      prompt: vi.fn(async (sid: string) => {
        // codex-acp >= 1.1.3 auto-titles an untitled session from the raw first
        // prompt — ALL text blocks joined, so it starts with the inlined standing
        // context. The daemon must not persist or fan out that echo (issue #659).
        onUpdate(sid, {
          sessionUpdate: 'session_info_update',
          title: '# Agent - Name: bot-a - ID: bot-a - Source: slack - Channel: C1 first fallback'
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const setTitle = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:201.1',
      traceId: 'title-echo',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '201.1',
      sender: { id: 'U1', isBot: false },
      text: 'first fallback',
      mentionedBots: [],
      isDm: true
    })

    // No 'plan' metadata re-emit: the echo never reaches persistSessionTitle.
    expect(emitEventSession.mock.calls.map(([payload]) => payload.phase)).toEqual(['start', 'end'])
    // The session keeps its first-message fallback title instead of the echo.
    expect(emitEventSession.mock.calls[1]![0]).toMatchObject({
      sessionId: 'acp-title-echo',
      phase: 'end',
      title: 'first fallback',
      status: 'idle'
    })
    expect(setTitle).not.toHaveBeenCalled()
    await daemon.stop()
  }, 15_000)

  it('fans out a model-authored title to the UI and Slack during the turn', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        // Some adapters publish metadata before replying to session/new, before
        // SessionManager can commit the local row.
        onUpdate('acp-tool-title', { sessionUpdate: 'session_info_update', title: 'Early runtime title' })
        return 'acp-tool-title'
      }),
      hasSession: (id: string) => id === 'acp-tool-title',
      prompt: vi.fn(async () => {
        await (daemon as any).setSessionTitleFromTool({
          agentId: 'bot-a',
          platform: 'slack',
          // Simulate a session-static MCP token created before the integration
          // rotated from A to the current dispatch route B.
          integrationId: 'int-a',
          isDm: true,
          channel: 'D1',
          thread: '205.1',
          title: 'Fix session titles'
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const staleSetTitle = vi.fn(async () => {})
    const setTitle = vi.fn(async () => {})
    ;(daemon as any).connByIntegration.set('int-a', {
      setStatus: vi.fn(async () => {}),
      setTitle: staleSetTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    ;(daemon as any).connByIntegration.set('int-b', {
      setStatus: vi.fn(async () => {}),
      setTitle,
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: 'slack:D1:205.1',
        traceId: 'tool-title',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '205.1',
        sender: { id: 'U1', isBot: false },
        text: 'fix session titles',
        mentionedBots: [],
        isDm: true
      },
      'int-b'
    )

    expect(setTitle.mock.calls).toEqual([
      ['D1', '205.1', 'Early runtime title'],
      ['D1', '205.1', 'Fix session titles']
    ])
    expect(staleSetTitle).not.toHaveBeenCalled()
    expect((daemon as any).store.getSessionByAcpId('acp-tool-title')?.title).toBe('Fix session titles')
    expect(
      emitEventSession.mock.calls.some(([event]) => event.phase === 'plan' && event.title === 'Fix session titles')
    ).toBe(true)
    expect(emitEventSession.mock.calls.map(([event]) => event.phase).slice(0, 3)).toEqual(['start', 'plan', 'plan'])
    await daemon.stop()
  }, 15_000)

  it('applies a late runtime title to the UI and the exact Slack DM integration', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-title-late'),
      hasSession: (id: string) => id === 'acp-title-late',
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(),
      stop: vi.fn(async () => {
        onUpdate('acp-title-late', { sessionUpdate: 'session_info_update', title: 'Fix session titles' })
      })
    }
    const daemon = new Daemon({
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()

    const makeConn = () => ({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async () => undefined),
      postContext: vi.fn(async () => {})
    })
    const connA = makeConn()
    const connB = makeConn()
    ;(daemon as any).connByIntegration.set('int-a', connA)
    ;(daemon as any).connByIntegration.set('int-b', connB)
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch(
      'bot-a',
      {
        msgId: 'slack:D1:210.1',
        traceId: 'title-late',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '210.1',
        sender: { id: 'U1', isBot: false },
        text: 'fix session titles',
        mentionedBots: [],
        isDm: true
      },
      'int-b'
    )

    // The turn has completed and `pending` is gone. A later adapter/user rename
    // flushed while the host stops must still converge the durable title, CP
    // projection, and original Slack bot before its delivery binding is released.
    expect((daemon as any).pending.size).toBe(0)
    ;(daemon as any).onAcpUpdate('another-agent', 'acp-title-late', {
      sessionUpdate: 'session_info_update',
      title: 'Wrong agent title'
    })
    expect((daemon as any).store.getSessionByAcpId('acp-title-late')?.title).toBeNull()
    await (daemon as any).stopHost('bot-a')

    await vi.waitFor(() => expect(connB.setTitle).toHaveBeenCalledWith('D1', '210.1', 'Fix session titles'))
    expect(connA.setTitle).not.toHaveBeenCalled()
    expect((daemon as any).store.getSessionByAcpId('acp-title-late')?.title).toBe('Fix session titles')
    expect(emitEventSession.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'acp-title-late',
      phase: 'plan',
      title: 'Fix session titles'
    })
    expect((daemon as any).sessionDeliveryBindings.size).toBe(0)
    await daemon.stop()
  }, 15_000)

  it('keeps same-id ACP turns isolated by agent', async () => {
    const root = scaffold()
    const agentDir = join(root, 'agents', 'bot-b')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'bot-b',
        name: 'bot-b',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )

    const releases = new Map<string, () => void>()
    const updates = new Map<string, (sessionId: string, update: unknown) => void>()
    const daemon = new Daemon({
      root,
      hostFactory: (agent, onUpdate) => {
        updates.set(agent.id, onUpdate)
        let release!: () => void
        const blocked = new Promise<void>((resolve) => (release = resolve))
        releases.set(agent.id, release)
        return {
          __started: true,
          start: vi.fn(async () => {}),
          newSession: vi.fn(async () => 'shared-acp-id'),
          hasSession: () => true,
          prompt: vi.fn(async () => {
            await blocked
            return { stopReason: 'end_turn' }
          }),
          cancel: vi.fn(),
          stop: vi.fn()
        } as any
      }
    })
    await daemon.start()

    const message = (agentId: string) => ({
      msgId: `slack:${agentId}:1.1`,
      traceId: agentId,
      source: 'user',
      platform: 'slack',
      channel: agentId,
      thread: '1.1',
      sender: { id: 'U1', isBot: false },
      text: `work for ${agentId}`,
      mentionedBots: [],
      isDm: false
    })
    const a = (daemon as any).dispatch('bot-a', message('bot-a'))
    const b = (daemon as any).dispatch('bot-b', message('bot-b'))
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(2))

    updates.get('bot-a')?.('shared-acp-id', { sessionUpdate: 'session_info_update', title: 'Agent A title' })
    updates.get('bot-b')?.('shared-acp-id', { sessionUpdate: 'session_info_update', title: 'Agent B title' })
    expect((daemon as any).store.getSessionByAcpIdForAgent('bot-a', 'shared-acp-id')?.title).toBe('Agent A title')
    expect((daemon as any).store.getSessionByAcpIdForAgent('bot-b', 'shared-acp-id')?.title).toBe('Agent B title')

    releases.get('bot-a')?.()
    releases.get('bot-b')?.()
    await expect(Promise.all([a, b])).resolves.toEqual(['shared-acp-id', 'shared-acp-id'])
    expect((daemon as any).pending.size).toBe(0)
    await daemon.stop()
  }, 15_000)

  it.each([
    { scenario: 'a non-DM thread', title: 'Channel summary', isDm: false },
    { scenario: 'a blank DM title', title: '   ', isDm: true },
    { scenario: 'a cleared DM title', title: null, isDm: true }
  ])(
    'does not set a native Slack title for $scenario',
    async ({ title, isDm }) => {
      const root = scaffold()
      let onUpdate!: (sid: string, update: unknown) => void
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-title-skip'),
        hasSession: (id: string) => id === 'acp-title-skip',
        prompt: vi.fn(async (sid: string) => {
          onUpdate(sid, { sessionUpdate: 'session_info_update', title })
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({
        root,
        hostFactory: (_agent, update) => {
          onUpdate = update
          return fakeHost as any
        }
      })
      await daemon.start()
      const setTitle = vi.fn(async () => {})
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus: vi.fn(async () => {}),
        setTitle,
        postMessage: vi.fn(async () => undefined),
        postContext: vi.fn(async () => {})
      })

      await (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:201.1',
        traceId: 'title-skip',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        thread: '201.1',
        sender: { id: 'U1', isBot: false },
        text: 'first fallback',
        mentionedBots: [],
        isDm
      })

      expect(setTitle).not.toHaveBeenCalled()
      await daemon.stop()
    },
    15_000
  )

  it.each([
    { conversation: 'channel', channel: 'C1', isDm: false },
    { conversation: 'DM', channel: 'D1', isDm: true }
  ])(
    'uses the display name for $conversation authorship and the stable bot name in its footer',
    async ({ channel, isDm }) => {
      const root = scaffold('  Release Captain  ', undefined, 'https://console.example.test/icons/bot-a')
      let onUpdate!: (sid: string, update: unknown) => void
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-channel-username'),
        hasSession: (id: string) => id === 'acp-channel-username',
        prompt: vi.fn(async (sid: string) => {
          onUpdate(sid, { sessionUpdate: 'session_info_update', title: 'Unrelated session title' })
          onUpdate(sid, {
            sessionUpdate: 'tool_call',
            toolCallId: 'search-1',
            title: 'Searching…',
            status: 'in_progress'
          })
          onUpdate(sid, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'channel answer' }
          })
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({
        root,
        hostFactory: (_agent, update) => {
          onUpdate = update
          return fakeHost as any
        }
      })
      await daemon.start()
      const postMessage = vi.fn(
        async (_channel: string, _text: string, _thread?: string, _options?: unknown) => 'reply-ts'
      )
      const setStatus = vi.fn(async () => {})
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus,
        setTitle: vi.fn(async () => {}),
        postMessage,
        updateMessage: vi.fn(async () => {}),
        postBlocks: vi.fn(async () => 'status-ts'),
        updateBlocks: vi.fn(async () => {}),
        postContext: vi.fn(async () => {})
      })

      await (daemon as any).dispatch('bot-a', {
        msgId: `slack:${channel}:202.1`,
        traceId: 'channel-username',
        source: 'user',
        platform: 'slack',
        channel,
        thread: '202.1',
        sender: { id: 'U1', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm
      })

      const answerCall = postMessage.mock.calls.find(([, text]) => String(text).includes('channel answer'))
      expect(answerCall?.[3]).toMatchObject({
        username: 'Release Captain',
        icon_url: 'https://console.example.test/icons/bot-a',
        trailingBlocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: expect.stringContaining('|bot-a>') }]
          }
        ]
      })
      const expectedStatusIdentity = {
        username: 'Release Captain',
        icon_url: 'https://console.example.test/icons/bot-a'
      }
      expect(setStatus).toHaveBeenCalledWith(channel, '202.1', 'is thinking…', undefined, expectedStatusIdentity)
      expect(setStatus).toHaveBeenCalledWith(channel, '202.1', 'Searching…', ['Searching…'], expectedStatusIdentity)
      await daemon.stop()
    },
    15_000
  )

  it.each([
    { scenario: 'a trimmed display name', displayName: '  Release Captain  ', expectedUsername: 'Release Captain' },
    { scenario: 'the agent name fallback', displayName: '   ', expectedUsername: 'bot-a' }
  ])(
    'labels a pre-session channel failure with $scenario',
    async ({ displayName, expectedUsername }) => {
      const root = scaffold(displayName)
      const fakeHost = {
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => {
          throw new Error('session init failed')
        }),
        cancel: vi.fn(),
        stop: vi.fn()
      }
      const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
      await daemon.start()
      const postMessage = vi.fn(async () => 'failure-ts')
      vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
        setStatus: vi.fn(async () => {}),
        postMessage
      })

      await expect(
        (daemon as any).dispatch('bot-a', {
          msgId: 'slack:C1:202.2',
          traceId: 'channel-username-failure',
          source: 'user',
          platform: 'slack',
          channel: 'C1',
          thread: '202.2',
          sender: { id: 'U1', isBot: false },
          text: 'hello',
          mentionedBots: [],
          isDm: false
        })
      ).rejects.toThrow('session init failed')

      expect(postMessage).toHaveBeenCalledWith('C1', '⚠️ Agent failed to respond: session init failed', '202.2', {
        username: expectedUsername,
        chrome: true
      })
      await daemon.stop()
    },
    15_000
  )

  it('re-emits session metadata when display names are resolved after the turn', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-name-1'),
      hasSession: (id: string) => id === 'acp-name-1',
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const emitEventSession = vi.fn()
    ;(daemon as any).cpClient = { emitEventSession, emitUsageReport: vi.fn(), stop: vi.fn() }

    await (daemon as any).dispatch('bot-a', {
      msgId: 'slack:C1:300.1',
      traceId: 'names',
      source: 'user',
      platform: 'slack',
      channel: 'C1',
      thread: '300.1',
      sender: { id: 'U1', isBot: false },
      text: 'need names',
      mentionedBots: [],
      isDm: false
    })

    ;(daemon as any).store.setDisplayName('C1', 'deploys', Date.now())
    ;(daemon as any).store.setDisplayName('U1', 'Dana Reyes', Date.now())
    ;(daemon as any).emitSessionMetadataSnapshotsForDisplayName('C1')

    const refresh = emitEventSession.mock.calls.at(-1)![0]
    expect(refresh).toMatchObject({
      sessionId: 'acp-name-1',
      phase: 'plan',
      title: 'need names',
      status: 'idle',
      channelName: 'deploys',
      triggeredBy: 'U1',
      triggeredByName: 'Dana Reyes'
    })
    await daemon.stop()
  }, 15_000)

  it('pending map is cleaned up when host.prompt throws', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-err-1'),
      prompt: vi.fn(async () => {
        throw new Error('prompt exploded')
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const msg = {
      msgId: 'cron:x:2',
      traceId: '2',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:2',
      sender: { id: 'cron:x', isBot: false },
      text: 'fail',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    }
    await expect((daemon as any).dispatch('bot-a', msg)).rejects.toThrow('prompt exploded')
    expect((daemon as any).pending.size).toBe(0)
    await daemon.stop()
  }, 15_000)

  // codex-acp signals quota exhaustion by streaming the human-readable message as an
  // agent_message_chunk and then rejecting session/prompt with a bare "Internal error"
  // whose data carries the real text. The daemon must deliver that text exactly once —
  // as the flushed reply, recorded into the transcript — not a "⚠️ … Internal error".
  const USAGE_LIMIT_MSG =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:01 PM."
  const usageLimitError = () =>
    Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { message: USAGE_LIMIT_MSG, codexErrorInfo: 'usageLimitExceeded' }
    })

  it('flushes a runtime-streamed terminal error as the reply, with no duplicate ⚠️ notice', async () => {
    const root = scaffold()
    let onUpdate!: (sid: string, update: unknown) => void
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-quota-1'),
      hasSession: (id: string) => id === 'acp-quota-1',
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${USAGE_LIMIT_MSG}\n\n` }
        })
        throw usageLimitError()
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      root,
      hostFactory: (_agent, update) => {
        onUpdate = update
        return fakeHost as any
      }
    })
    await daemon.start()
    const posts: string[] = []
    const setStatus = vi.fn(async () => {})
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus,
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async (_c: string, text: string) => {
        posts.push(text)
        return undefined
      }),
      postContext: vi.fn(async () => {})
    })

    await expect(
      (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:400.1',
        traceId: 'quota',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        thread: '400.1',
        sender: { id: 'U1', isBot: false },
        text: 'summarize the day',
        mentionedBots: [],
        isDm: false
      })
    ).rejects.toThrow('Internal error')

    // The streamed message posted exactly once, verbatim — and no ⚠️ notice on top.
    expect(posts.filter((t) => t.includes("You've hit your usage limit"))).toHaveLength(1)
    expect(posts.some((t) => t.includes('⚠️'))).toBe(false)
    expect(setStatus).toHaveBeenCalledWith('C1', '400.1', '') // "is thinking…" cleared
    // …and it landed in the transcript, so the console session view shows it.
    const { rows } = (daemon as any).store.transcriptPage('C1', '400.1', null, 10)
    const agentRows = rows.filter((r: any) => r.sender === 'bot-a' && r.kind === 'text')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0]!.text).toContain("You've hit your usage limit")
    await daemon.stop()
  }, 15_000)

  it('surfaces the detailed data.message (not "Internal error") when nothing was streamed', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-quota-2'),
      prompt: vi.fn(async () => {
        throw usageLimitError()
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const posts: string[] = []
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      postMessage: vi.fn(async (_c: string, text: string) => {
        posts.push(text)
        return undefined
      }),
      postContext: vi.fn(async () => {})
    })

    await expect(
      (daemon as any).dispatch('bot-a', {
        msgId: 'slack:C1:401.1',
        traceId: 'quota-bare',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        thread: '401.1',
        sender: { id: 'U1', isBot: false },
        text: 'summarize the day',
        mentionedBots: [],
        isDm: false
      })
    ).rejects.toThrow('Internal error')

    expect(posts).toHaveLength(1)
    expect(posts[0]).toBe(`⚠️ Agent failed to respond: ${USAGE_LIMIT_MSG}`)
    const { rows } = (daemon as any).store.transcriptPage('C1', '401.1', null, 10)
    const agentRows = rows.filter((r: any) => r.sender === 'bot-a' && r.kind === 'text')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0]!.text).toBe(`⚠️ Agent failed to respond: ${USAGE_LIMIT_MSG}`)
    await daemon.stop()
  }, 15_000)

  it('C1 regression: single onInbound call dispatches exactly once (no double-dispatch)', async () => {
    const root = scaffold()
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-c1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    const dispatchSpy = vi.spyOn(daemon as any, 'dispatch')
    const msg = {
      msgId: 'm1',
      traceId: 't1',
      source: 'slack' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: 'T1',
      sender: { id: 'U1', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: false,
      trigger: 'mention' as const
    }
    ;(daemon as any).onInbound(msg)
    // merged rule set is empty (bot-a has no Slack integrations) → routeRules() returns null → 0 dispatches.
    // With the old bug, the message would have been dispatched once per integration in the group.
    // The key invariant: onInbound calls dispatch AT MOST ONCE per physical message event.
    expect(dispatchSpy.mock.calls.length).toBeLessThanOrEqual(1)
    await daemon.stop()
  }, 15_000)

  it('preserves an explicit self-mention route as trusted prompt context', async () => {
    const root = scaffold()
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-mention'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    vi.spyOn(daemon as any, 'mergedRules').mockReturnValue([
      {
        agentId: 'bot-a',
        integrationId: 'slack-int',
        botUserId: 'U1234567890',
        platform: 'slack',
        scope: { channel: 'C1' },
        match: { kind: 'mention' },
        source: 'config'
      }
    ])
    const dispatchSpy = vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp-mention')
    const inbound = {
      msgId: 'slack:C1:500.1',
      traceId: 'self-mention',
      source: 'user' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: '500.1',
      sender: { id: 'U0987654321', isBot: false },
      text: '<@U1234567890> hello',
      mentionedBots: ['U1234567890'],
      isDm: false
    }

    ;(daemon as any).onInbound(inbound)

    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(dispatchSpy.mock.calls[0]![0]).toBe('bot-a')
    expect(dispatchSpy.mock.calls[0]![1]).toEqual(expect.objectContaining({ trigger: 'mention', text: inbound.text }))
    expect(dispatchSpy.mock.calls[0]![2]).toBe('slack-int')
    await daemon.stop()
  }, 15_000)

  it('stop() releases all resources even if one throws, and rejects with AggregateError', async () => {
    const root = scaffold()
    const stopSpy = vi.fn(async () => {
      throw new Error('host stop failed')
    })
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-2'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: stopSpy
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()
    // trigger host creation so it ends up in hosts map
    await (daemon as any).dispatch('bot-a', {
      msgId: 'cron:x:3',
      traceId: '3',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:x:3',
      sender: { id: 'cron:x', isBot: false },
      text: 'hello',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    // spy on store.close to confirm it still runs despite the host throwing
    const storeSpy = vi.spyOn((daemon as any).store, 'close')
    const err = await daemon.stop().catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect(stopSpy).toHaveBeenCalled()
    expect(storeSpy).toHaveBeenCalled()
  }, 15_000)

  it('single-agent mode: --agent loads exactly that agent (zero-config) and dispatches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-single-')) // no config.json on purpose
    const agentsDir = join(root, 'agents')
    const adir = join(agentsDir, 'solo')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'solo',
        name: 'solo',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const prompts: string[] = []
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-solo'),
      prompt: vi.fn(async (_sid: string, blocks: any[]) => {
        prompts.push(blocks.map((b) => b.text).join(''))
        return 'end_turn'
      }),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, agentName: 'solo', overrides: { agentsDir }, hostFactory: () => fakeHost as any })
    await daemon.start()
    expect((daemon as any).agents.size).toBe(1)
    expect((daemon as any).agents.has('solo')).toBe(true)
    await (daemon as any).dispatch('solo', {
      msgId: 'cron:s:1',
      traceId: '1',
      source: 'cron',
      platform: 'slack',
      channel: 'C1',
      thread: 'cron:s:1',
      sender: { id: 'cron:s', isBot: false },
      text: 'go',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron'
    })
    expect(prompts.join('')).toContain('go')
    await daemon.stop()
  }, 15_000)

  it('low mode: cold agent gets "is starting up…" then "is thinking…"; warm agent goes straight to "is thinking…"', async () => {
    const root = scaffold()
    const fakeHost = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-status'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root, hostFactory: () => fakeHost as any })
    await daemon.start()

    const statuses: string[] = []
    const fakeConn = {
      setStatus: vi.fn(async (_c: string, _t: string, status: string) => {
        statuses.push(status)
      }),
      postMessage: vi.fn(async () => {})
    }
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue(fakeConn)

    const mk = (id: string) => ({
      msgId: `cron:s:${id}`,
      traceId: id,
      source: 'cron' as const,
      platform: 'slack' as const,
      channel: 'C1',
      thread: `cron:s:${id}`,
      sender: { id: 'cron:s', isBot: false },
      text: 'go',
      mentionedBots: [],
      isDm: false,
      trigger: 'cron' as const
    })

    // cold: host not yet started → "is starting up…" then "is thinking…"
    await (daemon as any).dispatch('bot-a', mk('1'))
    expect(statuses.slice(0, 2)).toEqual(['is starting up…', 'is thinking…'])

    // warm: host already started → first status is "is thinking…", never "is starting up…"
    statuses.length = 0
    await (daemon as any).dispatch('bot-a', mk('2'))
    expect(statuses[0]).toBe('is thinking…')
    expect(statuses).not.toContain('is starting up…')

    await daemon.stop()
  }, 15_000)

  it('single-agent mode runs an inactive agent when selected by --agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-single-'))
    const agentsDir = join(root, 'agents')
    const adir = join(agentsDir, 'paused-bot')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'paused-bot',
        name: 'paused-bot',
        status: 'inactive',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const daemon = new Daemon({
      root,
      agentName: 'paused-bot',
      overrides: { agentsDir },
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })
    await daemon.start()
    expect((daemon as any).agents.has('paused-bot')).toBe(true)
    await daemon.stop()
  }, 15_000)
})

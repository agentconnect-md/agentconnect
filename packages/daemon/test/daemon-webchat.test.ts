import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import type { WebchatOutput, WebchatDone, RdChatEvent, RdMsgWebchat } from '@agentconnect.md/protocol'

// A webchat conversation/agent target. agentId is a real UUID because the protocol
// WebchatMessage.agentId is uuid-validated at the wire; here it is the on-disk agent id.
const AGENT_ID = 'bot-a'
const CONV = '88888888-8888-4888-8888-888888888888'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner draining
// N queued turns through the serial gate (the 11-turn poll flaked at ~7/11). Every
// test here already allows 15s, so give the polls a uniform, generous budget.
const WAIT = { timeout: 10_000 }

function scaffold(limits?: Record<string, number>, agentExtra?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: {
        claude: { command: 'node', args: ['unused'] },
        'test-runtime': { command: 'node', args: ['codex-acp'] }
      },
      ...(limits ? { limits } : {})
    })
  )
  writeAgent(root, agentExtra)
  return root
}

function writeAgent(root: string, agentExtra?: Record<string, unknown>): void {
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' },
      ...agentExtra
    })
  )
}

/** A fake host replaying a scripted list of session/update events during prompt.
 *  `opts.model` makes the host advertise a model selector (drives the status bar);
 *  `opts.usage` is returned from prompt() with adapter-owned fold semantics. */
function streamingHost(
  updates: unknown[],
  opts: {
    stopReason?: string
    model?: string
    models?: string[]
    usage?: Record<string, number>
    initialUpdates?: unknown[]
  } = {}
) {
  const { stopReason = 'end_turn', model, models, usage, initialUpdates = [] } = opts
  let onUpdate!: (sid: string, u: unknown) => void
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, _mcpServers: unknown[], _effortOverride?: string) => {
      for (const update of initialUpdates) onUpdate('acp-wc-1', update)
      return 'acp-wc-1'
    }),
    modelOptions: vi.fn(() => (model ? { current: model, models: models ?? [model] } : null)),
    hasSession: vi.fn(() => true),
    setSessionModel: vi.fn(async () => true),
    setSessionEffort: vi.fn(async () => true),
    setSessionPermissionMode: vi.fn(async () => true),
    setSessionFastMode: vi.fn(async () => true),
    prompt: vi.fn(async (sid: string, _blocks: unknown[]) => {
      for (const u of updates) onUpdate(sid, u)
      return { stopReason, ...(usage ? { usage } : {}) }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  const factory = (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
    onUpdate = cb
    return host as any
  }
  return { factory, host }
}

const usageUpdate = (used: number, size: number, cost?: { amount: number; currency: string }) => ({
  sessionUpdate: 'usage_update',
  used,
  size,
  ...(cost ? { cost } : {})
})

/** Capture the webchat reply the daemon streams through the transport-neutral sink. */
function fakeCpClient() {
  const outputs: WebchatOutput[] = []
  const dones: WebchatDone[] = []
  const usageReports: unknown[] = []
  return {
    outputs,
    dones,
    usageReports,
    emitUsageReport: vi.fn<(report: unknown) => void>((report: unknown) => usageReports.push(report)),
    emitSessionActivity: vi.fn(),
    // An ordinary org-scoped daemon: it owns its agents outright and is not duty-governed.
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {}),
    // The transport-neutral reply sink a dispatch()/handleRelayMsg call threads in (the
    // turn engine writes here instead of a hardcoded client; captures the same arrays).
    sink: { output: (o: WebchatOutput) => outputs.push(o), done: (d: WebchatDone) => dones.push(d) }
  }
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
const thought = (t: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } })
const toolCall = (toolCallId: string, title: string, status = 'pending') => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title,
  status
})
const toolUpdate = (toolCallId: string, status: string) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId,
  status
})
const sessionTitleToolCall = (toolCallId: string, status = 'in_progress') => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  kind: 'execute',
  title: 'mcp.agentconnect.setSessionTitle',
  status,
  rawInput: {
    server: 'agentconnect',
    tool: 'setSessionTitle',
    arguments: { title: 'Fix session title visibility' }
  },
  _meta: { is_mcp_tool_call: true }
})
const sessionInfo = (title: string | null) => ({ sessionUpdate: 'session_info_update', title })

/** The slice of `K8sRuntimePlane` a webchat turn touches, with the one fact under test:
 *  whether this agent already has an attached shim session (i.e. its pod is up). */
function fakeK8sPlane(bound: boolean) {
  return {
    runsInSandbox: () => bound,
    withSandbox: (_id: string, work: () => Promise<unknown>) => work(),
    ensureChannel: async () => {},
    workspaceRootFor: () => undefined,
    gitRunnerFor: () => undefined,
    workspaceFsFor: () => undefined,
    memoryFsFor: () => new LocalMemoryFs(mkdtempSync(join(tmpdir(), 'ac-wc-mem-'))),
    autoMergeFor: () => undefined,
    releaseAgent: () => {},
    launchedAgents: () => [],
    stop: async () => {}
  }
}

describe('Daemon webchat: SessionUpdate → webchat/output mapping', () => {
  it('maps message/thinking/tool chunks to webchat events with a monotonic index, then done', async () => {
    const { factory } = streamingHost([
      thought('let me think'),
      toolCall('t1', 'Read file.ts', 'pending'),
      toolUpdate('t1', 'completed'),
      text('here is the answer')
    ])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    const msg = {
      msgId: `webchat:${CONV}:${turnId}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    // Every chunk carries the conversation + turn and a per-turn monotonic index.
    expect(cp.outputs.every((o) => o.conversationId === CONV && o.turnId === turnId)).toBe(true)
    expect(cp.outputs.map((o) => o.index)).toEqual([0, 1, 2, 3, 4])
    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'thinking', text: 'let me think' },
      { kind: 'tool_call', toolCallId: 't1', title: 'Read file.ts', status: 'pending' },
      { kind: 'tool_update', toolCallId: 't1', status: 'completed' },
      { kind: 'message', text: 'here is the answer' }
    ])

    // The turn closes with exactly one webchat/done carrying the stop reason.
    expect(cp.dones).toEqual([{ conversationId: CONV, turnId, stopReason: 'end_turn' }])
    await daemon.stop()
  })

  it('streams a sandbox-bootstrap notice ahead of the reply when the pod is not up yet', async () => {
    const { factory } = streamingHost([text('here is the answer')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    // The one plane fact the turn reads: no attached shim session ⇒ this turn brings a pod up.
    ;(daemon as any).k8sPlane = fakeK8sPlane(false)
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '55555555-5555-4555-8555-555555555555'
    const msg = {
      msgId: `webchat:${CONV}:${turnId}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    // The notice leads the stream, and the reply's indices continue from it rather than
    // restarting at 0 — a duplicate index is silently dropped by the browser's cursor.
    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'notice', text: '\u23f3 Allocating a sandbox pod\u2026' },
      { kind: 'message', text: 'here is the answer' }
    ])
    expect(cp.outputs.map((o) => o.index)).toEqual([...cp.outputs.keys()])
    await daemon.stop()
  })

  it('leaves the webchat stream alone when the agent already has a bound sandbox', async () => {
    const { factory } = streamingHost([text('here is the answer')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).k8sPlane = fakeK8sPlane(true)
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '44444444-4444-4444-8444-444444444444'
    const msg = {
      msgId: `webchat:${CONV}:${turnId}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    expect(cp.outputs.some((o) => o.event?.kind === 'notice')).toBe(false)
    await daemon.stop()
  })

  it('output mode is IM-only: `none` never suppresses the webchat reply stream', async () => {
    // `none` silences IM integrations (Slack/Telegram/…), NOT webchat: the playground
    // reply streams through the sink via emitWebchatUpdate, which bypasses the output-mode
    // converger entirely. An agent whose default output mode is `none` must still stream
    // its full reply + close cleanly over the webchat sink.
    const { factory } = streamingHost([
      thought('thinking'),
      toolCall('t1', 'Read file.ts', 'pending'),
      text('here is the answer')
    ])
    const daemon = new Daemon({
      root: scaffold(undefined, { output: { mode: 'none' } }),
      hostFactory: factory
    })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '66666666-6666-4666-8666-666666666666'
    const msgId = `webchat:${CONV}`
    const msg = {
      msgId,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    // The reply + interstitial events stream regardless of `none` …
    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'thinking', text: 'thinking' },
      { kind: 'tool_call', toolCallId: 't1', title: 'Read file.ts', status: 'pending' },
      { kind: 'message', text: 'here is the answer' }
    ])
    expect(cp.dones).toEqual([{ conversationId: CONV, turnId, stopReason: 'end_turn' }])
    // … and the transcript still holds the reply.
    const rows = (await (daemon as any).store.threadTranscript(CONV, msgId)) as {
      sender: string
      kind: string
      text: string
    }[]
    expect(rows.filter((r) => r.sender === AGENT_ID && r.kind === 'text').map((r) => r.text)).toContain(
      'here is the answer'
    )
    await daemon.stop()
  })

  it("streams the runtime's session title as a session_info event and persists it", async () => {
    // Regression: the live playground session kept its static "Playground · <agent>"
    // label because the runtime's auto-generated title (ACP session_info_update) was
    // dropped from the webchat stream — only the persisted list row ever saw it. A
    // null/whitespace title is a clear/no-op and must NOT be streamed (the client
    // keeps its fallback label); the real title both streams AND persists.
    const { factory } = streamingHost([
      sessionInfo(null),
      sessionInfo('   '),
      sessionInfo('Roll back the deploy'),
      text('done')
    ])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    const msg = {
      msgId: `webchat:${CONV}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    // Only the non-empty title reaches the live client; the reply follows.
    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'session_info', title: 'Roll back the deploy' },
      { kind: 'message', text: 'done' }
    ])
    // …and the persisted list row (the record) carries the same title (latest wins).
    const list = (await (daemon as any).store.listSessions(AGENT_ID)) as { title: string | null }[]
    expect(list[0]?.title).toBe('Roll back the deploy')
    await daemon.stop()
  })

  it('streams a session title emitted during session initialization', async () => {
    const { factory } = streamingHost([text('done')], {
      initialUpdates: [sessionInfo('Inspect startup state')]
    })
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()

    const turnId = '77777777-7777-4777-8777-777777777777'
    await (daemon as any).dispatch(
      AGENT_ID,
      {
        msgId: `webchat:${CONV}`,
        traceId: turnId,
        source: 'user' as const,
        platform: 'webchat' as const,
        channel: CONV,
        sender: { id: 'alice', isBot: false },
        text: 'go',
        mentionedBots: [] as string[],
        isDm: true,
        trigger: 'dm' as const
      },
      undefined,
      { conversationId: CONV, turnId, sink: cp.sink }
    )

    expect(cp.outputs.filter((output) => output.event).map((output) => output.event)).toEqual([
      { kind: 'session_info', title: 'Inspect startup state' },
      { kind: 'message', text: 'done' }
    ])
    await daemon.stop()
  })

  it('hides the internal session-title tool burst from live and persisted message streams', async () => {
    const { factory } = streamingHost([
      sessionTitleToolCall('title-tool'),
      toolUpdate('title-tool', 'completed'),
      toolCall('visible-tool', 'Read file.ts', 'completed'),
      text('done')
    ])
    const daemon = new Daemon({ root: scaffold(undefined, { runtime: 'test-runtime' }), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '12121212-1212-4212-8212-121212121212'
    const msg = {
      msgId: `webchat:${CONV}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'tool_call', toolCallId: 'visible-tool', title: 'Read file.ts', status: 'completed' },
      { kind: 'message', text: 'done' }
    ])
    const toolRows = (await (daemon as any).store.threadTranscript(CONV, `webchat:${CONV}`))
      .filter((row: { kind: string }) => row.kind === 'tool')
      .map((row: { text: string }) => row.text)
    expect(toolRows).toEqual(['Read file.ts'])
    await daemon.stop()
  })

  it('streams a status frame at turn start, on usage_update, and at turn end', async () => {
    const { factory } = streamingHost([usageUpdate(120_000, 200_000, { amount: 0.18, currency: 'USD' }), text('ok')], {
      model: 'opus-4.8',
      usage: { totalTokens: 45_200, inputTokens: 40_000, outputTokens: 5_200 }
    })
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '99999999-9999-4999-8999-999999999999'
    const msg = {
      msgId: `webchat:${CONV}:${turnId}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    const statuses = cp.outputs
      .filter((o) => o.status)
      .map((o) => o.status)
      .map(wire)
    // Turn start: model + sessionId (no usage folded yet). Runtime controls are hidden while
    // chat-side changes are disabled. Then usage_update adds context+cost. Turn end: token
    // totals fold in. Deduped ⇒ exactly these three snapshots.
    // The console deep-links from this, so it is the session's OUTWARD id (§1.1) — minted by the
    // daemon, never the runtime's `acp-wc-1`.
    const outward = (await (daemon as any).store.getSessionByAcpId('acp-wc-1'))!.sessionId
    expect(outward).not.toBe('acp-wc-1')
    const base = {
      model: 'opus-4.8',
      permissionMode: 'default',
      permissionModes: [],
      sessionId: outward
    }
    const ctx = { contextUsed: 120_000, contextSize: 200_000, costAmount: 0.18, costCurrency: 'USD' }
    expect(statuses).toEqual([base, { ...base, ...ctx }, { ...base, ...ctx, totalTokens: 45_200 }])
    // Indices stay globally monotonic across status + event frames.
    const idx = cp.outputs.map((o) => o.index)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(new Set(idx).size).toBe(idx.length)
    await daemon.stop()
  })

  it('accumulates Codex per-turn tokens and public-price fallback cost across turns', async () => {
    const { factory } = streamingHost([text('ok')], {
      model: 'gpt-5.4-mini',
      usage: { totalTokens: 250_000, inputTokens: 100_000, cachedReadTokens: 140_000, outputTokens: 10_000 }
    })
    const daemon = new Daemon({
      root: scaffold(undefined, { runtime: 'test-runtime' }),
      hostFactory: factory
    })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    for (const turnId of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      await (daemon as any).dispatch(
        AGENT_ID,
        {
          msgId: `webchat:${CONV}:${turnId}`,
          traceId: turnId,
          source: 'user' as const,
          platform: 'webchat' as const,
          channel: CONV,
          thread: `webchat:${CONV}`,
          sender: { id: 'alice', isBot: false },
          text: 'go',
          mentionedBots: [] as string[],
          isDm: true,
          trigger: 'dm' as const
        },
        undefined,
        { conversationId: CONV, turnId, sink: cp.sink }
      )
    }

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    const usage = await (daemon as any).store.getUsage(key)
    expect(usage).toMatchObject({
      totalTokens: 500_000,
      inputTokens: 200_000,
      cachedReadTokens: 280_000,
      outputTokens: 20_000,
      costCurrency: 'USD'
    })
    expect(usage.costAmount).toBeCloseTo(0.261)
    expect((cp.usageReports.at(-1) as any).usage.costAmount).toBeCloseTo(0.261)
    await daemon.stop()
  })

  it('treats zero ACP cost as reported, then falls back independently on the next turn', async () => {
    const updates = [usageUpdate(20_000, 400_000, { amount: 0, currency: 'USD' }), text('ok')]
    const { factory } = streamingHost(updates, {
      model: 'gpt-5.4-mini',
      usage: { totalTokens: 250_000, inputTokens: 100_000, cachedReadTokens: 140_000, outputTokens: 10_000 }
    })
    const daemon = new Daemon({
      root: scaffold(undefined, { runtime: 'test-runtime' }),
      hostFactory: factory
    })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp
    const turnId = '33333333-3333-4333-8333-333333333333'
    await (daemon as any).dispatch(
      AGENT_ID,
      {
        msgId: `webchat:${CONV}:${turnId}`,
        traceId: turnId,
        source: 'user' as const,
        platform: 'webchat' as const,
        channel: CONV,
        thread: `webchat:${CONV}`,
        sender: { id: 'alice', isBot: false },
        text: 'go',
        mentionedBots: [] as string[],
        isDm: true,
        trigger: 'dm' as const
      },
      undefined,
      { conversationId: CONV, turnId, sink: cp.sink }
    )
    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect((await (daemon as any).store.getUsage(key)).costAmount).toBe(0)

    // The marker is per-turn, not sticky across the session: no native cost on
    // turn two means the public-price fallback is added to the existing USD total.
    updates.splice(0, updates.length, text('ok again'))
    const turn2 = '55555555-5555-4555-8555-555555555555'
    await (daemon as any).dispatch(
      AGENT_ID,
      {
        msgId: `webchat:${CONV}:${turn2}`,
        traceId: turn2,
        source: 'user' as const,
        platform: 'webchat' as const,
        channel: CONV,
        thread: `webchat:${CONV}`,
        sender: { id: 'alice', isBot: false },
        text: 'again',
        mentionedBots: [] as string[],
        isDm: true,
        trigger: 'dm' as const
      },
      undefined,
      { conversationId: CONV, turnId: turn2, sink: cp.sink }
    )
    expect((await (daemon as any).store.getUsage(key)).costAmount).toBeCloseTo(0.1305)
    await daemon.stop()
  })

  it('accepts late ACP cost corrections while output drains and after pending cleanup', async () => {
    const { factory } = streamingHost([text('ok')], {
      model: 'gpt-5.4-mini',
      usage: { totalTokens: 250_000, inputTokens: 100_000, cachedReadTokens: 140_000, outputTokens: 10_000 }
    })
    const daemon = new Daemon({
      root: scaffold(undefined, { runtime: 'test-runtime' }),
      hostFactory: factory
    })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp
    let drainCorrection: Promise<unknown> | undefined
    cp.emitUsageReport.mockImplementation((report: unknown) => {
      cp.usageReports.push(report)
      if (drainCorrection) return
      // The normal report is synchronous; this runs at the following await while
      // Pending still exists but usageReportSent has already flipped true.
      drainCorrection = Promise.resolve().then(() =>
        (daemon as any).onAcpUpdate(
          AGENT_ID,
          'acp-wc-1',
          usageUpdate(20_000, 400_000, { amount: 0.21, currency: 'USD' })
        )
      )
    })
    const turnId = '44444444-4444-4444-8444-444444444444'
    await (daemon as any).dispatch(
      AGENT_ID,
      {
        msgId: `webchat:${CONV}:${turnId}`,
        traceId: turnId,
        source: 'user' as const,
        platform: 'webchat' as const,
        channel: CONV,
        thread: `webchat:${CONV}`,
        sender: { id: 'alice', isBot: false },
        text: 'go',
        mentionedBots: [] as string[],
        isDm: true,
        trigger: 'dm' as const
      },
      undefined,
      { conversationId: CONV, turnId, sink: cp.sink }
    )

    await drainCorrection

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect((await (daemon as any).store.getUsage(key)).costAmount).toBeCloseTo(0.21)
    expect(cp.usageReports).toHaveLength(2)
    expect((cp.usageReports.at(-1) as any).usage.costAmount).toBeCloseTo(0.21)

    // After dispatch returns Pending is gone; the session-id lookup still applies
    // and reports a newer correction.
    await (daemon as any).onAcpUpdate(
      AGENT_ID,
      'acp-wc-1',
      usageUpdate(20_000, 400_000, { amount: 0.22, currency: 'USD' })
    )
    expect((await (daemon as any).store.getUsage(key)).costAmount).toBeCloseTo(0.22)
    expect((cp.usageReports.at(-1) as any).usage.costAmount).toBeCloseTo(0.22)
    await daemon.stop()
  })

  it('set_model persists a sticky override and applies it live (webchat by-key core)', async () => {
    const { factory, host } = streamingHost([text('hi')], { model: 'a', models: ['a', 'b'] })
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).agents.get(AGENT_ID).allowRuntimeChangesInChat = true
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    // Run one full turn so a session row (with acpSessionId) exists for the conversation.
    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'go',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    await (daemon as any).commands.setModelByKey(key, 'b')
    expect(await (daemon as any).store.getModelOverride(key)).toBe('b') // sticky
    expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'b') // applied live
    await daemon.stop()
  })

  it.each([
    { allowed: true, expected: { model: 'b', effort: 'high', permissionMode: 'plan', fastMode: true } },
    { allowed: false, expected: {} }
  ])(
    'handles first-turn runtime choices at the Agent authority boundary (allowed=$allowed)',
    async ({ allowed, expected }) => {
      const runtime = { model: 'b', effort: 'high', permissionMode: 'plan', fastMode: true }
      const { factory, host } = streamingHost([text('hi')], { model: 'a', models: ['a', 'b'] })
      const daemon = new Daemon({
        root: scaffold(undefined, { allowRuntimeChangesInChat: allowed }),
        hostFactory: factory
      })
      await daemon.start()
      const cp = fakeCpClient()

      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'go',
        { id: 'webchat', name: 'webchat' },
        cp.sink,
        undefined,
        undefined,
        runtime
      )
      await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)

      const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
      expect({
        model: await (daemon as any).store.getModelOverride(key),
        effort: await (daemon as any).store.getEffortOverride(key),
        permissionMode: await (daemon as any).store.getPermissionModeOverride(key),
        fastMode: await (daemon as any).store.getFastModeOverride(key)
      }).toEqual(expected)
      expect(host.newSession.mock.calls[0]?.[2]).toBe(allowed ? 'high' : undefined)
      if (allowed) {
        expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'b')
        expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'high')
        expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-wc-1', 'plan')
        expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', true)
      }
      await daemon.stop()
    },
    15_000
  )

  it('revokes staged first-turn runtime choices when authority changes during session creation', async () => {
    let releaseFirstSession!: () => void
    let releaseSecondSession!: () => void
    const firstSessionGate = new Promise<void>((resolve) => (releaseFirstSession = resolve))
    const secondSessionGate = new Promise<void>((resolve) => (releaseSecondSession = resolve))
    const configured = {
      allowRuntimeChangesInChat: true,
      runtimeOverrides: { model: 'a' },
      reasoningEffort: 'low',
      permissionMode: 'default',
      fastMode: false
    }
    const root = scaffold(undefined, configured)
    let newSessionCalls = 0
    let discardCalls = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async (_cwd: string, _mcpServers: unknown[], _effortOverride?: string) => {
        newSessionCalls += 1
        if (newSessionCalls === 1) {
          await firstSessionGate
          return 'acp-wc-staged-1'
        }
        if (newSessionCalls === 2) {
          await secondSessionGate
          return 'acp-wc-staged-2'
        }
        return 'acp-wc-1'
      }),
      discardSession: vi.fn(() => {
        discardCalls += 1
        if (discardCalls !== 1) return
        // Re-enable in the narrow gap before recreation so the retry itself carries
        // ultracode; the second disable below must fence that awaited retry too.
        const current = (daemon as any).agents.get(AGENT_ID)
        ;(daemon as any).agents.set(AGENT_ID, { ...current, allowRuntimeChangesInChat: true })
      }),
      modelOptions: vi.fn(() => ({ current: 'a', models: ['a', 'b'] })),
      hasSession: vi.fn(() => true),
      setSessionModel: vi.fn(async () => true),
      setSessionEffort: vi.fn(async () => true),
      setSessionPermissionMode: vi.fn(async () => true),
      setSessionFastMode: vi.fn(async () => true),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root, hostFactory: () => host as any })
    await daemon.start()
    const cp = fakeCpClient()
    const runtime = { model: 'b', effort: 'ultracode', permissionMode: 'plan', fastMode: true }

    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'go',
      { id: 'webchat', name: 'webchat' },
      cp.sink,
      undefined,
      undefined,
      runtime
    )
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1), WAIT)

    writeAgent(root, { ...configured, allowRuntimeChangesInChat: false })
    await (daemon as any).reconcile()
    releaseFirstSession()
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(2), WAIT)

    writeAgent(root, { ...configured, allowRuntimeChangesInChat: false })
    await (daemon as any).reconcile()
    releaseSecondSession()
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect(await (daemon as any).store.getModelOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getEffortOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getPermissionModeOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getFastModeOverride(key)).toBeUndefined()
    expect(host.newSession).toHaveBeenCalledTimes(3)
    expect(host.newSession.mock.calls[0]?.[2]).toBe('ultracode')
    expect(host.newSession.mock.calls[1]?.[2]).toBe('ultracode')
    expect(host.newSession.mock.calls[2]?.[2]).toBeUndefined()
    expect(host.discardSession).toHaveBeenNthCalledWith(1, 'acp-wc-staged-1')
    expect(host.discardSession).toHaveBeenNthCalledWith(2, 'acp-wc-staged-2')
    expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'a')
    expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'low')
    expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-wc-1', 'default')
    expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', false)
    expect(host.setSessionModel).not.toHaveBeenCalledWith('acp-wc-1', 'b')
    expect(host.setSessionPermissionMode).not.toHaveBeenCalledWith('acp-wc-1', 'plan')
    expect(host.setSessionFastMode).not.toHaveBeenCalledWith('acp-wc-1', true)
    const promptOrder = host.prompt.mock.invocationCallOrder[0]!
    expect(host.setSessionModel.mock.invocationCallOrder.at(-1)).toBeLessThan(promptOrder)
    expect(host.setSessionEffort.mock.invocationCallOrder.at(-1)).toBeLessThan(promptOrder)
    expect(host.setSessionPermissionMode.mock.invocationCallOrder.at(-1)).toBeLessThan(promptOrder)
    expect(host.setSessionFastMode.mock.invocationCallOrder.at(-1)).toBeLessThan(promptOrder)
    await daemon.stop()
  })

  it('revokes chat-selected runtime settings from an idle warm session', async () => {
    const configured = {
      allowRuntimeChangesInChat: true,
      runtimeOverrides: { model: 'a' },
      reasoningEffort: 'low',
      permissionMode: 'default',
      fastMode: false
    }
    const root = scaffold(undefined, configured)
    const { factory, host } = streamingHost([text('hi')], { model: 'a', models: ['a', 'b'] })
    const daemon = new Daemon({ root, hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    // Finish a turn first: Pending is gone, but the ACP session remains warm.
    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'first',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)
    expect((daemon as any).pending.size).toBe(0)
    expect(host.newSession).toHaveBeenCalledTimes(1)

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect(await (daemon as any).commands.setModelByKey(key, 'b')).toBe(true)
    expect(await (daemon as any).commands.setEffortByKey(key, 'high')).toBe(true)
    expect(await (daemon as any).commands.setPermissionModeByKey(key, 'plan')).toBe(true)
    expect(await (daemon as any).commands.setFastByKey(key, true)).toBe(true)
    await vi.waitFor(() => {
      expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'b')
      expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'high')
      expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-wc-1', 'plan')
      expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', true)
    }, WAIT)
    host.setSessionModel.mockClear()
    host.setSessionEffort.mockClear()
    host.setSessionPermissionMode.mockClear()
    host.setSessionFastMode.mockClear()

    // Turning the gate off must restore every live session, not only an in-flight turn.
    writeAgent(root, { ...configured, allowRuntimeChangesInChat: false })
    await (daemon as any).reconcile()
    await vi.waitFor(() => {
      expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'a')
      expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'low')
      expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-wc-1', 'default')
      expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', false)
    }, WAIT)
    expect(await (daemon as any).store.getModelOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getEffortOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getPermissionModeOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getFastModeOverride(key)).toBeUndefined()

    // The next turn reuses that same restored session while chat changes remain locked.
    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'second',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(() => expect(cp.dones).toHaveLength(2), WAIT)
    expect(host.newSession).toHaveBeenCalledTimes(1)
    expect((daemon as any).agents.get(AGENT_ID).allowRuntimeChangesInChat).toBe(false)
    await daemon.stop()
  })

  it('restores the runtime default model and effort when the Agent leaves them unpinned', async () => {
    const configured = {
      allowRuntimeChangesInChat: true,
      permissionMode: 'default',
      fastMode: false
    }
    const root = scaffold(undefined, configured)
    const { factory, host } = streamingHost([text('hi')], {
      model: 'default',
      models: ['default', 'b']
    })
    const daemon = new Daemon({ root, hostFactory: factory })
    await daemon.start()
    ;(daemon as any).runtimeFacts.catalogs.set('claude', {
      models: [
        {
          id: 'default',
          efforts: [{ value: 'medium' }, { value: 'high' }],
          defaultEffort: 'medium',
          fastMode: true
        },
        { id: 'b', efforts: [{ value: 'high' }], fastMode: true }
      ],
      source: 'acp',
      observedAt: '2026-07-23T00:00:00.000Z'
    })
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'first',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)
    expect((daemon as any).pending.size).toBe(0)

    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect(await (daemon as any).commands.setModelByKey(key, 'b')).toBe(true)
    expect(await (daemon as any).commands.setEffortByKey(key, 'high')).toBe(true)
    expect(await (daemon as any).commands.setFastByKey(key, true)).toBe(true)
    await vi.waitFor(() => {
      expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'b')
      expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'high')
      expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', true)
    }, WAIT)
    host.setSessionModel.mockClear()
    host.setSessionEffort.mockClear()
    host.setSessionFastMode.mockClear()

    writeAgent(root, { ...configured, allowRuntimeChangesInChat: false })
    await (daemon as any).reconcile()
    await vi.waitFor(() => {
      expect(host.setSessionModel).toHaveBeenCalledWith('acp-wc-1', 'default')
      expect(host.setSessionEffort).toHaveBeenCalledWith('acp-wc-1', 'medium')
      expect(host.setSessionFastMode).toHaveBeenCalledWith('acp-wc-1', false)
    }, WAIT)

    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'second',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(() => expect(cp.dones).toHaveLength(2), WAIT)
    expect(host.newSession).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('handleWebchatCancel interrupts the in-flight turn without muting', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      modelOptions: vi.fn(() => null),
      hasSession: vi.fn(() => true),
      setSessionModel: vi.fn(async () => true),
      prompt: vi.fn(async () => {
        await gate
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'go',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    await vi.waitFor(
      () =>
        expect([...(daemon as any).pending.values()].some((p: any) => p.webchat?.conversationId === CONV)).toBe(true),
      WAIT
    )

    const outputsBeforeCancel = cp.outputs.length
    await (daemon as any).webchatTransport.handleWebchatCancel(CONV)
    expect(host.cancel).toHaveBeenCalledWith('acp-wc-1')
    expect(cp.dones).toEqual([expect.objectContaining({ conversationId: CONV, error: 'cancel' })])
    // NOT muted — a follow-up turn would still dispatch.
    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    expect(await (daemon as any).store.isSessionMuted(key)).toBe(false)

    release()
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(0), WAIT)
    expect(cp.dones).toHaveLength(1) // cancel-resolved prompt must not emit a second terminal frame
    expect(cp.outputs).toHaveLength(outputsBeforeCancel)
    await daemon.stop()
  })

  it('terminates a cold accepted webchat turn exactly once before Pending exists', async () => {
    let releaseSession!: () => void
    const sessionGate = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        await sessionGate
        return 'acp-wc-cold'
      }),
      modelOptions: vi.fn(() => null),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()
    const cp = fakeCpClient()

    const ack = await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'go',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    expect(ack.accepted).toBe(true)
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1), WAIT)
    expect((daemon as any).pending.size).toBe(0)

    await (daemon as any).webchatTransport.handleWebchatCancel(CONV)
    expect(cp.dones).toEqual([expect.objectContaining({ turnId: ack.turnId, error: 'cancel' })])
    expect(host.cancel).not.toHaveBeenCalled()

    releaseSession()
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    expect(host.prompt).not.toHaveBeenCalled()
    expect(cp.dones).toHaveLength(1)
    await daemon.stop()
  })

  it('surfaces a failed agent start as a webchat/done carrying the error', async () => {
    // Host that can't start (spawn failure / ACP handshake reject). Without the
    // dispatch catch this turn would emit no done at all and the client would hang.
    // agentStartAttempts: 1 → no retries, so the failure surfaces immediately.
    const host = {
      start: vi.fn(async () => {
        throw new Error('spawn claude ENOENT')
      }),
      newSession: vi.fn(async () => 'acp-wc-x'),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const factory = () => host as any

    const daemon = new Daemon({ root: scaffold({ agentStartAttempts: 1 }), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    const msg = {
      msgId: `webchat:${CONV}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    // dispatch rethrows after surfacing (callers only log) — swallow it here.
    await expect(
      (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })
    ).rejects.toThrow('spawn claude ENOENT')

    // Exactly one terminal frame, carrying the failure reason and no stopReason.
    expect(cp.dones).toEqual([{ conversationId: CONV, turnId, error: 'spawn claude ENOENT' }])
    await daemon.stop()
  })

  it('retries a transient start failure and recovers without surfacing an error', async () => {
    // A fresh host is built per attempt (hostFactory is called each try). The first
    // fails to start; the second succeeds and runs the turn normally.
    let onUpdate!: (sid: string, u: unknown) => void
    let attempt = 0
    const factory = (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
      onUpdate = cb
      attempt += 1
      const willFail = attempt === 1
      return {
        start: vi.fn(async () => {
          if (willFail) throw new Error('transient ECONNRESET')
        }),
        newSession: vi.fn(async () => 'acp-wc-ok'),
        prompt: vi.fn(async (sid: string) => {
          onUpdate(sid, text('recovered reply'))
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(async () => {}),
        stop: vi.fn(async () => {})
      } as any
    }

    // Two attempts, zero backoff → the retry is instant.
    const daemon = new Daemon({
      root: scaffold({ agentStartAttempts: 2, agentStartBackoffMs: 0 }),
      hostFactory: factory
    })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    const msg = {
      msgId: `webchat:${CONV}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    expect(attempt).toBe(2) // one failed start, one that stuck
    // Clean completion — the reply streamed and the turn closed with NO error field.
    expect(cp.outputs.filter((o) => o.event).map((o) => o.event)).toEqual([
      { kind: 'message', text: 'recovered reply' }
    ])
    expect(cp.dones).toEqual([{ conversationId: CONV, turnId, stopReason: 'end_turn' }])
    await daemon.stop()
  })

  it('skips dispatch for a paused agent — no turn runs, resolves null (#288)', async () => {
    const { factory, host } = streamingHost([text('should not run')])
    const daemon = new Daemon({ root: scaffold(undefined, { pause: true }), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    const msg = {
      msgId: `webchat:${CONV}`,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'go',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    const result = await (daemon as any).dispatch(AGENT_ID, msg, undefined, {
      conversationId: CONV,
      turnId,
      sink: cp.sink
    })

    expect(result).toBeNull() // skipped, like the drain gate
    expect(host.prompt).not.toHaveBeenCalled() // no ACP turn ran
    expect(cp.outputs).toEqual([]) // nothing streamed
    expect(cp.dones).toEqual([]) // no terminal frame
    await daemon.stop()
  })

  it('rejects a webchat turn for a paused agent with reason "paused" (#288)', async () => {
    const { factory, host } = streamingHost([text('should not run')])
    const daemon = new Daemon({ root: scaffold(undefined, { pause: true }), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const ack = await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'go',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )

    expect(ack).toMatchObject({ accepted: false, reason: 'paused' })
    expect(host.prompt).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('rejects the 12th exact-key turn synchronously when the head plus ten queued turns fill the gate', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      modelOptions: vi.fn(() => null),
      hasSession: vi.fn(() => true),
      setSessionModel: vi.fn(async () => true),
      prompt: vi.fn(async () => {
        await gate
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()
    const cp = fakeCpClient()

    const accepted = [
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'head',
        { id: 'webchat', name: 'webchat' },
        cp.sink
      )
    ]
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    for (let n = 1; n <= 10; n++) {
      accepted.push(
        await (daemon as any).webchatTransport.dispatchWebchatTurn(
          AGENT_ID,
          CONV,
          `queued-${n}`,
          { id: 'webchat', name: 'webchat' },
          cp.sink
        )
      )
    }
    expect(accepted.every((ack) => ack.accepted)).toBe(true)
    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(10), WAIT)

    // The exact-key preflight must reject before returning an accepted ACK. A client
    // therefore never starts waiting for a `done` frame that this non-admitted turn
    // cannot produce.
    const rejected = await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'queue-full',
      { id: 'webchat', name: 'webchat' },
      cp.sink
    )
    expect(rejected).toMatchObject({ accepted: false, reason: 'busy' })
    expect(cp.dones).toEqual([])

    release()
    await vi.waitFor(() => expect(cp.dones).toHaveLength(11), WAIT)
    expect(new Set(cp.dones.map((done) => done.turnId))).toEqual(new Set(accepted.map((ack) => ack.turnId)))
    expect(cp.dones.some((done) => done.turnId === rejected.turnId)).toBe(false)
    expect(host.prompt).toHaveBeenCalledTimes(11)
    await daemon.stop()
  })

  it('records the webchat turn as a real session (transcript has the reply)', async () => {
    const { factory } = streamingHost([text('the reply')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const turnId = '77777777-7777-4777-8777-777777777777'
    // msgId is stable per-conversation (statusThread falls back to it); the session
    // thread is therefore this msgId, not the turnId.
    const msgId = `webchat:${CONV}`
    const msg = {
      msgId,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: 'ask',
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    }
    await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

    // A webchat session is REAL: its activity log is recorded like any other session.
    // The agent's reply is recorded once (accumulated from the message chunks) under
    // the agent's id, since webchat has no Slack post boundary where text is saved.
    const rows = (await (daemon as any).store.threadTranscript(CONV, msgId)) as {
      sender: string
      kind: string
      text: string
    }[]
    const botText = rows.filter((r) => r.sender === AGENT_ID && r.kind === 'text').map((r) => r.text)
    expect(botText).toContain('the reply')
    await daemon.stop()
  })

  // #912 regression: the token's `user` claim became the profile's display NAME, and the
  // daemon stamped it as the transcript sender — so a re-read row identified the author by
  // a mutable label the console could not match against /me, and the viewer's own messages
  // came back as a stranger's. The row must record the stable principal instead.
  it('records the stable principal as the transcript sender and caches the handle as a name', async () => {
    const { factory } = streamingHost([text('ok')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'ask',
      { id: 'user-1', name: 'Ada Lovelace' },
      cp.sink
    )
    // The ack returns before the dispatch commits, so poll for the durable row.
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)

    const rows = (await (daemon as any).store.threadTranscript(CONV, `webchat:${CONV}`)) as {
      sender: string
      kind: string
    }[]
    const humanSenders = rows.filter((r) => r.kind === 'text' && r.sender !== AGENT_ID).map((r) => r.sender)
    expect(humanSenders.length).toBeGreaterThan(0)
    expect(new Set(humanSenders)).toEqual(new Set(['user-1']))
    // The handle is not lost — it moves to the name cache the session reader projects as
    // `senderName`, and that `initiatorLabel` reads for a session worktree's branch.
    expect((await (daemon as any).store.getDisplayNames(['user-1'])).get('user-1')).toBe('Ada Lovelace')
    await daemon.stop()
  })

  // An older relay sends no principal. The turn must still work, and must not write a
  // pointless self-referential name-cache row for the handle it fell back to.
  it('falls back to the display handle when a pre-principal relay sends no id', async () => {
    const { factory } = streamingHost([text('ok')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const ack = await (daemon as any).webchatTransport.dispatchWebchatTurn(
      AGENT_ID,
      CONV,
      'ask',
      { id: 'Ada Lovelace', name: 'Ada Lovelace' },
      cp.sink
    )
    expect(ack.accepted).toBe(true)
    await vi.waitFor(() => expect(cp.dones).toHaveLength(1), WAIT)

    const rows = (await (daemon as any).store.threadTranscript(CONV, `webchat:${CONV}`)) as {
      sender: string
      kind: string
    }[]
    expect(rows.some((r) => r.kind === 'text' && r.sender === 'Ada Lovelace')).toBe(true)
    expect((await (daemon as any).store.getDisplayNames(['Ada Lovelace'])).size).toBe(0)
    await daemon.stop()
  })

  // #807 follow-up: the fix posted only the woken agent's REPLY live — the SENDER's own
  // message reached the browser only via refresh (history), never in the live view.
  it('an agent-initiated wake posts the INBOUND message live, postId shared with its transcript row', async () => {
    const { factory } = streamingHost([text('forwarding: B says hi')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp
    const posts: any[] = []
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: (p: any) => posts.push(p) }

    const SENDER = '99999999-9999-4999-8999-999999999999'
    const thread = `webchat:${CONV}`
    const msg = {
      msgId: `agentcall:${CONV}:d-1`,
      traceId: 'd-1',
      source: 'agent' as const,
      platform: 'webchat' as const,
      channel: CONV,
      thread,
      transcriptTs: String(Date.now()),
      sender: { id: SENDER, isBot: true },
      text: 'hi from B',
      mentionedBots: [] as string[],
      isDm: false
    }
    await (daemon as any).dispatch(
      AGENT_ID,
      msg,
      undefined,
      (daemon as any).webchatTransport.webchatWakeContext('webchat', CONV)
    )

    // Two live posts: the inbound sender message first, then the woken reply.
    expect(posts).toHaveLength(2)
    expect(posts[0]).toMatchObject({
      conversationId: CONV,
      agentId: SENDER,
      initiator: 'agent',
      post: { author: { kind: 'agent', agentId: SENDER }, text: 'hi from B', at: Number(msg.transcriptTs) }
    })
    expect(posts[1]).toMatchObject({
      agentId: AGENT_ID,
      initiator: 'agent',
      post: { author: { kind: 'agent', agentId: AGENT_ID }, text: 'forwarding: B says hi' }
    })
    // The transcript row carries the same postId, so a later transcript refetch
    // reconciles the live step instead of double-rendering it.
    const rows = (await (daemon as any).store.threadTranscript(CONV, thread)) as {
      sender: string
      postId?: string
      text: string
    }[]
    const inbound = rows.find((r) => r.sender === SENDER)
    expect(inbound?.postId).toBe(posts[0].post.postId)
    await daemon.stop()
  })

  it('records EVERY user turn — a stable per-conversation msgId must not dedup follow-ups', async () => {
    // Regression: webchat's msgId is stable per conversation, so a naive transcript ts
    // (derived from the msgId) is identical for every turn — the (channel,thread,ts) unique
    // index then dropped all follow-up user messages, leaving only the first recorded.
    const { factory } = streamingHost([text('a reply')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const cp = fakeCpClient()
    ;(daemon as any).cpClient = cp

    const msgId = `webchat:${CONV}` // stable across turns, on purpose
    const mk = (turnId: string, body: string) => ({
      msgId,
      traceId: turnId,
      source: 'user' as const,
      platform: 'webchat' as const,
      channel: CONV,
      sender: { id: 'alice', isBot: false },
      text: body,
      mentionedBots: [] as string[],
      isDm: true,
      trigger: 'dm' as const
    })
    const t1 = '11111111-1111-4111-8111-111111111111'
    const t2 = '22222222-2222-4222-8222-222222222222'
    await (daemon as any).dispatch(AGENT_ID, mk(t1, 'first question'), undefined, {
      conversationId: CONV,
      turnId: t1,
      sink: cp.sink
    })
    await (daemon as any).dispatch(AGENT_ID, mk(t2, 'second question'), undefined, {
      conversationId: CONV,
      turnId: t2,
      sink: cp.sink
    })

    const rows = (await (daemon as any).store.threadTranscript(CONV, msgId)) as {
      sender: string
      kind: string
      text: string
    }[]
    const userText = rows.filter((r) => r.sender === 'alice' && r.kind === 'text').map((r) => r.text)
    expect(userText).toContain('first question')
    expect(userText).toContain('second question') // was dropped before the per-turn-ts fix
    await daemon.stop()
  })
})

describe('Daemon handleRelayMsg (rd/msg op dispatch — the relay data plane)', () => {
  const rd = (payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
    source: 'webchat',
    agentId: AGENT_ID,
    sessionKey: CONV,
    msgId: 'm-1',
    chatId: CONV,
    payload,
    ...over
  })

  it('suppresses a silent decline: the streamed sentinel never reaches the browser, no post, no reply row', async () => {
    const { factory } = streamingHost([text('AC_NO_'), text('RESPONSE')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const events: RdChatEvent[] = []
    const posts: unknown[] = []
    const ack = await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'anyone?', user: 'owner', turnId, post: { postId: turnId, at: 1_000 } }),
      (event: RdChatEvent) => events.push(event),
      (post: unknown) => posts.push(post)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    const messages = events.flatMap((e) =>
      e.kind === 'output' && e.output.event?.kind === 'message' ? [e.output.event.text] : []
    )
    expect(messages).toEqual([]) // the sentinel was held and dropped
    expect(posts).toEqual([]) // no canonical post fan-out
    const replies = (await (daemon as any).store.transcriptSince(`${CONV}`, `webchat:${CONV}`, null)).filter(
      (row: { sender: string }) => row.sender === AGENT_ID
    )
    expect(replies).toEqual([]) // no transcript reply row
    await daemon.stop()
  })

  it('releases held text the instant the body diverges from the sentinel prefix', async () => {
    const { factory } = streamingHost([text('AC_NO'), text(' — actually, here is the answer')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const events: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'anyone?', user: 'owner', turnId, post: { postId: turnId, at: 1_000 } }),
      (event: RdChatEvent) => events.push(event)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    const messages = events.flatMap((e) =>
      e.kind === 'output' && e.output.event?.kind === 'message' ? [e.output.event.text] : []
    )
    expect(messages.join('')).toBe('AC_NO — actually, here is the answer')
    await daemon.stop()
  })

  it('a turn op preserves the browser turnId and streams rd/chat output→done', async () => {
    const { factory } = streamingHost([text('hi from agent')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const events: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'go', user: 'ada', turnId }),
      (e: RdChatEvent) => events.push(e)
    )
    expect(ack).toMatchObject({ msgId: 'm-1', accepted: true, turnId })

    // The reply streams asynchronously through the same engine as the CP path, but now
    // over the `chat` callback (→ rd/chat) instead of the cp client.
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(events.filter((e) => e.kind === 'output').length).toBeGreaterThan(0)
    const done = events.find((e) => e.kind === 'done')
    expect(done?.kind === 'done' && done.done).toMatchObject({ conversationId: CONV, turnId: ack.turnId })
    await daemon.stop()
  })

  it('keeps a newer resume bound when a delayed older generation arrives afterward', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const first: RdChatEvent[] = []
    const second: RdChatEvent[] = []
    const third: RdChatEvent[] = []
    const stale: RdChatEvent[] = []
    const sink = (events: RdChatEvent[]) => ({
      output: (output: WebchatOutput) => events.push({ kind: 'output', output }),
      done: (done: WebchatDone) => events.push({ kind: 'done', done })
    })
    const stream = (daemon as any).webchatTransport.createWebchatTurnStream(AGENT_ID, CONV, turnId, sink(first))

    stream.sink.output({ conversationId: CONV, turnId, index: 0, event: { kind: 'message', text: 'first' } })
    const activeResume = await (daemon as any).handleRelayMsg(
      rd({ op: 'resume', turnId, generation: 2, afterIndex: -1 }, { msgId: 'resume-active' }),
      (event: RdChatEvent) => second.push(event)
    )
    expect(activeResume).toMatchObject({ accepted: true, turnId })
    expect(second.filter((event) => event.kind === 'output')).toHaveLength(1)

    const delayedResume = await (daemon as any).handleRelayMsg(
      rd({ op: 'resume', turnId, generation: 1, afterIndex: -1 }, { msgId: 'resume-delayed' }),
      (event: RdChatEvent) => stale.push(event)
    )
    expect(delayedResume).toMatchObject({ accepted: false, turnId, reason: 'stream_stale' })

    stream.sink.output({ conversationId: CONV, turnId, index: 1, event: { kind: 'message', text: 'second' } })
    stream.sink.done({ conversationId: CONV, turnId, stopReason: 'end_turn' })
    expect(first).toHaveLength(1) // future output moved to the resumed relay sink
    expect(stale).toEqual([]) // delayed generation never steals the stream transport
    expect(second.at(-1)).toEqual({
      kind: 'done',
      done: { conversationId: CONV, turnId, agentId: AGENT_ID, lastIndex: 1, stopReason: 'end_turn' }
    })

    const terminalResume = await (daemon as any).handleRelayMsg(
      rd({ op: 'resume', turnId, generation: 3, afterIndex: 0 }, { msgId: 'resume-terminal' }),
      (event: RdChatEvent) => third.push(event)
    )
    expect(terminalResume).toMatchObject({ accepted: true, turnId })
    expect(third).toEqual([
      {
        kind: 'output',
        output: {
          conversationId: CONV,
          turnId,
          agentId: AGENT_ID,
          index: 1,
          event: { kind: 'message', text: 'second' }
        }
      },
      {
        kind: 'done',
        done: { conversationId: CONV, turnId, agentId: AGENT_ID, lastIndex: 1, stopReason: 'end_turn' }
      }
    ])
    await daemon.stop()
  })

  it('accepts a retry after resume arrives before the delayed original turn', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const original: RdChatEvent[] = []
    const resumed: RdChatEvent[] = []
    const beforeTurn = await (daemon as any).handleRelayMsg(
      rd({ op: 'resume', turnId, generation: 1, afterIndex: -1 }, { msgId: 'resume-before-turn' }),
      (event: RdChatEvent) => resumed.push(event)
    )
    expect(beforeTurn).toMatchObject({ accepted: false, reason: 'stream_not_found' })

    const stream = (daemon as any).webchatTransport.createWebchatTurnStream(AGENT_ID, CONV, turnId, {
      output: (output: WebchatOutput) => original.push({ kind: 'output', output }),
      done: (done: WebchatDone) => original.push({ kind: 'done', done })
    })
    stream.sink.output({ conversationId: CONV, turnId, index: 0, event: { kind: 'message', text: 'missed' } })
    const retry = await (daemon as any).handleRelayMsg(
      rd({ op: 'resume', turnId, generation: 2, afterIndex: -1 }, { msgId: 'resume-retry' }),
      (event: RdChatEvent) => resumed.push(event)
    )
    expect(retry).toMatchObject({ accepted: true, turnId })

    stream.sink.output({ conversationId: CONV, turnId, index: 1, event: { kind: 'message', text: 'continued' } })
    expect(original).toEqual([
      {
        kind: 'output',
        output: {
          conversationId: CONV,
          turnId,
          agentId: AGENT_ID,
          index: 0,
          event: { kind: 'message', text: 'missed' }
        }
      }
    ])
    expect(resumed).toEqual([
      {
        kind: 'output',
        output: {
          conversationId: CONV,
          turnId,
          agentId: AGENT_ID,
          index: 0,
          event: { kind: 'message', text: 'missed' }
        }
      },
      {
        kind: 'output',
        output: {
          conversationId: CONV,
          turnId,
          agentId: AGENT_ID,
          index: 1,
          event: { kind: 'message', text: 'continued' }
        }
      }
    ])
    await daemon.stop()
  })

  it('rejects resume explicitly when the bounded replay window no longer covers the cursor', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()

    const turnId = '77777777-7777-4777-8777-777777777777'
    const stream = (daemon as any).webchatTransport.createWebchatTurnStream(AGENT_ID, CONV, turnId, {
      output: () => {},
      done: () => {}
    })
    for (let index = 0; index <= 256; index++) {
      stream.sink.output({
        conversationId: CONV,
        turnId,
        index,
        event: { kind: 'message', text: String(index) }
      })
    }

    expect(
      await (daemon as any).handleRelayMsg(
        rd({ op: 'resume', turnId, generation: 1, afterIndex: -1 }, { msgId: 'resume-overflow' }),
        () => {}
      )
    ).toMatchObject({ accepted: false, turnId, reason: 'stream_gap' })
    await daemon.stop()
  })

  it('delivers an inline webchat image and retains it for transcript replay', async () => {
    const { factory, host } = streamingHost([text('I can see it')])
    ;(host as any).promptSupports = (kind: string) => kind === 'image'
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const bytes = Buffer.from('image bytes')
    const events: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(
      rd({
        op: 'turn',
        text: 'What is shown?',
        user: 'ada',
        attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: bytes.toString('base64') }]
      }),
      (event: RdChatEvent) => events.push(event)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), WAIT)

    // The trigger names its own attachment beside the pixels: the image block is what the
    // model looks at, the marker is what `sendMessage`'s `attachment` forwards it BY.
    expect(host.prompt.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        { type: 'text', text: '[ada] What is shown?\n[attached: screen.webp (image/webp)]' },
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/webp' }
      ])
    )
    const rows = (await (daemon as any).store.threadTranscript(CONV, `webchat:${CONV}`)) as Array<{
      sender: string
      text: string
      attachmentsJson?: string
    }>
    const userRow = rows.find((row) => row.sender === 'ada')
    expect(userRow?.text).toBe('What is shown?\n[attached: screen.webp (image/webp)]')
    expect(JSON.parse(userRow?.attachmentsJson ?? '[]')).toEqual([
      { name: 'screen.webp', mimeType: 'image/webp', data: bytes.toString('base64') }
    ])
    await daemon.stop()
  })

  it('retains the inline image when the turn carries a canonical post (admission write wins the slot)', async () => {
    // Real relay traffic ALWAYS mints `post`, which makes the turn-final-refresh
    // admission write claim the transcript slot before SessionManager's append —
    // INSERT OR IGNORE then dedups the authoritative copy, so the admission row
    // itself must carry the image or attachmentsJson is pinned to NULL and the
    // reopened console shows only the `[attached: …]` label.
    const { factory, host } = streamingHost([text('I can see it')])
    ;(host as any).promptSupports = (kind: string) => kind === 'image'
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const bytes = Buffer.from('image bytes')
    const turnId = '88888888-8888-4888-8888-888888888888'
    const events: RdChatEvent[] = []
    const ack = await (daemon as any).handleRelayMsg(
      rd({
        op: 'turn',
        text: 'What is shown?',
        user: 'ada',
        turnId,
        post: { postId: turnId, at: 1_000 },
        attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: bytes.toString('base64') }]
      }),
      (event: RdChatEvent) => events.push(event)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'done')).toBe(true), WAIT)

    const rows = (await (daemon as any).store.threadTranscript(CONV, `webchat:${CONV}`)) as Array<{
      sender: string
      text: string
      attachmentsJson?: string
    }>
    const userRow = rows.find((row) => row.sender === 'ada')
    expect(userRow?.text).toBe('What is shown?\n[attached: screen.webp (image/webp)]')
    expect(JSON.parse(userRow?.attachmentsJson ?? '[]')).toEqual([
      { name: 'screen.webp', mimeType: 'image/webp', data: bytes.toString('base64') }
    ])
    await daemon.stop()
  })

  it('rejects a turn for an agent not on this daemon (accepted:false, reason no_agent)', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const ack = await (daemon as any).handleRelayMsg(rd({ op: 'turn', text: 'go' }, { agentId: 'ghost' }), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'no_agent' })
    await daemon.stop()
  })

  it('names a failed runtime start after the failure staged the agent out of the roster', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    const detail = 'Error: Missing optional dependency @openai/codex-linux-x64'
    ;(daemon as any).lastStartFailure.set(AGENT_ID, detail)
    // Exactly what agent/activate does when its start proof fails: fence the agent, then let
    // reconcile drop it from the roster. The cause must survive that removal to be reportable.
    ;(daemon as any).moveStagedAgents.add(AGENT_ID)
    await (daemon as any).reconcile()
    expect((daemon as any).agents.has(AGENT_ID)).toBe(false)

    const ack = await (daemon as any).handleRelayMsg(rd({ op: 'turn', text: 'go' }), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'start_failed', detail })
    await daemon.stop()
  })

  it('forgets a start failure once the agent is genuinely removed', async () => {
    const { factory } = streamingHost([])
    const root = scaffold()
    const daemon = new Daemon({ root, hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    ;(daemon as any).lastStartFailure.set(AGENT_ID, 'Error: Missing optional dependency x')
    await (daemon as any).reconcile()
    expect((daemon as any).lastStartFailure.has(AGENT_ID)).toBe(true)

    rmSync(join(root, 'agents', AGENT_ID), { recursive: true, force: true })
    await (daemon as any).reconcile()

    expect((daemon as any).agents.has(AGENT_ID)).toBe(false)
    expect((daemon as any).lastStartFailure.has(AGENT_ID)).toBe(false)
    await daemon.stop()
  })

  it('routes each session-control op to its key-based core under the webchat session key', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    await (daemon as any).store.upsertSession({
      key,
      agentId: AGENT_ID,
      platform: 'webchat',
      channel: CONV,
      thread: `webchat:${CONV}`,
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    ;(daemon as any).agents.get(AGENT_ID).allowRuntimeChangesInChat = true

    const setModel = vi.spyOn((daemon as any).commands, 'setModelByKey')
    const setEffort = vi.spyOn((daemon as any).commands, 'setEffortByKey')
    const setPerm = vi.spyOn((daemon as any).commands, 'setPermissionModeByKey')
    const setFast = vi.spyOn((daemon as any).commands, 'setFastByKey')

    // Each op needs a distinct msgId — a repeated (sessionKey,msgId) is deduped by design.
    expect(
      await (daemon as any).handleRelayMsg(rd({ op: 'set_model', model: 'b' }, { msgId: 'm-model' }), () => {})
    ).toEqual({
      msgId: 'm-model',
      accepted: true
    })
    await (daemon as any).handleRelayMsg(rd({ op: 'set_effort', effort: 'high' }, { msgId: 'm-effort' }), () => {})
    await (daemon as any).handleRelayMsg(
      rd({ op: 'set_permission_mode', permissionMode: 'plan' }, { msgId: 'm-perm' }),
      () => {}
    )
    await (daemon as any).handleRelayMsg(rd({ op: 'set_fast', fastMode: true }, { msgId: 'm-fast' }), () => {})

    expect(setModel).toHaveBeenCalledWith(key, 'b')
    expect(setEffort).toHaveBeenCalledWith(key, 'high')
    expect(setPerm).toHaveBeenCalledWith(key, 'plan')
    expect(setFast).toHaveBeenCalledWith(key, true)
    await daemon.stop()
  })

  it('rejects every runtime-control op when chat changes are disabled', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
    await (daemon as any).store.upsertSession({
      key,
      agentId: AGENT_ID,
      platform: 'webchat',
      channel: CONV,
      thread: `webchat:${CONV}`,
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })

    const ops: RdMsgWebchat['payload'][] = [
      { op: 'set_model', model: 'b' },
      { op: 'set_effort', effort: 'high' },
      { op: 'set_permission_mode', permissionMode: 'plan' },
      { op: 'set_fast', fastMode: true }
    ]
    for (const [index, payload] of ops.entries()) {
      expect(
        await (daemon as any).handleRelayMsg(rd(payload, { msgId: `runtime-change-${index}` }), () => {})
      ).toMatchObject({
        accepted: false,
        reason: 'runtime changes are disabled in chat'
      })
    }
    expect(await (daemon as any).store.getModelOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getEffortOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getPermissionModeOverride(key)).toBeUndefined()
    expect(await (daemon as any).store.getFastModeOverride(key)).toBeUndefined()
    await daemon.stop()
  })

  it('routes cancel/close to their handlers by chatId', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    const cancel = vi.spyOn((daemon as any).webchatTransport, 'handleWebchatCancel')
    const close = vi.spyOn((daemon as any).webchatTransport, 'handleWebchatClose')

    expect(await (daemon as any).handleRelayMsg(rd({ op: 'cancel' }, { msgId: 'm-cancel' }), () => {})).toEqual({
      msgId: 'm-cancel',
      accepted: true
    })
    expect(await (daemon as any).handleRelayMsg(rd({ op: 'close' }, { msgId: 'm-close' }), () => {})).toEqual({
      msgId: 'm-close',
      accepted: true
    })
    // Cancel is agent-scoped now: the relay addresses each participant daemon
    // with its own agent, so the frame's agentId rides along.
    expect(cancel).toHaveBeenCalledWith(CONV, AGENT_ID)
    expect(close).toHaveBeenCalledWith(CONV)
    await daemon.stop()
  })

  it('dedups a retransmitted rd/msg (same sessionKey,msgId) — dispatches once, replays the ack', async () => {
    const { factory } = streamingHost([text('once')])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    const spy = vi.spyOn((daemon as any).webchatTransport, 'dispatchWebchatTurn')

    // The relay's at-least-once wire can re-send a byte-identical rd/msg on an ack stall.
    const frame = rd({ op: 'turn', text: 'go', user: 'ada' }, { msgId: 'dup-1' })
    const a1 = await (daemon as any).handleRelayMsg(frame, () => {})
    const a2 = await (daemon as any).handleRelayMsg(frame, () => {}) // retransmit — must NOT re-run the turn

    expect(spy).toHaveBeenCalledTimes(1) // dispatched exactly once
    expect(a2).toEqual(a1) // same ack (same turnId) replayed so the relay settles
    await daemon.stop()
  })

  it('rejects a turn while draining (accepted:false, reason draining) — no turn dispatched', async () => {
    const { factory } = streamingHost([])
    const daemon = new Daemon({ root: scaffold(), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    ;(daemon as any).draining = true // whole-daemon drain (SIGTERM / scope:daemon)
    const dispatch = vi.spyOn(daemon as any, 'dispatch')

    const ack = await (daemon as any).handleRelayMsg(rd({ op: 'turn', text: 'go' }, { msgId: 'drn-1' }), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'draining' })
    expect(dispatch).not.toHaveBeenCalled() // no turn started — the browser gets a terminal ack
    await daemon.stop()
  })
})

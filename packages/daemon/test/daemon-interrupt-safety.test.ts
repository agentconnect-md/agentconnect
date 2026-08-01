import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { sessionKey } from '../src/store/local-store.js'
import { FakeClock } from './cp/fake-clock.js'

const AGENT_ID = 'bot-a'
const CONV_1 = '11111111-1111-4111-8111-111111111111'
const CONV_2 = '22222222-2222-4222-8222-222222222222'

function hasPending(daemon: Daemon, acpSessionId: string): boolean {
  return [...(daemon as any).pending.values()].some(
    (pending: any) => pending.agentId === AGENT_ID && pending.acpSessionId === acpSessionId
  )
}

function scaffold(limits: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-interrupt-safety-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } },
      limits
    })
  )
  const agentDir = join(root, 'agents', AGENT_ID)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function updateAgent(root: string, patch: Record<string, unknown>): void {
  const file = join(root, 'agents', AGENT_ID, 'agent.json')
  const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...current, ...patch }))
}

function webchatSink() {
  const outputs: unknown[] = []
  const dones: Array<{ conversationId: string; turnId: string; error?: string; stopReason?: string }> = []
  return {
    outputs,
    dones,
    sink: {
      output: (event: unknown) => outputs.push(event),
      done: (event: { conversationId: string; turnId: string; error?: string; stopReason?: string }) =>
        dones.push(event)
    }
  }
}

const dm = (channel: string, thread: string, ts: string, text: string) => ({
  msgId: `slack:${channel}:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel,
  thread,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

describe('Daemon interrupt safety gates', () => {
  it('emits one webchat done when cancel lands after Pending but before prompt', async () => {
    let releaseOverride!: () => void
    const overrideBlocked = new Promise<void>((resolve) => (releaseOverride = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-pre-prompt'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      setSessionModel: vi.fn(async () => {
        await overrideBlocked
        return true
      }),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    const stream = webchatSink()
    await daemon.start()
    ;(daemon as any).agents.get(AGENT_ID).allowRuntimeChangesInChat = true

    try {
      const key = (daemon as any).webchatSessionKey(CONV_1, AGENT_ID)
      ;(daemon as any).store.upsertSession({
        key,
        agentId: AGENT_ID,
        platform: 'webchat',
        channel: CONV_1,
        thread: `webchat:${CONV_1}`,
        acpSessionId: 'acp-pre-prompt',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      ;(daemon as any).store.setModelOverride(key, 'blocked-model')
      const ack = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'first', 'alice', stream.sink)
      await vi.waitFor(() => expect(host.setSessionModel).toHaveBeenCalled())
      expect(hasPending(daemon, 'acp-pre-prompt')).toBe(true)

      ;(daemon as any).handleWebchatCancel(CONV_1)
      expect(stream.dones).toEqual([expect.objectContaining({ turnId: ack.turnId, error: 'cancel' })])
      releaseOverride()

      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0))
      expect(stream.dones).toHaveLength(1)
      expect(host.prompt).not.toHaveBeenCalled()
    } finally {
      releaseOverride()
      await daemon.stop()
    }
  }, 15_000)

  it('rejects an immediate webchat retry until the cancelled turn has fully unwound', async () => {
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    let nextSession = 0
    let promptCalls = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++nextSession}`),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => {
        if (++promptCalls === 1) await firstBlocked
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    const stream = webchatSink()
    await daemon.start()

    try {
      const first = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'first', 'alice', stream.sink)
      expect(first.accepted).toBe(true)
      await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true))

      ;(daemon as any).handleWebchatCancel(CONV_1)
      expect(host.cancel).toHaveBeenCalledWith('acp-1')

      // The cancel backstop is host-wide. Until the old prompt has yielded, accepting
      // work even in another conversation could let that backstop kill the fresh turn.
      const tooEarly = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_2, 'too early', 'alice', stream.sink)
      expect(tooEarly).toMatchObject({ accepted: false, reason: 'busy' })
      expect(host.newSession).toHaveBeenCalledTimes(1)

      releaseFirst()
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0))

      const fresh = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_2, 'fresh', 'alice', stream.sink)
      expect(fresh.accepted).toBe(true)
      await vi.waitFor(() =>
        expect(stream.dones).toContainEqual(
          expect.objectContaining({ conversationId: CONV_2, turnId: fresh.turnId, stopReason: 'end_turn' })
        )
      )
      expect(host.prompt).toHaveBeenCalledTimes(2)
    } finally {
      releaseFirst()
      await daemon.stop()
    }
  }, 15_000)

  it('keeps an unrelated active session MCP-capable and drains its queued work after T1 trips', async () => {
    let releaseT1!: () => void
    let releaseT2!: () => void
    const t1Blocked = new Promise<void>((resolve) => (releaseT1 = resolve))
    const t2Blocked = new Promise<void>((resolve) => (releaseT2 = resolve))
    let nextSession = 0
    let t2PromptCalls = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++nextSession}`),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async (sessionId: string) => {
        if (sessionId === 'acp-1') await t1Blocked
        if (sessionId === 'acp-2' && ++t2PromptCalls === 1) await t2Blocked
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()

    const t1Msg = dm('C1', 'T1', '100', 'T1 active')
    const t2Msg = dm('C2', 'T2', '200', 'T2 active')
    const t2QueuedMsg = dm('C2', 'T2', '300', 'T2 queued')
    const t1 = (daemon as any).dispatch(AGENT_ID, t1Msg)
    let t2: Promise<unknown> | undefined
    let t2Queued: Promise<unknown> | undefined

    try {
      await vi.waitFor(() => expect(hasPending(daemon, 'acp-1')).toBe(true))
      t2 = (daemon as any).dispatch(AGENT_ID, t2Msg)
      await vi.waitFor(() => expect(hasPending(daemon, 'acp-2')).toBe(true))
      // DMs start private. Model the CP publishing this unrelated session so
      // the memory assertion below tests cancellation isolation, not privacy.
      expect((daemon as any).store.applyCpCaptureGate('acp-2', false, 1)).toBe('applied')
      t2Queued = (daemon as any).dispatch(AGENT_ID, t2QueuedMsg)
      const t2Key = sessionKey('slack', 'C2', 'T2', AGENT_ID)
      expect((daemon as any).serialQueue.get(t2Key)).toHaveLength(1)

      const scope = 'slack:C1:dm'
      ;(daemon as any).store.tripLoopGuard(scope, 1_000, 'automatic_turn_burst')
      ;(daemon as any).onLoopGuardTripped(scope, 'automatic_turn_burst', { agentId: AGENT_ID, msg: t1Msg })
      expect(host.cancel).toHaveBeenCalledWith('acp-1')

      // T1's conversation-scoped cancellation must not poison bridge tools in the
      // already-running T2 session on the same agent.
      const t2Context: SessionContext = {
        agentId: AGENT_ID,
        platform: 'slack',
        isDm: false,
        channel: 'C2',
        thread: 'T2',
        tools: []
      }
      await expect(executeTool(t2Context, 'readMemory', {}, (daemon as any).mcp.deps)).resolves.toMatchObject({
        path: 'MEMORY.md'
      })

      // Nor may an agent-wide safety latch gate-drop work that T2 had already admitted.
      releaseT2()
      await expect(t2).resolves.toBe('acp-2')
      await expect(t2Queued).resolves.toBe('acp-2')
      expect(t2PromptCalls).toBe(2)
      expect(hasPending(daemon, 'acp-1')).toBe(true)

      releaseT1()
      await expect(t1).resolves.toBeNull()
    } finally {
      releaseT1()
      releaseT2()
      await Promise.allSettled([t1, ...(t2 ? [t2] : []), ...(t2Queued ? [t2Queued] : [])])
      await daemon.stop()
    }
  }, 15_000)

  it('force-stops a host when a cancelled cold pre-Pending session/new never returns', async () => {
    const clock = new FakeClock()
    let rejectSession!: (reason: Error) => void
    const sessionBlocked = new Promise<never>((_resolve, reject) => (rejectSession = reject))
    let sessionSettled = false
    const settleSession = () => {
      if (sessionSettled) return
      sessionSettled = true
      rejectSession(new Error('host force-stopped'))
    }
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => sessionBlocked),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => settleSession())
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any, clock })
    const stream = webchatSink()
    await daemon.start()

    try {
      const ack = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'cold', 'alice', stream.sink)
      expect(ack.accepted).toBe(true)
      await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1))
      expect((daemon as any).pending.size).toBe(0)

      ;(daemon as any).handleWebchatCancel(CONV_1)
      expect(host.cancel).not.toHaveBeenCalled()
      expect(stream.dones).toEqual([expect.objectContaining({ turnId: ack.turnId, error: 'cancel' })])

      clock.advance(30_000)
      await vi.waitFor(() => expect(host.stop).toHaveBeenCalled())
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0))
      expect(host.prompt).not.toHaveBeenCalled()
      expect(stream.dones).toHaveLength(1)
    } finally {
      settleSession()
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0)).catch(() => {})
      await daemon.stop()
    }
  }, 15_000)

  it('bounds a cancelled cold non-host initialization await with the same backstop', async () => {
    const clock = new FakeClock()
    const memoryBlocked = new Promise<string>(() => {})
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'must-not-start'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any, clock })
    const stream = webchatSink()
    await daemon.start()
    const standingContext = vi.fn(() => memoryBlocked)
    ;(daemon as any).memory.standingContextAtSessionStart = standingContext
    const key = (daemon as any).webchatSessionKey(CONV_1, AGENT_ID)
    ;(daemon as any).store.upsertSession({
      key,
      agentId: AGENT_ID,
      platform: 'webchat',
      channel: CONV_1,
      thread: `webchat:${CONV_1}`,
      acpSessionId: 'acp-memory',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    expect((daemon as any).store.applyCpCaptureGate('acp-memory', false, 1)).toBe('applied')

    const ack = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'cold memory', 'alice', stream.sink)
    await vi.waitFor(() => expect(standingContext).toHaveBeenCalled())
    ;(daemon as any).handleWebchatCancel(CONV_1)
    expect(stream.dones).toEqual([expect.objectContaining({ turnId: ack.turnId, error: 'cancel' })])

    clock.advance(30_000)
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalled())
    await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0))
    expect(host.newSession).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()

    await daemon.stop()
  }, 15_000)

  it('keeps admission fail-closed when the cold force-stop itself fails', async () => {
    const clock = new FakeClock()
    let releaseSession!: () => void
    const sessionBlocked = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => {
        await sessionBlocked
        return 'late-session'
      }),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        throw new Error('cannot stop child')
      })
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any, clock })
    const stream = webchatSink()
    await daemon.start()

    try {
      const ack = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'cold', 'alice', stream.sink)
      expect(ack.accepted).toBe(true)
      await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1))

      ;(daemon as any).handleWebchatCancel(CONV_1)
      clock.advance(30_000)
      await vi.waitFor(() => expect(host.stop).toHaveBeenCalledTimes(1))
      expect((daemon as any).inflight.size).toBe(1)

      expect((daemon as any).safetyDrainingAgents.has(AGENT_ID)).toBe(true)
      const retry = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_2, 'must stay blocked', 'alice', stream.sink)
      expect(retry).toMatchObject({ accepted: false, reason: 'busy' })
      expect(host.newSession).toHaveBeenCalledTimes(1)
    } finally {
      releaseSession()
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0)).catch(() => {})
      await daemon.stop()
    }
  }, 15_000)

  it('keeps host respawn gated until an existing host teardown settles', async () => {
    let releaseStop!: () => void
    const stopBlocked = new Promise<void>((resolve) => (releaseStop = resolve))
    const host1 = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-old'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => stopBlocked)
    }
    const host2 = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-new'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const hosts = [host1, host2]
    const factory = vi.fn(() => hosts.shift()!)
    const root = scaffold()
    const daemon = new Daemon({ root, hostFactory: () => factory() as any })
    await daemon.start()
    await (daemon as any).watcher.close()
    ;(daemon as any).watcher = undefined
    let priorStop: Promise<void> | undefined
    let staleEnsure: Promise<unknown> | undefined
    let reconciling: Promise<void> | undefined

    try {
      await expect((daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'warm'))).resolves.toBe('acp-old')
      priorStop = (daemon as any).stopHost(AGENT_ID)
      await vi.waitFor(() => expect(host1.stop).toHaveBeenCalledTimes(1))
      // This already-admitted resource request is waiting on the first teardown
      // before reconcile installs its agent gate.
      staleEnsure = (daemon as any).ensureHostAsync(AGENT_ID)

      updateAgent(root, {
        workspace: { mode: 'from-scratch', path: join(root, 'agents', AGENT_ID, 'workspace-new') }
      })
      reconciling = daemon.reconcile()
      await vi.waitFor(() => expect((daemon as any).drainingAgents.has(AGENT_ID)).toBe(true))

      await expect((daemon as any).dispatch(AGENT_ID, dm('C2', 'T2', '200', 'during stop'))).resolves.toBeNull()
      await expect((daemon as any).ensureHostAsync(AGENT_ID)).rejects.toThrow(/draining/)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(host2.start).not.toHaveBeenCalled()

      const staleEnsureFailure = expect(staleEnsure).rejects.toThrow(/draining/)
      releaseStop()
      await staleEnsureFailure
      await priorStop
      await reconciling
      await expect((daemon as any).dispatch(AGENT_ID, dm('C2', 'T2', '300', 'fresh'))).resolves.toBe('acp-new')
      expect(host2.start).toHaveBeenCalledTimes(1)
    } finally {
      releaseStop()
      await Promise.allSettled([
        ...(priorStop ? [priorStop] : []),
        ...(staleEnsure ? [staleEnsure] : []),
        ...(reconciling ? [reconciling] : [])
      ])
      await daemon.stop()
    }
  }, 15_000)

  it('removes and gates an agent before awaiting its reconcile teardown', async () => {
    let releaseStop!: () => void
    const stopBlocked = new Promise<void>((resolve) => (releaseStop = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-old'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => stopBlocked)
    }
    const factory = vi.fn(() => host)
    const root = scaffold()
    const daemon = new Daemon({ root, hostFactory: () => factory() as any })
    await daemon.start()
    await (daemon as any).watcher.close()
    ;(daemon as any).watcher = undefined
    let reconciling: Promise<void> | undefined

    try {
      await expect((daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'warm'))).resolves.toBe('acp-old')
      updateAgent(root, { status: 'inactive' })
      reconciling = daemon.reconcile()
      await vi.waitFor(() => expect(host.stop).toHaveBeenCalledTimes(1))

      expect((daemon as any).agents.has(AGENT_ID)).toBe(false)
      expect((daemon as any).drainingAgents.has(AGENT_ID)).toBe(true)
      await expect((daemon as any).dispatch(AGENT_ID, dm('C2', 'T2', '200', 'during removal'))).resolves.toBeNull()
      expect(factory).toHaveBeenCalledTimes(1)

      releaseStop()
      await reconciling
      expect((daemon as any).drainingAgents.has(AGENT_ID)).toBe(false)
    } finally {
      releaseStop()
      await Promise.allSettled(reconciling ? [reconciling] : [])
      await daemon.stop()
    }
  }, 15_000)

  it('releases the admission gate when a host-respawn teardown rejects (no permanent dark)', async () => {
    // Regression: a config PATCH that changed a hostSpawnSig field triggered a host
    // respawn whose teardown REJECTED (real incident: claude-agent-acp "Query closed
    // before response received"). The bare `await stopHost` rethrew, so the agent was
    // left latched in drainingAgents forever — every later inbound was silently dropped
    // as `draining` until the next daemon restart — and the throw aborted the rest of
    // the reconcile batch.
    const host1 = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-old'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        throw new Error('Query closed before response received')
      })
    }
    const host2 = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-new'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const hosts = [host1, host2]
    const factory = vi.fn(() => hosts.shift()!)
    const root = scaffold()
    const daemon = new Daemon({ root, hostFactory: () => factory() as any })
    await daemon.start()
    await (daemon as any).watcher.close()
    ;(daemon as any).watcher = undefined
    const errors: string[] = []
    vi.spyOn((daemon as any).log, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]))
    })

    try {
      // Warm host1 so the respawn has a cached host to tear down.
      await expect((daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'warm'))).resolves.toBe('acp-old')

      // `description` ∈ hostSpawnSig → hostRespawn; host1.stop() rejects mid-teardown.
      updateAgent(root, { description: 'be terse' })
      await expect(daemon.reconcile()).resolves.toBeUndefined()

      // The rejected teardown is surfaced, not swallowed…
      expect(host1.stop).toHaveBeenCalledTimes(1)
      expect(errors.some((e) => /host teardown failed/.test(e))).toBe(true)
      // …and the admission gate is released rather than latched forever, and the stale
      // host was evicted so the next session spawns fresh.
      expect((daemon as any).drainingAgents.has(AGENT_ID)).toBe(false)
      expect((daemon as any).hosts.has(AGENT_ID)).toBe(false)

      // Recovery: the next message spawns host2 and is served (pre-fix: dropped forever).
      await expect((daemon as any).dispatch(AGENT_ID, dm('C2', 'T2', '200', 'after respawn'))).resolves.toBe('acp-new')
      expect(host2.start).toHaveBeenCalledTimes(1)
    } finally {
      await daemon.stop()
    }
  }, 15_000)

  it('shares one Slack top-level loop circuit across agents and fresh message roots', async () => {
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
    let sessions = 0
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root, hostFactory: () => host as any })
    await daemon.start()
    // Per-turn config rematerialization touches agents/**; on a slow runner the
    // debounced file-watch reconcile can then land mid-loop and revert the
    // in-memory integrations injected below (session source turns 'unavailable').
    await (daemon as any).watcher.close()
    ;(daemon as any).watcher = undefined
    clearTimeout((daemon as any).debounceTimer)
    for (const [agentId, integrationId] of [
      [AGENT_ID, 'int-a'],
      ['bot-b', 'int-b']
    ] as const) {
      ;(daemon as any).agents.get(agentId).integrations = [
        {
          id: integrationId,
          platform: 'slack',
          slack: { mode: 'direct', botToken: `b-${agentId}`, appToken: `p-${agentId}`, bindRules: [] }
        }
      ]
      ;(daemon as any).connByIntegration.set(integrationId, {
        workspaceId: vi.fn(() => 'T1'),
        setStatus: vi.fn(async () => {}),
        postMessage: vi.fn(async () => undefined)
      })
    }

    try {
      const topLevelMention = (n: number) => {
        const ts = String(n)
        const targetAgent = n % 2 === 1 ? AGENT_ID : 'bot-b'
        return {
          targetAgent,
          msg: {
            msgId: `slack:C-loop:${ts}`,
            traceId: ts,
            source: 'user' as const,
            platform: 'slack' as const,
            channel: 'C-loop',
            thread: ts,
            sender: { id: n % 2 === 1 ? 'UBOTB' : 'UBOTA', isBot: true },
            text: `<@${targetAgent}> continue`,
            mentionedBots: [targetAgent],
            isDm: false,
            trigger: 'mention' as const
          }
        }
      }

      for (let n = 1; n <= 8; n++) {
        const { targetAgent, msg } = topLevelMention(n)
        await expect((daemon as any).dispatch(targetAgent, msg)).resolves.toEqual(expect.any(String))
      }
      const ninth = topLevelMention(9)
      await expect((daemon as any).dispatch(ninth.targetAgent, ninth.msg)).resolves.toBeNull()

      expect((daemon as any).store.isLoopGuardOpen('slack:C-loop:top-level')).toBe(true)
      expect(host.prompt).toHaveBeenCalledTimes(8)

      // A genuine reply remains scoped to its thread and is not blocked by the
      // separate channel top-level circuit.
      await expect(
        (daemon as any).dispatch(AGENT_ID, {
          ...ninth.msg,
          msgId: 'slack:C-loop:reply-1',
          traceId: 'reply-1',
          thread: '1',
          sender: { id: 'U1', isBot: false },
          text: 'human thread reply'
        })
      ).resolves.toEqual(expect.any(String))
      expect(host.prompt).toHaveBeenCalledTimes(9)

      const agent = (daemon as any).agents.get(AGENT_ID)
      agent.integrations = [
        {
          id: 'int-a',
          platform: 'slack',
          slack: {
            botToken: 'xoxb-test',
            appToken: 'xapp-test',
            botUserId: 'UBOTA',
            allowedUserIds: ['U1'],
            bindRules: [{ match: { kind: 'mention' } }]
          }
        }
      ]
      const conn = { postMessage: vi.fn(async () => {}), setStatus: vi.fn(async () => {}) }
      ;(daemon as any).connByIntegration.set('int-a', conn)
      ;(daemon as any).handleCommand(
        { kind: 'resume' },
        {
          ...ninth.msg,
          msgId: 'slack:C-loop:resume',
          traceId: 'resume',
          thread: '9',
          sender: { id: 'U1', isBot: false },
          text: '!resume'
        },
        { agentId: AGENT_ID, integrationId: 'int-a', via: 'mention' }
      )
      expect((daemon as any).store.isLoopGuardOpen('slack:C-loop:top-level')).toBe(false)
      expect(conn.postMessage).toHaveBeenCalledWith('C-loop', expect.stringContaining('Resumed'), '9')
    } finally {
      await daemon.stop()
    }
  }, 15_000)

  it('cancels a cold host-start backoff and settles the dispatch before closing the store', async () => {
    const clock = new FakeClock()
    const failedHost = {
      start: vi.fn(async () => {
        throw new Error('first start failed')
      }),
      newSession: vi.fn(async () => 'must-not-start'),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const forbiddenRetry = {
      ...failedHost,
      start: vi.fn(async () => {})
    }
    const hosts = [failedHost, forbiddenRetry]
    const factory = vi.fn(() => hosts.shift()!)
    const root = scaffold({
      agentStartAttempts: 2,
      agentStartBackoffMs: 60_000,
      idleSweepMs: 30_000,
      shutdownDrainMs: 1_000
    })
    const daemon = new Daemon({ root, hostFactory: () => factory() as any, clock })
    await daemon.start()
    const store = (daemon as any).store
    const closeStore = store.close.bind(store)
    const closeSpy = vi.spyOn(store, 'close').mockImplementation(() => {
      expect((daemon as any).activeDispatchesByAgent.size).toBe(0)
      closeStore()
    })
    const turn = (daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'cold startup'))
    let stopped = false

    try {
      await vi.waitFor(() => expect(failedHost.start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(clock.pending()).toContain(60_000))
      await expect(daemon.stop()).resolves.toBeUndefined()
      stopped = true
      await expect(turn).resolves.toBeNull()

      expect(closeSpy).toHaveBeenCalledTimes(1)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(clock.pending()).not.toContain(60_000)
      expect(forbiddenRetry.start).not.toHaveBeenCalled()
    } finally {
      if (!stopped) await daemon.stop().catch(() => {})
    }
  }, 15_000)

  it('emits exactly one terminal webchat frame when shutdown aborts a cold turn', async () => {
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => new Promise<string>(() => {})),
      hasSession: vi.fn(() => true),
      modelOptions: vi.fn(() => null),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    const stream = webchatSink()
    await daemon.start()

    const ack = (daemon as any).dispatchWebchatTurn(AGENT_ID, CONV_1, 'cold shutdown', 'alice', stream.sink)
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledTimes(1))
    await daemon.stop()

    expect(stream.dones).toEqual([
      expect.objectContaining({ conversationId: CONV_1, turnId: ack.turnId, error: 'shutdown' })
    ])
    expect((daemon as any).activeDispatchesByAgent.size).toBe(0)
  }, 15_000)
})

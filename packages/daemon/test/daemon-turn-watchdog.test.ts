import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { FailStopError } from '../src/daemon/turn-types.js'
import { sessionKey } from '../src/store/local-store.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// #1915: a stalled session/prompt never returns and the SDK lease hides it from the idle sweep; the watchdog cancels it like `!stop`.
const AGENT_ID = 'bot-a'
const CONV = '11111111-1111-4111-8111-111111111111'
const LIMITS = { turnStallTimeoutMs: 60_000, idleSweepMs: 10_000, cancelBackstopMs: 5_000 }

function scaffold(limits: Record<string, number> = LIMITS): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-turn-watchdog-'))
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

/** Every prompt hangs; `cancel` yields it as cancelled unless ignored, and a force-stop rejects what is still hung. */
function hangingHost(opts: { ignoreCancel?: boolean } = {}) {
  const hung = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  let onUpdate: ((sid: string, update: unknown) => void) | undefined
  let nextSession = 0
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++nextSession}`),
    hasSession: vi.fn(() => true),
    forgetSession: vi.fn(),
    modelOptions: vi.fn(() => null),
    prompt: vi.fn((sid: string) => new Promise((resolve, reject) => hung.set(sid, { resolve, reject }))),
    cancel: vi.fn(async (sid: string) => {
      if (!opts.ignoreCancel) hung.get(sid)?.resolve({ stopReason: 'cancelled' })
    }),
    stop: vi.fn(async () => {
      for (const [, pending] of hung) pending.reject(new Error('host force-stopped'))
      hung.clear()
    })
  }
  return {
    host,
    update: (sid: string, update: unknown) => onUpdate?.(sid, update),
    factory: (_agent: unknown, cb: (sid: string, update: unknown) => void) => {
      onUpdate = cb
      return host as any
    }
  }
}

function webchatSink() {
  const dones: Array<{ conversationId: string; turnId: string; error?: string; stopReason?: string }> = []
  return {
    dones,
    sink: {
      output: () => {},
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

/** The idle sweep re-arms itself after each async run, so the clock moves one sweep at a time. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += LIMITS.idleSweepMs) {
    clock.advance(LIMITS.idleSweepMs)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function startDaemon(opts: { ignoreCancel?: boolean; limits?: Record<string, number> } = {}) {
  const clock = new FakeClock()
  const runtime = hangingHost({ ignoreCancel: opts.ignoreCancel === true })
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root: scaffold(opts.limits),
    hostFactory: runtime.factory,
    clock
  })
  await daemon.start()
  const warn = vi.spyOn((daemon as any).log, 'warn')
  return { clock, daemon, warn, ...runtime }
}

describe('turn stall watchdog', () => {
  it('cancels a prompt that has gone silent past the budget and tells the conversation why', async () => {
    const { clock, daemon, host, warn } = await startDaemon()
    const stream = webchatSink()
    try {
      const ack = await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'hello',
        { id: 'alice', name: 'alice' },
        stream.sink
      )
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

      // Under budget: a slow turn is left alone.
      await advance(clock, 50_000)
      expect(host.cancel).not.toHaveBeenCalled()

      await advance(clock, 20_000)
      await vi.waitFor(() => expect(host.cancel).toHaveBeenCalledWith('acp-1'), WAIT)
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/turn watchdog: session .* \(acp-1\) has had no runtime activity for 1 min/)
      )
      // Exactly one terminal frame for the browser, and it says what happened.
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
      expect(stream.dones).toEqual([
        expect.objectContaining({ turnId: ack.turnId, error: expect.stringMatching(/cancelled as stalled/) })
      ])
      const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
      const rec = await (daemon as any).store.getSession(key)
      expect(rec?.state).toBe('idle')
      // A stall is the turn's own failure: a parent reading the child's status must not see `done`.
      expect(rec?.lastTurnOutcome).toBe('failed')
    } finally {
      await daemon.stop()
    }
  })

  it('restarts the budget when any human card settles, and never interrupts a successor turn', async () => {
    const { clock, daemon, host } = await startDaemon()
    const stream = webchatSink()
    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'hello',
        { id: 'alice', name: 'alice' },
        stream.sink
      )
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
      const pending = [...(daemon as any).pending.values()][0] as { hostKey: unknown; runtimeActivityAt?: number }

      // An ordinary elicitation (no approval meter) answered 50s in: the gate closing restamps activity.
      await advance(clock, 50_000)
      ;(daemon as any).permissions.syncApprovalActivity(pending.hostKey, 'acp-1', { id: 'q1' })
      expect(pending.runtimeActivityAt).toBe(clock.now())
      await advance(clock, 50_000)
      expect(host.cancel).not.toHaveBeenCalled()

      // A stale target — the interrupt is aimed at a Pending that is no longer the live one — is a no-op.
      const key = (daemon as any).webchatTransport.webchatSessionKey(CONV, AGENT_ID)
      await (daemon as any).interruptTurn(AGENT_ID, key, 'stalled', 'acp-1', { only: {} })
      expect(host.cancel).not.toHaveBeenCalled()
      expect(stream.dones).toEqual([])

      // The target unwinds and a successor takes its ACP id DURING the interrupt's own awaits: the
      // cancel, the state write, and the backstop must all stay off the successor.
      const map = (daemon as any).pending as Map<string, object>
      const pendingKey = [...map.keys()][0]!
      const successor = { ...(pending as object) }
      vi.spyOn((daemon as any).permissions, 'releaseElicits').mockImplementationOnce(async () => {
        map.set(pendingKey, successor)
      })
      await (daemon as any).interruptTurn(AGENT_ID, key, 'stalled', 'acp-1', { only: pending })
      expect(host.cancel).not.toHaveBeenCalled()
      expect((await (daemon as any).store.getSession(key))?.state).not.toBe('cancelling')
      ;(daemon as any).armCancelBackstop(pending.hostKey, 'acp-1', key, 'stalled', pending)
      clock.advance(LIMITS.cancelBackstopMs)
      expect(host.stop).not.toHaveBeenCalled()
      map.set(pendingKey, pending)
      // The target itself was owned (suppressed) before the interrupt yielded; let the runtime unwind it.
      expect((pending as { outputSuppressed?: string }).outputSuppressed).toBe('stalled')
      await host.cancel('acp-1')
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
      expect(stream.dones).toEqual([expect.objectContaining({ error: 'stalled' })])
    } finally {
      await daemon.stop()
    }
  })

  it('force-stops a runtime that ignores the cancel and fail-stops the messages queued behind the stall', async () => {
    const { clock, daemon, host } = await startDaemon({ ignoreCancel: true })
    const appended = vi.spyOn((daemon as any).store, 'appendTranscript')
    const first = (daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'first'))
    let second: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
      // Settled into a value up front: the rejection lands while the clock is still moving.
      second = (daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '200', 'second')).then(
        () => 'resolved',
        (err: unknown) => err
      )
      const key = sessionKey('slack', 'C1', 'T1', AGENT_ID)
      await vi.waitFor(() => expect((daemon as any).serialQueue.get(key)).toHaveLength(1), WAIT)

      // The prompt went out at t=0; the sweep at t=60s is the first to see a full budget of silence.
      await advance(clock, 60_000)
      await vi.waitFor(() => expect(host.cancel).toHaveBeenCalledWith('acp-1'), WAIT)
      // §6.9 fail-stop: what queued behind the dead turn is rejected, never run onto it.
      await expect(second).resolves.toBeInstanceOf(FailStopError)
      // The conversation was told, in the transcript at least (no reply transport is wired here).
      expect(appended).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringMatching(/⚠️ Agent failed to respond: .*cancelled as stalled/) })
      )

      // The runtime never yields to session/cancel: the same backstop `!stop` uses force-stops it.
      expect(host.stop).not.toHaveBeenCalled()
      clock.advance(LIMITS.cancelBackstopMs)
      await vi.waitFor(() => expect(host.stop).toHaveBeenCalled(), WAIT)
      await expect(first).resolves.toBeNull()
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    } finally {
      await Promise.allSettled([first, second])
      await daemon.stop()
    }
  })

  it('leaves a turn alone while the runtime streams or a human is being asked', async () => {
    const { clock, daemon, host, update } = await startDaemon()
    const stream = webchatSink()
    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'hello',
        { id: 'alice', name: 'alice' },
        stream.sink
      )
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

      // Three minutes of slow-but-live work: every update restarts the budget.
      for (let i = 0; i < 6; i++) {
        await advance(clock, 30_000)
        update('acp-1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'still here' } })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(host.cancel).not.toHaveBeenCalled()

      // A permission card the human has not answered is the human's time, not the runtime's.
      const pending = [...(daemon as any).pending.values()][0] as { approval: { depth: number } }
      pending.approval.depth = 1
      await advance(clock, 120_000)
      expect(host.cancel).not.toHaveBeenCalled()

      // Answered (the coordinator restamps activity when the wait closes) — then real silence trips.
      pending.approval.depth = 0
      ;(pending as { runtimeActivityAt?: number }).runtimeActivityAt = clock.now()
      await advance(clock, 70_000)
      await vi.waitFor(() => expect(host.cancel).toHaveBeenCalledWith('acp-1'), WAIT)
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
    } finally {
      await daemon.stop()
    }
  })

  it('is off when turnStallTimeoutMs is 0', async () => {
    const { clock, daemon, host } = await startDaemon({ limits: { ...LIMITS, turnStallTimeoutMs: 0 } })
    const stream = webchatSink()
    try {
      await (daemon as any).webchatTransport.dispatchWebchatTurn(
        AGENT_ID,
        CONV,
        'hello',
        { id: 'alice', name: 'alice' },
        stream.sink
      )
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
      await advance(clock, 600_000)
      expect(host.cancel).not.toHaveBeenCalled()
      expect(stream.dones).toEqual([])
    } finally {
      await (daemon as any).webchatTransport.handleWebchatCancel(CONV)
      await vi.waitFor(() => expect((daemon as any).inflight.size).toBe(0), WAIT)
      await daemon.stop()
    }
  })

  it('clears a session the runtime no longer has, so the next message opens a fresh one', async () => {
    const { daemon, host } = await startDaemon()
    host.prompt.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Internal error'), { code: -32603, data: { details: 'Session not found' } })
    })
    const first = (daemon as any).dispatch(AGENT_ID, dm('C1', 'T1', '100', 'first'))
    try {
      await first.catch(() => undefined)
      const key = sessionKey('slack', 'C1', 'T1', AGENT_ID)
      await vi.waitFor(async () => {
        const rec = await (daemon as any).store.getSession(key)
        expect(rec?.acpSessionId).toBeNull()
        expect(rec?.state).toBe('idle')
      }, WAIT)
      expect(host.forgetSession).toHaveBeenCalledWith('acp-1')
    } finally {
      await daemon.stop()
    }
  })
})

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { FakeClock } from './cp/fake-clock.js'
import { RuntimeSessionFailure } from '../src/acp/session-failure.js'

/**
 * Live-turn auth signal (issue: claude-agent-acp initializes, opens sessions,
 * and enumerates models fine while logged out — only the live prompt rejects
 * with ACP -32000). The daemon must learn login-required from real turns, not
 * just the probe sweep, and must clear the mark on the next successful turn.
 */

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-auth-'))
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
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** Attach a routable Slack integration + fake connection so the failure path
 *  (surface ⚠️ notice) has a transport to talk to, like daemon-transcript.test.ts. */
function makeRoutable(daemon: Daemon): void {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  let n = 0
  const conn = {
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn(async () => `reply-${++n}`),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {})
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
}

const dm = (ts: string, text: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

describe('live-turn runtime auth signal', () => {
  it('marks the runtime login-required on ACP -32000 and clears it on the next successful turn', async () => {
    const root = scaffold()
    const behaviors: Array<'generic' | 'auth' | 'ok' | 'oauth-expired'> = [
      'generic',
      'auth',
      'ok',
      'oauth-expired',
      'ok'
    ]
    let sessions = 0
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      prompt: vi.fn(async () => {
        const mode = behaviors.shift() ?? 'ok'
        if (mode === 'generic') throw new Error('runtime exploded')
        if (mode === 'auth') throw Object.assign(new Error('Authentication required'), { code: -32000 })
        if (mode === 'oauth-expired')
          // Observed live from claude-agent-acp 0.59.0: an expired-but-present
          // OAuth credential rejects the prompt -32603 with this wording (only
          // a FRESH logged-out credential uses -32000).
          throw Object.assign(
            new Error('Internal error: Failed to authenticate: OAuth session expired and could not be refreshed'),
            { code: -32603 }
          )
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    makeRoutable(daemon)
    const emitted: Array<Array<{ runtime: string; authRequired?: boolean }>> = []
    ;(daemon as any).cpClient = {
      emitDaemonRuntimes: (profiles: Array<{ runtime: string; authRequired?: boolean }>) => {
        emitted.push(profiles)
      },
      emitSessionActivity: vi.fn(),
      stop: vi.fn(async () => {})
    }

    try {
      // An ordinary turn failure is NOT an auth signal — no mark, no emit.
      await expect((daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')).rejects.toThrow('runtime exploded')
      expect((daemon as any).runtimeFacts.profileFor('claude').authRequired).toBeUndefined()
      expect(emitted.length).toBe(0)

      // ACP -32000 marks the agent's runtime and re-emits the facts snapshot.
      await expect((daemon as any).dispatch('bot-a', dm('200', 'q2'), 'int-a')).rejects.toMatchObject({
        code: -32000
      })
      expect((daemon as any).runtimeFacts.profileFor('claude')).toMatchObject({ authRequired: true })
      expect(emitted.length).toBe(1)
      expect(emitted[0]!.find((p) => p.runtime === 'claude')?.authRequired).toBe(true)

      // The next successful turn proves credentials work — mark cleared, flip emitted.
      await (daemon as any).dispatch('bot-a', dm('300', 'q3'), 'int-a')
      expect((daemon as any).runtimeFacts.profileFor('claude').authRequired).toBeUndefined()
      expect(emitted.length).toBe(2)
      expect(emitted[1]!.find((p) => p.runtime === 'claude')?.authRequired).toBeUndefined()

      // The expired-credential family (-32603 + auth wording) marks it too.
      await expect((daemon as any).dispatch('bot-a', dm('400', 'q4'), 'int-a')).rejects.toThrow(/OAuth session expired/)
      expect((daemon as any).runtimeFacts.profileFor('claude')).toMatchObject({ authRequired: true })
      expect(emitted.length).toBe(3)

      await (daemon as any).dispatch('bot-a', dm('500', 'q5'), 'int-a')
      expect((daemon as any).runtimeFacts.profileFor('claude').authRequired).toBeUndefined()
      expect(emitted.length).toBe(4)
    } finally {
      await daemon.stop()
    }
  })

  it('keeps the turn outcome intact when the facts emit throws (hot-path best-effort)', async () => {
    const root = scaffold()
    const behaviors: Array<'auth' | 'ok'> = ['auth', 'ok']
    let sessions = 0
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      prompt: vi.fn(async () => {
        if (behaviors.shift() === 'auth') throw Object.assign(new Error('Authentication required'), { code: -32000 })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => fakeHost as any })
    await daemon.start()
    makeRoutable(daemon)
    ;(daemon as any).cpClient = {
      emitDaemonRuntimes: () => {
        throw new Error('telemetry down')
      },
      emitSessionActivity: vi.fn(),
      stop: vi.fn(async () => {})
    }

    try {
      // The failed turn still rejects with ITS error (not the telemetry one),
      // and the flag still flips despite the emit throwing.
      await expect((daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')).rejects.toMatchObject({
        code: -32000
      })
      expect((daemon as any).runtimeFacts.profileFor('claude')).toMatchObject({ authRequired: true })
      // The successful turn still completes and clears the mark.
      await (daemon as any).dispatch('bot-a', dm('200', 'q2'), 'int-a')
      expect((daemon as any).runtimeFacts.profileFor('claude').authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })
})

describe('runtime prompt recovery', () => {
  const contended = () =>
    Object.assign(
      new Error(
        'Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'
      ),
      { code: -32603 }
    )

  async function start(prompt: (sessionId: string) => Promise<{ stopReason: string }>) {
    const clock = new FakeClock()
    let sessions = 0
    let emitUpdate!: (sessionId: string, update: unknown) => void
    const fakeHost = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      prompt: vi.fn(prompt),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      clock,
      hostFactory: (_agent, onUpdate) => {
        emitUpdate = onUpdate
        return fakeHost as any
      }
    })
    await daemon.start()
    makeRoutable(daemon)
    return { daemon, clock, fakeHost, emitUpdate: (sid: string, update: unknown) => emitUpdate(sid, update) }
  }

  // The daemon arms its own 60 s timers too, so wait for the retry's timer on top of those.
  async function advanceWhenArmed(clock: FakeClock, ms: number, before: number): Promise<void> {
    await vi.waitFor(() => expect(clock.pending().filter((t) => t === ms).length).toBeGreaterThan(before))
    clock.advance(ms)
  }

  const armed = (clock: FakeClock) => clock.pending().filter((t) => t === 60_000).length

  const recoverable = () =>
    new RuntimeSessionFailure({ category: 'service', title: 'Provider temporarily unavailable', actions: ['retry'] })

  it('reports failure after one automatic retry is exhausted', async () => {
    const { daemon, clock, fakeHost } = await start(async () => {
      throw recoverable()
    })
    try {
      const before = clock.pending().filter((t) => t === 5_000).length
      const turn = (daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')
      const settled = expect(turn).rejects.toThrow('Provider temporarily unavailable')
      await advanceWhenArmed(clock, 5_000, before)
      await settled
      expect(fakeHost.prompt).toHaveBeenCalledTimes(2)
      expect(fakeHost.prompt.mock.calls[1]).toEqual(fakeHost.prompt.mock.calls[0])
    } finally {
      await daemon.stop()
    }
  })

  it.each(['tool', 'tool_update', 'answer', 'request'] as const)(
    'does not retry after %s makes replay inappropriate',
    async (boundary) => {
      const { daemon, fakeHost, emitUpdate } = await start(async (sid) => {
        if (boundary === 'tool' || boundary === 'tool_update')
          emitUpdate(sid, {
            sessionUpdate: boundary === 'tool' ? 'tool_call' : 'tool_call_update',
            toolCallId: 't1',
            title: 'Write file',
            kind: 'edit',
            status: 'completed'
          })
        if (boundary === 'answer')
          emitUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial answer' } })
        throw boundary === 'request'
          ? new RuntimeSessionFailure({ category: 'request', title: 'Invalid model', actions: [] })
          : recoverable()
      })
      try {
        await expect((daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')).rejects.toBeInstanceOf(
          RuntimeSessionFailure
        )
        expect(fakeHost.prompt).toHaveBeenCalledOnce()
      } finally {
        await daemon.stop()
      }
    }
  )

  it('does not restart a turn cancelled during retry backoff', async () => {
    const { daemon, clock, fakeHost } = await start(async () => {
      throw recoverable()
    })
    try {
      const before = clock.pending().filter((t) => t === 5_000).length
      const turn = (daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')
      await vi.waitFor(() => expect(clock.pending().filter((t) => t === 5_000).length).toBeGreaterThan(before))
      const pending = [...(daemon as any).pending.values()][0] as any
      await (daemon as any).interruptTurn('bot-a', pending.plan.sessionKey, 'cancel', pending.acpSessionId)
      clock.advance(5_000)
      await turn
      expect(fakeHost.prompt).toHaveBeenCalledOnce()
    } finally {
      await daemon.stop()
    }
  })

  it('resends the prompt once after a minute when nothing ran yet', async () => {
    const outcomes = [contended, () => ({ stopReason: 'end_turn' })]
    const { daemon, clock, fakeHost } = await start(async () => {
      const next = outcomes.shift()!()
      if (next instanceof Error) throw next
      return next
    })
    try {
      const before = armed(clock)
      const turn = (daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')
      await advanceWhenArmed(clock, 60_000, before)
      await turn
      expect(fakeHost.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await daemon.stop()
    }
  })

  it('surfaces the failure when the retry is contended again', async () => {
    const { daemon, clock, fakeHost } = await start(async () => {
      throw contended()
    })
    try {
      const before = armed(clock)
      const turn = (daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')
      const settled = expect(turn).rejects.toThrow(/another Claude Code process/)
      await advanceWhenArmed(clock, 60_000, before)
      await settled
      expect(fakeHost.prompt).toHaveBeenCalledTimes(2)
    } finally {
      await daemon.stop()
    }
  })

  it('does not resend a prompt whose tool call is still queued behind slower updates', async () => {
    const ref: { daemon?: any } = {}
    const { daemon, fakeHost } = await start(async (sessionId) => {
      const turn = [...ref.daemon.pending.values()].find((p: any) => p.acpSessionId === sessionId)
      const queued = new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
        turn.promptRanTool = true
      })
      ref.daemon.acpUpdateChains.set(`${turn.hostKey}\u001f${sessionId}`, queued)
      throw contended()
    })
    ref.daemon = daemon
    try {
      await expect((daemon as any).dispatch('bot-a', dm('100', 'q1'), 'int-a')).rejects.toThrow(
        /another Claude Code process/
      )
      expect(fakeHost.prompt).toHaveBeenCalledTimes(1)
    } finally {
      await daemon.stop()
    }
  })
})

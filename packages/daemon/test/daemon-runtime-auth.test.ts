import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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

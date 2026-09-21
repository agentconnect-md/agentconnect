import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'

/**
 * channel-session-mode.md §3 — a conversation on `append` keys every message onto ONE
 * session, while answers keep posting where the question was asked.
 *
 * These drive the real ingress ladder and read what dispatch was handed, because the whole
 * point of §3.1 is WHERE the coordinate is resolved: after routing picks the target and
 * before anything keys on the result. A test that called the resolver directly would pass
 * against an implementation that resolved it too late to matter.
 */

function scaffold(mode: 'createNew' | 'append', agents: string[] = ['bot-a']): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-append-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agents) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${id}`,
            platform: 'slack',
            core: {
              bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }],
              // Only a conversation that departs from the default is listed, so `createNew`
              // exercises the absent-entry path rather than an explicit one. A SECOND agent
              // always stays on the default — that is what makes per-target resolution visible.
              ...(mode === 'append' && id === 'bot-a' ? { sessionModes: [{ channel: 'C1', mode: 'append' }] } : {})
            },
            config: { botToken: 'xoxb', appToken: 'xapp' }
          }
        ],
        output: { mode: 'low' }
      })
    )
  }
  return root
}

async function boot(mode: 'createNew' | 'append', realDispatch = false, agents: string[] = ['bot-a']) {
  const daemon = new Daemon({
    root: scaffold(mode, agents),
    hostFactory: () =>
      ({
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-1'),
        prompt: vi.fn(async () => 'end_turn'),
        cancel: vi.fn(),
        stop: vi.fn()
      }) as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const calls: { agentId: string; msg: { thread?: string; sessionThread?: string } }[] = []
  // `realDispatch` keeps the genuine gate, inbox lane and session-key derivation. It is
  // what makes the §3.1 property observable at all: a stub captures the coordinate the
  // ingress ladder resolved, but only the real path proves everything downstream keys on
  // the SAME one rather than re-deriving it from the physical thread.
  if (!realDispatch)
    (daemon as never as { dispatch: unknown }).dispatch = vi.fn(async (agentId: string, msg: never) => {
      calls.push({ agentId, msg })
    })
  return { daemon, calls }
}

const human = (over: Record<string, unknown>) => ({
  msgId: `slack:C1:${over.ts ?? '1720000000.000100'}`,
  traceId: 't',
  source: 'user',
  platform: 'slack',
  channel: 'C1',
  sender: { id: 'U1', isBot: false },
  text: 'hello',
  mentionedBots: [],
  isDm: false,
  ...over
})

const route = async (daemon: Daemon, msg: unknown) =>
  await (daemon as never as { onInboundOutcome: (m: unknown, s: string[]) => Promise<unknown> }).onInboundOutcome(msg, [
    'int-bot-a',
    'int-bot-b'
  ])

describe('append mode keys one session per conversation', () => {
  it('joins two top-level messages and a thread reply onto one coordinate', async () => {
    const { daemon, calls } = await boot('append')

    await route(daemon, human({ ts: '1720000000.000100' }))
    await route(daemon, human({ ts: '1720000000.000200', msgId: 'slack:C1:1720000000.000200' }))
    // A reply inside a thread the conversation happens to be using joins the same session:
    // in `append` every admitted message does, top-level or not.
    await route(
      daemon,
      human({ ts: '1720000000.000300', msgId: 'slack:C1:1720000000.000300', thread: '1720000000.000100' })
    )

    expect(calls).toHaveLength(3)
    const coordinates = calls.map((c) => c.msg.sessionThread)
    expect(coordinates.every(isAppendCoordinate)).toBe(true)
    expect(new Set(coordinates).size).toBe(1)

    // The delivery coordinate is untouched, which is what keeps the answer in the room the
    // question came from: two of these have no thread, the third has its own.
    expect(calls.map((c) => c.msg.thread)).toEqual([undefined, undefined, '1720000000.000100'])
    await daemon.stop()
  })

  // The gate, the durable inbox lane and `plan.sessionKey` are all keyed on the session
  // coordinate, so two top-level messages in an append conversation must land on ONE key —
  // otherwise both pass the in-flight check and run concurrent turns against one ACP
  // session, and `!stop` addresses a session that does not exist.
  it('derives ONE session key inside the real dispatch path for two top-level messages', async () => {
    const { daemon } = await boot('append', true)
    // The key dispatch computed, captured where it first uses it. Asserting here rather
    // than on a persisted row keeps the test on the property §3.1 is about — the gate, the
    // inbox lane and the session manager agreeing on one coordinate — instead of on how far
    // a turn gets in a harness with no real platform audience.
    const keys: string[] = []
    const inner = daemon as never as { bindSessionSource: (...a: unknown[]) => Promise<string> }
    const original = inner.bindSessionSource.bind(inner)
    inner.bindSessionSource = async (agentId: unknown, key: unknown, ...rest: unknown[]) => {
      keys.push(key as string)
      return await original(agentId, key, ...rest)
    }

    await route(daemon, human({ ts: '1720000000.000100' }))
    await route(daemon, human({ ts: '1720000000.000200', msgId: 'slack:C1:1720000000.000200' }))
    await vi.waitFor(() => expect(keys.length).toBe(2))

    // Two keys would mean two gates, two concurrent turns against one ACP session, and a
    // `!stop` that addresses neither.
    expect(new Set(keys).size).toBe(1)
    // The coordinate carries a colon of its own, so match its shape inside the key rather
    // than splitting the key into segments.
    expect(keys[0]).toMatch(/:append:\d+:/)
    await daemon.stop()
  })

  // Resolution is per TARGET precisely so two agents in one room need not agree. Pinning it
  // here because the alternative — one answer written onto a shared message — is the mistake
  // §3.1 exists to prevent, and it is invisible until a channel actually has two agents.
  it('resolves per target, so one agent can append while another keeps its threads', async () => {
    const { daemon, calls } = await boot('append', false, ['bot-a', 'bot-b'])
    await route(daemon, human({ ts: '1720000000.000100' }))

    expect(calls.map((c) => c.agentId).sort()).toEqual(['bot-a', 'bot-b'])
    const byAgent = new Map(calls.map((c) => [c.agentId, c.msg]))
    expect(isAppendCoordinate(byAgent.get('bot-a')!.sessionThread)).toBe(true)
    expect(byAgent.get('bot-b')!.sessionThread).toBeUndefined()
    await daemon.stop()
  })

  it('leaves a createNew conversation keying on its thread, as it always did', async () => {
    const { daemon, calls } = await boot('createNew')

    await route(daemon, human({ ts: '1720000000.000100' }))
    await route(
      daemon,
      human({ ts: '1720000000.000300', msgId: 'slack:C1:1720000000.000300', thread: '1720000000.000100' })
    )

    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.msg.sessionThread === undefined)).toBe(true)
    await daemon.stop()
  })
})

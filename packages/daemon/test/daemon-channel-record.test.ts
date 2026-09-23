import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey, transcriptPromptText } from '../src/store/local-store.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/**
 * message-intake.md §5 steps 1/2/6, §6 and §7 — the daemon's ingress is "record first, admit last".
 *
 * These drive the real ladder (`onInboundOutcome` / `handleRelayIm`) and read the rows with a raw
 * query rather than through a session scope: an unadmitted row is invisible to a scoped read, which
 * is exactly what these tests must be able to see.
 */

interface AgentSpec {
  id: string
  /** Rule kind for C1; omit for none, so nothing routes there. */
  trigger?: 'auto' | 'mention'
  muted?: boolean
  gated?: boolean
  sessionMode?: 'append' | 'createNew'
}

function scaffold(agents: AgentSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-record-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const a of agents) {
    const adir = join(root, 'agents', a.id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: a.id,
        name: a.id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: `int-${a.id}`,
            platform: 'slack',
            core: {
              bindRules: a.trigger ? [{ match: { kind: a.trigger }, channel: 'C1' }] : [],
              ...(a.muted ? { mutedChannels: ['C1'] } : {}),
              ...(a.gated ? { gated: true } : {}),
              ...(a.sessionMode ? { sessionModes: [{ channel: 'C1', mode: a.sessionMode }] } : {})
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

async function boot(agents: AgentSpec[], blockTurns = false) {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async () => {
      if (blockTurns) await blocked
      return 'end_turn'
    }),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(agents),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const store = (daemon as any).store
  const scope = (daemon as any).transportScopeForIntegrationIds([`int-${agents[0]!.id}`]) as string | undefined
  return { daemon, store, host, channel: transcriptChannelKey('C1', scope), release }
}

/** Every row of the conversation, admitted or not — the channel record itself. */
const rowsOf = async (store: any, channel: string): Promise<any[]> =>
  (await store.db
    .prepare(`SELECT seq, thread, ts, sender, kind, text, recipient, quoteJson FROM transcript WHERE channel = ?`)
    .all(channel)) as any[]

/** The admissions of the conversation's rows: one per (row, agent). */
const admissionsOf = async (
  store: any,
  channel: string
): Promise<{ agentId: string; sessionKey: string; ts: string }[]> =>
  (await store.db
    .prepare(
      `SELECT tr.agentId AS agentId, tr.sessionKey AS sessionKey, t.ts AS ts FROM transcript_recipient tr
         JOIN transcript t ON t.seq = tr.seq WHERE t.channel = ? ORDER BY tr.agentId`
    )
    .all(channel)) as { agentId: string; sessionKey: string; ts: string }[]

const human = (over: Record<string, unknown> = {}) => ({
  msgId: `slack:C1:${(over.ts as string) ?? '1720000000.000100'}`,
  traceId: 't',
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  sender: { id: 'U1', isBot: false },
  text: 'hello',
  mentionedBots: [] as string[],
  isDm: false,
  ...over
})

const route = async (daemon: Daemon, msg: unknown, on = ['int-bot-a', 'int-bot-b']): Promise<any> =>
  await (daemon as any).onInboundOutcome(msg, on)

/** A Slack connection complete enough for a turn to actually RUN: without a workspace id the
 *  session-source binding is unavailable and every turn is rejected before it prompts. */
function liveConn(daemon: Daemon, integrationId = 'int-bot-a'): void {
  ;(daemon as any).connByIntegration.set(integrationId, {
    workspaceId: () => 'T_FAKE_TEAM',
    setStatus: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    postMessage: vi.fn(async () => 'reply-1'),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {})
  })
}

describe('step 1: the channel record', () => {
  it('records a message that routes to nobody, in a conversation with no session anywhere', async () => {
    // The recency gate is gone: this used to record nothing at all unless a session was live.
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'mention' }])
    const notice = vi.fn()
    ;(daemon as any).maybeGatedNotice = notice

    const outcome = await route(daemon, human({ text: 'nobody is addressed here' }), ['int-bot-a'])

    expect(outcome).toEqual({ kind: 'rejected', reason: 'unrouted' })
    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['nobody is addressed here'])
    expect(await admissionsOf(store, channel)).toEqual([])
    expect(notice).toHaveBeenCalled()
    await daemon.stop()
  })

  it('records a conversation whose trigger is off, with no admission', async () => {
    // §5 step 1 is explicit that `off` is still a row: a Decision enabled later must not start blind.
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto', muted: true }])

    await route(daemon, human({ text: 'said in an off channel' }), ['int-bot-a'])

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['said in an off channel'])
    expect(await admissionsOf(store, channel)).toEqual([])
    await daemon.stop()
  })

  it('carries the physical thread, sender, quote and attachment mention, and no recipient', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'mention' }])

    await route(
      daemon,
      human({
        thread: '1720000000.000001',
        text: 'look at this',
        quoted: { messageId: '99.9', sender: 'U2', text: 'the quoted source' },
        attachments: [{ id: 'f1', name: 'shot.png', mimeType: 'image/png' }]
      }),
      ['int-bot-a']
    )

    const rows = await rowsOf(store, channel)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      thread: '1720000000.000001',
      ts: '1720000000.000100',
      sender: 'U1',
      kind: 'text',
      text: 'look at this\n[attached: shot.png (image/png)]',
      recipient: null
    })
    expect(JSON.parse(rows[0].quoteJson).text).toBe('the quoted source')
    await daemon.stop()
  })

  it('makes a redelivery a no-op: one row, one admission, for two arrivals of the same (channel, ts)', async () => {
    // Slack's `message.*` + `app_mention` copies of one mention are untagged alike, so the second
    // must still be rejected as a duplicate even though the record now runs above that gate.
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    const first = await route(daemon, human({ text: 'double fired' }), ['int-bot-a'])
    const second = await route(daemon, human({ text: 'double fired' }), ['int-bot-a'])

    expect(first).toMatchObject({ kind: 'dispatched' })
    expect(second).toEqual({ kind: 'rejected', reason: 'deduplicated' })
    expect((await rowsOf(store, channel)).filter((r) => r.sender === 'U1').map((r) => r.text)).toEqual(['double fired'])
    // One admission, so the duplicate dispatched nothing either.
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(1), WAIT)
    expect(await admissionsOf(store, channel)).toHaveLength(1)
    await daemon.stop()
  })

  it('still refreshes the row in place from a streamed reply’s closing edit', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'mention' }])

    await route(daemon, human({ text: 'partial' }), ['int-bot-a'])
    await route(daemon, human({ text: 'the completed text', ingressEventTag: SLACK_RESPONSE_FINAL_EVENT_TAG }), [
      'int-bot-a'
    ])

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['the completed text'])
    await daemon.stop()
  })
})

describe('step 2: commands are recorded and (except !queue) never admitted', () => {
  it('records a !stop, admits nobody for it, and still mutes the session it addresses', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])
    // A session has to exist for `!stop` to latch a mute, so open one the ordinary way first.
    await route(daemon, human({ text: 'start a session', thread: 'T1' }), ['int-bot-a'])
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(1), WAIT)
    const muted = vi.fn()
    ;(daemon as any).commands.setSessionMuted = muted

    const outcome = await route(daemon, human({ ts: '1720000000.000200', text: '!stop', thread: 'T1' }), ['int-bot-a'])

    expect(outcome).toEqual({ kind: 'rejected', reason: 'suppressed' })
    const humanRows = (await rowsOf(store, channel)).filter((r) => r.sender === 'U1')
    expect(humanRows.map((r) => r.text)).toEqual(['start a session', '!stop'])
    // The command's own row is admitted by nobody; only the message that opened the session is.
    expect((await admissionsOf(store, channel)).filter((a) => a.ts === '1720000000.000200')).toEqual([])
    expect(muted).toHaveBeenCalledWith(expect.any(String), true)
    await daemon.stop()
  })

  it('records /status and admits nobody', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    await route(daemon, human({ text: '/status' }), ['int-bot-a'])

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['/status'])
    expect(await admissionsOf(store, channel)).toEqual([])
    await daemon.stop()
  })

  it('admits a `!queue hello` onto the row that keeps the command as typed, and prompts as `hello`', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    await route(daemon, human({ text: '!queue hello' }), ['int-bot-a'])
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(1), WAIT)

    const rows = await rowsOf(store, channel)
    // ONE row, holding the command as typed — that is what the channel shows.
    expect(rows.map((r) => r.text)).toEqual(['!queue hello'])
    expect((await admissionsOf(store, channel))[0]!.agentId).toBe('bot-a')
    // …and prompt assembly is what strips it, as a pure function of the text.
    expect(transcriptPromptText({ kind: 'text', text: rows[0]!.text })).toBe('hello')
    await daemon.stop()
  })

  it('records a bare `!queue` (usage reply) and never admits it', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    await route(daemon, human({ text: '!queue' }), ['int-bot-a'])

    const rows = await rowsOf(store, channel)
    expect(rows.map((r) => r.text)).toEqual(['!queue'])
    expect(await admissionsOf(store, channel)).toEqual([])
    // A row nothing admitted must not be blanked by the strip either.
    expect(transcriptPromptText({ kind: 'text', text: rows[0]!.text })).toBe('!queue')
    await daemon.stop()
  })
})

describe('§4.1: the physical thread a row carries', () => {
  it('files a Discord root on the thread promotion is about to open, so its replies join it', async () => {
    // Promotion is a REST call `dispatch` makes AFTER step 1, so the record is driven directly here
    // — the same entry point relay ingress uses, with the owning org named outright.
    const { daemon, store } = await boot([{ id: 'bot-a', trigger: 'auto' }])
    const record = async (msg: Record<string, unknown>): Promise<void> =>
      await (daemon as any).recordChannelInbound(msg, undefined, { orgAgentId: 'bot-a' })
    const discord = (over: Record<string, unknown>) => ({
      ...human(),
      platform: 'discord',
      channel: '55550000',
      ...over
    })

    await record(discord({ msgId: 'discord:55550000:11223344', text: 'the root', promoteToThread: true }))
    await record(discord({ msgId: 'discord:11223344:11223399', thread: '11223344', text: 'a reply in the thread' }))

    const rows = await rowsOf(store, transcriptChannelKey('55550000'))
    expect(rows.map((r) => [r.text, r.thread])).toEqual([
      ['the root', '11223344'],
      ['a reply in the thread', '11223344']
    ])
    await daemon.stop()
  })
})

describe('a recorded control is not session context', () => {
  it('does not discard and re-prompt the turn a `!status` was typed at', async () => {
    const { daemon, store, channel, host, release } = await boot([{ id: 'bot-a', trigger: 'auto' }], true)
    liveConn(daemon)

    await route(daemon, human({ ts: '1720000000.000100', thread: 'T1', text: 'do the thing' }), ['int-bot-a'])
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    const outcome = await route(daemon, human({ ts: '1720000000.000200', thread: 'T1', text: '!status' }), [
      'int-bot-a'
    ])

    expect(outcome).toEqual({ kind: 'rejected', reason: 'suppressed' })
    // Recorded like anything else — it is the session-context READ that leaves it out.
    expect((await rowsOf(store, channel)).filter((r) => r.sender === 'U1').map((r) => r.text)).toEqual([
      'do the thing',
      '!status'
    ])

    release()
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(0), WAIT)
    // A second prompt would be the turn-final refresh re-running the turn on `!status`.
    expect(host.prompt).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })
})

describe('step 6: one row, one admission per target at its own coordinate', () => {
  it('gives two agents with different session modes their own admission from ONE row', async () => {
    const { daemon, store, channel } = await boot([
      { id: 'bot-a', trigger: 'auto', sessionMode: 'append' },
      { id: 'bot-b', trigger: 'auto' }
    ])

    await route(daemon, human({ text: 'both of you' }))
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(2), WAIT)

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['both of you'])
    const admissions = await admissionsOf(store, channel)
    expect(admissions.map((a) => a.agentId)).toEqual(['bot-a', 'bot-b'])
    // bot-a appends, bot-b keys on the thread: the coordinate lives on the admission, not the row.
    expect(isAppendCoordinate(admissions[0]!.sessionKey.split(':').slice(2, -2).join(':'))).toBe(true)
    expect(admissions[0]!.sessionKey).toMatch(/:append:\d+:bot-a/)
    expect(admissions[1]!.sessionKey).toContain('1720000000.000100:bot-b')
    await daemon.stop()
  })
})

describe('the admission is written at admission time, not when the turn runs', () => {
  it('has a message queued behind a running turn already admitted into that session', async () => {
    const { daemon, store, channel, host, release } = await boot([{ id: 'bot-a', trigger: 'auto' }], true)
    liveConn(daemon)

    await route(daemon, human({ ts: '1720000000.000100', thread: 'T1', text: 'first' }), ['int-bot-a'])
    // The first turn is genuinely in flight — otherwise the second would just dispatch.
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(1), WAIT)
    // The turn is still blocked, so this one can only be queued behind it.
    await route(daemon, human({ ts: '1720000000.000200', thread: 'T1', text: 'second' }), ['int-bot-a'])

    await vi.waitFor(
      async () =>
        expect((await admissionsOf(store, channel)).map((a) => a.ts).sort()).toEqual([
          '1720000000.000100',
          '1720000000.000200'
        ]),
      WAIT
    )
    release()
    await daemon.stop()
  })
})

describe('§6: a relay-forwarded IM records like direct ingress', () => {
  const relayFrame = (over: Record<string, unknown> = {}) => ({
    source: 'im' as const,
    agentId: 'bot-a',
    sessionKey: 'C1/1720000000.000100',
    msgId: 'slack:C1:1720000000.000100',
    botId: '11111111-1111-4111-8111-111111111111',
    integrationId: 'int-bot-a',
    chatId: 'C1',
    payload: human({ trigger: 'mention' }),
    ...over
  })

  it('records BEFORE the last-hop gate, so an Off conversation is in the record with no admission', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto', muted: true }])

    expect(await (daemon as any).handleRelayIm(relayFrame())).toMatchObject({ accepted: true })

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['hello'])
    expect(await admissionsOf(store, channel)).toEqual([])
    await daemon.stop()
  })

  it('writes exactly one admission when the relay IM dispatches', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    await (daemon as any).handleRelayIm(relayFrame())
    await vi.waitFor(async () => expect(await admissionsOf(store, channel)).toHaveLength(1), WAIT)

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['hello'])
    expect((await admissionsOf(store, channel))[0]).toMatchObject({ agentId: 'bot-a' })
    await daemon.stop()
  })

  it('records a !stop-muted relay IM and admits nobody', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])
    ;(daemon as any).commands.isSessionMuted = async () => true

    await (daemon as any).handleRelayIm(relayFrame({ payload: human({}) }))

    expect((await rowsOf(store, channel)).map((r) => r.text)).toEqual(['hello'])
    expect(await admissionsOf(store, channel)).toEqual([])
    await daemon.stop()
  })

  it('does not record a frame for an agent this daemon does not hold', async () => {
    const { daemon, store, channel } = await boot([{ id: 'bot-a', trigger: 'auto' }])

    expect(await (daemon as any).handleRelayIm(relayFrame({ agentId: 'bot-zzz' }))).toMatchObject({
      accepted: false,
      reason: 'no_agent'
    })

    expect(await rowsOf(store, channel)).toEqual([])
    await daemon.stop()
  })
})

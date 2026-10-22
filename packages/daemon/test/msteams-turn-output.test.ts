import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTokenEndpoint, type MsTeamsTarget } from '../src/platforms/msteams/api.js'
import {
  MSTEAMS_MESSAGE_MAX_BYTES,
  MsTeamsConnection,
  msTeamsConnKey,
  type MsTeamsEgressPort
} from '../src/platforms/msteams/connection.js'
import {
  applyMsTeamsAction,
  MSTEAMS_NO_REPLY_TEXT,
  MSTEAMS_PLACEHOLDER_TEXT,
  MsTeamsConverger,
  MsTeamsPlaceholder,
  MsTeamsStream,
  type MsTeamsTurnState
} from '../src/platforms/msteams/turn-output.js'
import { WriteBudget } from '../src/platforms/write-budget.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const GROUP_CHAT = '19:example-group@thread.v2'
const target: MsTeamsTarget = { serviceUrl: SERVICE_URL, conversationId: GROUP_CHAT }

function fakePort(): MsTeamsEgressPort & { calls: string[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls,
    post: async (_target, text) => {
      calls.push(`post ${text.length > 40 ? `${text.length}b` : text}`)
      return `act-${++n}`
    },
    update: async (_target, id, text) => {
      calls.push(`update ${id} ${text}`)
    },
    remove: async (_target, id) => {
      calls.push(`remove ${id}`)
    }
  }
}

/** Timers that fire only when the test says so. */
function manualTimers() {
  const pending = new Set<{ fn: () => void; ms: number }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const handle = { fn, ms }
      pending.add(handle)
      return handle
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as { fn: () => void; ms: number })
    },
    waits: () => [...pending].map((h) => h.ms),
    fire: () => {
      const due = [...pending]
      pending.clear()
      for (const h of due) h.fn()
    }
  }
}

const settle = () => new Promise((r) => setImmediate(r))

describe('MsTeamsStream', () => {
  it('posts the first text at once and coalesces later text into one edit per interval', async () => {
    const port = fakePort()
    const clock = { t: 0 }
    const timers = manualTimers()
    const stream = new MsTeamsStream(port, target, undefined, { now: () => clock.t, ...timers })
    stream.update('Hel')
    await settle()
    clock.t = 500
    stream.update('Hello')
    clock.t = 900
    stream.update('Hello, wor')
    // One timer for the rest of the two-second interval, however many snapshots arrive.
    expect(timers.waits()).toEqual([1_500])
    await settle()
    expect(port.calls).toEqual(['post Hel'])
    clock.t = 2_000
    timers.fire()
    await settle()
    expect(port.calls).toEqual(['post Hel', 'update act-1 Hello, wor'])
    expect(await stream.finish('Hello, world')).toEqual([{ id: 'act-1', text: 'Hello, world' }])
    expect(port.calls).toEqual(['post Hel', 'update act-1 Hello, wor', 'update act-1 Hello, world'])
  })

  it('splits an answer above 80 KB into consecutive messages', async () => {
    const port = fakePort()
    const paragraph = `${'x'.repeat(999)}\n`
    const text = Array.from({ length: 170 }, () => paragraph).join('\n')
    const sent = await new MsTeamsStream(port, target).finish(text)
    expect(sent.length).toBe(3)
    for (const segment of sent)
      expect(Buffer.byteLength(segment.text, 'utf8')).toBeLessThanOrEqual(MSTEAMS_MESSAGE_MAX_BYTES)
    expect(sent.map((s) => s.id)).toEqual(['act-1', 'act-2', 'act-3'])
    expect(port.calls.every((c) => c.startsWith('post '))).toBe(true)
  })

  it('edits the acknowledgement rather than posting beside it', async () => {
    const port = fakePort()
    const timers = manualTimers()
    const ack = new MsTeamsPlaceholder(port, target, timers)
    ack.arm(2_000)
    timers.fire()
    await settle()
    expect(port.calls).toEqual([`post ${MSTEAMS_PLACEHOLDER_TEXT}`])
    const adopted = ack.take()
    const sent = await new MsTeamsStream(port, target, () => adopted).finish('The answer')
    expect(sent).toEqual([{ id: 'act-1', text: 'The answer' }])
    expect(port.calls).toEqual([`post ${MSTEAMS_PLACEHOLDER_TEXT}`, 'update act-1 The answer'])
    // Taken over, so the turn's end leaves it alone.
    await ack.end('completed')
    expect(port.calls).toHaveLength(2)
  })
})

describe('MsTeamsPlaceholder', () => {
  it('says the turn finished without a reply, and withdraws itself on an interrupt or a rerun', async () => {
    const run = async (end: 'completed' | 'interrupted' | 'rerun') => {
      const port = fakePort()
      const timers = manualTimers()
      const ack = new MsTeamsPlaceholder(port, target, timers)
      ack.arm(2_000)
      timers.fire()
      await settle()
      await ack.end(end)
      return port.calls.slice(1)
    }
    expect(await run('completed')).toEqual([`update act-1 ${MSTEAMS_NO_REPLY_TEXT}`])
    expect(await run('interrupted')).toEqual(['remove act-1'])
    expect(await run('rerun')).toEqual(['remove act-1'])
  })

  it('posts nothing when text arrives before the delay', async () => {
    const port = fakePort()
    const timers = manualTimers()
    const ack = new MsTeamsPlaceholder(port, target, timers)
    ack.arm(2_000)
    expect(await ack.take()).toBeUndefined()
    timers.fire()
    await settle()
    expect(port.calls).toEqual([])
  })
})

describe('applyMsTeamsAction', () => {
  it('records each landed activity by the ID its send returned, so a quote of it resolves', async () => {
    const port = fakePort()
    const rows: { ts: string; thread: string; text: string }[] = []
    const host = {
      recordReplySegment: async () => {
        throw new Error('the reply landed, so it is recorded by activity')
      },
      appendTranscript: async (row: { ts: string; thread: string; text: string }) => {
        rows.push({ ts: row.ts, thread: row.thread, text: row.text })
      },
      nowUs: () => 1,
      warn: () => {}
    }
    const turn = {
      plan: {
        transcriptChannel: 'scope\u001fchat',
        statusThread: 'msteams:1700000000000',
        agentId: 'a',
        sessionKey: 'k'
      }
    }
    const state: MsTeamsTurnState = { conn: port, target }
    const converger = new MsTeamsConverger('low')
    const chunk = (text: string) =>
      converger.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as never)
    for (const action of [...chunk('First '), ...chunk('answer'), ...converger.onFinal()])
      await applyMsTeamsAction(host, turn, state, action)
    expect(rows).toEqual([{ ts: 'act-1', thread: 'msteams:1700000000000', text: 'First answer' }])
  })
})

describe('MsTeamsConnection writes', () => {
  it('spaces writes per conversation, posts extended Markdown into the raw conversation ID, and takes the shared budget', async () => {
    const urls: string[] = []
    const bodies: unknown[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      const json = (status: number, body: unknown) =>
        ({ ok: true, status, headers: { get: () => null }, json: async () => body }) as unknown as Response
      if (target === msTeamsTokenEndpoint(ZERO)) return json(200, { access_token: 'tok', expires_in: 3600 })
      urls.push(target)
      bodies.push(JSON.parse(String(init?.body)))
      return json(201, { id: `act-${urls.length}` })
    }) as typeof fetch
    const clock = { t: 0 }
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      clock.t += ms
    }
    const budget = new WriteBudget({ capacity: 50, refillPerMinute: 3_000 }, () => clock.t, sleep)
    const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
    const conn = new MsTeamsConnection({
      group: {
        key: msTeamsConnKey(config),
        agentId: 'a',
        integrationId: 'i',
        config,
        integrations: [{ agentId: 'a', integrationId: 'i' }]
      },
      fetchImpl,
      now: () => clock.t,
      sleep,
      budget
    })
    const thread = {
      serviceUrl: SERVICE_URL,
      conversationId: '19:example-channel@thread.tacv2;messageid=1700000000000'
    }
    expect(await conn.post(thread, 'one')).toBe('act-1')
    expect(await conn.post(target, 'elsewhere')).toBe('act-2')
    expect(await conn.post(thread, 'two')).toBe('act-3')
    // Only the second write into the same conversation waited out the two-second spacing.
    expect(sleeps).toEqual([2_000])
    expect(budget.available()).toBeLessThan(50)
    expect(urls[0]).toBe(`${SERVICE_URL}v3/conversations/${encodeURIComponent(thread.conversationId)}/activities`)
    expect(bodies[0]).toEqual({ type: 'message', textFormat: 'extendedmarkdown', text: 'one' })
  })

  it('remembers each conversation’s serviceUrl and builds a channel thread’s target from its root', async () => {
    const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
    const conn = new MsTeamsConnection({
      group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] }
    })
    const message = (channel: string, conversationId: string, isDm = false): NormalizedMessage =>
      ({
        msgId: `msteams:${channel}:1700000000001`,
        traceId: 't',
        source: 'user',
        platform: 'msteams',
        channel,
        sender: { id: ZERO, isBot: false, name: 'Example Person' },
        text: 'hi',
        mentionedBots: [],
        isDm,
        adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId, userId: '29:example-user' } }
      }) as NormalizedMessage
    conn.noteMessage(
      message('19:example-channel@thread.tacv2', '19:example-channel@thread.tacv2;messageid=1700000000000')
    )
    conn.noteMessage(message(GROUP_CHAT, GROUP_CHAT))
    conn.noteMessage(message('a:example-personal', 'a:example-personal', true))
    expect(conn.botUserId).toBe(`28:${ZERO}`)
    expect(conn.targetFor('19:example-channel@thread.tacv2', '1700000000009')).toEqual({
      serviceUrl: SERVICE_URL,
      conversationId: '19:example-channel@thread.tacv2;messageid=1700000000009'
    })
    expect(conn.targetFor(GROUP_CHAT, 'msteams:1700000000001')).toEqual(target)
    expect(conn.targetFor('19:unseen@thread.v2')).toBeUndefined()
    expect(await conn.getChannelInfo('a:example-personal')).toMatchObject({ isIm: true, name: 'Example Person' })
  })
})

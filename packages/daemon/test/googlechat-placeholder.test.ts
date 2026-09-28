/** Google Chat's turn acknowledgement (google-chat-integration.md §5): one placeholder that becomes the answer or is resolved at the end. */
import { describe, it, expect } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  GOOGLE_CHAT_NO_REPLY_TEXT,
  GOOGLE_CHAT_PLACEHOLDER_TEXT,
  GoogleChatPlaceholder,
  type GoogleChatPlaceholderPort
} from '../src/platforms/googlechat/placeholder.js'
import {
  acknowledgeGoogleChatTurn,
  applyGoogleChatAction,
  GoogleChatConverger,
  googleChatClientId,
  initialGoogleChatTurnState,
  type GoogleChatTurnState
} from '../src/platforms/googlechat/turn-output.js'
import type { TurnAcknowledgement } from '../src/platforms/turn-output.js'

const SPACE = 'spaces/EXAMPLE_SPACE'
const THREAD = `${SPACE}/threads/EXAMPLE_THREAD`
const DM = 'spaces/EXAMPLE_DM'
const SCOPE = 'scope'

const message = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `googlechat:${SPACE}:${SPACE}/messages/T.M`,
    traceId: 't',
    platform: 'googlechat',
    channel: SPACE,
    thread: THREAD,
    sender: { id: 'users/1', isBot: false },
    text: 'hi',
    mentionedBots: [],
    isDm: false,
    source: 'user',
    transportScope: SCOPE,
    ...overrides
  }) as NormalizedMessage

const DELIVERY = `${SCOPE}\u001fgooglechat:${SPACE}:${SPACE}/messages/T.M`
/** The answer's first message id, which the placeholder shares. */
const FIRST = googleChatClientId(DELIVERY, 0, 0)

/** A fake Google keyed by client id: a repeated id answers the message already there, as a replayed request id does. */
function google() {
  const wire = new Map<string, string>()
  const writes: string[][] = []
  const id = (name: string) => name.slice(name.lastIndexOf('/') + 1)
  const port: GoogleChatPlaceholderPort = {
    async createMessage(input) {
      const name = `${input.space}/messages/${input.clientId}`
      writes.push(['create', input.clientId, input.text, input.thread ?? '(no thread)'])
      const existing = wire.get(name)
      if (existing !== undefined) return { name, clientId: input.clientId, text: existing }
      wire.set(name, input.text)
      return { name, clientId: input.clientId, text: input.text }
    },
    async patchMessage(name, text) {
      writes.push(['patch', id(name), text])
      wire.set(name, text)
    },
    async deleteOwnMessage(name) {
      writes.push(['delete', id(name)])
      wire.delete(name)
    }
  }
  return { port, wire, writes }
}

/** A hand-driven clock for the placeholder's timer. */
function clock() {
  let t = 0
  const timers = new Set<{ fn: () => void; due: number }>()
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return {
    setTimer: (fn: () => void, ms: number) => {
      const handle = { fn, due: t + ms }
      timers.add(handle)
      return handle
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as { fn: () => void; due: number })
    },
    advance: async (ms: number) => {
      t += ms
      for (const handle of [...timers]) {
        if (handle.due > t) continue
        timers.delete(handle)
        handle.fn()
      }
      await flush()
    },
    armed: () => timers.size,
    flush
  }
}

function rig(
  opts: {
    msg?: NormalizedMessage
    mode?: string
    rerun?: boolean
    interrupted?: () => boolean
    /** Messages an earlier run left on the wire before this turn starts. */
    seed?: Record<string, string>
  } = {}
) {
  const g = google()
  for (const [name, text] of Object.entries(opts.seed ?? {})) g.wire.set(name, text)
  const c = clock()
  const msg = opts.msg ?? message()
  const ctx = { mode: opts.mode ?? 'low', isDm: msg.isDm, showFooter: false, message: msg, egress: g.port }
  const ack = acknowledgeGoogleChatTurn(
    ctx,
    { rerun: opts.rerun ?? false, interrupted: opts.interrupted ?? (() => false) },
    { setTimer: c.setTimer, clearTimer: c.clearTimer }
  )
  const state: GoogleChatTurnState = {
    ...initialGoogleChatTurnState({ ...ctx, ...(ack ? { acknowledgement: ack } : {}) }),
    streamOptions: { now: () => 0, setTimer: () => 0, clearTimer: () => {} }
  }
  const rows: { ts: string; text: string }[] = []
  const recorded: string[] = []
  const host = {
    recordReplySegment: async (_turn: unknown, text: string) => {
      recorded.push(text)
    },
    appendTranscript: async (row: { ts: string; text: string }) => {
      rows.push({ ts: row.ts, text: row.text })
    },
    nowUs: () => 1,
    warn: () => {}
  }
  const turn = { plan: { transcriptChannel: 'tc', statusThread: THREAD, agentId: 'agent-1', sessionKey: 'sk' } }
  const apply = async (action: { kind: string; text?: string; recordOnly?: boolean }) => {
    await applyGoogleChatAction(host, turn, state, action)
    await c.flush()
  }
  return { ...g, ...c, ack, state, rows, recorded, apply }
}

describe('the placeholder is posted only for a turn that stays silent', () => {
  it('posts one placeholder into the thread two seconds after the turn starts, and not before', async () => {
    const r = rig()
    expect(r.ack).toBeInstanceOf(GoogleChatPlaceholder)
    await r.advance(1_999)
    expect(r.writes).toEqual([])
    await r.advance(1)
    expect(r.writes).toEqual([['create', FIRST, GOOGLE_CHAT_PLACEHOLDER_TEXT, THREAD]])
    // One placeholder per turn, however long the turn keeps working.
    await r.advance(60_000)
    expect(r.writes).toHaveLength(1)
  })

  it('posts into a DM with no thread option', async () => {
    const r = rig({ msg: message({ channel: DM, thread: DM, isDm: true }) })
    await r.advance(2_000)
    expect(r.writes[0]!.slice(2)).toEqual([GOOGLE_CHAT_PLACEHOLDER_TEXT, '(no thread)'])
  })

  it('never posts one for a fast turn: text inside two seconds cancels it, and so does an end', async () => {
    const answered = rig()
    await answered.advance(500)
    await answered.apply({ kind: 'gchat-stream', text: 'Hello' })
    await answered.advance(10_000)
    expect(answered.writes).toEqual([['create', FIRST, 'Hello', THREAD]])
    await answered.apply({ kind: 'post', text: 'Hello' })
    await answered.ack!.end('completed')
    expect(answered.writes).toHaveLength(1)

    // A turn that finishes inside two seconds with no text posts nothing new, not even the no-reply notice.
    const quiet = rig()
    await quiet.advance(1_000)
    await quiet.ack!.end('completed')
    await quiet.advance(10_000)
    expect(quiet.writes).toEqual([])
    expect(quiet.armed()).toBe(0)
  })

  it('acknowledges only a real inbound message that has an egress', () => {
    const g = google()
    const turn = { rerun: false, interrupted: () => false }
    const ctx = (msg: NormalizedMessage, egress?: unknown) => ({
      mode: 'low',
      isDm: false,
      showFooter: false,
      message: msg,
      ...(egress ? { egress } : {})
    })
    expect(acknowledgeGoogleChatTurn(ctx(message({ source: 'agent' }), g.port), turn)).toBeUndefined()
    expect(acknowledgeGoogleChatTurn(ctx(message({ headless: true }), g.port), turn)).toBeUndefined()
    expect(acknowledgeGoogleChatTurn(ctx(message()), turn)).toBeUndefined()
  })
})

describe('the placeholder becomes the answer', () => {
  it('lets the first text take it over in place: one message, patched into the answer and recorded under its name', async () => {
    const r = rig()
    await r.advance(2_000)
    await r.apply({ kind: 'gchat-stream', text: 'Hello' })
    await r.apply({ kind: 'post', text: 'Hello world' })
    await r.ack!.end('completed')
    // The answer's create reused the placeholder's id, so Google answered the placeholder and it was patched.
    expect(r.writes).toEqual([
      ['create', FIRST, GOOGLE_CHAT_PLACEHOLDER_TEXT, THREAD],
      ['create', FIRST, 'Hello', THREAD],
      ['patch', FIRST, 'Hello'],
      ['patch', FIRST, 'Hello world']
    ])
    expect([...r.wire.values()]).toEqual(['Hello world'])
    expect(r.rows).toEqual([{ ts: `${SPACE}/messages/${FIRST}`, text: 'Hello world' }])
  })

  it('takes a failure notice the same way, whether it rides the turn output or arrives before the turn had any', async () => {
    const warm = rig()
    await warm.advance(2_000)
    await warm.apply({ kind: 'post', text: '⚠️ Agent failed to respond: boom' })
    await warm.ack!.end('failed')
    expect([...warm.wire.values()]).toEqual(['⚠️ Agent failed to respond: boom'])

    // A turn that failed before its output existed: the notice replaces the placeholder, and the end leaves it.
    const cold = rig()
    await cold.advance(2_000)
    expect(await cold.ack!.replace('⚠️ Agent failed to respond: no runtime')).toBe(true)
    await cold.ack!.end('failed')
    expect(cold.writes.slice(1)).toEqual([['patch', FIRST, '⚠️ Agent failed to respond: no runtime']])
    expect([...cold.wire.values()]).toEqual(['⚠️ Agent failed to respond: no runtime'])
  })

  it('declines a failure notice when nothing is showing yet, and then never posts the placeholder', async () => {
    const r = rig()
    await r.advance(1_000)
    expect(await r.ack!.replace('⚠️ Agent failed to respond: boom')).toBe(false)
    await r.advance(10_000)
    await r.ack!.end('failed')
    expect(r.writes).toEqual([])
  })
})

describe('a placeholder the answer never took is resolved when the turn ends', () => {
  it('becomes a short notice when the turn ends with no text and without the marker', async () => {
    const r = rig()
    await r.advance(2_000)
    await r.ack!.end('completed')
    expect(r.writes.slice(1)).toEqual([['patch', FIRST, GOOGLE_CHAT_NO_REPLY_TEXT]])
  })

  it('is withdrawn when the turn ends silently on purpose with the no-response marker', async () => {
    const r = rig()
    await r.advance(2_000)
    const conv = new GoogleChatConverger('low')
    for (const action of conv.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'AC_NO_RESPONSE' }
    } as never))
      await r.apply(action)
    for (const action of conv.onFinal()) await r.apply(action)
    await r.ack!.end('completed')
    expect(r.writes.slice(1)).toEqual([['delete', FIRST]])
    expect(r.wire.size).toBe(0)
  })

  it('is never armed in a mode that posts nothing, and a rerun there withdraws an earlier one by name without creating one', async () => {
    expect(rig({ mode: 'none' }).ack).toBeUndefined()
    const r = rig({ mode: 'none', rerun: true, seed: { [`${SPACE}/messages/${FIRST}`]: GOOGLE_CHAT_PLACEHOLDER_TEXT } })
    await r.flush()
    expect(r.writes).toEqual([['delete', FIRST]])
    expect(r.wire.size).toBe(0)
    await r.apply({ kind: 'post', text: 'kept in the transcript only', recordOnly: true })
    expect(await r.ack!.replace('⚠️ failed')).toBe(false)
    await r.ack!.end('completed')
    expect(r.recorded).toEqual(['kept in the transcript only'])
    expect(r.writes).toEqual([['delete', FIRST]])

    // With nothing left earlier, the withdrawal is a no-op delete and nothing is ever shown.
    const clear = rig({ mode: 'none', rerun: true })
    await clear.flush()
    await clear.ack!.end('completed')
    expect(clear.writes).toEqual([['delete', FIRST]])
    expect(clear.wire.size).toBe(0)
  })

  it('is withdrawn when the turn is cancelled, and never posted once the turn is interrupted', async () => {
    const shown = rig()
    await shown.advance(2_000)
    await shown.ack!.end('interrupted')
    expect(shown.writes.slice(1)).toEqual([['delete', FIRST]])

    let interrupted = false
    const cut = rig({ interrupted: () => interrupted })
    await cut.advance(1_000)
    interrupted = true
    await cut.advance(1_000)
    expect(cut.writes).toEqual([])
    await cut.ack!.end('interrupted')
    expect(cut.writes).toEqual([])
  })
})

describe('a rerun of the same delivery reuses the placeholder', () => {
  it('leaves it for the rerun, which adopts it by its client id and never posts a second message', async () => {
    const first = rig()
    await first.advance(2_000)
    // A shutdown or a turn cut keeps the row: the placeholder stays for the next run.
    await first.ack!.end('rerun')
    expect(first.writes).toHaveLength(1)

    const second = rig({ rerun: true })
    second.wire.set(`${SPACE}/messages/${FIRST}`, GOOGLE_CHAT_PLACEHOLDER_TEXT)
    // A rerun posts at once, so it holds the earlier placeholder even if it answers inside two seconds.
    await second.advance(0)
    expect(second.writes).toEqual([['create', FIRST, GOOGLE_CHAT_PLACEHOLDER_TEXT, THREAD]])
    await second.apply({ kind: 'post', text: 'The answer after the restart' })
    await second.ack!.end('completed')
    expect([...second.wire.entries()]).toEqual([[`${SPACE}/messages/${FIRST}`, 'The answer after the restart']])
  })

  it('adopts an earlier partial answer as it stands, and resolves it like its own placeholder', async () => {
    const r = rig({ rerun: true })
    r.wire.set(`${SPACE}/messages/${FIRST}`, 'An answer the earlier run had begun')
    await r.advance(0)
    // Adopted without a patch back to the placeholder text.
    expect(r.writes).toHaveLength(1)
    await r.ack!.end('completed')
    expect([...r.wire.values()]).toEqual([GOOGLE_CHAT_NO_REPLY_TEXT])
  })
})

describe('the turn state', () => {
  it('holds the placeholder it was handed, and ignores an acknowledgement that is not one', () => {
    const g = google()
    const ack = acknowledgeGoogleChatTurn(
      { mode: 'low', isDm: false, showFooter: false, message: message(), egress: g.port },
      { rerun: false, interrupted: () => false },
      { setTimer: () => 0, clearTimer: () => {} }
    )!
    const base = { mode: 'low', isDm: false, showFooter: false, message: message(), egress: g.port }
    expect(initialGoogleChatTurnState({ ...base, acknowledgement: ack }).acknowledgement).toBe(ack)
    const other: TurnAcknowledgement = { replace: async () => false, end: async () => {} }
    expect(initialGoogleChatTurnState({ ...base, acknowledgement: other }).acknowledgement).toBeUndefined()
  })
})

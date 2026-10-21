import { describe, expect, it, vi } from 'vitest'
import { dingTalkApiError } from '../src/platforms/dingtalk/api.js'
import type { DingTalkCardPort } from '../src/platforms/dingtalk/card.js'
import type { DingTalkReplyPort } from '../src/platforms/dingtalk/connection.js'
import {
  DINGTALK_CARD_INTERVAL_MS,
  DINGTALK_QUOTA_NOTICE,
  DingTalkProgressCard,
  DingTalkQuotaNotice
} from '../src/platforms/dingtalk/progress-card.js'
import { DINGTALK_CARD_TAIL_CHARS, DingTalkProgressView, plainCardText } from '../src/platforms/dingtalk/progress.js'
import { createDingTalkTurnOutput } from '../src/platforms/dingtalk/surface.js'
import { applyDingTalkAction, DingTalkConverger } from '../src/platforms/dingtalk/turn-output.js'
import { NO_RESPONSE_SENTINEL } from '../src/session/no-response.js'

const QUOTA = dingTalkApiError('/v1.0/card/streaming', 403, 'Forbidden.AccessDenied.ApiCountLimitForOrg')
const RATE = dingTalkApiError('/v1.0/card/streaming', 403, 'Forbidden.AccessDenied.QpsLimitForAppkeyAndApi')

const chunk = (text: string, messageId = 'm1') =>
  ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }) as never
const tool = (toolCallId: string, title: string, status = 'in_progress') =>
  ({ sessionUpdate: 'tool_call', toolCallId, title, status }) as never

function fakeCards(opts: { openError?: unknown; streamErrors?: unknown[] } = {}) {
  const calls: string[] = []
  const cards: DingTalkCardPort = {
    open: vi.fn(async () => {
      calls.push('open')
      if (opts.openError) throw opts.openError
      return 'track-1'
    }),
    setStatus: vi.fn(
      async (_id: string, status: string, content: string) => void calls.push(`status ${status} ${content}`)
    ),
    stream: vi.fn(async (_id: string, content: string, o?: { finalize?: boolean; error?: boolean }) => {
      calls.push(`stream${o?.finalize ? ' final' : ''}${o?.error ? ' error' : ''} ${content}`)
      const error = opts.streamErrors?.shift()
      if (error) throw error
    }),
    warn: vi.fn()
  }
  return { calls, cards }
}

function fakeClock() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    opts: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { at: now + ms, fn }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle: unknown) => {
        timers = timers.filter((timer) => timer !== handle)
      }
    },
    settle,
    async advance(ms: number) {
      now += ms
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((t) => t !== timer)
        timer.fn()
      }
      await settle()
    }
  }
}

function card(cards: DingTalkCardPort, clock = fakeClock()) {
  const sendText = vi.fn(async (_text: string) => 'pqk')
  const progress = new DingTalkProgressCard(cards, 'cid', new DingTalkQuotaNotice(sendText), clock.opts)
  return { progress, sendText, clock }
}

describe('DingTalkProgressView', () => {
  it('shows nothing in none mode and names tools only in medium and high', () => {
    expect(new DingTalkProgressView('none').onUpdate(tool('t1', 'Read file'))).toEqual([])
    expect(new DingTalkProgressView('low').onUpdate(tool('t1', 'Read file'))).toEqual([
      { kind: 'card', text: '🔨 Working…', tools: 1 }
    ])
    expect(new DingTalkProgressView('medium').onUpdate(tool('t1', 'Read `src/a.ts`'))).toEqual([
      { kind: 'card', text: '🔨 Read src/a.ts\n\n⏳ Read src/a.ts', tools: 1 }
    ])
  })

  it('emits on a status change or enough reply growth, with a bounded plain tail', () => {
    const view = new DingTalkProgressView('low')
    expect(view.onUpdate(chunk('Hello'))).toEqual([{ kind: 'card', text: '✍️ Writing…\n\nHello', tools: 0 }])
    expect(view.onUpdate(chunk(' there'))).toEqual([])
    const long = `\n\n## Table\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n${'word '.repeat(300)}`
    const [action] = view.onUpdate(chunk(long))
    expect(action?.text.startsWith('✍️ Writing…\n\n…')).toBe(true)
    expect([...(action?.text ?? '')].length).toBeLessThanOrEqual(DINGTALK_CARD_TAIL_CHARS + 20)
    expect(action?.text).not.toMatch(/```|\|/)
  })

  it('never shows the no-response marker', () => {
    const view = new DingTalkProgressView('low')
    const texts = [
      ...view.onUpdate(chunk('AC_NO')),
      ...view.onUpdate(chunk(NO_RESPONSE_SENTINEL.slice('AC_NO'.length) + ' '.repeat(200))),
      ...view.onUpdate(chunk(`Real answer. ${'x'.repeat(200)}`, 'm2'))
    ].map((action) => action.text)
    expect(texts[0]).toBe('✍️ Writing…')
    expect(texts.at(-1)).toMatch(/^✍️ Writing…\n\nReal answer\./)
    expect(texts.join('\n')).not.toContain('AC_NO')
  })

  it('turns Markdown the card renders badly into plain lines', () => {
    expect(
      plainCardText(
        '# Head\n\n- one\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n[x](https://example.test) **b**'
      )
    ).toBe('Head\n\n• one\n(2) two\n\na · b\n1 · 2\n\ncode\nx b')
  })
})

describe('DingTalkProgressCard', () => {
  it('coalesces updates to one push per interval and collapses to a summary', async () => {
    const { calls, cards } = fakeCards()
    const { progress, clock } = card(cards)
    progress.update('first', 0)
    await clock.advance(0)
    progress.update('second', 1)
    await clock.advance(1_000)
    progress.update('third', 2)
    await clock.advance(1_000)
    expect(calls).toEqual(['open', 'status 2 ', 'stream first'])
    await clock.advance(DINGTALK_CARD_INTERVAL_MS)
    expect(calls.at(-1)).toBe('stream third')
    await clock.advance(60_000)
    await progress.end('completed')
    expect(calls.slice(-2)).toEqual([
      'stream final ✅ Finished in 1m 05s · 2 tool calls',
      'status 3 ✅ Finished in 1m 05s · 2 tool calls'
    ])
  })

  it('settles a stopped turn as finished and a failed one as failed', async () => {
    const stopped = fakeCards()
    const a = card(stopped.cards)
    await a.clock.advance(12_000)
    await a.progress.end('interrupted')
    expect(stopped.calls).toEqual(['open', 'status 3 ⏹ Stopped after 12s'])
    const failed = fakeCards()
    const b = card(failed.cards)
    b.progress.update('working', 0)
    await b.clock.advance(3_000)
    await b.progress.end('failed')
    expect(failed.calls.slice(-2)).toEqual(['stream final error ⚠️ Failed after 3s', 'status 5 ⚠️ Failed after 3s'])
  })

  it('shows a failure notice in place and ignores the end after it', async () => {
    const { calls, cards } = fakeCards()
    const { progress, clock } = card(cards)
    await clock.settle()
    await expect(progress.replace('⚠️ Agent failed to respond: boom')).resolves.toBe(true)
    await progress.end('failed')
    expect(calls).toEqual(['open', 'status 5 ⚠️ Agent failed to respond: boom'])
  })

  it('runs the turn without a card when the card cannot open', async () => {
    const { calls, cards } = fakeCards({ openError: dingTalkApiError('/v1.0/card/instances', 403, 'Forbidden') })
    const { progress, sendText, clock } = card(cards)
    progress.update('text', 0)
    await clock.advance(10_000)
    await expect(progress.replace('notice')).resolves.toBe(false)
    await progress.end('completed')
    expect(calls).toEqual(['open'])
    expect(sendText).not.toHaveBeenCalled()
  })

  it('skips an update refused for QPS and backs off', async () => {
    const { calls, cards } = fakeCards({ streamErrors: [RATE] })
    const { progress, clock } = card(cards)
    progress.update('one', 0)
    await clock.advance(0)
    expect(calls).toEqual(['open', 'status 2 ', 'stream one'])
    await clock.advance(DINGTALK_CARD_INTERVAL_MS)
    expect(calls).toHaveLength(3)
    await clock.advance(DINGTALK_CARD_INTERVAL_MS)
    expect(calls.at(-1)).toBe('stream one')
  })

  it('stops the card and posts the quota notice once per turn', async () => {
    const { calls, cards } = fakeCards({ openError: QUOTA })
    const { progress, sendText, clock } = card(cards)
    await clock.settle()
    expect(sendText).toHaveBeenCalledExactlyOnceWith(DINGTALK_QUOTA_NOTICE)
    await progress.quota.note(QUOTA)
    expect(sendText).toHaveBeenCalledTimes(1)
    const streaming = fakeCards({ streamErrors: [QUOTA] })
    const second = card(streaming.cards)
    second.progress.update('one', 0)
    await second.clock.advance(0)
    second.progress.update('two', 0)
    await second.clock.advance(DINGTALK_CARD_INTERVAL_MS)
    expect(streaming.calls).toEqual(['open', 'status 2 ', 'stream one'])
    expect(second.sendText).toHaveBeenCalledExactlyOnceWith(DINGTALK_QUOTA_NOTICE)
    expect(calls).toEqual(['open'])
  })
})

describe('DingTalk turn wiring', () => {
  const host = { appendTranscript: async () => {}, monotonicTs: () => 'local-1' }
  const turn = {
    plan: { transcriptChannel: 'transcript', statusThread: 'dt:msg-1', agentId: 'agent', sessionKey: 'session' }
  }

  it('acknowledges with a card unless the mode is none, and hands it to the turn state', () => {
    const { cards } = fakeCards()
    const conn = { sendMarkdown: vi.fn(), sendText: vi.fn(), cards } as unknown as DingTalkReplyPort
    const surface = createDingTalkTurnOutput(host)
    const ctx = (mode: string) =>
      ({ mode, isDm: false, showFooter: true, message: { channel: 'cid' }, egress: conn }) as never
    expect(surface.acknowledge?.(ctx('none'), { rerun: false, interrupted: () => false })).toBeUndefined()
    const ack = surface.acknowledge?.(ctx('low'), { rerun: false, interrupted: () => false })
    expect(ack).toBeInstanceOf(DingTalkProgressCard)
    const state = surface.initialTurnState({ ...(ctx('low') as object), acknowledgement: ack } as never) as {
      card?: unknown
      quota?: unknown
    }
    expect(state.card).toBe(ack)
    expect(state.quota).toBe((ack as DingTalkProgressCard).quota)
  })

  it('routes card actions to the card and names a quota refusal of the answer once', async () => {
    const sendText = vi.fn(async (_channel: string, _text: string) => 'pqk')
    const conn = {
      sendMarkdown: vi.fn(async () => [{ text: 'answer', error: QUOTA }]),
      sendText
    } satisfies DingTalkReplyPort
    const update = vi.fn()
    const state = {
      conn,
      channel: 'cid',
      card: { update } as unknown as DingTalkProgressCard,
      quota: new DingTalkQuotaNotice((text) => sendText('cid', text))
    }
    const conv = new DingTalkConverger('low', { continueHint: false })
    for (const action of conv.onUpdate(chunk('Hello'))) await applyDingTalkAction(host, turn, state, action)
    expect(update).toHaveBeenCalledWith('✍️ Writing…\n\nHello', 0)
    await applyDingTalkAction(host, turn, state, { kind: 'post', text: 'answer' })
    await applyDingTalkAction(host, turn, state, { kind: 'post', text: 'answer' })
    expect(sendText).toHaveBeenCalledExactlyOnceWith('cid', DINGTALK_QUOTA_NOTICE)
  })
})

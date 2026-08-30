import { describe, it, expect } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import {
  TelegramConverger,
  escapeHtml,
  renderStatusText,
  renderStatusReply,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_CONTINUE_HINT,
  TELEGRAM_CONTINUE_HINT_SUFFIX,
  type TelegramAction
} from '../src/telegram/render.js'

const chunk = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate
const thought = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate
const toolCall = (o: Record<string, unknown>): SessionUpdate =>
  ({ sessionUpdate: 'tool_call', ...o }) as unknown as SessionUpdate
const plan = (entries: unknown[]): SessionUpdate => ({ sessionUpdate: 'plan', entries }) as unknown as SessionUpdate

const kinds = (as: TelegramAction[]) => as.map((a) => a.kind)

describe('escapeHtml', () => {
  it('escapes only & < >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    expect(escapeHtml('plain "quotes" ok')).toBe('plain "quotes" ok')
  })
})

describe('TelegramConverger body buffering', () => {
  it('buffers message chunks and flushes them as plain-text post actions', () => {
    const c = new TelegramConverger('low')
    expect(c.onUpdate(chunk('hello '))).toEqual([])
    expect(c.onUpdate(chunk('world\n\n'))).toEqual([])
    expect(c.hasBuffered()).toBe(true)
    const out = c.flushBuffered()
    expect(out).toEqual([{ kind: 'post', text: 'hello world\n\n' }])
  })

  it('idle-flushes only through the last paragraph break, holding the streaming tail', () => {
    const c = new TelegramConverger('low')
    c.onUpdate(chunk('First paragraph.\n\nSecond one is still mid-wo'))
    expect(c.flushBuffered()).toEqual([{ kind: 'post', text: 'First paragraph.\n\n' }])
    c.onUpdate(chunk('rd.'))
    expect(
      c.onFinal('https://example/session').some((a) => a.kind === 'post' && a.text === 'Second one is still mid-word.')
    ).toBe(true)
  })

  it('flushTerminal drains a boundary-less body and a held tail — the turn never reaches onFinal', () => {
    const noBreak = new TelegramConverger('medium')
    noBreak.onUpdate(chunk("You've hit your usage limit."))
    expect(noBreak.flushTerminal()).toEqual([{ kind: 'post', text: "You've hit your usage limit." }])
    expect(noBreak.hasBuffered()).toBe(false)

    const withTail = new TelegramConverger('medium')
    withTail.onUpdate(chunk('Quota exceeded.\n\nRetry after the reset at'))
    expect(withTail.flushTerminal()).toEqual([{ kind: 'post', text: 'Quota exceeded.\n\nRetry after the reset at' }])
    expect(withTail.hasBuffered()).toBe(false)
  })

  it('splits an over-long body across posts at the 4096 cap', () => {
    const c = new TelegramConverger('low')
    const line = 'x'.repeat(3000)
    c.onUpdate(chunk(`${line}\n${line}\n\n`))
    const out = c.flushBuffered()
    expect(out).toHaveLength(2)
    for (const a of out) {
      expect(a.kind).toBe('post')
      expect((a as { text: string }).text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
  })

  it('suppresses a bare AC_NO_RESPONSE reply', () => {
    const c = new TelegramConverger('medium')
    c.onUpdate(chunk('AC_NO_RESPONSE'))
    expect(c.flushBuffered().some((a) => a.kind === 'post')).toBe(false)
    expect(c.onFinal('https://example/session')).toEqual([])
  })

  it('suppresses a model explanation followed by a terminal bare sentinel', () => {
    const c = new TelegramConverger('medium')
    c.onUpdate(chunk('This message is addressed to another user, not me.\n\nAC_NO_RESPONSE'))
    expect(c.onFinal('https://example/session')).toEqual([])
  })

  it('still posts a normal reply that starts with the sentinel prefix then diverges', () => {
    const c = new TelegramConverger('low')
    c.onUpdate(chunk('NO'))
    c.onUpdate(chunk(' worries'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'NO worries' }])
  })
})

describe('TelegramConverger modes', () => {
  it('low mode: a tool call flushes body + a typing hint (no progress message)', () => {
    const c = new TelegramConverger('low')
    c.onUpdate(chunk('before'))
    const out = c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read file' }))
    expect(kinds(out)).toEqual(['post', 'typing'])
  })

  it('medium mode: a tool call emits an in-place progress message with the label as inline code', () => {
    const c = new TelegramConverger('medium')
    const out = c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash: ls' }))
    expect(kinds(out)).toEqual(['typing', 'progress'])
    const progress = out.find((a) => a.kind === 'progress') as { text: string; parseMode: string }
    expect(progress.parseMode).toBe('HTML')
    expect(progress.text).toBe('🔨 <code>Bash: ls</code>')
  })

  it('high mode: accumulates reasoning and drains it (above the body) as an HTML thinking block', () => {
    const c = new TelegramConverger('high')
    c.onUpdate(thought('let me '))
    c.onUpdate(thought('consider'))
    c.onUpdate(chunk('the answer\n\n'))
    const out = c.flushBuffered()
    expect(kinds(out)).toEqual(['reasoning', 'post'])
    const reasoning = out[0] as { text: string; parseMode: string }
    expect(reasoning.parseMode).toBe('HTML')
    expect(reasoning.text.startsWith('💭 <b>Thinking</b>')).toBe(true)
    expect(reasoning.text).toContain('let me consider')
  })

  it('high mode: a finished tool posts its output once as an HTML <pre> block', () => {
    const c = new TelegramConverger('high')
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash', status: 'in_progress' }))
    const done = c.onUpdate(
      toolCall({
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '<result> 3 files' } }]
      })
    )
    const output = done.find((a) => a.kind === 'tool-output') as { text: string }
    expect(output.text).toContain('<pre>&lt;result&gt; 3 files</pre>')
    // Not re-emitted on a later update.
    const again = c.onUpdate(toolCall({ toolCallId: 't1', status: 'completed' }))
    expect(again.find((a) => a.kind === 'tool-output')).toBeUndefined()
  })

  it('renders a plan (medium/high) with unicode status icons, escaped', () => {
    const c = new TelegramConverger('medium')
    const out = c.onUpdate(
      plan([
        { content: 'do <x>', status: 'completed' },
        { content: 'do y', status: 'in_progress' },
        { content: 'do z', status: 'pending' }
      ])
    )
    const p = out.find((a) => a.kind === 'plan') as { text: string }
    expect(p.text).toBe('📋 <b>Plan</b>\n✅ do &lt;x&gt;\n⏳ do y\n⬜ do z')
  })

  // Output mode is ONE agent-level setting every integration obeys, so the plan cannot be a
  // channel message on one platform and a typing hint on another at the same rung.
  it('posts the plan on low too, the default mode', () => {
    const c = new TelegramConverger('low')
    const out = c.onUpdate(plan([{ content: 'do y', status: 'in_progress' }]))
    expect((out.find((a) => a.kind === 'plan') as { text: string } | undefined)?.text).toBe('📋 <b>Plan</b>\n⏳ do y')
  })

  it('still withholds the plan on minimal and none', () => {
    for (const mode of ['minimal', 'none'] as const) {
      const c = new TelegramConverger(mode)
      const out = c.onUpdate(plan([{ content: 'do y', status: 'in_progress' }]))
      expect(out.some((a) => a.kind === 'plan')).toBe(false)
    }
  })
})

describe('TelegramConverger minimal mode', () => {
  it('collapses narration into one live-reply and records each segment (recordOnly)', () => {
    const c = new TelegramConverger('minimal')
    expect(c.onUpdate(chunk('step one '))).toEqual([])
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' }))).toEqual([
      { kind: 'typing' },
      { kind: 'live-reply', text: 'step one ' },
      { kind: 'post', text: 'step one ', recordOnly: true }
    ])
    expect(c.onUpdate(chunk('final'))).toEqual([])
    expect(c.onFinal('https://example.com/s/1')).toEqual([
      { kind: 'live-reply', text: 'final' },
      { kind: 'post', text: 'final', recordOnly: true }
    ])
  })

  it('idle flush streams the current segment as a live-reply', () => {
    const c = new TelegramConverger('minimal')
    c.onUpdate(chunk('partial'))
    expect(c.flushBuffered()).toEqual([{ kind: 'live-reply', text: 'partial' }])
  })

  it('does not re-record a segment already closed by a tool boundary', () => {
    const c = new TelegramConverger('minimal')
    c.onUpdate(chunk('done'))
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' })).filter((a) => a.kind === 'post')).toEqual([
      { kind: 'post', text: 'done', recordOnly: true }
    ])
    expect(c.onFinal()).toEqual([])
  })
})

describe('TelegramConverger onFinal', () => {
  it('low mode flushes the body only', () => {
    const c = new TelegramConverger('low')
    c.onUpdate(chunk('answer'))
    expect(c.onFinal('https://app/x')).toEqual([{ kind: 'post', text: 'answer' }])
  })

  it('medium mode appends a done footer linking to the session detail', () => {
    const c = new TelegramConverger('medium')
    c.onUpdate(chunk('answer'))
    const out = c.onFinal('https://app/s/1')
    expect(kinds(out)).toEqual(['post', 'notice'])
    const footer = out[1] as { text: string }
    expect(footer.text).toBe('✅ done — <a href="https://app/s/1">details</a>')
  })

  it('adds the hop-limit notice to the existing final footer', () => {
    const c = new TelegramConverger('medium')
    c.onUpdate(chunk('answer'))
    const out = c.onFinal('https://app/s/1', 'Agent conversation stopped after reaching the 20-hop limit.')
    expect(out).toContainEqual({
      kind: 'notice',
      text:
        '✅ done — <a href="https://app/s/1">details</a> · ' +
        'Agent conversation stopped after reaching the 20-hop limit.',
      parseMode: 'HTML'
    })
  })

  it('omits the footer when no link is configured', () => {
    const c = new TelegramConverger('medium')
    c.onUpdate(chunk('answer'))
    expect(kinds(c.onFinal())).toEqual(['post'])
  })
})

describe('TelegramConverger continue hint', () => {
  it('annotates the turn-closing reply so users know to reply to it', () => {
    const c = new TelegramConverger('low', { continueHint: true })
    c.onUpdate(chunk('answer'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'answer', hint: TELEGRAM_CONTINUE_HINT }])
  })

  it('carries the hint on the LAST section only when the reply is split', () => {
    const c = new TelegramConverger('medium', { continueHint: true })
    const line = 'x'.repeat(3000)
    c.onUpdate(chunk(`${line}\n${line}`))
    const posts = c.onFinal().filter((a) => a.kind === 'post') as { hint?: string }[]
    expect(posts).toHaveLength(2)
    expect(posts[0]!.hint).toBeUndefined()
    expect(posts[1]!.hint).toBe(TELEGRAM_CONTINUE_HINT)
  })

  it('reserves the suffix in the body budget so a maximal section + hint still fits', () => {
    const c = new TelegramConverger('medium', { continueHint: true })
    // One unbroken line (no newline to split on) longer than the cap: the splitter hard-cuts
    // at the budget, so section 1 is exactly maximal — the case that used to overflow.
    c.onUpdate(chunk('x'.repeat(TELEGRAM_MESSAGE_LIMIT + 500)))
    const posts = c.onFinal().filter((a) => a.kind === 'post') as { text: string; hint?: string }[]
    expect(posts.length).toBeGreaterThan(1)
    expect(posts[0]!.text.length).toBe(TELEGRAM_MESSAGE_LIMIT - TELEGRAM_CONTINUE_HINT_SUFFIX.length)
    for (const p of posts) {
      const sent = p.hint ? `${p.text}${TELEGRAM_CONTINUE_HINT_SUFFIX}` : p.text
      expect(sent.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
  })

  it('annotates the already-sent body when the turn ends with nothing left to flush', () => {
    const c = new TelegramConverger('low', { continueHint: true })
    c.onUpdate(chunk('before'))
    // A tool boundary drains the body mid-turn; no further text arrives.
    const mid = c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' }))
    expect(mid.find((a) => a.kind === 'post')).toEqual({ kind: 'post', text: 'before' })
    expect(c.onFinal()).toEqual([{ kind: 'continue-hint', hint: TELEGRAM_CONTINUE_HINT }])
  })

  it('annotates an idle-flushed reply the same way, and only once', () => {
    const c = new TelegramConverger('medium', { continueHint: true })
    c.onUpdate(chunk('streamed answer\n\n'))
    expect(c.flushBuffered()).toEqual([{ kind: 'post', text: 'streamed answer\n\n' }])
    const out = c.onFinal('https://app/s/1')
    expect(kinds(out)).toEqual(['continue-hint', 'notice'])
  })

  it('carries the hint on the final post rather than a redundant edit', () => {
    const c = new TelegramConverger('low', { continueHint: true })
    c.onUpdate(chunk('before'))
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' }))
    c.onUpdate(chunk('after'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'after', hint: TELEGRAM_CONTINUE_HINT }])
  })

  it('emits no hint for a turn that never sent a body', () => {
    const c = new TelegramConverger('low', { continueHint: true })
    c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' }))
    expect(c.onFinal()).toEqual([])
  })

  it('emits no hint for a suppressed (AC_NO_RESPONSE) turn', () => {
    const c = new TelegramConverger('low', { continueHint: true })
    c.onUpdate(chunk('AC_NO_RESPONSE'))
    expect(c.onFinal()).toEqual([])
  })

  it('never annotates modes whose reply is not a sent, recorded post', () => {
    for (const mode of ['none', 'minimal'] as const) {
      const c = new TelegramConverger(mode, { continueHint: true })
      c.onUpdate(chunk('answer'))
      for (const a of c.onFinal()) expect((a as { hint?: string }).hint).toBeUndefined()
    }
  })

  it('stays off by default', () => {
    const c = new TelegramConverger('high')
    c.onUpdate(chunk('answer'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'answer' }])
  })
})

describe('status text (/status reply)', () => {
  it('renders a compact HTML status line', () => {
    expect(
      renderStatusText({
        model: 'opus-4.8',
        fastMode: true,
        contextUsed: 120_000,
        contextSize: 200_000,
        totalTokens: 45_200
      })
    ).toBe('📊 <b>opus-4.8</b> · fast · ctx 120k/200k (60%) · 45k tok')
    // Under 10k keeps one decimal.
    expect(renderStatusText({ totalTokens: 4520 })).toBe('📊 4.5k tok')
    expect(renderStatusText({})).toBe('📊 —')
  })

  it('appends a View-session link line when a deep link is known', () => {
    expect(renderStatusReply({ model: 'opus-4.8' }, 'https://app/s/1')).toBe(
      '📊 <b>opus-4.8</b>\n🔗 <a href="https://app/s/1">View session</a>'
    )
  })

  it('omits the link line (and escapes the link) appropriately', () => {
    expect(renderStatusReply({ totalTokens: 4520 })).toBe('📊 4.5k tok')
    expect(renderStatusReply({}, 'https://app/s/a&b')).toBe('📊 —\n🔗 <a href="https://app/s/a&amp;b">View session</a>')
  })
})

// A run that speaks more than once has no tool/thought/plan boundary between its messages, so the
// runtime's own `messageId` is the only thing separating them — see test/message-boundary.test.ts.
describe('TelegramConverger message boundaries', () => {
  const named = (messageId: string, text: string): SessionUpdate =>
    ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }) as unknown as SessionUpdate

  const postsOf = (c: TelegramConverger, updates: SessionUpdate[]): string[] => {
    const out: string[] = []
    const take = (actions: { kind: string; text?: string }[]): void => {
      for (const a of actions) if (a.kind === 'post' && a.text !== undefined) out.push(a.text)
    }
    for (const u of updates) take(c.onUpdate(u))
    take(c.onFinal())
    return out
  }

  it('delivers each named message on its own', () => {
    const posts = postsOf(new TelegramConverger('low'), [named('m1', 'first thing'), named('m2', 'second thing')])
    expect(posts).toEqual(['first thing', 'second thing'])
  })

  it('keeps an unnamed run one message, however many chunks it streams in', () => {
    const posts = postsOf(new TelegramConverger('low'), [chunk('Hello '), chunk('there.')])
    expect(posts).toEqual(['Hello there.'])
  })
})

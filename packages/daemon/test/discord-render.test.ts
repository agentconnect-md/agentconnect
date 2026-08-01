import { describe, it, expect } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { DiscordConverger, type DiscordAction } from '../src/discord/render.js'

const chunk = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate
const toolCall = (o: Record<string, unknown>): SessionUpdate =>
  ({ sessionUpdate: 'tool_call', ...o }) as unknown as SessionUpdate
const kinds = (as: DiscordAction[]) => as.map((a) => a.kind)

describe('DiscordConverger modes', () => {
  it('low mode: a tool call flushes body + a typing hint (no progress message)', () => {
    const c = new DiscordConverger('low')
    c.onUpdate(chunk('before'))
    expect(kinds(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read file' })))).toEqual(['post', 'typing'])
  })

  it('medium mode: a tool call emits an in-place progress message', () => {
    const c = new DiscordConverger('medium')
    expect(kinds(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Bash' })))).toEqual(['typing', 'progress'])
  })

  it('idle-flushes only through the last paragraph break so a reply is never cut mid-sentence', () => {
    const c = new DiscordConverger('medium')
    c.onUpdate(chunk('First paragraph.\n\nStill streaming mid-wo'))
    expect(c.flushBuffered()).toEqual([{ kind: 'post', text: 'First paragraph.\n\n' }])
    c.onUpdate(chunk('rd.'))
    expect(c.onFinal()).toContainEqual({ kind: 'post', text: 'Still streaming mid-word.' })
  })

  it('idle-flushes nothing while the buffer holds no paragraph break yet', () => {
    const c = new DiscordConverger('medium')
    c.onUpdate(chunk('one long line so f'))
    expect(c.flushBuffered()).toEqual([])
    expect(c.hasBuffered()).toBe(true)
  })

  it('flushTerminal drains a boundary-less body and a held tail — the turn never reaches onFinal', () => {
    const noBreak = new DiscordConverger('medium')
    noBreak.onUpdate(chunk("You've hit your usage limit."))
    expect(noBreak.flushTerminal()).toEqual([{ kind: 'post', text: "You've hit your usage limit." }])
    expect(noBreak.hasBuffered()).toBe(false)

    const withTail = new DiscordConverger('medium')
    withTail.onUpdate(chunk('Quota exceeded.\n\nRetry after the reset at'))
    expect(withTail.flushTerminal()).toEqual([{ kind: 'post', text: 'Quota exceeded.\n\nRetry after the reset at' }])
    expect(withTail.hasBuffered()).toBe(false)
  })
})

describe('DiscordConverger AC_NO_RESPONSE suppression', () => {
  it('suppresses a model explanation followed by a terminal bare sentinel', () => {
    const c = new DiscordConverger('medium')
    c.onUpdate(chunk('This message is addressed to another user, not me.\n\nAC_NO_RESPONSE'))
    expect(c.onFinal('https://example/session')).toEqual([])
  })
})

describe('DiscordConverger minimal mode', () => {
  it('collapses narration into one live-reply and records each segment (recordOnly)', () => {
    const c = new DiscordConverger('minimal')
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
    const c = new DiscordConverger('minimal')
    c.onUpdate(chunk('partial'))
    expect(c.flushBuffered()).toEqual([{ kind: 'live-reply', text: 'partial' }])
  })

  it('does not re-record a segment already closed by a tool boundary', () => {
    const c = new DiscordConverger('minimal')
    c.onUpdate(chunk('done'))
    expect(c.onUpdate(toolCall({ toolCallId: 't1', title: 'Read' })).filter((a) => a.kind === 'post')).toEqual([
      { kind: 'post', text: 'done', recordOnly: true }
    ])
    expect(c.onFinal()).toEqual([])
  })
})

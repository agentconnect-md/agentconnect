import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { QQConverger, applyQQAction, type QQTurnState } from '../src/platforms/qq/turn-output.js'

const chunk = (text: string, phase?: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  ...(phase ? { _meta: { codex: { phase } } } : {}),
  ...(messageId ? { messageId } : {})
})
const tool: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Check', status: 'in_progress' }
afterEach(() => vi.useRealTimers())

describe('QQ group progress', () => {
  it.each([undefined, 'commentary'])('publishes only complete public messages (phase=%s)', (phase) => {
    const c = new QQConverger('high', undefined, 'group')
    expect(c.onUpdate(chunk('Checking ', phase))).toEqual([])
    expect(c.onUpdate(chunk('the input.', phase))).toEqual([])
    expect(c.onUpdate(tool)).toEqual([{ kind: 'qq-progress', text: 'Checking the input.', attributed: false }])
    expect(
      c.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private thought' } })
    ).toEqual([])
    expect(c.onUpdate(chunk('Complete ', phase ? 'final_answer' : undefined))).toEqual([])
    expect(c.onUpdate(chunk('answer.', phase ? 'final_answer' : undefined))).toEqual([])
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'Complete answer.', attributed: false }])
    expect(c.onFinal()).toEqual([])
  })

  it('uses named-message boundaries, caps progress at two posts and spaces them by fifteen seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const c = new QQConverger('high', undefined, 'group')
    c.onUpdate(chunk('First.', undefined, 'first'))
    expect(c.onUpdate(chunk('Too soon.', undefined, 'second'))).toMatchObject([{ kind: 'qq-progress', text: 'First.' }])
    expect(c.onUpdate(tool)).toEqual([])
    vi.setSystemTime(15_000)
    c.onUpdate(chunk('Second.', undefined, 'third'))
    expect(c.onUpdate(tool)).toMatchObject([{ kind: 'qq-progress', text: 'Second.' }])
    vi.setSystemTime(30_000)
    c.onUpdate(chunk('Over limit.'))
    expect(c.onUpdate(tool)).toEqual([])
    c.onUpdate(chunk('Final.', 'final_answer'))
    expect(c.onFinal()).toMatchObject([{ kind: 'post', text: 'Final.' }])
  })

  it('rewrites workspace links only after the complete progress message arrives', () => {
    const c = new QQConverger('high', () => 'https://console.example/file', 'group')
    expect(c.onUpdate(chunk('Review [the file]('))).toEqual([])
    expect(c.onUpdate(chunk('/workspace/private.txt).'))).toEqual([])
    const action = c.onUpdate(tool)[0]!
    expect(action.text).toContain('https://console.example/file')
    expect(action.text).not.toContain('/workspace/')
  })

  it.each(['low', 'none'])('keeps progress silent in %s mode', (mode) => {
    const c = new QQConverger(mode, undefined, 'group')
    c.onUpdate(chunk('Checking.', 'commentary'))
    expect(c.onUpdate(tool)).toEqual([])
    c.onUpdate(chunk('Final.', 'final_answer'))
    expect(c.onFinal()).toEqual([
      { kind: 'post', text: 'Final.', attributed: false, ...(mode === 'none' ? { recordOnly: true } : {}) }
    ])
  })

  it('withholds no-response markers, long progress and explicitly final content', () => {
    for (const [text, phase] of [
      ['AC_NO_RESPONSE', undefined],
      ['x'.repeat(1201), undefined],
      ['Final.', 'final_answer']
    ]) {
      const c = new QQConverger('high', undefined, 'group')
      c.onUpdate(chunk(text!, phase))
      expect(c.onUpdate(tool)).toEqual([])
    }
  })

  it.each([true, false])('only suppresses a repeated final when the progress was delivered (%s)', async (sent) => {
    const sendProgress = vi.fn(async () => sent)
    const sendText = vi.fn(async () => {})
    const record = vi.fn(async () => {})
    const state: QQTurnState = { channel: 'group:g', replyId: 'm', conn: { sendProgress, sendText } }
    await applyQQAction(state, { kind: 'qq-progress', text: 'Result.' }, record)
    await applyQQAction(state, { kind: 'post', text: 'Result.' }, record)
    expect(sendText).toHaveBeenCalledTimes(sent ? 0 : 1)
    expect(record).toHaveBeenCalledExactlyOnceWith('Result.')
  })
})

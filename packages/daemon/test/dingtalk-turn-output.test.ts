import { describe, expect, it, vi } from 'vitest'
import {
  applyDingTalkAction,
  DINGTALK_CONTINUE_HINT,
  DingTalkConverger,
  type DingTalkTurnHost
} from '../src/platforms/dingtalk/turn-output.js'
import type { DingTalkReplyPort } from '../src/platforms/dingtalk/connection.js'

const chunk = (text: string, messageId: string) =>
  ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }) as never

describe('DingTalkConverger', () => {
  it('posts the final answer with the continue hint only where the hint is on', () => {
    const group = new DingTalkConverger('low', { continueHint: true })
    group.onUpdate(chunk('Done.', 'm1'))
    expect(group.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false, hint: DINGTALK_CONTINUE_HINT }])
    const dm = new DingTalkConverger('low', { continueHint: false })
    dm.onUpdate(chunk('Done.', 'm1'))
    expect(dm.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false }])
    const silent = new DingTalkConverger('none', { continueHint: true })
    silent.onUpdate(chunk('Done.', 'm1'))
    expect(silent.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false, recordOnly: true }])
  })

  it('posts a completed intermediate message in medium mode, never the partial one', () => {
    const conv = new DingTalkConverger('medium', { continueHint: true })
    expect(conv.onUpdate(chunk('Checking ', 'm1'))).toEqual([])
    expect(conv.onUpdate(chunk('the logs.', 'm1'))).toEqual([])
    expect(conv.onUpdate(chunk('Found it.', 'm2'))).toEqual([
      { kind: 'post', text: 'Checking the logs.', attributed: false }
    ])
    expect(conv.onFinal()).toEqual([
      { kind: 'post', text: 'Found it.', attributed: false, hint: DINGTALK_CONTINUE_HINT }
    ])
    // A failed turn flushes what it has without the hint.
    const failed = new DingTalkConverger('low', { continueHint: true })
    failed.onUpdate(chunk('Partial answer.', 'm1'))
    expect(failed.flushTerminal()).toEqual([{ kind: 'post', text: 'Partial answer.', attributed: false }])
  })
})

describe('applyDingTalkAction', () => {
  const turn = {
    plan: { transcriptChannel: 'transcript', statusThread: 'dt:msg-1', agentId: 'agent', sessionKey: 'session' }
  }
  const setup = (sent: { text: string; processQueryKey?: string }[]) => {
    const rows: { ts: string; text: string; thread: string }[] = []
    let local = 0
    const host: DingTalkTurnHost = {
      appendTranscript: async (row) => void rows.push({ ts: row.ts, text: row.text, thread: row.thread }),
      monotonicTs: () => `local-${++local}`
    }
    const conn = {
      sendMarkdown: vi.fn(async () => sent),
      sendText: vi.fn(async () => 'pqk-notice')
    } satisfies DingTalkReplyPort
    return { rows, host, conn }
  }

  it('records each sent part under its process query key and a failed part under a local one', async () => {
    const { rows, host, conn } = setup([{ text: 'part one', processQueryKey: 'pqk-1' }, { text: 'part two' }])
    await applyDingTalkAction(host, turn, { conn, channel: 'cid' }, { kind: 'post', text: 'whole', hint: 'hint' })
    expect(conn.sendMarkdown).toHaveBeenCalledWith('cid', 'whole', { suffix: 'hint' })
    expect(rows).toEqual([
      { ts: 'pqk-1', text: 'part one', thread: 'dt:msg-1' },
      { ts: 'local-1', text: 'part two', thread: 'dt:msg-1' }
    ])
  })

  it('sends a notice as text without recording it, and records without sending when headless or record-only', async () => {
    const { rows, host, conn } = setup([])
    await applyDingTalkAction(host, turn, { conn, channel: 'cid' }, { kind: 'notice', text: 'Stopped.' })
    expect(conn.sendText).toHaveBeenCalledWith('cid', 'Stopped.')
    await applyDingTalkAction(host, turn, { conn, channel: 'cid' }, { kind: 'post', text: 'quiet', recordOnly: true })
    await applyDingTalkAction(host, turn, { channel: 'cid' }, { kind: 'post', text: 'headless' })
    expect(conn.sendMarkdown).not.toHaveBeenCalled()
    expect(rows.map((row) => row.text)).toEqual(['quiet', 'headless'])
  })
})

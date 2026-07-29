import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ReplyAttributionInfo } from '../src/messages/attribution.js'
import {
  buildCompletedReplyCard,
  buildStreamingReplyCard,
  FeishuConverger,
  FEISHU_STREAMING_ELEMENT_ID
} from '../src/feishu/render.js'

const chunk = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate

const attribution: ReplyAttributionInfo = {
  botName: 'Review Bot',
  botUrl: 'https://agentconnect.example/agents/review-bot',
  runtime: 'Codex',
  model: 'gpt-5.6',
  sessionUrl: 'https://agentconnect.example/sessions/123'
}

describe('FeishuConverger AC_NO_RESPONSE suppression', () => {
  it('retracts the initial card for a bare response-control marker', () => {
    const c = new FeishuConverger('low')
    expect(c.onStart()).toEqual([{ kind: 'card-start' }])
    c.onUpdate(chunk('AC_NO_RESPONSE'))
    expect(c.streamUpdate()).toEqual([])
    expect(c.onFinal()).toEqual([{ kind: 'card-cancel' }])
  })

  it('delivers the old generic NO_RESPONSE phrase as ordinary content', () => {
    const c = new FeishuConverger('low')
    c.onUpdate(chunk('NO_RESPONSE'))
    expect(c.onFinal()).toEqual([
      { kind: 'post', text: 'NO_RESPONSE', recordOnly: true },
      { kind: 'card-final', text: 'NO_RESPONSE' }
    ])
  })

  it('drains whitespace-only buffers before the next response segment', () => {
    const c = new FeishuConverger('low')
    c.onUpdate(chunk('   '))
    expect(c.flushBuffered()).toEqual([])
    c.onUpdate(chunk('hello'))
    expect(c.onFinal()).toEqual([
      { kind: 'post', text: 'hello', recordOnly: true },
      { kind: 'card-final', text: 'hello' }
    ])
  })
})

describe('Lark CardKit reply lifecycle', () => {
  it('streams cumulative text and finalizes the same reply with shared attribution', () => {
    const c = new FeishuConverger('low')
    expect(c.onStart()).toEqual([{ kind: 'card-start' }])

    c.onUpdate(chunk('Hello'))
    expect(c.streamUpdate()).toEqual([{ kind: 'card-stream', text: 'Hello' }])
    c.onUpdate(chunk(' world'))
    expect(c.onFinal(attribution)).toEqual([
      { kind: 'post', text: 'Hello world', recordOnly: true },
      {
        kind: 'card-final',
        text: 'Hello world',
        attribution
      }
    ])
  })

  it('builds a streaming element and the canonical attribution footer', () => {
    const initial = buildStreamingReplyCard() as {
      config: { streaming_mode: boolean }
      body: { elements: { element_id?: string; content?: string }[] }
    }
    expect(initial.config.streaming_mode).toBe(true)
    expect(initial.body.elements[0]).toMatchObject({
      element_id: FEISHU_STREAMING_ELEMENT_ID,
      content: 'Thinking…'
    })

    const completed = buildCompletedReplyCard('Done', attribution) as {
      body: { elements: { tag: string; content?: string; text_size?: string }[] }
    }
    expect(completed.body.elements).toEqual([
      { tag: 'markdown', content: 'Done' },
      {
        tag: 'markdown',
        text_size: 'notation',
        content:
          'sent by [Review Bot](https://agentconnect.example/agents/review-bot) (Codex · gpt-5.6) · [open in session](https://agentconnect.example/sessions/123)'
      }
    ])
  })
})

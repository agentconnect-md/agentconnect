import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import {
  buildCompletedReplyCard,
  buildStreamingReplyCard,
  FeishuConverger,
  FEISHU_STREAMING_ELEMENT_ID
} from '../src/feishu/render.js'

const chunk = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as unknown as SessionUpdate

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

describe('Feishu CardKit reply lifecycle', () => {
  it('streams cumulative text and finalizes the same reply with a session link', () => {
    const c = new FeishuConverger('low')
    expect(c.onStart()).toEqual([{ kind: 'card-start' }])

    c.onUpdate(chunk('Hello'))
    expect(c.streamUpdate()).toEqual([{ kind: 'card-stream', text: 'Hello' }])
    c.onUpdate(chunk(' world'))
    expect(c.onFinal('https://agentconnect.example/sessions/123')).toEqual([
      { kind: 'post', text: 'Hello world', recordOnly: true },
      {
        kind: 'card-final',
        text: 'Hello world',
        link: 'https://agentconnect.example/sessions/123'
      }
    ])
  })

  it('builds a streaming element and a linked notation footer', () => {
    const initial = buildStreamingReplyCard() as {
      config: { streaming_mode: boolean }
      body: { elements: { element_id?: string; content?: string }[] }
    }
    expect(initial.config.streaming_mode).toBe(true)
    expect(initial.body.elements[0]).toMatchObject({
      element_id: FEISHU_STREAMING_ELEMENT_ID,
      content: 'Thinking…'
    })

    const completed = buildCompletedReplyCard('Done', 'https://agentconnect.example/sessions/123') as {
      body: { elements: { tag: string; content?: string; text_size?: string }[] }
    }
    expect(completed.body.elements).toEqual([
      { tag: 'markdown', content: 'Done' },
      { tag: 'hr' },
      {
        tag: 'markdown',
        text_size: 'notation',
        content: 'AI-generated content is for reference only. [View session](https://agentconnect.example/sessions/123)'
      }
    ])
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ReplyAttributionInfo } from '../src/messages/attribution.js'
import {
  buildCompletedReplyCard,
  buildStreamingReplyCard,
  FeishuConverger,
  FEISHU_REPLY_ACTIONS_ELEMENT_ID,
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
    const initial = buildStreamingReplyCard(attribution.sessionUrl) as {
      config: { streaming_mode: boolean }
      body: { elements: Record<string, unknown>[] }
    }
    expect(initial.config.streaming_mode).toBe(true)
    expect(initial.body.elements[0]).toMatchObject({
      tag: 'column_set',
      columns: [
        {
          width: 'weighted',
          elements: [
            {
              element_id: FEISHU_STREAMING_ELEMENT_ID,
              content: 'Thinking…'
            }
          ]
        },
        {
          width: 'auto',
          elements: [
            {
              tag: 'overflow',
              element_id: FEISHU_REPLY_ACTIONS_ELEMENT_ID,
              options: [
                {
                  text: { tag: 'plain_text', content: 'Cancel run' },
                  value: 'cancel'
                },
                {
                  text: { tag: 'plain_text', content: 'View session' },
                  value: 'session',
                  multi_url: { url: attribution.sessionUrl }
                }
              ]
            }
          ]
        }
      ]
    })

    const completed = buildCompletedReplyCard('Done', attribution) as {
      body: { elements: Record<string, unknown>[] }
    }
    expect(completed.body.elements).toEqual([
      { tag: 'markdown', content: 'Done' },
      {
        tag: 'hr'
      },
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        horizontal_align: 'right',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              {
                tag: 'markdown',
                text_size: 'notation',
                content:
                  'sent by [Review Bot](https://agentconnect.example/agents/review-bot) (Codex · gpt-5.6) · [open in session](https://agentconnect.example/sessions/123)'
              }
            ]
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [
              {
                tag: 'overflow',
                element_id: FEISHU_REPLY_ACTIONS_ELEMENT_ID,
                width: 'default',
                options: [
                  {
                    text: { tag: 'plain_text', content: 'View session' },
                    value: 'session',
                    multi_url: { url: attribution.sessionUrl }
                  }
                ],
                value: { action: 'agentconnect_reply' }
              }
            ]
          }
        ]
      }
    ])
  })

  it('keeps the hop-limit notice inside the completed reply card footer', () => {
    const completed = buildCompletedReplyCard('Done', {
      ...attribution,
      notice: 'Agent conversation stopped after reaching the 20-hop limit.'
    }) as { body: { elements: Record<string, unknown>[] } }

    expect(JSON.stringify(completed.body.elements)).toContain(
      'Agent conversation stopped after reaching the 20-hop limit.'
    )
  })
})

// A run that speaks more than once has no tool/thought/plan boundary between its messages, so the
// runtime's own `messageId` is the only thing separating them — see test/message-boundary.test.ts.
describe('FeishuConverger message boundaries', () => {
  const named = (messageId: string, text: string): SessionUpdate =>
    ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }) as unknown as SessionUpdate

  const postsOf = (c: FeishuConverger, updates: SessionUpdate[]): string[] => {
    const out: string[] = []
    const take = (actions: { kind: string; text?: string }[]): void => {
      for (const a of actions) if (a.kind === 'post' && a.text !== undefined) out.push(a.text)
    }
    for (const u of updates) take(c.onUpdate(u))
    take(c.onFinal())
    return out
  }

  it('delivers each named message on its own', () => {
    const posts = postsOf(new FeishuConverger('low'), [named('m1', 'first thing'), named('m2', 'second thing')])
    expect(posts).toEqual(['first thing', 'second thing'])
  })

  it('keeps an unnamed run one message, however many chunks it streams in', () => {
    const posts = postsOf(new FeishuConverger('low'), [chunk('Hello '), chunk('there.')])
    expect(posts).toEqual(['Hello there.'])
  })
})

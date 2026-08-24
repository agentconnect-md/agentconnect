import { describe, expect, it, vi } from 'vitest'
import { FeishuConnection, type FeishuClientHandle } from '../src/feishu/connection.js'
import { buildCompletedReplyCard } from '../src/feishu/render.js'

describe('FeishuConnection.getChannelHistory', () => {
  it('converts bounds, maps messages, and preserves the provider cursor', async () => {
    const listMessages = vi.fn(async () => ({
      items: [
        {
          message_id: 'om_3',
          thread_id: 'omt_3',
          msg_type: 'text',
          create_time: '3000',
          sender: { id: 'ou_user', sender_type: 'user' },
          body: { content: '{"text":"hello @_user_1"}' },
          mentions: [{ key: '@_user_1', id: 'ou_alice', name: 'Alice' }]
        },
        {
          message_id: 'om_card',
          msg_type: 'interactive',
          create_time: '2500',
          sender: { id: 'cli_bot', sender_type: 'app' },
          body: { content: JSON.stringify(buildCompletedReplyCard('CardKit answer')) }
        },
        {
          message_id: 'om_2',
          msg_type: 'text',
          create_time: '2000',
          sender: { id: 'cli_bot', sender_type: 'app' },
          body: { content: '{"text":"bot reply"}' }
        },
        {
          message_id: 'om_1',
          msg_type: 'text',
          create_time: '1000',
          sender: { id: 'ou_old', sender_type: 'user' },
          body: { content: '{"text":"outside bound"}' }
        }
      ],
      hasMore: true,
      nextCursor: 'page-2'
    }))
    const handle = {
      api: { listMessages },
      startWs: async () => {},
      close: () => {}
    } as unknown as FeishuClientHandle
    const connection = new FeishuConnection(
      {
        group: {
          appId: 'cli_history',
          appSecret: 'secret',
          mode: 'direct',
          region: 'feishu',
          integrations: []
        },
        onMessage: () => {},
        newTraceId: () => 'trace'
      },
      () => handle
    )

    await expect(
      connection.getChannelHistory('oc_current', {
        cursor: 'page-1',
        limit: 200,
        oldest: '2000',
        latest: '3999'
      })
    ).resolves.toEqual({
      messages: [
        {
          sender: 'ou_user',
          ts: '3000',
          text: 'hello @Alice',
          isBot: false,
          threadTs: 'omt_3'
        },
        { sender: 'cli_bot', ts: '2500', text: 'CardKit answer', isBot: true },
        { sender: 'cli_bot', ts: '2000', text: 'bot reply', isBot: true }
      ],
      hasMore: true,
      nextCursor: 'page-2'
    })
    expect(listMessages).toHaveBeenCalledWith('oc_current', {
      cursor: 'page-1',
      limit: 50,
      startTime: '2',
      endTime: '4'
    })
  })
})

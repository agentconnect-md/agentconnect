import { describe, expect, it, vi } from 'vitest'
import { FeishuConnection, type ConsolidatedFeishuGroup, type FeishuClientHandle } from '../src/feishu/connection.js'
import { FEISHU_STREAMING_ELEMENT_ID } from '../src/feishu/render.js'

function connection() {
  const createCardEntity = vi.fn(async () => ({ cardId: 'card-1' }))
  const replyCardEntityMessage = vi.fn(async (): Promise<{ messageId?: string }> => ({ messageId: 'message-1' }))
  const updateCardEntityElement = vi.fn(async () => {})
  const setCardEntityStreaming = vi.fn(async () => {})
  const updateCardEntity = vi.fn(async () => {})
  const deleteMessage = vi.fn(async () => {})
  const handle: FeishuClientHandle = {
    api: {
      createText: async () => ({}),
      createCard: async () => ({}),
      replyText: async () => ({}),
      replyCard: async () => ({}),
      createCardEntity,
      createCardEntityMessage: async () => ({ messageId: 'message-flat' }),
      replyCardEntityMessage,
      updateCardEntityElement,
      setCardEntityStreaming,
      updateCardEntity,
      deleteMessage,
      updateText: async () => {},
      downloadResource: async () => {},
      getChat: async (id) => ({ id }),
      listChatMembers: async () => [],
      listChats: async () => [],
      getUser: async (id) => ({ id }),
      getBotInfo: async () => ({})
    },
    startWs: async () => {},
    close: () => {}
  }
  const group: ConsolidatedFeishuGroup = {
    appId: 'cli_streamingtest',
    appSecret: 'secret',
    region: 'lark',
    integrations: []
  }
  return {
    conn: new FeishuConnection(
      { group, onMessage: () => {}, newTraceId: () => 'trace', sendIntervalMs: 0 },
      () => handle
    ),
    createCardEntity,
    replyCardEntityMessage,
    updateCardEntityElement,
    setCardEntityStreaming,
    updateCardEntity,
    deleteMessage
  }
}

describe('Feishu CardKit transport', () => {
  it('creates, streams, and finalizes one threaded card with monotonic sequences', async () => {
    const {
      conn,
      createCardEntity,
      replyCardEntityMessage,
      updateCardEntityElement,
      setCardEntityStreaming,
      updateCardEntity
    } = connection()

    const card = await conn.startStreamingCard('oc_chat', 'om_root')
    expect(card).toEqual({ cardId: 'card-1', messageId: 'message-1' })
    expect(createCardEntity.mock.calls[0]![0]).toMatchObject({
      schema: '2.0',
      config: { streaming_mode: true }
    })
    expect(replyCardEntityMessage).toHaveBeenCalledWith('om_root', 'card-1')

    await conn.updateStreamingCard('oc_chat', card!, 'Hello')
    await conn.finishStreamingCard('oc_chat', card!, 'Hello world', 'https://agentconnect.example/sessions/123')

    expect(updateCardEntityElement).toHaveBeenCalledWith('card-1', FEISHU_STREAMING_ELEMENT_ID, 'Hello', 1)
    expect(setCardEntityStreaming).toHaveBeenCalledWith('card-1', false, 2)
    expect(updateCardEntity.mock.calls[0]![0]).toBe('card-1')
    expect(updateCardEntity.mock.calls[0]![2]).toBe(3)
    expect(updateCardEntity.mock.calls[0]![1]).toMatchObject({
      body: {
        elements: [
          { tag: 'markdown', content: 'Hello world' },
          { tag: 'hr' },
          {
            tag: 'markdown',
            content:
              'AI-generated content is for reference only. [View session](https://agentconnect.example/sessions/123)'
          }
        ]
      }
    })
  })

  it('retracts an unfinished card by message id', async () => {
    const { conn, deleteMessage } = connection()
    const card = await conn.startStreamingCard('oc_chat')
    await conn.cancelStreamingCard('oc_chat', card!)
    expect(deleteMessage).toHaveBeenCalledWith('message-flat')
  })

  it('falls back when the IM send response has no message id', async () => {
    const { conn, replyCardEntityMessage, updateCardEntity } = connection()
    replyCardEntityMessage.mockResolvedValueOnce({})

    const card = await conn.startStreamingCard('oc_chat', 'om_root')

    expect(card).toBeUndefined()
    expect(updateCardEntity).not.toHaveBeenCalled()
  })
})

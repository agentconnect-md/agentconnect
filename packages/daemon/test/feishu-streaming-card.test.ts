import { describe, expect, it, vi } from 'vitest'
import {
  FeishuConnection,
  type ConsolidatedFeishuGroup,
  type FeishuApi,
  type FeishuCardActionResponse,
  type FeishuClientHandle,
  type FeishuRawCardActionEvent
} from '../src/feishu/connection.js'
import {
  FEISHU_REPLY_ACTIONS_ELEMENT_ID,
  FEISHU_REPLY_ACTION_VALUE,
  FEISHU_REPLY_CANCEL_OPTION,
  FEISHU_STREAMING_ELEMENT_ID
} from '../src/feishu/render.js'
import type { ReplyAttributionInfo } from '../src/messages/attribution.js'

const attribution: ReplyAttributionInfo = {
  botName: 'Review Bot',
  botUrl: 'https://agentconnect.example/agents/review-bot',
  runtime: 'Codex',
  model: 'gpt-5.6',
  sessionUrl: 'https://agentconnect.example/sessions/123'
}
const cardTarget = {
  v: 1,
  agentId: '33333333-3333-4333-8333-333333333333',
  integrationId: '44444444-4444-4444-8444-444444444444'
} as const

function connection() {
  const createCardEntity = vi.fn<FeishuApi['createCardEntity']>(async () => ({ cardId: 'card-1' }))
  const replyCardEntityMessage = vi.fn(async (): Promise<{ messageId?: string }> => ({ messageId: 'message-1' }))
  const updateCardEntityElement = vi.fn(async () => {})
  const setCardEntityStreaming = vi.fn(async () => {})
  const patchCardMessage = vi.fn<FeishuApi['patchCardMessage']>(async () => {})
  const deleteMessage = vi.fn(async () => {})
  const onStatusAction = vi.fn()
  let cardActionHandler: ((event: FeishuRawCardActionEvent) => FeishuCardActionResponse | undefined) | undefined
  const handle: FeishuClientHandle = {
    api: {
      createText: async () => ({}),
      createCard: async () => ({}),
      replyText: async () => ({}),
      replyCard: async () => ({}),
      listMessages: async () => ({ items: [], hasMore: false }),
      uploadImage: async () => ({ imageKey: 'img_1' }),
      createImage: async () => ({}),
      replyImage: async () => ({}),
      createCardEntity,
      createCardEntityMessage: async () => ({ messageId: 'message-flat' }),
      replyCardEntityMessage,
      updateCardEntityElement,
      setCardEntityStreaming,
      patchCardMessage,
      deleteMessage,
      updateText: async () => {},
      downloadResource: async () => {},
      getChat: async (id) => ({ id }),
      listChatMembers: async () => [],
      listChats: async () => [],
      getUser: async (id) => ({ id }),
      getBotInfo: async () => ({})
    },
    startWs: async (_onEvent, onCardAction) => {
      cardActionHandler = onCardAction
    },
    close: () => {}
  }
  const group: ConsolidatedFeishuGroup = {
    appId: 'cli_streamingtest',
    appSecret: 'secret',
    mode: 'direct',
    region: 'lark',
    integrations: []
  }
  return {
    conn: new FeishuConnection(
      { group, onMessage: () => {}, onStatusAction, newTraceId: () => 'trace', sendIntervalMs: 0 },
      () => handle
    ),
    createCardEntity,
    replyCardEntityMessage,
    updateCardEntityElement,
    setCardEntityStreaming,
    patchCardMessage,
    deleteMessage,
    onStatusAction,
    triggerCardAction: (event: FeishuRawCardActionEvent) => cardActionHandler?.(event)
  }
}

describe('Lark CardKit transport', () => {
  it('creates, streams, and finalizes one threaded card with monotonic sequences', async () => {
    const {
      conn,
      createCardEntity,
      replyCardEntityMessage,
      updateCardEntityElement,
      setCardEntityStreaming,
      patchCardMessage
    } = connection()

    const card = await conn.startStreamingCard('oc_chat', 'om_root', {
      sessionKey: 'feishu:oc_chat:om_root:review-bot',
      sessionUrl: attribution.sessionUrl,
      target: cardTarget
    })
    expect(card).toEqual({ cardId: 'card-1', messageId: 'message-1' })
    expect(createCardEntity.mock.calls[0]![0]).toMatchObject({
      schema: '2.0',
      config: { streaming_mode: true },
      body: {
        elements: [
          {
            tag: 'column_set',
            columns: [
              {
                elements: [{ element_id: FEISHU_STREAMING_ELEMENT_ID, content: 'Thinking…' }]
              },
              {
                elements: [
                  {
                    element_id: FEISHU_REPLY_ACTIONS_ELEMENT_ID,
                    value: { action: FEISHU_REPLY_ACTION_VALUE, target: cardTarget },
                    options: [
                      { value: FEISHU_REPLY_CANCEL_OPTION },
                      { value: 'session', multi_url: { url: attribution.sessionUrl } }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    })
    expect(replyCardEntityMessage).toHaveBeenCalledWith('om_root', 'card-1')

    await conn.updateStreamingCard('oc_chat', card!, 'Hello')
    await conn.finishStreamingCard('oc_chat', card!, 'Hello world', attribution)

    expect(updateCardEntityElement).toHaveBeenCalledWith('card-1', FEISHU_STREAMING_ELEMENT_ID, 'Hello', 1)
    expect(setCardEntityStreaming).toHaveBeenCalledWith('card-1', false, 2)
    expect(patchCardMessage.mock.calls[0]![0]).toBe('message-1')
    expect(patchCardMessage.mock.calls[0]![1]).toMatchObject({
      body: {
        elements: [
          { tag: 'markdown', content: 'Hello world' },
          { tag: 'hr' },
          {
            tag: 'column_set',
            columns: [
              {
                elements: [
                  {
                    tag: 'markdown',
                    content:
                      'sent by [Review Bot](https://agentconnect.example/agents/review-bot) (Codex · gpt-5.6) · [open in session](https://agentconnect.example/sessions/123)'
                  }
                ]
              },
              {
                elements: [
                  {
                    tag: 'overflow',
                    options: [{ value: 'session', multi_url: { url: attribution.sessionUrl } }]
                  }
                ]
              }
            ]
          }
        ]
      }
    })
  })

  it('routes an active reply Cancel run selection once', async () => {
    const { conn, onStatusAction, triggerCardAction } = connection()
    await conn.start()
    await conn.startStreamingCard('oc_chat', 'om_root', {
      sessionKey: 'feishu:oc_chat:om_root:review-bot',
      sessionUrl: attribution.sessionUrl,
      target: cardTarget
    })

    const event: FeishuRawCardActionEvent = {
      context: { open_message_id: 'message-1', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_operator' },
      action: {
        tag: 'overflow',
        option: FEISHU_REPLY_CANCEL_OPTION,
        value: { action: FEISHU_REPLY_ACTION_VALUE, target: cardTarget }
      }
    }
    expect(triggerCardAction(event)).toEqual({
      toast: { type: 'info', content: 'Cancellation requested.' }
    })
    expect(triggerCardAction(event)).toBeUndefined()
    expect(onStatusAction).toHaveBeenCalledOnce()
    expect(onStatusAction).toHaveBeenCalledWith({
      kind: 'cancel',
      sessionKey: 'feishu:oc_chat:om_root:review-bot',
      actor: { userId: 'ou_operator' }
    })
  })

  it('retracts an unfinished card by message id', async () => {
    const { conn, deleteMessage } = connection()
    const card = await conn.startStreamingCard('oc_chat')
    await conn.cancelStreamingCard('oc_chat', card!)
    expect(deleteMessage).toHaveBeenCalledWith('message-flat')
  })

  it('falls back when the IM send response has no message id', async () => {
    const { conn, replyCardEntityMessage, patchCardMessage } = connection()
    replyCardEntityMessage.mockResolvedValueOnce({})

    const card = await conn.startStreamingCard('oc_chat', 'om_root')

    expect(card).toBeUndefined()
    expect(patchCardMessage).not.toHaveBeenCalled()
  })
})

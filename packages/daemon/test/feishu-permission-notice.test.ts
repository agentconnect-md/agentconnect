import { describe, expect, it, vi } from 'vitest'
import { FeishuConnection, type ConsolidatedFeishuGroup, type FeishuClientHandle } from '../src/feishu/connection.js'

function permissionError(
  code = 99991672,
  scopes = ['im:message', 'im:message:send_as_bot', 'im:resource', 'im:chat']
): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: {
      data: {
        code,
        msg: 'Access denied. Required scopes are missing.',
        error: {
          permission_violations: scopes.map((subject) => ({ type: 'action_scope_required', subject }))
        }
      }
    }
  })
}

function connectionFor(
  region: 'feishu' | 'lark',
  patchText: () => Promise<void>,
  getUser: (id: string, idType: 'open_id' | 'union_id') => Promise<{ id: string }> = async (id) => ({ id })
) {
  const createText = vi.fn(async (_chatId: string, _text: string) => ({}))
  const createCard = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => ({ messageId: 'notice-1' }))
  const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => ({ messageId: 'notice-2' }))
  const handle: FeishuClientHandle = {
    api: {
      createText,
      createCard,
      replyText: async () => ({}),
      replyCard,
      listMessages: async () => ({ items: [], hasMore: false }),
      createCardEntity: async () => ({ cardId: 'card-1' }),
      createCardEntityMessage: async () => ({ messageId: 'message-1' }),
      replyCardEntityMessage: async () => ({ messageId: 'message-2' }),
      updateCardEntityElement: async () => {},
      setCardEntityStreaming: async () => {},
      patchCardMessage: async () => {},
      deleteMessage: async () => {},
      uploadImage: async () => ({}),
      createImage: async () => ({}),
      replyImage: async () => ({}),
      updateText: patchText,
      downloadResource: async () => {},
      getChat: async (id) => ({ id }),
      listChatMembers: async () => [],
      listChats: async () => [],
      getUser,
      getBotInfo: async () => ({})
    },
    startWs: async () => {},
    close: () => {}
  }
  const group: ConsolidatedFeishuGroup = {
    appId: 'cli_permissiontest',
    appSecret: 'secret',
    mode: 'direct',
    region,
    integrations: []
  }
  const conn = new FeishuConnection(
    { group, onMessage: () => {}, newTraceId: () => 'trace', sendIntervalMs: 0 },
    () => handle
  )
  return { conn, createText, createCard, replyCard }
}

describe('Feishu/Lark permission update notice', () => {
  it('uses the provider id type supplied by message senders and callback actors', async () => {
    const getUser = vi.fn(async (id: string) => ({ id }))
    const { conn } = connectionFor('lark', async () => {}, getUser)

    await conn.getUserProfile('on_union')
    await conn.getUserProfile('ou_open')

    expect(getUser).toHaveBeenNthCalledWith(1, 'on_union', 'union_id')
    expect(getUser).toHaveBeenNthCalledWith(2, 'ou_open', 'open_id')
  })

  it.each([
    ['feishu', 'https://open.feishu.cn'],
    ['lark', 'https://open.larksuite.com']
  ] as const)('posts one region-specific app-permission card for %s', async (region, origin) => {
    const patchText = vi.fn(async () => {
      throw permissionError()
    })
    const { conn, createCard, replyCard } = connectionFor(region, patchText)

    await conn.updateMessage('oc_chat', 'om_progress', 'first')
    await conn.updateMessage('oc_chat', 'om_progress', 'second')

    expect(patchText).toHaveBeenCalledTimes(2)
    expect(createCard).toHaveBeenCalledOnce()
    expect(replyCard).not.toHaveBeenCalled()
    const [chatId, card] = createCard.mock.calls[0]!
    expect(chatId).toBe('oc_chat')
    const c = card as {
      header: { title: { content: string } }
      body: { elements: { tag: string; content?: string; behaviors?: { default_url: string }[] }[] }
    }
    expect(c.header.title.content).toBe('⚠️ Permissions update required')
    expect(c.body.elements[0]?.content).toContain('publish a new app version')
    const url = new URL(c.body.elements[1]!.behaviors![0]!.default_url)
    expect(url.origin).toBe(origin)
    expect(url.pathname).toBe('/app/cli_permissiontest/auth')
    expect(url.searchParams.get('q')).toBe('im:message,im:message:send_as_bot,im:resource,im:chat')
    expect(url.searchParams.get('op_from')).toBe('openapi')
    expect(url.searchParams.get('token_type')).toBe('tenant')
  })

  it('uses the platform-reported contact scopes for a profile permission failure', async () => {
    const contactScopes = ['contact:contact.base:readonly', 'contact:contact:readonly_as_app']
    const { conn, createCard } = connectionFor(
      'feishu',
      async () => {},
      async () => {
        throw permissionError(99991672, contactScopes)
      }
    )

    await conn.getUserProfile('ou_user')
    await conn.postMessage('oc_chat', 'reply')

    expect(createCard).toHaveBeenCalledOnce()
    const card = createCard.mock.calls[0]![1] as {
      body: { elements: { behaviors?: { default_url: string }[] }[] }
    }
    const url = new URL(card.body.elements[1]!.behaviors![0]!.default_url)
    expect(url.searchParams.get('q')).toBe(contactScopes.join(','))
    expect(url.searchParams.get('q')).not.toContain('im:message')
  })

  it('does not deliver a failed chat-specific card in another chat', async () => {
    const chatAccessError = permissionError(230002)
    const { conn, createCard } = connectionFor('feishu', async () => {
      throw chatAccessError
    })
    createCard.mockImplementation(async (chatId) => {
      if (chatId === 'A') throw chatAccessError
      return { messageId: 'unexpected-notice' }
    })

    await conn.updateMessage('A', 'om_progress', 'first')
    expect(createCard.mock.calls.map(([chatId]) => chatId)).toEqual(['A'])
    ;(conn as unknown as { permissionNoticeRetryAt: Map<string, number> }).permissionNoticeRetryAt.clear()

    await conn.postMessage('B', 'healthy')
    expect(createCard.mock.calls.map(([chatId]) => chatId)).toEqual(['A'])
  })

  it('merges application scopes until a permission card succeeds', async () => {
    const contactScope = 'contact:contact.base:readonly'
    const sendScope = 'im:message:send_as_bot'
    const { conn, createText, createCard } = connectionFor(
      'lark',
      async () => {},
      async () => {
        throw permissionError(99991672, [contactScope])
      }
    )
    createText.mockRejectedValueOnce(permissionError(99991672, [sendScope]))
    createCard.mockRejectedValueOnce(permissionError(99991672, [sendScope]))

    await conn.getUserProfile('ou_user')
    await conn.postMessage('A', 'blocked')
    expect(createCard).toHaveBeenCalledOnce()

    await conn.postMessage('B', 'still cooling down')
    expect(createCard).toHaveBeenCalledOnce()

    ;(conn as unknown as { permissionNoticeRetryAt: Map<string, number> }).permissionNoticeRetryAt.clear()

    await conn.postMessage('C', 'repaired')
    expect(createCard).toHaveBeenCalledTimes(2)
    const card = createCard.mock.calls[1]![1] as {
      body: { elements: { behaviors?: { default_url: string }[] }[] }
    }
    const url = new URL(card.body.elements[1]!.behaviors![0]!.default_url)
    expect(url.searchParams.get('q')).toBe(`${contactScope},${sendScope}`)
  })

  it('keeps scopes learned while a permission card is in flight', async () => {
    const contactScope = 'contact:contact.base:readonly'
    const sendScope = 'im:message:send_as_bot'
    let profileCall = 0
    let resolveFirstCard!: (value: { messageId: string }) => void
    const { conn, createCard } = connectionFor(
      'feishu',
      async () => {},
      async () => {
        profileCall += 1
        throw permissionError(99991672, [profileCall === 1 ? contactScope : sendScope])
      }
    )
    createCard.mockImplementationOnce(
      async () =>
        await new Promise<{ messageId: string }>((resolve) => {
          resolveFirstCard = resolve
        })
    )

    await conn.getUserProfile('ou_contact')
    const firstPost = conn.postMessage('A', 'first')
    await vi.waitFor(() => expect(createCard).toHaveBeenCalledOnce())
    await conn.getUserProfile('ou_message')
    resolveFirstCard({ messageId: 'notice-1' })
    await firstPost

    await conn.postMessage('B', 'follow-up')
    expect(createCard).toHaveBeenCalledTimes(2)
    const card = createCard.mock.calls[1]![1] as {
      body: { elements: { behaviors?: { default_url: string }[] }[] }
    }
    const url = new URL(card.body.elements[1]!.behaviors![0]!.default_url)
    expect(url.searchParams.get('q')).toBe(`${contactScope},${sendScope}`)
  })

  it('does not post a permission card for an unrelated request error', async () => {
    const { conn, createCard } = connectionFor('lark', async () => {
      throw permissionError(230001)
    })

    await conn.updateMessage('oc_chat', 'om_progress', 'text')
    expect(createCard).not.toHaveBeenCalled()
  })
})

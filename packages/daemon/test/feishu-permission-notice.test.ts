import { describe, expect, it, vi } from 'vitest'
import { FeishuConnection, type ConsolidatedFeishuGroup, type FeishuClientHandle } from '../src/feishu/connection.js'

function permissionError(code = 99991672): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: { data: { code, msg: 'Access denied. Required scopes are missing.' } }
  })
}

function connectionFor(region: 'feishu' | 'lark', patchText: () => Promise<void>) {
  const createCard = vi.fn(async (_chatId: string, _card: Record<string, unknown>) => ({ messageId: 'notice-1' }))
  const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => ({ messageId: 'notice-2' }))
  const handle: FeishuClientHandle = {
    api: {
      createText: async () => ({}),
      createCard,
      replyText: async () => ({}),
      replyCard,
      patchText,
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
    appId: 'cli_permissiontest',
    appSecret: 'secret',
    region,
    integrations: []
  }
  const conn = new FeishuConnection(
    { group, onMessage: () => {}, newTraceId: () => 'trace', sendIntervalMs: 0 },
    () => handle
  )
  return { conn, createCard, replyCard }
}

describe('Feishu/Lark permission update notice', () => {
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

  it('does not post a permission card for an unrelated request error', async () => {
    const { conn, createCard } = connectionFor('lark', async () => {
      throw permissionError(230001)
    })

    await conn.updateMessage('oc_chat', 'om_progress', 'text')
    expect(createCard).not.toHaveBeenCalled()
  })
})

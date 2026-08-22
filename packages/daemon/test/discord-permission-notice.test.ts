import { describe, expect, it, vi } from 'vitest'
import { DiscordConnection } from '../src/discord/connection.js'

function connectionWith(channel: unknown | ((id: string) => unknown | Promise<unknown>)): DiscordConnection {
  const conn = new DiscordConnection({
    group: { botToken: 'token', integrations: [] },
    onMessage: () => {},
    newTraceId: () => 'trace',
    sendIntervalMs: 0
  })
  conn.botUserId = '123456789012345678'
  ;(conn as unknown as { client: unknown }).client = {
    application: null,
    channels: {
      fetch: vi.fn(async (id: string) => (typeof channel === 'function' ? await channel(id) : channel))
    }
  }
  return conn
}

describe('Discord permission update notice', () => {
  it('posts one OAuth permission card after concurrent missing-permission failures', async () => {
    const missingPermission = Object.assign(new Error('Missing Permissions'), { code: 50013 })
    const startThread = vi.fn(async () => {
      throw missingPermission
    })
    let resolveNotice!: (message: { id: string }) => void
    const send = vi.fn(
      (_payload: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveNotice = resolve
        })
    )
    const channel = {
      send,
      messages: { fetch: vi.fn(async () => ({ startThread })) }
    }
    const conn = connectionWith(channel)

    const first = conn.createThread('channel-1', 'message-1', 'First')
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    const second = conn.createThread('channel-1', 'message-2', 'Second')
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledTimes(2))
    expect(send).toHaveBeenCalledOnce()

    const payload = send.mock.calls[0]![0] as {
      content: string
      components: { components: { url?: string; label: string; style: number }[] }[]
    }
    expect(payload.content).toContain('⚠️ **Permissions update required.**')
    expect(payload.content).toContain("channel's permission overrides")
    const button = payload.components[0]!.components[0]!
    expect(button).toEqual(expect.objectContaining({ label: 'Update permissions', style: 5 }))
    const url = new URL(button.url!)
    expect(url.origin).toBe('https://discord.com')
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('123456789012345678')
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    expect(url.searchParams.get('permissions')).toBe('309237763136')

    resolveNotice({ id: 'notice-1' })
    await Promise.all([first, second])
  })

  it('does not label unrelated Discord API failures as permission problems', async () => {
    const startThread = vi.fn(async () => {
      throw Object.assign(new Error('Thread is archived'), { code: 50083 })
    })
    const send = vi.fn(async (_payload: unknown) => ({ id: 'unexpected' }))
    const conn = connectionWith({
      send,
      messages: { fetch: vi.fn(async () => ({ startThread })) }
    })

    await expect(conn.createThread('channel-1', 'message-1', 'Archived')).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not deliver a failed channel-specific notice in another channel', async () => {
    const missingPermission = Object.assign(new Error('Missing Permissions'), { code: 50013 })
    const sendA = vi.fn(async () => {
      throw missingPermission
    })
    const sendB = vi.fn(async () => ({ id: 'unexpected-notice' }))
    const conn = connectionWith((id: string) =>
      id === 'A'
        ? {
            send: sendA,
            messages: {
              fetch: vi.fn(async () => ({
                startThread: async () => {
                  throw missingPermission
                }
              }))
            }
          }
        : { send: sendB, sendTyping: vi.fn(async () => {}) }
    )

    await conn.createThread('A', 'message-1', 'Thread')
    expect(sendA).toHaveBeenCalledOnce()
    ;(conn as unknown as { permissionNoticeRetryAt: Map<string, number> }).permissionNoticeRetryAt.clear()

    await conn.sendChatAction('B')
    expect(sendB).not.toHaveBeenCalled()
  })

  it('rate-limits a global OAuth repair across channels without losing it', async () => {
    const missingScope = Object.assign(new Error('Missing required OAuth2 scope'), { code: 50026 })
    const missingPermission = Object.assign(new Error('Missing Permissions'), { code: 50013 })
    const sendA = vi.fn(async () => {
      throw missingPermission
    })
    const sendB = vi.fn<(payload: unknown) => Promise<{ id: string }>>(async () => ({ id: 'notice-B' }))
    const conn = connectionWith((id: string) =>
      id === 'A'
        ? {
            send: sendA,
            messages: {
              fetch: vi.fn(async () => ({
                startThread: async () => {
                  throw missingPermission
                }
              }))
            }
          }
        : { send: sendB, sendTyping: vi.fn(async () => {}) }
    )
    ;(
      conn as unknown as {
        rememberPermissionIssue: (err: unknown, channel?: string) => boolean
      }
    ).rememberPermissionIssue(missingScope)

    await conn.createThread('A', 'message-1', 'Thread')
    expect(sendA).toHaveBeenCalledOnce()

    await conn.sendChatAction('B')
    expect(sendB).not.toHaveBeenCalled()

    ;(conn as unknown as { permissionNoticeRetryAt: Map<string, number> }).permissionNoticeRetryAt.clear()

    await conn.sendChatAction('B')
    expect(sendB).toHaveBeenCalledOnce()
    expect((sendB.mock.calls[0]![0] as { content: string }).content).toContain('Permissions update required')
  })
})

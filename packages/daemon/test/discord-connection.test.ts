import { GatewayIntentBits, Partials, type Client } from 'discord.js'
import { describe, expect, it, vi } from 'vitest'
import { DiscordConnection } from '../src/discord/connection.js'

describe('DiscordConnection gateway options', () => {
  it('subscribes to direct messages and allows their uncached channels', () => {
    const connection = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace'
    })
    const client = (connection as unknown as { client: Client }).client

    expect(client.options.intents.has(GatewayIntentBits.DirectMessages)).toBe(true)
    expect(client.options.partials).toContain(Partials.Channel)
  })

  it('uses the thread coordinate as the concrete Discord destination', async () => {
    const connection = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    })
    const edit = vi.fn(async () => {})
    const channel = {
      send: vi.fn(async () => ({ id: 'sent' })),
      sendTyping: vi.fn(async () => {}),
      messages: { fetch: vi.fn(async () => ({ edit })) }
    }
    const fetch = vi.fn<(id: string) => Promise<typeof channel>>(async () => channel)
    ;(connection as unknown as { client: unknown }).client = { channels: { fetch } }

    await connection.postMessage('PARENT', 'reply', 'THREAD')
    await connection.postChrome('PARENT', 'progress', { threadTs: 'THREAD' })
    await connection.updateMessage('PARENT', 'message', 'updated', { threadTs: 'THREAD' })
    await connection.sendChatAction('PARENT', 'THREAD')

    expect(fetch.mock.calls.map(([id]) => id)).toEqual(['THREAD', 'THREAD', 'THREAD', 'THREAD'])
    expect(edit).toHaveBeenCalledOnce()
  })

  it('reads a newest-first page from the current channel with Discord pagination', async () => {
    const connection = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace'
    })
    const messages = [
      {
        id: '300',
        createdTimestamp: 3_000,
        content: 'hello <@42>',
        author: { id: '7', bot: false },
        mentions: { users: new Map([['42', { id: '42', username: 'alice', globalName: 'Alice' }]]) },
        thread: { id: 'thread-300', messageCount: 2 }
      },
      {
        id: '200',
        createdTimestamp: 2_000,
        content: 'from bot',
        author: { id: '8', bot: true },
        mentions: { users: new Map() },
        thread: null
      }
    ]
    const fetchMessages = vi.fn(async () => new Map(messages.map((message) => [message.id, message])))
    const fetchChannel = vi.fn(async () => ({ isTextBased: () => true, messages: { fetch: fetchMessages } }))
    ;(connection as unknown as { client: unknown }).client = { channels: { fetch: fetchChannel } }

    await expect(
      connection.getChannelHistory('channel-1', {
        cursor: 'before-400',
        limit: 2,
        oldest: '1000',
        latest: '3000'
      })
    ).resolves.toEqual({
      messages: [
        {
          sender: '7',
          ts: '3000',
          text: 'hello @Alice',
          isBot: false,
          threadTs: 'thread-300',
          replyCount: 2
        },
        { sender: '8', ts: '2000', text: 'from bot', isBot: true }
      ],
      hasMore: true,
      nextCursor: '200'
    })
    expect(fetchMessages).toHaveBeenCalledWith({ limit: 2, before: 'before-400' })
  })
})

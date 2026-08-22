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
})

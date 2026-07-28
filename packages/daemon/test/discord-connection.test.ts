import { GatewayIntentBits, Partials, type Client } from 'discord.js'
import { describe, expect, it } from 'vitest'
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
})

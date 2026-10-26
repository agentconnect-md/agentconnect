// Discord's capability card (capability-requests.md §4.4.2): a style-5 link button and a Decline whose custom_id names the card.
import { describe, expect, it, vi } from 'vitest'
import { parseCapabilityDeclineData, type CapabilityCardModel } from '../src/platforms/capability-card.js'
import { withCapabilityClick } from '../src/platforms/capability-click.js'
import {
  buildDiscordCapabilityCard,
  buildDiscordCapabilitySettled,
  discordCapabilityCards
} from '../src/platforms/discord/capability-card.js'

const CARD = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'

const model: CapabilityCardModel = {
  requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
  generation: 1234567890,
  cardId: CARD,
  summary: 'add the MCP server "Linear"',
  reason: 'Filing the bug needs [Linear](https://evil.example.test) @everyone',
  link: 'https://console.example.test/example-org/requests/7f3a',
  agentName: 'Ada',
  via: { agentId: '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b', integrationId: 'int-1', sessionKey: 'discord:C1:T1' }
}

describe('Discord capability card', () => {
  it('defuses the reason’s link syntax and offers the link and a Decline within Discord’s limits', () => {
    const draft = buildDiscordCapabilityCard(model)
    expect(draft.text).toContain('add the MCP server "Linear"')
    expect(draft.text).not.toContain('](https://evil.example.test)')
    const [open, decline] = draft.components[0]!.components
    expect(open).toMatchObject({ style: 5, url: model.link })
    expect(open!.custom_id).toBeUndefined()
    expect(decline!.style).toBe(4)
    expect(decline!.custom_id!.length).toBeLessThanOrEqual(100)
    expect(parseCapabilityDeclineData(decline!.custom_id!)).toEqual({ generation: 1234567890, cardId: CARD })
  })

  it('settles with an empty component list, which drops the buttons', () => {
    const settled = buildDiscordCapabilitySettled(model, { status: 'completed', by: 'Ana', outcome: 'Added.' })
    expect(settled.components).toEqual([])
    expect(settled.text).toContain('✅ Completed by Ana — Added.')
    expect(settled.text).toContain(`[View the request](${model.link})`)
  })

  it('posts and edits in a thread’s own channel, and answers beside a card it cannot edit', async () => {
    const conn = { updateMessage: vi.fn(async () => true), postChrome: vi.fn(async () => 'm2') }
    const draft = discordCapabilityCards.settled(model, { status: 'expired' })
    const handle = { conn, channel: 'C1', thread: 'T1', ts: 'm1' }
    await expect(discordCapabilityCards.rewrite(handle, draft)).resolves.toBe('edited')
    expect(conn.updateMessage).toHaveBeenCalledWith('T1', 'm1', expect.any(String), { keyboard: [] })
    conn.updateMessage.mockResolvedValueOnce(false)
    await expect(discordCapabilityCards.rewrite(handle, draft)).resolves.toBe('followed-up')
  })

  it('tells a clicker privately through their own click, and judges them by the bot flag it carried', async () => {
    const conn = { getUserProfile: async () => ({ id: 'U1', isBot: false }) }
    const told = await withCapabilityClick(conn, 'B1', { isBot: true, name: 'Helper' }, async () => {
      await expect(discordCapabilityCards.isPerson(conn, 'B1')).resolves.toBe(false)
      await expect(discordCapabilityCards.nameOf(conn, 'B1')).resolves.toBe('Helper')
      await discordCapabilityCards.tellPrivately({ conn, channel: 'C1' }, 'B1', 'Only someone who can ask Ada here…')
    })
    expect(told).toEqual(['Only someone who can ask Ada here…'])
    // With no click, nothing is said: a line in the channel would not be private.
    await discordCapabilityCards.tellPrivately({ conn, channel: 'C1' }, 'U1', 'unheard')
    await expect(discordCapabilityCards.isPerson(conn, 'U1')).resolves.toBe(true)
  })
})

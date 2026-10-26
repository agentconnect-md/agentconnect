// QQ's capability card (capability-requests.md §4.4.2): text with the link, declined by replying 1, settled by a follow-up.
import { QQUserId } from '@agentconnect.md/message'
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityCardModel } from '../src/platforms/capability-card.js'
import type { ElicitCardHost, ElicitCardTurn } from '../src/platforms/elicit-card.js'
import { qqCapabilityCards, qqCapabilityText } from '../src/platforms/qq/capability-card.js'

const model: CapabilityCardModel = {
  requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
  generation: 1,
  cardId: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9',
  summary: 'add the MCP server "Linear"',
  reason: 'Filing the bug needs Linear',
  link: 'https://console.example.test/example-org/requests/7f3a',
  agentName: 'Ada',
  via: { agentId: '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b', integrationId: 'int-1', sessionKey: 'qq:group:G1' }
}

describe('QQ capability card', () => {
  it('carries the link and says how to decline, mentioning the bot in a group', () => {
    const group = qqCapabilityText(model, 'group:G1')
    expect(group).toContain(`Open in AgentConnect: ${model.link}`)
    expect(group).toContain('Reply to this message with 1 to decline, mentioning the bot.')
    expect(qqCapabilityText(model, 'dm:U1')).toContain('Reply to this message with 1 to decline.')
  })

  it('posts the card as a reply to the turn’s own message, and nothing outside a turn', async () => {
    const sendCard = vi.fn(async () => 'card-1')
    const host = {
      turnState: () => ({ conn: { sendCard }, replyId: 'msg-1', channel: 'group:G1' }),
      postCardSerialized: async (_turn: unknown, post: () => Promise<string | undefined>) => await post()
    } as unknown as ElicitCardHost
    const draft = qqCapabilityCards.build(model)
    await expect(qqCapabilityCards.send(host, {} as ElicitCardTurn, draft)).resolves.toBe('card-1')
    expect(sendCard).toHaveBeenCalledWith('group:G1', 'msg-1', expect.stringContaining('with 1 to decline'))
    await expect(qqCapabilityCards.post({}, { channel: 'dm:U1' }, draft, { agentName: 'Ada' })).resolves.toBeUndefined()
    expect(qqCapabilityCards.directMessages).toBe(false)
  })

  it('declines only on a reply of 1, full-width digits included', () => {
    expect(qqCapabilityCards.claimReply!(' 1 ')).toBe(true)
    expect(qqCapabilityCards.claimReply!('１')).toBe(true)
    expect(qqCapabilityCards.claimReply!('2')).toBe(false)
    expect(qqCapabilityCards.claimReply!('why do you need it?')).toBe(false)
  })

  it('settles by a follow-up on the card, since QQ cannot edit a message', async () => {
    const followCard = vi.fn(async () => true)
    const draft = qqCapabilityCards.settled(model, { status: 'declined', by: 'Ben' })
    await expect(
      qqCapabilityCards.rewrite({ conn: { followCard }, channel: 'group:G1', ts: 'card-1' }, draft)
    ).resolves.toBe('followed-up')
    expect(followCard).toHaveBeenCalledWith('group:G1', 'card-1', expect.stringContaining('🚫 Declined by Ben'))
    followCard.mockResolvedValueOnce(false)
    await expect(
      qqCapabilityCards.rewrite({ conn: { followCard }, channel: 'group:G1', ts: 'card-1' }, draft)
    ).resolves.toBe('failed')
  })

  it('names a DM’s person by the id its messages carry, and takes this app’s senders for people', async () => {
    const conn = { workspaceId: () => 'app-1' }
    await expect(qqCapabilityCards.directMessageWith(conn, 'dm:U1')).resolves.toBe(QQUserId('app-1', 'U1'))
    await expect(qqCapabilityCards.directMessageWith(conn, 'group:G1')).resolves.toBeNull()
    await expect(qqCapabilityCards.isPerson(conn, QQUserId('app-1', 'U1'))).resolves.toBe(true)
    await expect(qqCapabilityCards.isPerson(conn, QQUserId('app-2', 'U1'))).resolves.toBe(false)
  })
})

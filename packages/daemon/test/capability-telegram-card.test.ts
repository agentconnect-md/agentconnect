// Telegram's capability card (capability-requests.md §4.4.2): a url button beside a Decline whose callback_data names the card.
import { describe, expect, it, vi } from 'vitest'
import { parseCapabilityDeclineData, type CapabilityCardModel } from '../src/platforms/capability-card.js'
import { withCapabilityClick } from '../src/platforms/capability-click.js'
import {
  buildTelegramCapabilityCard,
  buildTelegramCapabilitySettled,
  telegramCapabilityCards
} from '../src/platforms/telegram/capability-card.js'

const CARD = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'

const model: CapabilityCardModel = {
  requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
  generation: 1234567890,
  cardId: CARD,
  summary: 'install the skill "acme/lint"',
  reason: 'Linting needs <b>acme</b>',
  link: 'https://console.example.test/example-org/requests/7f3a',
  agentName: 'Ada',
  via: { agentId: '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b', integrationId: 'int-1', sessionKey: 'telegram:-100:tg:5' }
}

describe('Telegram capability card', () => {
  it('keeps the reason as plain text and fits the Decline into 64 bytes of callback_data', () => {
    const draft = buildTelegramCapabilityCard(model)
    expect(draft.text).toContain('Reason: Linting needs <b>acme</b>')
    const [open, decline] = draft.buttons[0]!
    expect(open).toMatchObject({ url: model.link })
    expect(Buffer.byteLength(decline!.callbackData, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseCapabilityDeclineData(decline!.callbackData)).toEqual({ generation: 1234567890, cardId: CARD })
  })

  it('settles with an empty keyboard, which removes the buttons', () => {
    const settled = buildTelegramCapabilitySettled(model, { status: 'withdrawn' })
    expect(settled.buttons).toEqual([])
    expect(settled.text).toContain(`View the request: ${model.link}`)
  })

  it('edits the card in place, else posts the settlement in the same reply chain', async () => {
    const conn = { editCard: vi.fn(async () => false), postCard: vi.fn(async () => '9') }
    const draft = telegramCapabilityCards.settled(model, { status: 'expired' })
    await expect(
      telegramCapabilityCards.rewrite({ conn, channel: '-100', thread: 'tg:5', ts: '8' }, draft)
    ).resolves.toBe('followed-up')
    expect(conn.editCard).toHaveBeenCalledWith('-100', 8, expect.any(String), [])
    expect(conn.postCard).toHaveBeenCalledWith('-100', expect.any(String), [], { replyTo: 5 })
  })

  it('answers a tapper only on their tap, and takes nobody for a person without one', async () => {
    const conn = {}
    await expect(telegramCapabilityCards.isPerson(conn, '42')).resolves.toBe(false)
    const told = await withCapabilityClick(conn, '42', { isBot: false, name: 'Ana' }, async () => {
      await expect(telegramCapabilityCards.isPerson(conn, '42')).resolves.toBe(true)
      await expect(telegramCapabilityCards.nameOf(conn, '42')).resolves.toBe('Ana')
      await telegramCapabilityCards.tellPrivately({ conn, channel: '-100' }, '42', 'Try again in a moment.')
    })
    expect(told).toEqual(['Try again in a moment.'])
    // A person's private chat with the bot has their own id.
    await expect(telegramCapabilityCards.openDirectMessage(conn, '42')).resolves.toBe('42')
    await expect(
      telegramCapabilityCards.directMessageWith(
        { getChannelInfo: async () => ({ id: '42', isIm: true, user: '42' }) },
        '42'
      )
    ).resolves.toBe('42')
  })
})

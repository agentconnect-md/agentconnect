// The Telegram and Discord approval cards stay inside their platforms' button limits, and their button payloads decode only what they minted.
import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  discordApprovalCards,
  discordApprovalId,
  parseDiscordApproval
} from '../src/platforms/discord/approval-card.js'
import {
  parseTelegramApproval,
  telegramApprovalCards,
  telegramApprovalData
} from '../src/platforms/telegram/approval-card.js'
import { SLACK_PERMISSION_MAX_OPTIONS } from '../src/slack/render.js'

const REQUEST = '0b5f7c1e-6c3a-4a51-9f6e-2d8c4b7a9e10'

const params = (count: number): RequestPermissionRequest =>
  ({
    sessionId: 's1',
    options: Array.from({ length: count }, (_, i) => ({
      optionId: `option-with-a-long-runtime-id-${i}`,
      name: `${'A very long option label '.repeat(5)}${i}`,
      kind: i === 0 ? 'allow_always' : i === count - 1 ? 'reject_once' : 'allow_once'
    })),
    toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
  }) as unknown as RequestPermissionRequest

describe('Telegram’s approval card', () => {
  it('offers every option the shared cap allows, one per row, each by position within 64 bytes', () => {
    expect(telegramApprovalCards.maxOptions).toBe(SLACK_PERMISSION_MAX_OPTIONS)
    const draft = telegramApprovalCards.build({ requestId: REQUEST, params: params(25) }) as {
      text: string
      buttons: { text: string; callbackData: string }[][]
    }
    expect(draft.buttons).toHaveLength(25)
    expect(draft.buttons.every((row) => row.length === 1)).toBe(true)
    for (const [i, [button]] of draft.buttons.entries()) {
      expect(button!.callbackData).toBe(telegramApprovalData(REQUEST, i))
      expect(Buffer.byteLength(button!.callbackData, 'utf8')).toBeLessThanOrEqual(64)
      expect(button!.text.length).toBeLessThanOrEqual(75)
    }
    expect(telegramApprovalCards.build({ requestId: REQUEST, params: params(26) })).toBeNull()
    expect(telegramApprovalCards.build({ requestId: REQUEST, params: params(0) })).toBeNull()
  })

  it('decodes only its own button data', () => {
    expect(parseTelegramApproval(telegramApprovalData(REQUEST, 24))).toEqual({ requestId: REQUEST, option: 24 })
    for (const foreign of [`ac_el:${REQUEST}:ac_o0`, 'm:2', `ac_pm:${REQUEST}:x`, `ac_pm:${REQUEST}:100`])
      expect(parseTelegramApproval(foreign)).toBeNull()
  })
})

describe('Discord’s approval card', () => {
  it('offers every option the shared cap allows in five rows of five, colored by kind', () => {
    expect(discordApprovalCards.maxOptions).toBe(SLACK_PERMISSION_MAX_OPTIONS)
    const draft = discordApprovalCards.build({ requestId: REQUEST, params: params(25) }) as {
      text: string
      components: { components: { style: number; label: string; custom_id: string }[] }[]
    }
    expect(draft.components.map((row) => row.components.length)).toEqual([5, 5, 5, 5, 5])
    const buttons = draft.components.flatMap((row) => row.components)
    expect(buttons.map((b) => b.custom_id)).toEqual(buttons.map((_, i) => discordApprovalId(REQUEST, i)))
    expect([buttons[0]!.style, buttons[1]!.style, buttons[24]!.style]).toEqual([3, 3, 4])
    expect(buttons.every((b) => b.label.length <= 80)).toBe(true)
    expect(discordApprovalCards.build({ requestId: REQUEST, params: params(26) })).toBeNull()
  })

  it('defuses link syntax in what the runtime wrote', () => {
    const p = { ...params(2), toolCall: { toolCallId: 't', title: '[open me](https://example.test)' } }
    const draft = discordApprovalCards.build({ requestId: REQUEST, params: p as RequestPermissionRequest }) as {
      text: string
    }
    expect(draft.text).not.toContain('[open me](https://example.test)')
  })

  it('decodes only its own component ids', () => {
    expect(parseDiscordApproval(discordApprovalId(REQUEST, 3))).toEqual({ requestId: REQUEST, option: 3 })
    for (const foreign of [`ac_el:${REQUEST}:x`, 'ac_cancel', `ac_pm:${REQUEST}:`])
      expect(parseDiscordApproval(foreign)).toBeNull()
  })
})

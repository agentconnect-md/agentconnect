import { describe, it, expect } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { FeishuConnection } from '../src/feishu/connection.js'
import {
  VirtualSlackConnection,
  VirtualDiscordConnection,
  VirtualTelegramConnection
} from '../src/evaluation/virtual-connections.js'

/**
 * The Layer-1 contract (integration-plugin-architecture.md §7.1) is enforced at
 * COMPILE time by `implements PlatformConnection` on all seven connections —
 * including the Arena's virtual ones, which makes the evals the contract's
 * second implementer (an S2 exit criterion). These tests pin the two things a
 * structural interface cannot:
 *
 *  1. the REQUIRED surface really exists at runtime (an interface is erased, so
 *     a member deleted behind an `any` cast would still compile), and
 *  2. the OPTIONAL-facet matrix — which platform answers which probe. Core
 *     currently discovers this by duck-typing (`typeof conn.getThreadReplies
 *     === 'function'`); the matrix below is the same knowledge stated once, and
 *     it is what the §5 manifest axes (`membershipEnumeration`,
 *     `leaveGranularity`) are derived from.
 */

const REQUIRED = [
  'start',
  'stop',
  'getChannelInfo',
  'listMembers',
  'listChannels',
  'getUserProfile',
  'downloadFile'
] as const

const CONNECTIONS = {
  slack: SlackConnection,
  telegram: TelegramConnection,
  discord: DiscordConnection,
  feishu: FeishuConnection,
  'virtual-slack': VirtualSlackConnection,
  'virtual-discord': VirtualDiscordConnection,
  'virtual-telegram': VirtualTelegramConnection
} as const

const has = (ctor: { prototype: object }, member: string): boolean =>
  typeof (ctor.prototype as Record<string, unknown>)[member] === 'function'

describe('Layer-1 platform contract (§7.1)', () => {
  it('every connection — real and virtual — carries the required surface', () => {
    for (const [name, ctor] of Object.entries(CONNECTIONS)) {
      for (const member of REQUIRED) {
        expect(has(ctor, member), `${name}.${member}`).toBe(true)
      }
    }
  })

  it('pins the optional-facet matrix the manifest axes are derived from', () => {
    // Slack is the only platform with authoritative bot-membership enumeration
    // (`membershipEnumeration: 'authoritative'`) and provider thread history.
    expect(has(SlackConnection, 'listBotChannels')).toBe(true)
    expect(has(SlackConnection, 'getThreadReplies')).toBe(true)
    expect(has(SlackConnection, 'getChannelHistory')).toBe(true)
    expect(has(SlackConnection, 'openDirectMessage')).toBe(true)
    for (const ctor of [TelegramConnection, DiscordConnection, FeishuConnection]) {
      expect(has(ctor, 'listBotChannels')).toBe(false)
      expect(has(ctor, 'getThreadReplies')).toBe(false)
    }
    expect(has(DiscordConnection, 'getChannelHistory')).toBe(true)
    expect(has(FeishuConnection, 'getChannelHistory')).toBe(true)
    expect(has(TelegramConnection, 'getChannelHistory')).toBe(false)

    // leaveGranularity: Slack/Telegram leave a CONVERSATION, Discord leaves the
    // enclosing SPACE (a bot joins servers, not channels), Feishu leaves neither.
    expect(has(SlackConnection, 'leaveChannel')).toBe(true)
    expect(has(TelegramConnection, 'leaveChannel')).toBe(true)
    expect(has(DiscordConnection, 'leaveSpace')).toBe(true)
    expect(has(DiscordConnection, 'leaveChannel')).toBe(false)
    expect(has(FeishuConnection, 'leaveChannel')).toBe(false)
    expect(has(FeishuConnection, 'leaveSpace')).toBe(false)
  })

  it('the Arena virtual connections implement the read port they stand in for', () => {
    // The interface was lifted FROM these, so a drift on either side breaks the
    // eval suite's ability to substitute for a real platform.
    expect(has(VirtualSlackConnection, 'getThreadReplies')).toBe(true)
    expect(has(VirtualSlackConnection, 'getChannelHistory')).toBe(true)
    expect(has(VirtualDiscordConnection, 'getChannelHistory')).toBe(true)
    expect(has(VirtualTelegramConnection, 'getChannelHistory')).toBe(false)
    expect(has(VirtualSlackConnection, 'listBotChannels')).toBe(true)
    expect(has(VirtualSlackConnection, 'openDirectMessage')).toBe(true)
    expect(has(VirtualSlackConnection, 'leaveChannel')).toBe(true)
  })
})

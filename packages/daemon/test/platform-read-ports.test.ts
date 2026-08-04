import { describe, it, expect } from 'vitest'
import {
  allAttachmentReadTools,
  attachmentReadToolsFor,
  directMessagePlatformFor,
  directMessagePlatformList,
  isAttachmentReadTool,
  offersDirectMessages,
  offersReadPort,
  platformLabel,
  readPortsFor
} from '../src/platforms/read-ports.js'
import { SlackConnection } from '../src/slack/connection.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { FeishuConnection } from '../src/feishu/connection.js'

/**
 * The Layer-1 read-port seam (integration-plugin-architecture.md §7.1/§7.4).
 *
 * Two asks with two answer sources, and the tests below hold BOTH honest:
 * `offersReadPort` probes a live bearer, the registry declares for a platform id
 * before a connection exists. A declaration that disagrees with its own adapter
 * is the failure mode this seam introduces, so it gets its own test.
 */

const has = (ctor: { prototype: object }, member: string): boolean =>
  typeof (ctor.prototype as Record<string, unknown>)[member] === 'function'

describe('offersReadPort (live probe)', () => {
  it('answers by method presence, and false for a bearer that is not there', () => {
    expect(offersReadPort({ getThreadReplies: () => [] }, 'getThreadReplies')).toBe(true)
    expect(offersReadPort({}, 'getThreadReplies')).toBe(false)
    expect(offersReadPort(undefined, 'getThreadReplies')).toBe(false)
    // A present-but-not-callable member is NOT the port: the probe replaced
    // `typeof conn?.x === 'function'`, not `'x' in conn`.
    expect(offersReadPort({ openDirectMessage: 'yes' }, 'openDirectMessage')).toBe(false)
  })

  it('reads each port independently on the same bearer', () => {
    const slackish = { getThreadReplies: () => [], openDirectMessage: () => 'D1' }
    const telegramish = {}
    expect(offersReadPort(slackish, 'openDirectMessage')).toBe(true)
    expect(offersReadPort(telegramish, 'getThreadReplies')).toBe(false)
    expect(offersReadPort(telegramish, 'openDirectMessage')).toBe(false)
  })

  it('accepts a real connection of every platform, including ones with no optional port', () => {
    // Regression guard for the WEAK-TYPE trap: typing the parameter as
    // `Partial<Record<ReadPort, unknown>>` makes TypeScript reject exactly the
    // connections that implement no optional port — the arm this must answer for.
    expect(offersReadPort(SlackConnection.prototype, 'getThreadReplies')).toBe(true)
    expect(offersReadPort(SlackConnection.prototype, 'openDirectMessage')).toBe(true)
    for (const ctor of [TelegramConnection, DiscordConnection, FeishuConnection]) {
      expect(offersReadPort(ctor.prototype, 'getThreadReplies')).toBe(false)
      expect(offersReadPort(ctor.prototype, 'openDirectMessage')).toBe(false)
    }
  })
})

describe('the read-port registry', () => {
  it('agrees with the adapters it declares for', () => {
    // The declaration exists to answer BEFORE a connection is in hand; if it
    // drifts from the connection it describes, every pre-connection decision
    // (tool injection, DM default) silently lies. Pinned against the real class.
    expect(offersDirectMessages('slack')).toBe(has(SlackConnection, 'openDirectMessage'))
    expect(offersDirectMessages('telegram')).toBe(has(TelegramConnection, 'openDirectMessage'))
    expect(offersDirectMessages('discord')).toBe(has(DiscordConnection, 'openDirectMessage'))
    expect(offersDirectMessages('feishu')).toBe(has(FeishuConnection, 'openDirectMessage'))
  })

  it('is fail-closed for an unregistered platform', () => {
    for (const unknownPlatform of ['webchat', 'hook', 'dream', 'github', 'constructor', 'toString', '']) {
      expect(readPortsFor(unknownPlatform)).toBeUndefined()
      expect(offersDirectMessages(unknownPlatform)).toBe(false)
      expect(attachmentReadToolsFor([unknownPlatform])).toEqual([])
      // A `Map`, not an object literal: `constructor` must not spread a function.
      expect(platformLabel(unknownPlatform)).toBe(unknownPlatform)
    }
  })

  it('labels the platforms whose errors name them', () => {
    expect(platformLabel('slack')).toBe('Slack')
    expect(platformLabel('telegram')).toBe('Telegram')
  })
})

describe('the direct-message port', () => {
  it('defaults a toUser send to the DM-capable platform, whatever the session is', () => {
    // Exactly the `directMessage ? 'slack' : ctx.platform` literal it replaces:
    // Slack is the only platform declaring the port, so every session resolves
    // to it — including sessions on platforms that cannot DM at all.
    expect(directMessagePlatformFor('slack')).toBe('slack')
    expect(directMessagePlatformFor('telegram')).toBe('slack')
    expect(directMessagePlatformFor('discord')).toBe('slack')
    expect(directMessagePlatformFor('feishu')).toBe('slack')
    expect(directMessagePlatformFor('webchat')).toBe('slack')
  })

  it('renders the capable platforms for the "not supported here" error', () => {
    expect(directMessagePlatformList()).toBe('Slack')
  })
})

describe('credentialed attachment tools', () => {
  it('keeps the learned tool names — the mechanism generalized, the names did not', () => {
    expect(attachmentReadToolsFor(['slack']).map((t) => t.name)).toEqual(['readSlackFile'])
    expect(attachmentReadToolsFor(['telegram']).map((t) => t.name)).toEqual(['readTelegramFile'])
  })

  it('emits in registry order, not in the caller-supplied order', () => {
    // An agent's tool list must not reshuffle because its integrations happened
    // to be stored the other way round.
    expect(attachmentReadToolsFor(['telegram', 'slack']).map((t) => t.name)).toEqual([
      'readSlackFile',
      'readTelegramFile'
    ])
    expect(attachmentReadToolsFor(['slack', 'telegram']).map((t) => t.name)).toEqual([
      'readSlackFile',
      'readTelegramFile'
    ])
  })

  it('gives a platform that declares no tool nothing at all', () => {
    // Discord's CDN links are fetchable without the bot credential and Feishu
    // never grew a tool: both must stay toolless until their own module declares one.
    expect(attachmentReadToolsFor(['discord', 'feishu'])).toEqual([])
    expect(attachmentReadToolsFor([])).toEqual([])
  })

  it('lists every injectable name for the permission auto-allow set', () => {
    expect(allAttachmentReadTools().map((t) => t.name)).toEqual(['readSlackFile', 'readTelegramFile'])
  })

  it('recognizes exactly the declared tool names at dispatch', () => {
    expect(isAttachmentReadTool('readSlackFile')).toBe(true)
    expect(isAttachmentReadTool('readTelegramFile')).toBe(true)
    expect(isAttachmentReadTool('readDiscordFile')).toBe(false)
    expect(isAttachmentReadTool('getCurrentChannel')).toBe(false)
    expect(isAttachmentReadTool('')).toBe(false)
  })

  it('describes each tool with a JSON-Schema object input requiring `url`', () => {
    for (const tool of allAttachmentReadTools()) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['url'] })
      expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>)).toEqual(['url', 'mimeType'])
      expect(tool.description).toContain('instead of curl/fetch')
    }
  })
})

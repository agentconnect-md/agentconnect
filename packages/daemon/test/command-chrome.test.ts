import { describe, it, expect } from 'vitest'
import { CommandChromeRegistry } from '../src/platforms/command-chrome.js'
import { slackCommandChrome } from '../src/platforms/slack/command-chrome.js'
import {
  parseTelegramSelect,
  telegramCommandChrome,
  telegramSelectButtons
} from '../src/platforms/telegram/command-chrome.js'
import { discordCommandChrome } from '../src/platforms/discord/command-chrome.js'
import { feishuCommandChrome } from '../src/platforms/feishu/command-chrome.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const ctx = { channel: 'C1', replyThread: '1700000000.001', sessionKey: 'k1' }

const registry = (() => {
  const r = new CommandChromeRegistry<NormalizedMessage, never>(slackCommandChrome as never)
  r.register(telegramCommandChrome as never)
  r.register(discordCommandChrome as never)
  r.register(feishuCommandChrome as never)
  return r
})()

describe('command chrome registry', () => {
  it('falls back to the core (Slack-shaped) surface for rendering', () => {
    // The pre-existing forks all ended in a Slack-shaped else arm; an unknown
    // origin must keep landing there.
    expect(registry.for('some-future-platform')).toBe(slackCommandChrome)
    expect(registry.for('telegram')).toBe(telegramCommandChrome)
  })

  it('answers the thread-identity fact with the OPPOSITE default', () => {
    // Rendering fails open to Slack; coordinates fail closed to the
    // latest-session fallback. Slack and Discord carry exact thread coordinates.
    expect(registry.threadIdentifiesSession('slack')).toBe(true)
    expect(registry.threadIdentifiesSession('discord')).toBe(true)
    for (const p of ['telegram', 'feishu', 'some-future-platform', 'constructor']) {
      expect(registry.threadIdentifiesSession(p)).toBe(false)
    }
  })
})

describe('telegram select encoding', () => {
  it('round-trips its own buttons', () => {
    const buttons = telegramSelectButtons('effort', 'high', ['low', 'high', 'max'])
    expect(buttons).toHaveLength(3)
    // Tap coordinate is the option INDEX — parse must recover kind + index.
    expect(parseTelegramSelect(buttons[2]![0]!.callbackData)).toEqual({ kind: 'effort', index: 2 })
  })

  it('marks the current option and applies permission display labels', () => {
    const buttons = telegramSelectButtons('permission', 'agent-full-access', ['agent-full-access'])
    // Raw mode ids render through the shared display alias, exactly as the
    // pre-seam buildSelectCard did via selectDisplay.
    expect(buttons[0]![0]!.text).toBe('✅ Full access')
  })

  it('rejects callback data this scheme did not mint', () => {
    for (const data of ['x:1', 'm:', 'm:one', 'ac_sel:m:1', '']) {
      expect(parseTelegramSelect(data)).toBeNull()
    }
  })
})

describe('per-platform reply anchoring', () => {
  const baseMsg = (over: Partial<NormalizedMessage>): NormalizedMessage =>
    ({
      platform: 'telegram',
      channel: '-100',
      msgId: 'tg:-100:42',
      text: '/status',
      sender: { id: 'u1', isBot: false },
      source: 'user',
      isDm: false,
      mentionedBots: [],
      ...over
    }) as NormalizedMessage

  it('telegram anchors the control reply to the command message', () => {
    const calls: unknown[][] = []
    const conn = { postMessage: (...a: unknown[]) => void calls.push(a) }
    telegramCommandChrome.reply(conn, baseMsg({}), ctx, 'ok')
    expect(calls[0]).toEqual(['C1', 'ok', '1700000000.001', { replyTo: 42 }])
  })

  it('slack (core) posts into the reply thread with no anchor', () => {
    const calls: unknown[][] = []
    const conn = { postMessage: (...a: unknown[]) => void calls.push(a) }
    slackCommandChrome.reply(conn, undefined, ctx, 'ok')
    // Chrome-marked: a control reply is not conversation, so thread backfill skips it.
    expect(calls[0]).toEqual(['C1', 'ok', '1700000000.001', { chrome: true }])
  })

  it('discord renders the select card only under its 25-button ceiling', () => {
    const posts: unknown[][] = []
    const conn = { postChrome: (...a: unknown[]) => void posts.push(a) }
    const many = Array.from({ length: 26 }, (_, i) => `m${i}`)
    expect(discordCommandChrome.selectCard!(conn, undefined, ctx, { kind: 'model', options: many, header: 'h' })).toBe(
      false
    )
    expect(posts).toHaveLength(0)
    expect(
      discordCommandChrome.selectCard!(conn, undefined, ctx, { kind: 'model', options: ['a', 'b'], header: 'h' })
    ).toBe(true)
    // The resolved session key rides the card so a tap routes back by key.
    expect(posts[0]![2]).toMatchObject({ threadTs: '1700000000.001', sessionKey: 'k1' })
  })

  it('feishu offers no select card at all', () => {
    expect(feishuCommandChrome.selectCard).toBeUndefined()
    expect(slackCommandChrome.selectCard).toBeUndefined()
  })
})

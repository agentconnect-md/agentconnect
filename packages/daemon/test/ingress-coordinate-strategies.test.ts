import { describe, it, expect } from 'vitest'
import { threadKeyForPost } from '../src/platforms/thread-keys.js'
import { isMalformedPlatformTurn } from '../src/platforms/malformed-turn.js'
import { threadPromotionFor, type ThreadPromotionHost } from '../src/platforms/thread-promotion.js'
import { discordThreadPromotion, discordThreadName } from '../src/platforms/discord/thread-promotion.js'
import { manifestFor } from '@agentconnect.md/protocol'

describe('outbound thread keys (threadKeyForPost)', () => {
  it('keeps each platform aligned with its inbound canonicalization', () => {
    // Slack (and core): the post's own ts IS the thread segment.
    expect(threadKeyForPost('slack', 'C1', '1700.1')).toBe('1700.1')
    // Discord: conversations are the channel; a post cannot open a thread.
    expect(threadKeyForPost('discord', 'chan9', '999')).toBe('chan9')
    // Telegram: numeric ids enter the tg: reply-root namespace…
    expect(threadKeyForPost('telegram', '-100', '42')).toBe('tg:42')
    // …non-numeric anchors (already-canonical keys) pass through…
    expect(threadKeyForPost('telegram', '-100', 'tg:42')).toBe('tg:42')
    // …and a DM is one continuous conversation.
    expect(threadKeyForPost('telegram', '-100', '42', true)).toBe('dm')
    // Feishu: group chats thread off the post; a DM is keyed by the chat.
    expect(threadKeyForPost('feishu', 'oc_1', 'om_9')).toBe('om_9')
    expect(threadKeyForPost('feishu', 'oc_1', 'om_9', true)).toBe('oc_1')
  })

  it('defaults an unregistered platform to the core rule (own ts)', () => {
    expect(threadKeyForPost('some-future-platform', 'c', 't1')).toBe('t1')
    expect(threadKeyForPost('constructor', 'c', 't1', true)).toBe('t1')
  })
})

describe('malformed-turn detection', () => {
  const poison = {
    platform: 'slack',
    source: 'user',
    sender: { id: 'unknown', isBot: false },
    text: '  ',
    attachments: []
  }

  it('recognizes the exact Slack wrapper poison shape', () => {
    expect(isMalformedPlatformTurn(poison)).toBe(true)
  })

  it('does not trip on any nearby legitimate shape', () => {
    // Each single-field deviation is a real message; the detector gates
    // destructive handling (loop-guard latches, inbox drops), so it must be exact.
    expect(isMalformedPlatformTurn({ ...poison, text: 'hi' })).toBe(false)
    expect(isMalformedPlatformTurn({ ...poison, sender: { id: 'U1', isBot: false } })).toBe(false)
    expect(isMalformedPlatformTurn({ ...poison, attachments: [{}] })).toBe(false)
    expect(isMalformedPlatformTurn({ ...poison, source: 'hook' })).toBe(false)
  })

  it('knows no poison shape on other platforms', () => {
    for (const platform of ['telegram', 'discord', 'feishu', 'webchat', 'some-future-platform']) {
      expect(isMalformedPlatformTurn({ ...poison, platform })).toBe(false)
    }
  })
})

describe('thread promotion', () => {
  it('is registered for Discord only; everyone else replies in place', () => {
    for (const platform of ['slack', 'telegram', 'feishu', 'webchat', 'some-future-platform']) {
      expect(threadPromotionFor(platform)).toBeUndefined()
    }
  })

  it('wants promotion via the generic coordinate alone (legacy twin retired)', () => {
    const base = { platform: 'discord', channel: 'c', msgId: 'discord:c:1', text: 'hi' }
    expect(discordThreadPromotion.wants({ ...base, promoteToThread: true })).toBe(true)
    // The retired named twin no longer participates — even if a stale object
    // carries it, only the generic coordinate decides.
    expect(discordThreadPromotion.wants({ ...base, discordTopLevel: true } as never)).toBe(false)
    expect(discordThreadPromotion.wants({ ...base, promoteToThread: false, discordTopLevel: true } as never)).toBe(
      false
    )
    expect(discordThreadPromotion.wants(base)).toBe(false)
  })

  it('re-keys the turn onto the opened thread, recording the parent first', () => {
    const events: string[] = []
    const host: ThreadPromotionHost = {
      setChannelScope: (channel, scope) => void events.push(`scope:${channel}<-${scope.parentId}`),
      noteChannel: (_conn, channel) => void events.push(`note:${channel}`),
      info: () => {},
      debug: () => {}
    }
    const conn = { createThread: async () => 'T9' }
    const msg = { platform: 'discord', channel: 'C1', msgId: 'discord:C1:M1', text: 'do the thing' }
    return discordThreadPromotion.promote(host, conn, msg).then(() => {
      expect(msg).toMatchObject({ parentChannel: 'C1', channel: 'T9', thread: 'T9' })
      // Parent scope is recorded while msg.channel still names the parent.
      expect(events).toEqual(['scope:T9<-C1', 'note:T9'])
    })
  })

  it('leaves coordinates untouched when no thread opens', async () => {
    const host: ThreadPromotionHost = {
      setChannelScope: () => {
        throw new Error('must not record scope')
      },
      noteChannel: () => {
        throw new Error('must not label')
      },
      info: () => {},
      debug: () => {}
    }
    const msg = { platform: 'discord', channel: 'C1', msgId: 'discord:C1:M1', text: 'hi' }
    await discordThreadPromotion.promote(host, { createThread: async () => undefined }, msg)
    expect(msg).toEqual({ platform: 'discord', channel: 'C1', msgId: 'discord:C1:M1', text: 'hi' })
  })

  it('clamps thread names to one line under the Discord cap', () => {
    expect(discordThreadName('first line\nsecond line')).toBe('first line second line')
    expect(discordThreadName('x'.repeat(200))).toHaveLength(90)
    expect(discordThreadName('   ')).toBe('Agent thread')
  })
})

describe('manifest dmChannelPattern', () => {
  it('recognizes Slack D-prefixed DM channels; no one else declares one', () => {
    // Slack app_mention payloads may omit channel_type — the D-prefix hedge is a
    // pre-dispatch read (gating discovery runs before routing), hence manifest.
    expect(manifestFor('slack').dmChannelPattern?.test('D0123')).toBe(true)
    expect(manifestFor('slack').dmChannelPattern?.test('C0123')).toBe(false)
    for (const p of ['telegram', 'discord', 'feishu', 'some-future-platform']) {
      expect(manifestFor(p).dmChannelPattern).toBeUndefined()
    }
  })
})

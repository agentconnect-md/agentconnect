import { describe, expect, it } from 'vitest'
import { DEFAULT_BOT_CARD_COPY, botCardCopy, platformRegistry } from './registry'

/**
 * The two sentences the Settings → Bots card writes into chrome the HOST owns
 * (§10 `settingsFragments.copy`). Both shipped as Slack's model rendered over
 * EVERY platform's rows, so what these pin is the split: Slack's wording
 * unchanged to the byte, and a provider-free default everywhere else.
 */
const UNCLAIMED = ['linear', 'hook', 'github', 'playground', 'webchat', 'lark', 'Slack', 'constructor', '__proto__', '']

/** Captured from `SettingsView.tsx` before the member existed. */
const SLACK_REVOKED = 'The Slack workspace uninstalled this app or revoked its tokens — re-install to reconnect'
const SLACK_SHARE_AVAILABLE = 'Allow several agents to share this bot across channels'
const SLACK_SHARE_UNAVAILABLE = 'HTTP transport required to share'

const PLATFORM_WORDS = /slack|telegram|discord|feishu|lark/i

describe('Settings → Bots row copy', () => {
  it('leaves Slack’s two sentences byte-identical', () => {
    // Slack is the only platform whose rows could reach either state, so it is
    // the only one whose copy this refactor must not move.
    const copy = botCardCopy('slack')
    expect(copy.revokedHint).toBe(SLACK_REVOKED)
    expect(copy.shareHint.available).toBe(SLACK_SHARE_AVAILABLE)
    expect(copy.shareHint.unavailable).toBe(SLACK_SHARE_UNAVAILABLE)
  })

  it('gives every other registered platform the provider-free default', () => {
    for (const id of platformRegistry.ids().filter((p) => p !== 'slack')) {
      const copy = botCardCopy(id)
      expect(copy.revokedHint, id).toBe(DEFAULT_BOT_CARD_COPY.revokedHint)
      expect(copy.shareHint, id).toEqual(DEFAULT_BOT_CARD_COPY.shareHint)
    }
    // Named, so a module that starts declaring one is a visible diff here.
    expect(
      platformRegistry
        .all()
        .filter((m) => m.settingsFragments?.copy)
        .map((m) => m.platformId)
    ).toEqual(['slack'])
  })

  it('names no platform in either default', () => {
    // The whole defect was a provider's vocabulary leaking onto other
    // providers' rows; a default that names one would reintroduce it.
    expect(DEFAULT_BOT_CARD_COPY.revokedHint).not.toMatch(PLATFORM_WORDS)
    expect(DEFAULT_BOT_CARD_COPY.shareHint.available).not.toMatch(PLATFORM_WORDS)
    expect(DEFAULT_BOT_CARD_COPY.shareHint.unavailable).not.toMatch(PLATFORM_WORDS)
  })

  it('collapses both share arms for a platform that cannot share at all', () => {
    // The host still picks an arm by transport, but multi-agent bots are
    // Slack-only at the CP — so on every other platform the arm the host lands
    // on is not the reason, and one sentence must serve both rather than
    // promising that switching transport would help.
    expect(DEFAULT_BOT_CARD_COPY.shareHint.available).toBe(DEFAULT_BOT_CARD_COPY.shareHint.unavailable)
    for (const id of ['telegram', 'discord', 'feishu']) {
      const { available, unavailable } = botCardCopy(id).shareHint
      expect(available, id).toBe(unavailable)
    }
    // Slack's two arms stay genuinely different — it is the one platform where
    // the transport really is why the toggle is off.
    expect(SLACK_SHARE_AVAILABLE).not.toBe(SLACK_SHARE_UNAVAILABLE)
  })

  it('answers for a platform id no module claims, and for none at all', () => {
    // A bot row carries whatever platform the CP sent, so the lookup is total —
    // the same reason `channelListSemantics` is.
    for (const id of UNCLAIMED) {
      expect(botCardCopy(id), id).toEqual(DEFAULT_BOT_CARD_COPY)
    }
    expect(botCardCopy(undefined)).toEqual(DEFAULT_BOT_CARD_COPY)
  })

  it('defaults each member on its own', () => {
    // A module may name the revocation it can actually reach without also
    // having to restate the share sentence, and vice versa.
    const partial = platformRegistry.get('slack')!.settingsFragments!.copy!
    expect(partial.revokedHint).toBeDefined()
    expect(partial.shareHint).toBeDefined()
    expect(Object.keys(DEFAULT_BOT_CARD_COPY).sort()).toEqual(['revokedHint', 'shareHint'])
  })
})

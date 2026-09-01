// @vitest-environment happy-dom

/**
 * Who may share a bot, and therefore who gets a live Sharable toggle.
 *
 * The Settings → Bots toggle shipped gated on TRANSPORT alone
 * (`(bot.transport ?? 'socket') === 'socket'`), while the server admits only the
 * platforms whose §5 manifest declares `multiAgentShareable` — Slack, of the
 * ones this console ships. Feishu is the one platform outside that set whose
 * bots can be `transport: 'http'` — it declares a transport affordance of its
 * own — so a Feishu HTTP bot presented a fully clickable toggle for a capability
 * the CP refuses.
 *
 * Nothing renders these predicates, so these assertions are the only thing that
 * notices when the platform fact and its two readers drift apart again.
 */

import { describe, expect, it } from 'vitest'
import type { BotDto } from '@/lib/api'
import { botCardCopy, botSharingEditable, platformRegistry, platformSupportsSharing } from './registry'

/** `platform`/`transport`/`shareable` are the only members either predicate
 *  reads; the rest is here so the fixture stays a real `BotDto`. */
function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'support',
    platform: 'slack',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'socket',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** Ids a bot row can carry that no module claims — core trigger kinds, a
 *  platform not built yet, and the prototype-pollution shapes a `Map` lookup
 *  must not answer for. */
const UNCLAIMED = ['webhook', 'github', 'playground', 'webchat', 'linear', 'lark', 'Slack', '__proto__', '']

describe('platformSupportsSharing', () => {
  it('is true for Slack and false for every other registered platform', () => {
    expect(platformSupportsSharing('slack')).toBe(true)
    for (const id of platformRegistry.ids().filter((p) => p !== 'slack')) {
      expect(platformSupportsSharing(id), id).toBe(false)
    }
  })

  it('answers for an id no module claims, and for none at all', () => {
    // A bot row carries whatever platform the CP sent — the lookup has to be
    // total, and its total answer has to be the refusing one.
    for (const id of UNCLAIMED) expect(platformSupportsSharing(id), id).toBe(false)
    expect(platformSupportsSharing(undefined)).toBe(false)
  })

  it('reads the modules’ single declaration of the fact', () => {
    // ONE declaration, so the wizard's shared opt-in and the Settings toggle
    // cannot disagree about a platform. Named, so a module that starts declaring
    // it is a visible diff here — and a reminder that the CP's own predicate has
    // to move in the same change.
    expect(
      platformRegistry
        .all()
        .filter((m) => m.wizard.affordances.share === true)
        .map((m) => m.platformId)
    ).toEqual(['slack'])
  })
})

describe('botSharingEditable', () => {
  it('lets a Slack HTTP bot be shared', () => {
    expect(botSharingEditable(bot({ platform: 'slack', transport: 'http' }))).toBe(true)
  })

  it('refuses a Feishu HTTP bot — the platform, not the transport, is the reason', () => {
    // The defect: Feishu declares a transport affordance, so its bots reach
    // `transport: 'http'` and cleared the old gate, but the CP refuses the
    // install that flag promises. Both Feishu clouds share the platform id.
    expect(botSharingEditable(bot({ platform: 'feishu', transport: 'http' }))).toBe(false)
    expect(botSharingEditable(bot({ platform: 'feishu', transport: 'socket' }))).toBe(false)
  })

  it('refuses a socket bot on every platform, Slack included', () => {
    // Transport is immutable post-create and relay ingress is what shared bots
    // route over, so a socket bot can never be shared regardless of platform.
    for (const id of platformRegistry.ids()) {
      expect(botSharingEditable(bot({ platform: id, transport: 'socket' })), id).toBe(false)
      // A platform with no transport affordance sends no transport at all.
      expect(botSharingEditable(bot({ platform: id, transport: undefined })), id).toBe(false)
    }
  })

  it('refuses a platform no module claims, whatever its transport', () => {
    for (const id of UNCLAIMED) {
      expect(botSharingEditable(bot({ platform: id, transport: 'http' })), id).toBe(false)
    }
  })

  it('keeps an already-shared row editable so the flag can be turned back off', () => {
    // Not defensive: while the toggle was transport-gated only, `PATCH /bots/:id`
    // accepted the flip, so rows on a non-sharing platform may already carry
    // `shareable: true`. The CP still honors turning those OFF (it refuses only
    // the enable direction), so the console must keep the control that does it.
    expect(botSharingEditable(bot({ platform: 'feishu', transport: 'http', shareable: true }))).toBe(true)
    expect(botSharingEditable(bot({ platform: 'slack', transport: 'http', shareable: true }))).toBe(true)
  })
})

describe('the disabled toggle and its tooltip agree', () => {
  it('never disables a toggle under a sentence promising a transport fix', () => {
    // The copy contract (§10 `settingsFragments.copy.shareHint`) collapses both
    // arms for a platform that cannot share; this pins the two halves together,
    // so a module cannot declare two different share sentences while the toggle
    // it explains is dead for a reason no transport change repairs.
    for (const id of platformRegistry.ids()) {
      if (platformSupportsSharing(id)) continue
      const { available, unavailable } = botCardCopy(id).shareHint
      expect(available, id).toBe(unavailable)
    }
  })

  it('keeps Slack’s transport sentence, where the transport really is the reason', () => {
    const { available, unavailable } = botCardCopy('slack').shareHint
    expect(available).not.toBe(unavailable)
    expect(botSharingEditable(bot({ platform: 'slack', transport: 'http' }))).toBe(true)
    expect(botSharingEditable(bot({ platform: 'slack', transport: 'socket' }))).toBe(false)
  })
})

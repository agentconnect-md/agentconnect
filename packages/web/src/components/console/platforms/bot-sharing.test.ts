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
import {
  botCardCopy,
  botSharingEditable,
  platformRegistry,
  platformSharingFixed,
  platformSupportsSharing
} from './registry'

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
const UNCLAIMED = ['webhook', 'github', 'playground', 'webchat', 'zulip', 'lark', 'Slack', '__proto__', '']

/** The platforms whose bots may serve several agents — the §5 manifest's
 *  `multiAgentShareable` set, mirrored one module at a time. */
const SHARING_PLATFORMS = ['slack', 'linear']

/** …and the ones where that is STRUCTURAL rather than an operator's opt-in: the
 *  provider stamps `shareable`, so no console surface offers a control for it. */
const FIXED_SHARING_PLATFORMS = ['linear']

describe('platformSupportsSharing', () => {
  it('is true for the multi-agent platforms and false for every other registered one', () => {
    for (const id of SHARING_PLATFORMS) expect(platformSupportsSharing(id), id).toBe(true)
    for (const id of platformRegistry.ids().filter((p) => !SHARING_PLATFORMS.includes(p))) {
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
    // ONE declaration, so the wizard's shared opt-in and the Settings cell cannot
    // disagree about a platform. Named, so a module that starts declaring it is a
    // visible diff here — and a reminder that the CP's own predicate has to move in
    // the same change.
    expect(
      platformRegistry
        .all()
        .filter((m) => m.wizard.affordances.share !== undefined)
        .map((m) => m.platformId)
    ).toEqual(SHARING_PLATFORMS)
  })
})

describe('platformSharingFixed', () => {
  it('separates structural sharing from the operator’s opt-in', () => {
    // Slack's `true` is a decision someone makes; Linear's `'fixed'` is a fact the
    // provider stamps. Both support sharing — only one is a control.
    for (const id of FIXED_SHARING_PLATFORMS) {
      expect(platformSharingFixed(id), id).toBe(true)
      expect(platformSupportsSharing(id), id).toBe(true)
    }
    expect(platformSharingFixed('slack')).toBe(false)
    expect(platformRegistry.get('slack')?.wizard.affordances.share).toBe(true)
  })

  it('never grants sharing on its own — it only ever suppresses a control', () => {
    for (const id of platformRegistry.ids().filter((p) => !FIXED_SHARING_PLATFORMS.includes(p))) {
      expect(platformSharingFixed(id), id).toBe(false)
    }
    for (const id of UNCLAIMED) expect(platformSharingFixed(id), id).toBe(false)
    expect(platformSharingFixed(undefined)).toBe(false)
  })
})

describe('botSharingEditable', () => {
  it('lets a Slack HTTP bot be shared', () => {
    expect(botSharingEditable(bot({ platform: 'slack', transport: 'http' }))).toBe(true)
  })

  it('never lets a Linear workspace’s structural sharing be operated', () => {
    // The provider stamps `shareable: true` on every workspace bot (§4.3). A live
    // toggle would let a one-member workspace be PATCHed back to `shareable: false`
    // — a state the provider contract does not have, recoverable only by re-running
    // the OAuth funnel. The `shareable` escape hatch must not reach these rows.
    expect(botSharingEditable(bot({ platform: 'linear', transport: 'http', shareable: true }))).toBe(false)
    expect(botSharingEditable(bot({ platform: 'linear', transport: 'http', shareable: false }))).toBe(false)
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
      // A fixed-sharing platform renders no toggle at all, but its cell still carries
      // this sentence as its title — so it is held to the same rule, not exempted.
      if (platformSupportsSharing(id) && !platformSharingFixed(id)) continue
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

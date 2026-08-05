/**
 * The control plane's §5 manifest reads (audit F9, F12).
 *
 * The CP imported `manifestFor` ZERO times before this: the one fact the daemon
 * and the relay read declaratively was re-spelled here as platform names. Three
 * predicates were involved, and all three are pinned below as EQUIVALENCES —
 * the retired expression on one side, the manifest read on the other, evaluated
 * over every registered id plus the ids that are not registered at all. An
 * equivalence is the right shape because these are not new decisions: the whole
 * claim of the change is that behavior did not move.
 *
 * The route- and orchestrator-level behavior these feed is pinned where it
 * lives — `orchestrator/httpBot.test.ts` for the snapshot gate,
 * `test/integration/integration-channels.test.ts` for the two leave refusals
 * and the Forget suppression.
 */
import { describe, it, expect } from 'vitest'
import { manifestFor } from '@agentconnect.md/protocol'
import { CP_PLATFORM_IDS } from './ids.js'

/** Ids no build serves — the miss arm every predicate below must keep taking
 *  the conservative way. `webchat`/`hook`/`dream` are real protocol platforms
 *  with no manifest entry; the last two are simply unknown. */
const UNREGISTERED = ['webchat', 'hook', 'dream', 'mastodon', 'constructor'] as const

const ALL = [...CP_PLATFORM_IDS, ...UNREGISTERED]

describe('F9 — Forget needs a durable suppression', () => {
  it('is the observed-membership arm, for every id', () => {
    for (const p of ALL) {
      // What `http/routes/integrations.ts` spelled before: the three platforms
      // whose conversation list is rebuilt from session history.
      const retired = p === 'telegram' || p === 'discord' || p === 'feishu'
      const viaManifest = manifestFor(p).membershipEnumeration === 'observed'
      // Registered ids: identical. Unregistered ids: the manifest DEMANDS a
      // suppression where the hand list silently skipped one — the fail-closed
      // direction, and unreachable in practice (a persisted integration's
      // platform has already passed `toDbPlatform`).
      if ((CP_PLATFORM_IDS as readonly string[]).includes(p)) expect(viaManifest, p).toBe(retired)
      else expect(viaManifest, p).toBe(true)
    }
  })
})

describe('F9 — the authoritative channel-snapshot gate', () => {
  it('is the authoritative-membership arm, for every id, with no exception', () => {
    for (const p of ALL) {
      // `orchestrator/httpBot.ts` spelled this `bot.platform !== 'slack'`.
      const retired = p !== 'slack'
      expect(manifestFor(p).membershipEnumeration !== 'authoritative', p).toBe(retired)
    }
  })
})

describe('F12 — what a leave request may target', () => {
  it('refuses a space target exactly where the platform has no space', () => {
    for (const p of ALL) {
      const retired = p !== 'discord' // `integrations.ts` before the manifest read
      expect(manifestFor(p).leaveGranularity !== 'space', p).toBe(retired)
    }
  })

  it('refuses a conversation target exactly where membership is space-scoped', () => {
    for (const p of ALL) {
      const retired = p === 'discord'
      expect(manifestFor(p).leaveGranularity === 'space', p).toBe(retired)
    }
  })

  it('leaves exactly one platform space-scoped', () => {
    // The manifest field earned by that branch. Pin the set so a later edit
    // cannot quietly widen a refusal that costs an operator a working action.
    expect(CP_PLATFORM_IDS.filter((p) => manifestFor(p).leaveGranularity === 'space')).toEqual(['discord'])
  })

  it('fails closed on an id this build does not serve', () => {
    // Conservative arm = `conversation`: a space-targeted leave is refused
    // rather than dispatched at a platform that cannot perform it. Same arm the
    // `!== 'discord'` comparison took.
    for (const p of UNREGISTERED) expect(manifestFor(p).leaveGranularity, p).toBe('conversation')
  })
})

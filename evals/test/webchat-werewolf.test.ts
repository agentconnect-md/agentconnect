/**
 * Webchat Werewolf, scripted (credential-free CI gate; part of
 * `eval:collab:contracts`) — the full game on the webchat composition:
 * ONE conversation, role delivery and night actions as postless
 * `toAgent + needsReply` calls from a scripted-subject referee acting through
 * the REAL tool surface, public day speech and votes as ordinary conversation
 * posts carried by the #906 continuation. The Slack-shaped Werewolf
 * (`evals/test/werewolf.test.ts`) pins the other composition.
 *
 * Role balance is size-appropriate (`werewolfWolfCount`): 5–6 players → ONE
 * wolf (two degenerate — an unsaved night-1 kill reaches parity instantly and
 * no day ever happens), 7+ → two. The 5p/6p games therefore run the
 * single-wolf propose-only night; the 7p game pins the two-wolf MEDIATED leg
 * (propose → relay → agree).
 */
import { describe, expect, it } from 'vitest'
import { runWebchatWerewolf } from '../games/webchat-werewolf-runner.js'
import { assignWerewolfRoles, werewolfWolfCount } from '../games/werewolf-rules.js'

describe('webchat werewolf (scripted)', () => {
  it('the role table is size-appropriate: one wolf at 5–6, two at 7+', () => {
    expect(werewolfWolfCount(5)).toBe(1)
    expect(werewolfWolfCount(6)).toBe(1)
    expect(werewolfWolfCount(7)).toBe(2)
    expect(werewolfWolfCount(12)).toBe(2)
  })

  it('a 5-player game (ONE wolf) plays through real rounds to a village win (seed 1)', async () => {
    const result = await runWebchatWerewolf({ seed: 1, playerCount: 5 })

    // Deterministic terminal state: no night-1 parity shortcut — the game is
    // decided by ACTUAL PLAY (two rounds, two completed days, the wolf found
    // by the seer and lynched by ballot).
    expect(result.terminalReason).toBe('completed')
    expect(result.winner).toBe('village')
    expect(result.rounds).toBe(2)
    expect(result.roles).toEqual(
      Object.fromEntries(assignWerewolfRoles(['player-1', 'player-2', 'player-3', 'player-4', 'player-5'], 1))
    )

    // Night 1: the SINGLE wolf's propose-only night (no relay leg exists) —
    // its clear statement is the pack's choice, and the doctor's save lands.
    expect(result.nights).toHaveLength(2)
    expect(result.nights[0]).toMatchObject({
      round: 1,
      wolfLead: 'player-2',
      proposal: 'player-1',
      kill: 'player-1',
      protect: 'player-1',
      saved: true
    })
    expect(result.nights[0]!.verdict).toBeUndefined()
    // Night 2: the wolf kills the seer — who had just inspected it.
    expect(result.nights[1]).toMatchObject({ round: 2, kill: 'player-3', death: 'player-3' })
    expect(result.nights[1]!.inspectResult).toBe('werewolf')

    // Two COMPLETED day cycles: full speaking order, full ballot, a lynch.
    expect(result.days).toHaveLength(2)
    expect(result.days[0]!.order).toEqual(['player-1', 'player-2', 'player-3', 'player-4', 'player-5'])
    expect([...result.days[0]!.spoke].sort()).toEqual(result.days[0]!.order)
    expect(Object.keys(result.days[0]!.votes).sort()).toEqual(result.days[0]!.order)
    expect(result.days[0]).toMatchObject({ lynched: 'player-1', revealed: 'villager' })
    expect(Object.keys(result.days[1]!.votes).sort()).toEqual(['player-2', 'player-4', 'player-5'])
    expect(result.days[1]).toMatchObject({ lynched: 'player-2', revealed: 'werewolf' })

    // Every needsReply obligation answered, evidence-backed; no losses.
    expect(result.replyLoss.every((row) => row.delivered && row.answered)).toBe(true)
    expect(result.replyWakesAccepted).toBe(result.replyLoss.filter((row) => row.answered).length)

    // Privacy posture: canaries never in the conversation, never across
    // sibling sessions (#967 pin), and no report ever posted (#966 pin).
    expect(result.canaryLeaks).toBe(0)
    expect(result.canaryCrossVisibility).toBe(0)
    expect(result.privateReportsPostedPublicly).toBe(0)
  }, 180_000)

  it('a 6-player game (ONE wolf) runs multiple rounds through the host night-cue loop (seed 2)', async () => {
    const result = await runWebchatWerewolf({ seed: 2, playerCount: 6, maxRounds: 4 })
    expect(result.terminalReason).toBe('completed')
    expect(result.rounds).toBeGreaterThanOrEqual(2)
    expect(result.winner).toBeDefined()
    expect(Object.values(result.roles).filter((role) => role === 'werewolf')).toHaveLength(1)
    expect(result.nights.length).toBeGreaterThanOrEqual(2)
    expect(result.replyLoss.every((row) => row.answered)).toBe(true)
    expect(result.replyWakesAccepted).toBe(result.replyLoss.filter((row) => row.answered).length)
    expect(result.canaryLeaks).toBe(0)
    expect(result.canaryCrossVisibility).toBe(0)
    expect(result.privateReportsPostedPublicly).toBe(0)
  }, 180_000)

  it('a 7-player game (TWO wolves) pins the mediated propose→relay→agree leg across rounds (seed 1)', async () => {
    const result = await runWebchatWerewolf({ seed: 1, playerCount: 7, maxRounds: 4 })
    expect(result.terminalReason).toBe('completed')
    expect(result.winner).toBe('werewolves')
    expect(result.rounds).toBe(3)
    expect(Object.values(result.roles).filter((role) => role === 'werewolf')).toHaveLength(2)
    // EVERY night's kill went through the mediated relay and was agreed.
    for (const night of result.nights) {
      if (night.kill !== undefined) {
        expect(night.proposal).toBeDefined()
        expect(night.verdict).toBe('agreed')
      }
    }
    expect(result.replyLoss.every((row) => row.answered)).toBe(true)
    expect(result.replyWakesAccepted).toBe(result.replyLoss.filter((row) => row.answered).length)
    expect(result.canaryLeaks).toBe(0)
    expect(result.canaryCrossVisibility).toBe(0)
    expect(result.privateReportsPostedPublicly).toBe(0)
  }, 180_000)

  it('a public-vote abstainer is privately re-prompted once and its private ballot counts (seed 1)', async () => {
    const result = await runWebchatWerewolf({ seed: 1, playerCount: 5, scriptedAbstainers: ['player-5'] })
    // The game still completes through real play…
    expect(result.terminalReason).toBe('completed')
    expect(result.winner).toBe('village')
    // …because the referee re-prompted the abstainer individually and its
    // PRIVATE ballot (the self-identifying reply form) was counted.
    const day1 = result.days[0]!
    expect(day1.rePrompted).toEqual(['player-5'])
    expect(day1.votes['player-5']).toBeDefined()
    expect(day1.abstentions ?? []).toEqual([])
    const rePromptRows = result.replyLoss.filter((row) => row.purpose === 'vote-reprompt')
    expect(rePromptRows.length).toBeGreaterThanOrEqual(1)
    expect(rePromptRows.every((row) => row.delivered && row.answered)).toBe(true)
    expect(result.canaryLeaks).toBe(0)
    expect(result.privateReportsPostedPublicly).toBe(0)
  }, 180_000)
})

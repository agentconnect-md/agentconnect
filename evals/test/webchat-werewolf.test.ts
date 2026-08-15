/**
 * Webchat Werewolf, scripted (credential-free CI gate; part of
 * `eval:collab:contracts`) — the full game on the webchat composition:
 * ONE conversation, role delivery and night actions as postless
 * `toAgent + needsReply` calls from a scripted-subject referee acting through
 * the REAL tool surface, night kill referee-MEDIATED (propose → agree relay),
 * public day speech and votes as ordinary conversation posts carried by the
 * #906 continuation. The Slack-shaped Werewolf (`evals/test/werewolf.test.ts`)
 * pins the other composition and stays untouched.
 */
import { describe, expect, it } from 'vitest'
import { runWebchatWerewolf } from '../games/webchat-werewolf-runner.js'
import { assignWerewolfRoles } from '../games/werewolf-rules.js'

describe('webchat werewolf (scripted)', () => {
  it('plays a full 5-player game to a winner through the real tool surface (seed 1)', async () => {
    const result = await runWebchatWerewolf({ seed: 1, playerCount: 5 })

    // Deterministic terminal state, pinned exactly.
    expect(result.terminalReason).toBe('completed')
    expect(result.winner).toBe('werewolves')
    expect(result.rounds).toBe(1)
    expect(result.roles).toEqual(
      Object.fromEntries(assignWerewolfRoles(['player-1', 'player-2', 'player-3', 'player-4', 'player-5'], 1))
    )

    // Night 1: the MEDIATED kill — wolf lead proposed, the second wolf
    // agreed through the referee's relay, and the doctor's save landed.
    expect(result.nights).toHaveLength(1)
    expect(result.nights[0]).toMatchObject({
      round: 1,
      wolfLead: 'player-2',
      proposal: 'player-1',
      verdict: 'agreed',
      kill: 'player-1',
      protect: 'player-1',
      inspect: 'player-1',
      inspectResult: 'not-werewolf',
      saved: true
    })

    // Day 1: the sequential order completed IN ORDER (the #906 continuation
    // carried it), every living player voted exactly once, and the lynch
    // resolved. The committed POSTS are the ground truth for ordering (the
    // brain's `spoke` records referee-wake arrival order, which async wakes
    // may permute).
    expect(result.days).toHaveLength(1)
    expect(result.days[0]!.order).toEqual(['player-1', 'player-2', 'player-3', 'player-4', 'player-5'])
    expect([...result.days[0]!.spoke].sort()).toEqual(result.days[0]!.order)
    const speechPosts = result.posts
      .filter((post) => /^player-\d+: nothing stands out|^player-\d+: I have a bad feeling/.test(post.text))
      .map((post) => post.author)
    expect(speechPosts).toEqual(result.days[0]!.order)
    const votePosts = result.posts.filter((post) => /^player-\d+: I vote for /.test(post.text))
    expect(votePosts).toHaveLength(5)
    expect(Object.keys(result.days[0]!.votes).sort()).toEqual(result.days[0]!.order)
    expect(result.days[0]).toMatchObject({ lynched: 'player-1', revealed: 'villager' })

    // Every needsReply call the referee issued was delivered AND answered —
    // with correctly scripted children there are no reply losses.
    expect(result.replyLoss.map((row) => row.purpose).sort()).toEqual(
      ['role', 'role', 'role', 'role', 'role', 'kill-proposal', 'kill-verdict', 'inspect', 'protect'].sort()
    )
    expect(result.replyLoss.every((row) => row.delivered)).toBe(true)
    expect(result.replyLoss.every((row) => row.answered)).toBe(true)
    // Daemon-side cross-check: every `answered` verdict is backed by an
    // ADMITTED reply wake — a #926 context echo of a dropped wake cannot
    // masquerade as an answer.
    expect(result.replyWakesAccepted).toBe(result.replyLoss.filter((row) => row.answered).length)

    // Leak assertions, adapted to the conversation shape: the canaries ride
    // ONLY the private role calls and must never surface in the shared
    // conversation (posts or transcript).
    expect(result.canaryLeaks).toBe(0)

    // #967 regression pin: pairwise a2a transcripts are private per
    // (caller, child) pair — a role canary never surfaces in any prompt of a
    // player whose role does not hold it.
    expect(result.canaryCrossVisibility).toBe(0)

    // #966 fixed (was the measured #926 surface, previously pinned > 0): a
    // needsReply report resumes the parent session-only — no role ack, kill
    // statement, or night action ever surfaces as a conversation post.
    expect(result.privateReportsPostedPublicly).toBe(0)
  }, 180_000)

  it('a 6-player game runs multiple rounds through the host night-cue loop (seed 2)', async () => {
    const result = await runWebchatWerewolf({ seed: 2, playerCount: 6, maxRounds: 4 })
    expect(result.terminalReason).toBe('completed')
    expect(result.rounds).toBeGreaterThanOrEqual(2)
    expect(result.winner).toBeDefined()
    expect(result.canaryLeaks).toBe(0)
    expect(result.canaryCrossVisibility).toBe(0)
    expect(result.privateReportsPostedPublicly).toBe(0)
    // Multi-round means at least two night cue round-trips through the host.
    expect(result.nights.length).toBeGreaterThanOrEqual(2)
    // Every night's kill was mediated: a proposal preceded the kill.
    for (const night of result.nights) {
      if (night.kill !== undefined) expect(night.proposal).toBeDefined()
    }
    expect(result.replyLoss.every((row) => row.answered)).toBe(true)
    // Daemon-side cross-check: every `answered` verdict is backed by an
    // ADMITTED reply wake — a #926 context echo of a dropped wake cannot
    // masquerade as an answer.
    expect(result.replyWakesAccepted).toBe(result.replyLoss.filter((row) => row.answered).length)
  }, 180_000)
})

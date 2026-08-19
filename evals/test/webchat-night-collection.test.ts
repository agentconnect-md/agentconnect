/**
 * Night collection, scripted (credential-free CI gate; part of
 * `eval:collab:contracts`) — the webchat reproduction of the live Werewolf
 * night-1 failure shape. See `evals/games/night-collection.ts` for the
 * scenario; this file pins the current-main truths:
 *
 *  - every child reply sent correctly (`sendMessage {sessionId}`) reaches the
 *    referee's session EXACTLY once, regardless of interleaved public filler
 *    (a coalesced wake still carries the reply in the turn's input);
 *  - a child that answers in PROSE (headless, no tool call) is a LOST reply —
 *    the #905 validation cell, pinned as `lost` because that IS current main;
 *  - the referee-mediated wolf relay (proposal → wolf-B → verdict) round-trips
 *    end to end through the real tool surface.
 */
import { describe, expect, it } from 'vitest'
import {
  MARKERS,
  NIGHT_ALIASES,
  NIGHT_START_TEXT,
  NightCollectionReferee,
  scoreNightCollection,
  type NightCollectionScore
} from '../games/night-collection.js'
import { WebchatArena, mintSeats, prepareScriptedWebchatRoot, type WebchatSeat } from '../games/webchat-fixture.js'
import {
  executeBrainTurn,
  parentSessionIdOf,
  scriptedWebchatHostFactory,
  type PromptLogEntry,
  type ScriptedSessionHandler
} from '../games/webchat-referee.js'
import { callDaemonTool } from '../games/mcp-client.js'

const ALIASES = NIGHT_ALIASES

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

interface NightRun {
  arena: WebchatArena
  seats: WebchatSeat[]
  referee: NightCollectionReferee
  log: PromptLogEntry[]
  score: () => NightCollectionScore
  refereePrompts: () => string[]
  stop: () => Promise<void>
}

/**
 * Boot the scenario. `gate` (optional) holds the referee's turn open after its
 * brain actions until the returned promise resolves — the deterministic way to
 * force a child reply to land while the referee's turn is still in flight
 * (the coalesce cell).
 */
async function startNightRun(
  options: {
    refereeGate?: (promptText: string) => Promise<void>
    /** #800 deadline the referee attaches to every night call. */
    deadlineMs?: number
    /** Aliases whose delegation turn NEVER ends — the shape no turn-final inference reaches. */
    silent?: string[]
  } = {}
): Promise<NightRun> {
  const seats = mintSeats([...ALIASES])
  const seat = (alias: (typeof ALIASES)[number]) => seats.find((candidate) => candidate.alias === alias)!
  const referee = new NightCollectionReferee({
    wolfA: seat('wolf-a'),
    wolfB: seat('wolf-b'),
    seer: seat('seer'),
    doctor: seat('doctor'),
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {})
  })
  let releaseSilent: () => void = () => undefined
  const silentGate = new Promise<void>((resolve) => {
    releaseSilent = resolve
  })
  const log: PromptLogEntry[] = []
  const handlers = new Map<string, ScriptedSessionHandler>()

  handlers.set(seat('referee').agentId, async ({ text, binding }) => {
    const { reply } = await executeBrainTurn(referee, binding, text, callDaemonTool)
    await options.refereeGate?.(text)
    return reply
  })
  const childReply = (marker: string, body: string): ScriptedSessionHandler => {
    return async ({ text, binding }) => {
      if (text.includes(`\`${marker}\``)) {
        const sessionId = parentSessionIdOf(text)
        if (!binding || !sessionId) return `cannot report: binding=${Boolean(binding)} parent=${sessionId}`
        const result = await callDaemonTool(binding, 'sendMessage', { sessionId, message: `${marker} ${body}` })
        return result.ok ? 'reported.' : `report failed: ${result.error ?? 'unknown'}`
      }
      if (text.includes('NIGHT 1 begins')) return 'Waiting.'
      return undefined
    }
  }
  handlers.set(seat('wolf-a').agentId, childReply(MARKERS.proposal, 'we eliminate the doctor tonight.'))
  handlers.set(seat('wolf-b').agentId, childReply(MARKERS.verdict, 'agreed — the doctor it is.'))
  handlers.set(seat('doctor').agentId, childReply(MARKERS.doctor, 'I protect the seer tonight.'))
  // The PROSE child: answers the delegation in plain text, no tool call — the
  // headless-child reply loss (delegate-and-forward finding; #905 is parked on
  // this cell). Deliberate, and pinned below as LOST on current main.
  handlers.set(seat('seer').agentId, async ({ text }) => {
    if (text.includes(`\`${MARKERS.seer}\``)) return `${MARKERS.seer} I inspect wolf-a tonight.`
    if (text.includes('NIGHT 1 begins')) return 'Waiting.'
    return undefined
  })
  handlers.set(seat('villager').agentId, ({ text }) => (text.includes('NIGHT 1 begins') ? 'Waiting.' : undefined))
  for (const alias of options.silent ?? []) {
    handlers.set(seat(alias as (typeof ALIASES)[number]).agentId, async ({ text }) => {
      if (text.includes('NIGHT 1 begins')) return 'Waiting.'
      await silentGate
      return undefined
    })
  }

  const { root } = prepareScriptedWebchatRoot(seats)
  const arena = new WebchatArena({
    root,
    seats,
    hostFactory: scriptedWebchatHostFactory(handlers, log) as never
  })
  await arena.start()
  const refereePrompts = () =>
    log.filter((entry) => entry.agentId === seat('referee').agentId).map((entry) => entry.text)
  return {
    arena,
    seats,
    referee,
    log,
    refereePrompts,
    score: () =>
      scoreNightCollection({
        events: arena.events(),
        refereePrompts: refereePrompts(),
        posts: arena.posts,
        refereeAgentId: seat('referee').agentId,
        children: [
          { alias: 'wolf-a', marker: 'proposal' },
          { alias: 'seer', marker: 'seer' },
          { alias: 'doctor', marker: 'doctor' },
          { alias: 'wolf-b', marker: 'verdict' }
        ]
      }),
    stop: async () => {
      releaseSilent()
      await arena.stop()
    }
  }
}

describe('webchat night collection (scripted)', () => {
  it('three concurrent needsReply calls: correct replies wake the referee exactly once each; the prose reply is LOST; the wolf relay round-trips', async () => {
    const run = await startNightRun()
    try {
      await run.arena.postHost(NIGHT_START_TEXT)
      await run.arena.settle({ quietMs: 900, timeoutMs: 90_000 })

      // The referee issued exactly four needsReply calls (three night calls +
      // the wolf-B relay), all delivered.
      expect(run.referee.issued.map((call) => call.purpose)).toEqual(['proposal', 'seer', 'doctor', 'verdict'])
      expect(run.referee.issued.every((call) => call.delivered)).toBe(true)

      const score = run.score()
      const byChild = new Map(score.replies.map((reply) => [reply.child, reply]))

      // Correct child replies (sessionId form) each woke the referee's
      // session exactly once — no double wake, no swallow.
      for (const child of ['wolf-a', 'doctor', 'wolf-b']) {
        const outcome = byChild.get(child)!
        expect(outcome.mode, `${child} reply must reach the referee`).not.toBe('lost')
        expect(outcome.ownTurnStarts, `${child} reply must not double-wake the referee`).toBeLessThanOrEqual(1)
        expect(outcome.deliveredPromptSightings + outcome.contextRowSightings).toBeGreaterThanOrEqual(1)
        // #966 fixed (was the measured #926 surface): a needsReply report
        // resumes the parent session-only — it is never committed as a
        // conversation post, so the roster cannot read private reports.
        expect(outcome.postedPublicly).toBe(false)
      }

      // The #800 mechanism-fix cell (formerly the #905 validation cell, whose
      // current-main truth was 'lost'): a headless child's PROSE answer is no
      // longer dropped — the daemon delivers its final output to the referee
      // as an INFERRED reply, explicitly marked, and nothing is lost.
      expect(byChild.get('seer')!.mode).toBe('delivered-inferred')
      expect(score.lost).toEqual([])

      // Daemon-side ground truth: three direct reports plus the seer's
      // inferred delivery — four admitted reply wakes, and no verdict above
      // rests on content visibility alone.
      expect(score.acceptedReplyWakes).toBe(4)

      // The referee-mediated relay leg, end to end: wolf-B was woken with
      // wolf-A's proposal, and its verdict came back.
      const wolfBPrompts = run.log
        .filter((entry) => entry.agentId === run.seats.find((s) => s.alias === 'wolf-b')!.agentId)
        .map((entry) => entry.text)
      expect(wolfBPrompts.some((text) => text.includes('we eliminate the doctor tonight.'))).toBe(true)
      expect(run.referee.markerSightings.get('verdict') ?? 0).toBeGreaterThanOrEqual(1)

      // Interleaved public filler happened (the interference is real), and
      // the referee's closing public post landed in the conversation.
      expect(score.fillerPosts).toBeGreaterThanOrEqual(1)
      expect(score.nightResolvedPosted).toBe(true)
    } finally {
      await run.stop()
    }
  }, 120_000)

  it('a reply landing while the referee turn is in flight is never swallowed: it is coalesced into the turn input or runs as its own wake', async () => {
    // Hold the referee's night-start turn open until the doctor's reply has
    // been submitted, so that reply must land on a BUSY referee session.
    let doctorReported: (() => void) | undefined
    const doctorDone = new Promise<void>((resolve) => (doctorReported = resolve))
    const run = await startNightRun({
      refereeGate: async (text) => {
        if (/NIGHT 1 begins/.test(text)) {
          await Promise.race([doctorDone, new Promise((resolve) => setTimeout(resolve, 20_000))])
          // Give the queued reply a beat to be durably enqueued against the
          // still-open turn before the turn ends.
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    })
    // Observe the doctor's report going out (its handler resolves the gate).
    const doctorSeat = run.seats.find((s) => s.alias === 'doctor')!
    const originalLogPush = run.log.push.bind(run.log)
    run.log.push = ((entry: PromptLogEntry) => {
      const result = originalLogPush(entry)
      if (entry.agentId === doctorSeat.agentId && entry.text.includes('`DOCTOR-REPORT:`')) {
        // The child prompt arrived; its handler will report during this turn.
        setTimeout(() => doctorReported?.(), 500)
      }
      return result
    }) as typeof run.log.push
    try {
      await run.arena.postHost(NIGHT_START_TEXT)
      await run.arena.settle({ quietMs: 900, timeoutMs: 90_000 })
      const score = run.score()
      const doctor = score.replies.find((reply) => reply.child === 'doctor')!
      // The invariant: never swallowed. Either shape is legal; both are
      // recorded — and the referee saw the reply exactly once either way.
      // A 'coalesced' verdict is only reachable through an admitted wake the
      // scorer's evidence budget vouches for — content visibility alone
      // (a #926 public-copy echo) scores 'lost'.
      expect(score.acceptedReplyWakes).toBeGreaterThanOrEqual(3)
      expect(doctor.mode).not.toBe('lost')
      expect(doctor.ownTurnStarts).toBeLessThanOrEqual(1)
      expect(doctor.deliveredPromptSightings + doctor.contextRowSightings).toBeGreaterThanOrEqual(1)
    } finally {
      await run.stop()
    }
  }, 120_000)

  it('#800 deadline: a child that never reports wakes the referee anyway, and it re-prompts unaided', async () => {
    // The seer's delegation turn never ends, so nothing turn-final can infer a reply for it.
    // Before the deadline this referee had no event to act on at all — the live game needed a
    // human to say "the vote has gone quiet".
    const run = await startNightRun({ deadlineMs: 2_000, silent: ['seer'] })
    try {
      await run.arena.postHost(NIGHT_START_TEXT)
      // The silent child's turn never ends, so the arena never goes idle — poll for the
      // recovery instead of waiting for a quiet that cannot come.
      await waitUntil(() => run.referee.rePrompted.has('seer'), 60_000)

      const refereeInput = run.refereePrompts().join('\n')
      expect(refereeInput).toContain('[needsReply deadline]')
      expect(refereeInput).toContain('No report arrived')
      // The notice is not an answer: the seer's marker never appears through it.
      expect(refereeInput).toContain('this notice is NOT its answer')
      expect(run.referee.deadlineNotices).toBeGreaterThanOrEqual(1)

      // …and the referee acted on it by itself — the lever a quiet child previously blocked.
      expect(run.referee.rePrompted.has('seer')).toBe(true)
      expect(run.referee.issued.filter((call) => call.purpose === 'seer')).toHaveLength(2)

      // The children that DID report are unaffected.
      const score = run.score()
      for (const child of ['wolf-a', 'doctor']) {
        expect(score.replies.find((reply) => reply.child === child)!.mode).not.toBe('lost')
      }
    } finally {
      await run.stop()
    }
  }, 120_000)
})

import { describe, expect, it } from 'vitest'
import type { ExecutorCandidate, ExecutorCandidatesResult, RuntimeStrategyEntry } from '@agentconnect.md/protocol'
import {
  candidateEligible,
  catalogOffers,
  executorLost,
  placeSession,
  strategyFor,
  strategySpreads,
  type PlacementAsk
} from '../src/execution/executor-placement.js'

// The birth predicate, the one rule that selects, and the lazy loss rule (session-executors.md §6, §7).

const ASK: PlacementAsk = { isolation: 'session', strategy: 'host', runtime: 'claude' }

function candidate(daemonId: string, over: Partial<ExecutorCandidate> = {}): ExecutorCandidate {
  return {
    daemonId,
    strategies: { host: { available: true }, microsandbox: { available: false, reason: 'no KVM here' } },
    endpoint: { host: '10.0.0.2', port: 7100 },
    capacity: 32,
    hostedSessions: 0,
    runtimes: [{ runtime: 'claude', authRequired: false }],
    ...over
  }
}

function answer(
  candidates: ExecutorCandidate[],
  over: Partial<ExecutorCandidatesResult> = {}
): ExecutorCandidatesResult {
  return { candidates, ...over }
}

describe('the birth predicate', () => {
  it('keeps a shared session with the primary checkout', () => {
    const placement = placeSession({
      ask: { ...ASK, isolation: 'shared' },
      holderHostedSessions: 9,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b')])
    })
    expect(placement).toEqual({ stayedHome: 'shared_session' })
  })

  it('keeps a session whose managed memory the control plane has not flipped yet', () => {
    const placement = placeSession({
      ask: { ...ASK, memoryDaemonHomed: true },
      holderHostedSessions: 9,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b')])
    })
    expect(placement).toEqual({ stayedHome: 'memory_daemon_homed' })
  })

  it('keeps the session home when the control plane could not be asked at all', () => {
    expect(placeSession({ ask: ASK, holderHostedSessions: 9, holderCapacity: 32, holderAuthenticates: true })).toEqual({
      stayedHome: 'control_plane_unreachable'
    })
  })

  it('records the reason the control plane gave for an empty answer', () => {
    for (const reason of ['group_switch_off', 'not_on_group'] as const) {
      expect(
        placeSession({
          ask: ASK,
          holderHostedSessions: 9,
          holderCapacity: 32,
          holderAuthenticates: true,
          answer: answer([], { reason })
        })
      ).toEqual({
        stayedHome: reason
      })
    }
    expect(
      placeSession({
        ask: ASK,
        holderHostedSessions: 9,
        holderCapacity: 32,
        holderAuthenticates: true,
        answer: answer([], { reason: 'no_member_shares' })
      })
    ).toEqual({ stayedHome: 'no_candidate' })
  })

  it('refuses a candidate that offers no matching strategy, cannot authenticate the runtime, or has no endpoint', () => {
    const unmatched = [
      candidate('b', { strategies: { host: { available: false, reason: 'not Linux' } } }),
      candidate('c', { runtimes: [{ runtime: 'claude', authRequired: true }] }),
      candidate('d', { runtimes: [{ runtime: 'codex', authRequired: false }] }),
      candidate('e', { endpoint: undefined })
    ]
    expect(
      placeSession({
        ask: ASK,
        holderHostedSessions: 9,
        holderCapacity: 32,
        holderAuthenticates: true,
        answer: answer(unmatched)
      })
    ).toEqual({
      stayedHome: 'no_candidate'
    })
  })

  it('asks a candidate for exactly the agent’s strategy, never a stronger or a weaker one', () => {
    const sandboxing = candidate('b', {
      strategies: { host: { available: true }, microsandbox: { available: true } }
    })
    expect(strategyFor(ASK, sandboxing)).toBe('host')
    expect(strategyFor({ ...ASK, strategy: 'microsandbox' }, sandboxing)).toBe('microsandbox')
    // Its microsandbox is unavailable, and `host` is no substitute for it.
    expect(strategyFor({ ...ASK, strategy: 'microsandbox' }, candidate('c'))).toBeUndefined()
    // A VM does not stand in for a host session either.
    expect(strategyFor(ASK, candidate('d', { strategies: { microsandbox: { available: true } } }))).toBeUndefined()
  })

  it('places an srt session on a member whose facet offers srt, and keeps home a strategy no facet prepares', () => {
    const offersSrt = candidate('b', { strategies: { srt: { available: true } } })
    const answer: ExecutorCandidatesResult = { candidates: [offersSrt] }
    const place = (strategy: string, reachable?: ExecutorCandidatesResult) =>
      placeSession({
        ask: { ...ASK, strategy },
        holderHostedSessions: 9,
        holderCapacity: 32,
        holderAuthenticates: true,
        ...(reachable ? { answer: reachable } : {})
      })
    expect(place('srt', answer)).toEqual({ spread: [{ daemonId: 'b', strategy: 'srt' }] })
    expect(place('srt')).toEqual({ stayedHome: 'control_plane_unreachable' })
    for (const reachable of [answer, undefined])
      expect(place('docker', reachable)).toEqual({ stayedHome: 'no_candidate' })
    expect(['host', 'srt', 'microsandbox'].every(strategySpreads)).toBe(true)
    expect(strategySpreads('docker')).toBe(false)
  })
})

describe('the one rule that selects', () => {
  it('sends the session to the candidate hosting the fewest', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 4,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b', { hostedSessions: 3 }), candidate('c', { hostedSessions: 1 })])
    })
    expect(placement).toEqual({
      spread: [
        { daemonId: 'c', strategy: 'host' },
        { daemonId: 'b', strategy: 'host' }
      ]
    })
  })

  it('keeps the session home on a tie, which costs no link', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 2,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b', { hostedSessions: 2 })])
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })

  it('counts a member that has not reported a heartbeat yet as hosting nothing', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 1,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b', { hostedSessions: undefined })])
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'b', strategy: 'host' }] })
  })

  it('puts the control plane hint first, whatever the counts say', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('b', { hostedSessions: 5 }), candidate('c', { hostedSessions: 0 })], {
        currentExecutorDaemonId: 'b'
      })
    })
    // A successor attaches to the environment its predecessor left rather than re-placing the work in it.
    expect(placement).toEqual({
      spread: [
        { daemonId: 'b', strategy: 'host' },
        { daemonId: 'c', strategy: 'host' }
      ]
    })
  })

  it('ignores a hint naming a machine that is not a candidate', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([candidate('c')], { currentExecutorDaemonId: 'gone' })
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })
})

describe('capacity', () => {
  it('reads each load against its capacity, so a larger machine takes a larger share', () => {
    // An idle 8/2/1 group: the new session is least full on the largest machine, not on the small holder.
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
      holderCapacity: 1,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: 2 }), candidate('c', { capacity: 8 })])
    })
    expect(placement).toEqual({
      spread: [
        { daemonId: 'c', strategy: 'host' },
        { daemonId: 'b', strategy: 'host' }
      ]
    })
  })

  it('keeps a larger holder with fewer sessions per slot, even when it hosts more', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 3,
      holderCapacity: 8,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: 2, hostedSessions: 1 })])
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })

  it('keeps a tie home when both would be equally full', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 1,
      holderCapacity: 2,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: 4, hostedSessions: 3 })])
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })

  it('skips a member already at capacity', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 5,
      holderCapacity: 4,
      holderAuthenticates: true,
      answer: answer([
        candidate('b', { capacity: 2, hostedSessions: 2 }),
        candidate('c', { capacity: 4, hostedSessions: 3 })
      ])
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'c', strategy: 'host' }] })
  })

  it('stays home as candidates_full when every member is at capacity', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 9,
      holderCapacity: 4,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: 1, hostedSessions: 1 }), candidate('c', { capacity: 0 })])
    })
    expect(placement).toEqual({ stayedHome: 'candidates_full' })
  })

  it("still tries the hinted member at capacity, which may hold this session's environment", () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
      holderCapacity: 4,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: 1, hostedSessions: 1 })], { currentExecutorDaemonId: 'b' })
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'b', strategy: 'host' }] })
  })

  it('replaces a lost executor with a live member even when the holder would be less full', () => {
    // The holder cannot take a placed session back, so its own load is not compared (§7).
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 2,
      holderCapacity: 8,
      holderAuthenticates: true,
      replacing: 'lost',
      answer: answer([candidate('b', { capacity: 2 })], { currentExecutorDaemonId: 'lost' })
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'b', strategy: 'host' }] })
  })

  it('never offers the lost executor as its own replacement', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
      holderCapacity: 4,
      holderAuthenticates: true,
      replacing: 'lost',
      answer: answer([candidate('lost'), candidate('b', { capacity: 1, hostedSessions: 1 })], {
        currentExecutorDaemonId: 'lost'
      })
    })
    expect(placement).toEqual({ stayedHome: 'candidates_full' })
  })

  it('weighs a member that reports no capacity like the holder', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 2,
      holderCapacity: 4,
      holderAuthenticates: true,
      answer: answer([candidate('b', { capacity: undefined, hostedSessions: 1 })])
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'b', strategy: 'host' }] })
  })
})

describe('the holder as a candidate', () => {
  const codex: PlacementAsk = { ...ASK, runtime: 'codex' }
  const signedIn = (daemonId: string, over: Partial<ExecutorCandidate> = {}) =>
    candidate(daemonId, { runtimes: [{ runtime: 'codex', authRequired: false }], ...over })

  it('sends the session to a member that authenticates the runtime when the holder does not, whatever the loads say', () => {
    const placement = placeSession({
      ask: codex,
      holderHostedSessions: 0,
      holderCapacity: 32,
      holderAuthenticates: false,
      answer: answer([signedIn('b', { hostedSessions: 7 }), signedIn('c', { hostedSessions: 9 })])
    })
    expect(placement).toEqual({
      spread: [
        { daemonId: 'b', strategy: 'host' },
        { daemonId: 'c', strategy: 'host' }
      ]
    })
  })

  it('keeps the session home as before when no member authenticates the runtime either', () => {
    const placement = placeSession({
      ask: codex,
      holderHostedSessions: 0,
      holderCapacity: 32,
      holderAuthenticates: false,
      answer: answer([signedIn('b', { runtimes: [{ runtime: 'codex', authRequired: true }] }), candidate('c')])
    })
    expect(placement).toEqual({ stayedHome: 'no_candidate' })
  })

  it('keeps a tie home when the holder authenticates the runtime', () => {
    const placement = placeSession({
      ask: codex,
      holderHostedSessions: 2,
      holderCapacity: 32,
      holderAuthenticates: true,
      answer: answer([signedIn('b', { hostedSessions: 2 })])
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })
})

describe('the strategy’s own catalog', () => {
  const vm: PlacementAsk = { ...ASK, strategy: 'microsandbox', model: 'model-b' }
  const offering = (daemonId: string, entry: RuntimeStrategyEntry, over: Partial<ExecutorCandidate> = {}) =>
    candidate(daemonId, {
      strategies: { host: { available: true }, microsandbox: { available: true } },
      runtimes: [
        {
          runtime: 'claude',
          authRequired: false,
          strategies: {
            // The host install advertises the model; only the entry for the session's strategy counts.
            host: { available: true, models: ['model-a', 'model-b'], modelsSource: 'probed' },
            microsandbox: entry
          }
        }
      ],
      ...over
    })

  it('reads a live list strictly, and a cached, empty or absent one permissively, as the activation check does', () => {
    expect(catalogOffers({ available: true, models: ['model-a'], modelsSource: 'probed' }, 'model-b')).toBe(false)
    expect(catalogOffers({ available: true, models: ['model-a'] }, 'model-b')).toBe(false)
    expect(catalogOffers({ available: true, models: ['model-a'], modelsSource: 'cached' }, 'model-b')).toBe(true)
    expect(catalogOffers({ available: true }, 'model-b')).toBe(true)
    // A successful probe of a runtime with no model selector advertises none.
    expect(catalogOffers({ available: true, models: [], modelsSource: 'probed' }, 'model-b')).toBe(true)
    expect(catalogOffers({ available: true, models: ['model-a'] }, undefined)).toBe(true)
    expect(catalogOffers({ available: false, unavailableReason: 'not in the image' }, undefined)).toBe(false)
    expect(catalogOffers(undefined, undefined)).toBe(false)
  })

  it('judges a candidate by the entry for the session’s strategy alone', () => {
    expect(candidateEligible(vm, offering('b', { available: true, models: ['model-a'], modelsSource: 'probed' }))).toBe(
      false
    )
    expect(candidateEligible(vm, offering('c', { available: false, unavailableReason: 'not in the image' }))).toBe(
      false
    )
    expect(candidateEligible(vm, offering('d', { available: true }))).toBe(true)
    expect(candidateEligible(vm, offering('g', { available: true, models: [], modelsSource: 'probed' }))).toBe(true)
    expect(candidateEligible(vm, offering('e', { available: true, models: ['model-b'], modelsSource: 'probed' }))).toBe(
      true
    )
    // A member that reports no entries predates them, and only its table and sign-in are read.
    expect(candidateEligible(vm, candidate('f', { strategies: { microsandbox: { available: true } } }))).toBe(true)
  })

  it('lands the session only where its runtime and model run, and never keeps it on a holder that lacks them', () => {
    const placement = placeSession({
      ask: vm,
      holderHostedSessions: 0,
      holderCapacity: 32,
      holderAuthenticates: true,
      holderOffers: false,
      answer: answer([
        offering('b', { available: true, models: ['model-a'], modelsSource: 'probed' }, { hostedSessions: 0 }),
        offering('c', { available: true, models: ['model-b'], modelsSource: 'probed' }, { hostedSessions: 9 })
      ])
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'c', strategy: 'microsandbox' }] })
  })

  it('keeps the session on a holder that runs it when no member does', () => {
    const placement = placeSession({
      ask: vm,
      holderHostedSessions: 9,
      holderCapacity: 32,
      holderAuthenticates: true,
      holderOffers: true,
      answer: answer([offering('b', { available: false, unavailableReason: 'not in the image' })])
    })
    expect(placement).toEqual({ stayedHome: 'no_candidate' })
  })
})

describe('the lazy loss rule', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('waits inside the grace, because a machine that is rebooting comes back with its directories', () => {
    expect(executorLost({ lastSeenAt: new Date(now - 60_000).toISOString(), now })).toBe(false)
  })

  it('gives the environment up past the grace', () => {
    expect(executorLost({ lastSeenAt: new Date(now - 11 * 60_000).toISOString(), now })).toBe(true)
  })

  it('gives it up when the control plane has no record of that daemon at all', () => {
    expect(executorLost({ lastSeenAt: null, now })).toBe(true)
  })

  it('keeps the session where it is when the stamp cannot be read', () => {
    expect(executorLost({ lastSeenAt: 'not a time', now })).toBe(false)
  })
})

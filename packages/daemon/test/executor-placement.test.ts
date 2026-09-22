import { describe, expect, it } from 'vitest'
import type { ExecutorCandidate, ExecutorCandidatesResult } from '@agentconnect.md/protocol'
import { executorLost, placeSession, strategyFor, type PlacementAsk } from '../src/execution/executor-placement.js'

// The birth predicate, the one rule that selects, and the lazy loss rule (session-executors.md §6, §7).

const ASK: PlacementAsk = { isolation: 'session', runInSandbox: false, runtime: 'claude' }

function candidate(daemonId: string, over: Partial<ExecutorCandidate> = {}): ExecutorCandidate {
  return {
    daemonId,
    strategies: { host: { available: true }, microsandbox: { available: false, reason: 'no KVM here' } },
    endpoint: { host: '10.0.0.2', port: 7100 },
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
      answer: answer([candidate('b')])
    })
    expect(placement).toEqual({ stayedHome: 'shared_session' })
  })

  it('keeps a session whose managed memory the control plane has not flipped yet', () => {
    const placement = placeSession({
      ask: { ...ASK, memoryDaemonHomed: true },
      holderHostedSessions: 9,
      answer: answer([candidate('b')])
    })
    expect(placement).toEqual({ stayedHome: 'memory_daemon_homed' })
  })

  it('keeps the session home when the control plane could not be asked at all', () => {
    expect(placeSession({ ask: ASK, holderHostedSessions: 9 })).toEqual({
      stayedHome: 'control_plane_unreachable'
    })
  })

  it('records the reason the control plane gave for an empty answer', () => {
    for (const reason of ['group_switch_off', 'not_on_group'] as const) {
      expect(placeSession({ ask: ASK, holderHostedSessions: 9, answer: answer([], { reason }) })).toEqual({
        stayedHome: reason
      })
    }
    expect(
      placeSession({ ask: ASK, holderHostedSessions: 9, answer: answer([], { reason: 'no_member_shares' }) })
    ).toEqual({ stayedHome: 'no_candidate' })
  })

  it('refuses a candidate that offers no matching strategy, cannot authenticate the runtime, or has no endpoint', () => {
    const unmatched = [
      candidate('b', { strategies: { host: { available: false, reason: 'not Linux' } } }),
      candidate('c', { runtimes: [{ runtime: 'claude', authRequired: true }] }),
      candidate('d', { runtimes: [{ runtime: 'codex', authRequired: false }] }),
      candidate('e', { endpoint: undefined })
    ]
    expect(placeSession({ ask: ASK, holderHostedSessions: 9, answer: answer(unmatched) })).toEqual({
      stayedHome: 'no_candidate'
    })
  })

  it('asks a sandboxing strategy for an agent that asked for a sandbox, and `host` otherwise', () => {
    const sandboxing = candidate('b', {
      strategies: { host: { available: true }, microsandbox: { available: true } }
    })
    expect(strategyFor(ASK, sandboxing)).toBe('host')
    expect(strategyFor({ ...ASK, runInSandbox: true }, sandboxing)).toBe('microsandbox')
    // The only sandboxing strategy of v1 is unavailable here, and `host` is not one.
    expect(strategyFor({ ...ASK, runInSandbox: true }, candidate('c'))).toBeUndefined()
  })
})

describe('the one rule that selects', () => {
  it('sends the session to the candidate hosting the fewest', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 4,
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
      answer: answer([candidate('b', { hostedSessions: 2 })])
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
  })

  it('counts a member that has not reported a heartbeat yet as hosting nothing', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 1,
      answer: answer([candidate('b', { hostedSessions: undefined })])
    })
    expect(placement).toEqual({ spread: [{ daemonId: 'b', strategy: 'host' }] })
  })

  it('puts the control plane hint first, whatever the counts say', () => {
    const placement = placeSession({
      ask: ASK,
      holderHostedSessions: 0,
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
      answer: answer([candidate('c')], { currentExecutorDaemonId: 'gone' })
    })
    expect(placement).toEqual({ stayedHome: 'holder_least_loaded' })
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

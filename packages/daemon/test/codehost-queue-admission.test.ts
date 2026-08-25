import { describe, expect, it } from 'vitest'
import type { HookQueueCandidate } from '../src/codehost/hook-admission.js'
import { planRevisionAdmission, planRevisionAdmissionEffects } from '../src/codehost/queue-admission.js'
import type { QueueEntry } from '../src/daemon/turn-types.js'

const KEY = 'acme/infra#42'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const BASE_A = '0'.repeat(40)
const BASE_B = '1'.repeat(40)

const entry = (deliveryKey: string, event: string, headSha: string, firedAt: string, baseSha = BASE_A): QueueEntry =>
  ({
    agentId: 'agent-1',
    msg: { platform: 'github', channel: KEY },
    hookContext: {
      hookId: 'hook-1',
      agentId: 'agent-1',
      deliveryKey,
      firedAt,
      event,
      github: {
        repoId: '123',
        repoFullName: 'acme/infra',
        sourceInstallationId: '456',
        subjectKind: 'pull_request',
        pullNumber: 42,
        headSha,
        baseSha,
        reportSha: headSha,
        ...(event === 'pull_request:edited' ? { baseChanged: true } : {})
      }
    }
  }) as unknown as QueueEntry

const active = (entry: QueueEntry): HookQueueCandidate[] => [{ key: KEY, entry, state: 'active' }]

describe('planGithubRevisionAdmission', () => {
  it('preempts a running pull_request:opened review with a newer pushed revision', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const pushed = entry('pushed', 'pull_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')

    const plan = planRevisionAdmission(KEY, pushed, active(opened))

    expect(plan?.winner.entry).toBe(pushed)
    const effects = planRevisionAdmissionEffects(plan!, pushed)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
  })

  it('waits out a running review of the same head instead of restarting it', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const redelivered = entry('redelivered', 'pull_request:synchronize', HEAD_A, '2026-08-19T01:25:00.000Z')

    const plan = planRevisionAdmission(KEY, redelivered, active(opened))

    const effects = planRevisionAdmissionEffects(plan!, redelivered)
    expect(effects.activeLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(effects.preemptableActiveLosers).toEqual([])
  })

  it('preempts a running review when the target branch changes under the same head', () => {
    const current = entry('current', 'pull_request:synchronize', HEAD_A, '2026-08-19T01:24:44.000Z', BASE_A)
    const retargeted = entry('retargeted', 'pull_request:edited', HEAD_A, '2026-08-19T01:25:00.000Z', BASE_B)

    const plan = planRevisionAdmission(KEY, retargeted, active(current))
    const effects = planRevisionAdmissionEffects(plan!, retargeted)

    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([current])
  })

  it('re-runs the head a re-request names, preempting the review already generating it', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const rerequested = entry('rerequested', 'check_run:rerequested', HEAD_A, '2026-08-19T01:26:00.000Z')

    const plan = planRevisionAdmission(KEY, rerequested, active(opened))

    expect(plan?.winner.entry).toBe(rerequested)
    const effects = planRevisionAdmissionEffects(plan!, rerequested)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
  })

  it('collapses a burst of re-requests for one head onto the newest delivery', () => {
    const first = entry('first', 'check_suite:rerequested', HEAD_A, '2026-08-19T17:55:42.765Z')
    const second = entry('second', 'check_suite:rerequested', HEAD_A, '2026-08-19T17:55:42.947Z')
    const third = entry('third', 'check_suite:rerequested', HEAD_A, '2026-08-19T17:55:43.456Z')

    const plan = planRevisionAdmission(KEY, third, [
      { key: KEY, entry: first, state: 'active' },
      { key: KEY, entry: second, state: 'queued' }
    ])

    expect(plan?.winner.entry).toBe(third)
    const effects = planRevisionAdmissionEffects(plan!, third)
    expect(effects.incomingWins).toBe(true)
    expect(effects.terminalLosers.map((candidate) => candidate.entry)).toEqual([second])
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([first])
  })

  it('leaves the head under review alone when a re-request names a stale one', () => {
    const pushed = entry('pushed', 'pull_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')
    const rerequested = entry('rerequested', 'check_suite:rerequested', HEAD_A, '2026-08-19T01:29:00.000Z')

    const plan = planRevisionAdmission(KEY, rerequested, active(pushed))

    expect(plan?.winner.entry).toBe(rerequested)
    expect(plan?.superseded).toEqual([])
  })
})

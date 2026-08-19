import { describe, expect, it } from 'vitest'
import type { GithubQueueCandidate } from '../src/github/hook-coords.js'
import { planGithubRevisionAdmission, planGithubRevisionAdmissionEffects } from '../src/github/queue-admission.js'
import type { QueueEntry } from '../src/daemon/turn-types.js'

const KEY = 'acme/infra#42'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

const entry = (deliveryKey: string, event: string, headSha: string, firedAt: string): QueueEntry =>
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
        baseSha: '0'.repeat(40),
        reportSha: headSha
      }
    }
  }) as unknown as QueueEntry

const active = (entry: QueueEntry): GithubQueueCandidate[] => [{ key: KEY, entry, state: 'active' }]

describe('planGithubRevisionAdmission', () => {
  it('preempts a running pull_request:opened review with a newer pushed revision', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const pushed = entry('pushed', 'pull_request:synchronize', HEAD_B, '2026-08-19T01:28:20.000Z')

    const plan = planGithubRevisionAdmission(KEY, pushed, active(opened))

    expect(plan?.winner.entry).toBe(pushed)
    const effects = planGithubRevisionAdmissionEffects(plan!, pushed)
    expect(effects.incomingWins).toBe(true)
    expect(effects.preemptableActiveLosers.map((candidate) => candidate.entry)).toEqual([opened])
  })

  it('waits out a running review of the same head instead of restarting it', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const redelivered = entry('redelivered', 'pull_request:synchronize', HEAD_A, '2026-08-19T01:25:00.000Z')

    const plan = planGithubRevisionAdmission(KEY, redelivered, active(opened))

    const effects = planGithubRevisionAdmissionEffects(plan!, redelivered)
    expect(effects.activeLosers.map((candidate) => candidate.entry)).toEqual([opened])
    expect(effects.preemptableActiveLosers).toEqual([])
  })

  it('leaves a re-request out of latest-wins, since it opens no new revision', () => {
    const opened = entry('opened', 'pull_request:opened', HEAD_A, '2026-08-19T01:24:44.000Z')
    const rerequested = entry('rerequested', 'check_run:rerequested', HEAD_A, '2026-08-19T01:26:00.000Z')

    expect(planGithubRevisionAdmission(KEY, rerequested, active(opened))).toBeUndefined()
  })
})

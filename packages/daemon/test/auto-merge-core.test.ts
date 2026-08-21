// The readiness rule and one tick against a stubbed GitHub — the whole reason merge-when-ready moved
// to the edge is that GitHub's own auto-merge answers "no" in most of these states.
import { describe, expect, it, vi } from 'vitest'
import { readiness, tick, type PrSnapshot } from '../src/github/auto-merge/core.js'

const OPEN: PrSnapshot = {
  prId: 'PR_1',
  headOid: 'sha_head',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  checks: []
}

describe('readiness', () => {
  it('is ready with no checks, no review decision and clean mergeability', () => {
    expect(readiness(OPEN)).toEqual({ ready: true })
  })

  it('waits on running checks and names them, capped', () => {
    const pending = (name: string) => ({ name, outcome: 'pending' as const })
    expect(readiness({ ...OPEN, checks: [pending('build'), pending('lint')] })).toEqual({
      ready: false,
      waitingOn: 'checks running: build, lint'
    })
    const many = ['a', 'b', 'c', 'd', 'e'].map(pending)
    expect(readiness({ ...OPEN, checks: many })).toEqual({ ready: false, waitingOn: 'checks running: a, b, c +2' })
  })

  it('reports a FAILING check ahead of a running one — the failure is the actionable fact', () => {
    expect(
      readiness({
        ...OPEN,
        checks: [
          { name: 'lint', outcome: 'pending' },
          { name: 'build', outcome: 'failure' }
        ]
      })
    ).toEqual({ ready: false, waitingOn: 'failing checks: build' })
  })

  it('blocks on CHANGES_REQUESTED but NOT on REVIEW_REQUIRED', () => {
    expect(readiness({ ...OPEN, reviewDecision: 'CHANGES_REQUESTED' })).toEqual({
      ready: false,
      waitingOn: 'changes requested'
    })
    // A repository with no required reviewers reports REVIEW_REQUIRED forever; treating it as a
    // blocker would make the box a control that never fires — the operator ticking it IS the approval.
    expect(readiness({ ...OPEN, reviewDecision: 'REVIEW_REQUIRED' })).toEqual({ ready: true })
    expect(readiness({ ...OPEN, reviewDecision: 'APPROVED' })).toEqual({ ready: true })
  })

  it('waits on UNKNOWN mergeability rather than merging on a verdict GitHub has not formed', () => {
    expect(readiness({ ...OPEN, mergeable: 'UNKNOWN' })).toMatchObject({ ready: false })
    expect(readiness({ ...OPEN, mergeable: 'CONFLICTING' })).toEqual({
      ready: false,
      waitingOn: 'conflicts with the base branch'
    })
  })

  it('refuses a draft and a closed pull request', () => {
    expect(readiness({ ...OPEN, isDraft: true })).toMatchObject({ ready: false })
    expect(readiness({ ...OPEN, state: 'CLOSED' })).toMatchObject({ ready: false })
    expect(readiness({ ...OPEN, state: 'MERGED' })).toMatchObject({ ready: false })
  })
})

/** A GraphQL answer shaped as the snapshot query returns it. */
function answer(overrides: Record<string, unknown> = {}, checks: Array<Record<string, unknown>> = []) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: 'PR_1',
          headRefOid: 'sha_head',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
          ...overrides
        }
      }
    }
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('tick', () => {
  it('merges by node id, pinned to the head it judged', async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json(bodies.length === 1 ? answer() : { data: { mergePullRequest: { clientMutationId: null } } })
    })

    const outcome = await tick({ token: async () => 'ghs_x', fetchImpl }, 'acme/repo', 7)

    expect(outcome).toEqual({ kind: 'merged' })
    expect(bodies[1]!.query).toContain('mergePullRequest')
    expect(bodies[1]!.query).toContain('mergeMethod:SQUASH')
    expect(bodies[1]!.variables).toEqual({ id: 'PR_1', oid: 'sha_head' })
  })

  it('does not merge while a check runs, and says what it is waiting on', async () => {
    const fetchImpl = vi.fn(async () =>
      json(answer({}, [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }]))
    )

    expect(await tick({ token: async () => 'ghs_x', fetchImpl }, 'acme/repo', 7)).toEqual({
      kind: 'waiting',
      waitingOn: 'checks running: build'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // the read only — no mutation
  })

  it('reads a skipped run as success and a cancelled one as failure', async () => {
    const checks = [
      { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'legacy/ci', state: 'SUCCESS' }
    ]
    const merged = vi.fn(async (_url: string, init?: RequestInit) =>
      json(String(init?.body).includes('mergePullRequest') ? { data: { mergePullRequest: {} } } : answer({}, checks))
    )
    expect(await tick({ token: async () => 'ghs_x', fetchImpl: merged }, 'acme/repo', 7)).toEqual({ kind: 'merged' })

    const cancelled = vi.fn(async () =>
      json(answer({}, [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'CANCELLED' }]))
    )
    expect(await tick({ token: async () => 'ghs_x', fetchImpl: cancelled }, 'acme/repo', 7)).toEqual({
      kind: 'waiting',
      waitingOn: 'failing checks: build'
    })
  })

  it('ends the watch on a CLOSED pull request rather than polling it forever', async () => {
    // The operator's intent expired with the pull request. A watcher left armed would poll for the
    // life of the pod and — worse — merge the thing if anyone reopened it weeks later.
    const fetchImpl = vi.fn(async () => json(answer({ state: 'CLOSED' })))
    expect(await tick({ token: async () => 'ghs_x', fetchImpl }, 'acme/repo', 7)).toEqual({ kind: 'closed' })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // no mutation, and no second look
  })

  it('reports a GitHub refusal as DATA rather than throwing — the watcher stays armed through it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      json(
        String(init?.body).includes('mergePullRequest')
          ? { data: { mergePullRequest: null }, errors: [{ message: 'Head branch was modified' }] }
          : answer()
      )
    )

    expect(await tick({ token: async () => 'ghs_x', fetchImpl }, 'acme/repo', 7)).toEqual({
      kind: 'error',
      error: 'Head branch was modified'
    })
  })

  it('reports an unavailable token the same way, without a GitHub call', async () => {
    const fetchImpl = vi.fn(async () => json(answer()))
    const outcome = await tick(
      {
        token: async () => {
          throw new Error('no gh credentials')
        },
        fetchImpl
      },
      'acme/repo',
      7
    )
    expect(outcome).toEqual({ kind: 'error', error: 'no gh credentials' })
  })
})

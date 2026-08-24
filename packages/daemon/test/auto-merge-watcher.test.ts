// The armed set at the edge: the loop's lifetime, and the watcher's placement dispatch. Nothing here
// touches a disk, because nothing about merge-when-ready is persisted — a restart forgetting the
// intent IS the contract, and these tests pin the behaviour that projects it honestly.
import { MAX_AUTO_MERGE_DETAIL } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { AutoMergeLoop } from '../src/github/auto-merge/loop.js'
import { AutoMergeViolationError, AutoMergeWatcher, type AutoMergeSandbox } from '../src/github/auto-merge/watcher.js'

/** A hand-driven interval: `fire()` runs one tick, so a test never waits out a poll. */
function fakeTimers() {
  const armed: Array<() => void> = []
  return {
    timers: {
      setInterval: (fn: () => void) => {
        armed.push(fn)
        return armed.length
      },
      clearInterval: (handle: unknown) => {
        armed[(handle as number) - 1] = () => {}
      }
    },
    fire: () => armed.forEach((fn) => fn())
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function githubStub(sequence: Array<Record<string, unknown>>) {
  const bodies: string[] = []
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return json(sequence.shift() ?? { data: null, errors: [{ message: 'unexpected extra call' }] })
  })
  return { fetchImpl, bodies }
}

const prAnswer = (checks: Array<Record<string, unknown>> = []) => ({
  data: {
    repository: {
      pullRequest: {
        id: 'PR_1',
        headRefOid: 'sha_head',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }
      }
    }
  }
})

describe('AutoMergeLoop', () => {
  it('ticks immediately on arm — a pull request that is already green must not wait out a poll', async () => {
    const github = githubStub([prAnswer(), { data: { mergePullRequest: {} } }])
    const { timers } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: { token: async () => 'ghs_x', fetchImpl: github.fetchImpl },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(loop.current().merged).toBe(true))
    expect(loop.armed()).toBe(false) // merged is terminal: the timer is gone
  })

  it('stays ARMED through a failing tick, and merges on a later one', async () => {
    const github = githubStub([
      prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }]),
      prAnswer(),
      { data: { mergePullRequest: {} } }
    ])
    const { timers, fire } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: { token: async () => 'ghs_x', fetchImpl: github.fetchImpl },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(loop.current().waitingOn).toBe('failing checks: build'))
    // A red check does not disarm: the usual cure is the next commit, and disarming would throw away
    // the operator's intent on one tick.
    expect(loop.armed()).toBe(true)

    fire()
    await vi.waitFor(() => expect(loop.current().merged).toBe(true))
  })

  it('stops when the pull request is CLOSED, and reads back unarmed', async () => {
    const github = githubStub([
      {
        data: {
          repository: {
            pullRequest: {
              id: 'PR_1',
              headRefOid: 'sha_head',
              state: 'CLOSED',
              isDraft: false,
              mergeable: 'MERGEABLE',
              reviewDecision: null,
              commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] }
            }
          }
        }
      }
    ])
    const { timers } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: { token: async () => 'ghs_x', fetchImpl: github.fetchImpl },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(loop.current().closed).toBe(true))
    expect(loop.armed()).toBe(false)
    expect(loop.current().waitingOn).toBe('the pull request was closed')
  })

  it('does NOT merge when disarm lands while the tick is awaiting GitHub', async () => {
    // The whole point of the fence: a tick that is already in flight decides to merge from a snapshot
    // read BEFORE the operator unticked the box. Without it, the toggle reports off and merges anyway.
    let release: ((value: Response) => void) | undefined
    const calls: string[] = []
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      calls.push(String(init?.body).includes('mergePullRequest') ? 'merge' : 'snapshot')
      return new Promise<Response>((resolve) => (release = resolve))
    })
    const { timers } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: { token: async () => 'ghs_x', fetchImpl },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(release).toBeDefined())
    // Disarm arrives with the snapshot still in the air, then the snapshot says "ready to merge".
    loop.stop()
    release!(json(prAnswer()))
    await loop.settle()

    expect(calls).toEqual(['snapshot'])
    expect(loop.current().merged).toBe(false)
  })

  it('does NOT merge when disarm lands while the MERGE TOKEN is being fetched', async () => {
    // The narrower window: the snapshot is back, readiness said go, and the tick is awaiting the token
    // the merge will be sent with. A fence checked only before that await has already passed.
    const calls: string[] = []
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      calls.push(String(init?.body).includes('mergePullRequest') ? 'merge' : 'snapshot')
      return Promise.resolve(json(prAnswer()))
    })
    // One resolver per `token()` call: the snapshot's, then the merge's.
    const tokenAsks: Array<(token: string) => void> = []
    const { timers } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: {
        // The pod fetches this over the gitcred tunnel, so it really is an await of its own.
        token: () => new Promise<string>((resolve) => tokenAsks.push(resolve)),
        fetchImpl
      },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(tokenAsks).toHaveLength(1))
    tokenAsks[0]!('ghs_snapshot')
    // Readiness passed, so the tick is now parked on the SECOND token — the merge's.
    await vi.waitFor(() => expect(tokenAsks).toHaveLength(2))
    expect(calls).toEqual(['snapshot'])

    loop.stop()
    tokenAsks[1]!('ghs_merge')
    await loop.settle()

    expect(calls).toEqual(['snapshot'])
    expect(loop.current().merged).toBe(false)
  })

  it('does not stack ticks behind a slow GitHub', async () => {
    let release: ((value: Response) => void) | undefined
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    const { timers, fire } = fakeTimers()
    const loop = new AutoMergeLoop({
      access: { token: async () => 'ghs_x', fetchImpl },
      repoFullName: 'acme/repo',
      prNumber: 7,
      timers
    })

    loop.start()
    await vi.waitFor(() => expect(release).toBeDefined())
    fire()
    fire()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    release!(json(prAnswer([{ __typename: 'CheckRun', name: 'x', status: 'QUEUED', conclusion: null }])))
  })
})

/** A pod channel that records what the daemon forwarded, and holds its own armed set. */
function fakeSandbox(): AutoMergeSandbox & { ops: string[] } {
  const armed = new Set<string>()
  const key = (c: { repoFullName: string; prNumber: number }) => `${c.repoFullName}#${c.prNumber}`
  const ops: string[] = []
  return {
    ops,
    arm: async (c) => {
      ops.push(`arm ${key(c)} cap=${c.capability ?? 'none'}`)
      armed.add(key(c))
      return { armed: true, waitingOn: 'checks running: build' }
    },
    disarm: async (c) => {
      ops.push(`disarm ${key(c)}`)
      armed.delete(key(c))
      return { armed: false }
    },
    state: async (c) => {
      ops.push(`state ${key(c)}`)
      return armed.has(key(c)) ? { armed: true, waitingOn: 'checks running: build' } : { armed: false }
    },
    anyArmed: async () => {
      ops.push('list')
      return armed.size > 0
    }
  }
}

const TARGET = { agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 }

describe('AutoMergeWatcher', () => {
  it('routes a SANDBOX agent to its pod, carrying the credential capability', async () => {
    const sandbox = fakeSandbox()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => true,
      sandboxFor: () => sandbox,
      capabilityFor: () => 'cap_secret',
      tokenFor: async () => 'ghs_x'
    })

    expect(await watcher.set(TARGET, true)).toEqual({
      ...TARGET,
      armed: true,
      placement: 'sandbox',
      waitingOn: 'checks running: build'
    })
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true, placement: 'sandbox' })
    expect(sandbox.ops[0]).toBe('arm acme/repo#7 cap=cap_secret')

    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('runs the loop HERE for a local agent, and reports `daemon` placement', async () => {
    const github = githubStub([
      prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }])
    ])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false, // a daemon that runs no sandboxes at all
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap_secret',
      // The daemon's own clamped credential path is what a local loop polls with.
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })

    const armed = await watcher.set(TARGET, true)
    expect(armed).toMatchObject({ armed: true, placement: 'daemon' })
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true, placement: 'daemon' })

    // Disarming drops the entry, and the state read then answers a plain "not armed".
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('answers `armedFor` from the POD for a sandbox agent, and from its own map for a local one', async () => {
    // The sandbox keep-alive's question. Asked of the pod because that is where the armed set lives:
    // a daemon-side index would answer `false` after a restart while the pod was still merging.
    const sandbox = fakeSandbox()
    const cluster = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => true,
      sandboxFor: () => sandbox,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })
    expect(await cluster.armedFor('agent-1')).toBe(false)
    await cluster.set(TARGET, true)
    expect(await cluster.armedFor('agent-1')).toBe(true)
    expect(sandbox.ops).toContain('list')

    const github = githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])])
    const { timers } = fakeTimers()
    const local = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })
    expect(await local.armedFor('agent-1')).toBe(false)
    await local.set(TARGET, true)
    expect(await local.armedFor('agent-1')).toBe(true)
    // Keyed per agent: another agent's armed watcher is not this one's reason to hold a pod.
    expect(await local.armedFor('agent-2')).toBe(false)
  })

  it('refuses an agent this daemon does not hold, with the machine reason the CP maps to a status', async () => {
    const watcher = new AutoMergeWatcher({
      knownAgent: () => false,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({ reason: 'unknown-agent' })
    await expect(watcher.state(TARGET)).rejects.toBeInstanceOf(AutoMergeViolationError)
  })

  it('refuses to arm a cluster agent whose sandbox is asleep, rather than starting a loop elsewhere', async () => {
    // The split-brain this predicate exists to prevent: `sandboxFor` answers on ATTACHMENT, and a
    // suspended sandbox is an ordinary state. Arming a daemon-local loop here would leave it polling
    // — and merging — where the next `state`/`disarm` (taken once the pod attaches) could not see it.
    const github = githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])])
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => true,
      sandboxFor: () => undefined, // cluster-placed, but its pod is not up
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({ reason: 'sandbox-asleep' })
    // And the reads agree: nothing is watching, which is the truth for a pod that is down.
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.armedFor('agent-1')).toBe(false)
  })

  it('refuses to arm a pull request that is mergeable NOW — one click must not squash-merge', async () => {
    // The loop's first tick is immediate, so arming a green pull request would merge it inside one
    // round trip. The direct Merge button is that action, and it takes two presses.
    const github = githubStub([prAnswer()])
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({ reason: 'already-mergeable' })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('arms anyway when the pre-arm probe cannot reach GitHub — an unreachable GitHub is not unarmable', async () => {
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => {
        throw new Error('no gh credentials')
      },
      timers
    })

    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true, placement: 'daemon' })
  })

  it('clamps a long GitHub message — an over-long reply would fail the CP’s strict decode', async () => {
    // The OAuth-App-access-restriction message is ~350 chars, and `AutoMergeState` bounds these at 300.
    // Unclamped, the whole REP is rejected: a 503 on the arm and `null` on every read after, over a
    // watcher that is armed and merging.
    const long = 'x'.repeat(400)
    const github = githubStub([
      prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }]),
      { data: null, errors: [{ message: long }] }
    ])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })

    await watcher.set(TARGET, true)
    await vi.waitFor(async () => {
      const state = await watcher.state(TARGET)
      expect(state.lastError?.length).toBe(MAX_AUTO_MERGE_DETAIL)
    })
  })

  it('answers a local disarm only after the tick in flight has settled, and never merges behind it', async () => {
    let release: ((value: Response) => void) | undefined
    const calls: string[] = []
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      const body = String(init?.body)
      calls.push(body.includes('mergePullRequest') ? 'merge' : 'snapshot')
      // The pre-arm probe answers at once (not ready); only the LOOP's snapshot is held open.
      if (calls.length === 1) {
        return Promise.resolve(
          json(prAnswer([{ __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null }]))
        )
      }
      return new Promise<Response>((resolve) => (release = resolve))
    })
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap_secret',
      tokenFor: async () => 'ghs_x',
      fetchImpl,
      timers
    })

    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true, placement: 'daemon' })
    await vi.waitFor(() => expect(release).toBeDefined())

    // Disarm while that snapshot is open, and let it come back GREEN — the tick would merge.
    const answered = watcher.set(TARGET, false)
    release!(json(prAnswer()))
    expect(await answered).toEqual({ ...TARGET, armed: false })
    expect(calls).toEqual(['snapshot', 'snapshot'])
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('drops a CLOSED local entry, so the pull request can be armed again if it reopens', async () => {
    const closedPr = (state: 'CLOSED' | 'OPEN') => ({
      data: {
        repository: {
          pullRequest: {
            id: 'PR_1',
            headRefOid: 'sha_head',
            state,
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: null,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null }] }
                    }
                  }
                }
              ]
            }
          }
        }
      }
    })
    // pre-arm probe (open, checks running) → loop tick (closed) → pre-arm probe again → loop tick.
    const github = githubStub([closedPr('OPEN'), closedPr('CLOSED'), closedPr('OPEN'), closedPr('OPEN')])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap_secret',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })

    await watcher.set(TARGET, true)
    // The closed tick is terminal: the entry goes, not just its timer.
    await vi.waitFor(async () => expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false }))
    expect(await watcher.armedFor(TARGET.agentId)).toBe(false)

    // Reopened: arming must build a NEW loop rather than hand back the stale stopped one forever.
    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true, placement: 'daemon' })
  })

  it('reports nothing armed after stop() — the restart the console projects as an unchecked box', async () => {
    const github = githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => false,
      sandboxFor: () => undefined,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers,
      log: { info: () => {}, warn: () => {} }
    })
    await watcher.set(TARGET, true)
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true })

    watcher.stop()
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })
})

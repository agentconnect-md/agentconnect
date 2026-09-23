// The armed set at the edge: the loop's lifetime, and the watcher's placement dispatch. Nothing here
// touches a disk, because nothing about merge-when-ready is persisted — a restart forgetting the
// intent IS the contract, and these tests pin the behaviour that projects it honestly.
import { MAX_AUTO_MERGE_DETAIL } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { AutoMergeLoop } from '../src/github/auto-merge/loop.js'
import { AutoMergeViolationError, AutoMergeWatcher, type AutoMergeSandbox } from '../src/github/auto-merge/watcher.js'
import { ShimAutoMergeClient, askArmed } from '../src/shim/auto-merge-client.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import type { ShimConnection } from '../src/shim/connection.js'
import { ShimSession } from '../src/shim/session.js'

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
function fakeSandbox(): AutoMergeSandbox & { ops: string[]; armed: Set<string> } {
  const armed = new Set<string>()
  const key = (c: { repoFullName: string; prNumber: number }) => `${c.repoFullName}#${c.prNumber}`
  const ops: string[] = []
  const state = (c: { repoFullName: string; prNumber: number }) =>
    armed.has(key(c)) ? { armed: true, waitingOn: 'checks running: build' } : { armed: false }
  return {
    ops,
    armed,
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
      return state(c)
    },
    watching: async (c) => {
      ops.push(`watching ${key(c)}`)
      return state(c)
    }
  }
}

const TARGET = { agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 }
const AGENT_POD = 'agent-1'
const SESSION_POD = 'agent-1/session-aaa'
const SIBLING_POD = 'agent-1/session-bbb'

/** The cluster seams over a fixed set of bound pods; an isolated session's arm is placed in the pod its id names. */
function inPods(pods: Record<string, AutoMergeSandbox | undefined>, placement: Record<string, string> = {}) {
  return {
    clusterPlaced: () => true,
    podsOf: () => Object.keys(pods),
    sandboxAt: async (subject: string) => pods[subject],
    placementOf: async (agentId: string, sessionId?: string) =>
      (sessionId === undefined ? undefined : placement[sessionId]) ?? agentId
  }
}

/** No pods at all: a daemon that runs no sandboxes. */
const LOCAL = {
  clusterPlaced: () => false,
  podsOf: () => [],
  sandboxAt: async () => undefined,
  placementOf: async (agentId: string) => agentId
}

const QUEUED = () => githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])]).fetchImpl

describe('AutoMergeWatcher', () => {
  it('routes a SANDBOX agent to its pod, carrying the credential capability', async () => {
    const sandbox = fakeSandbox()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: sandbox }),
      capabilityFor: () => 'cap_secret',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    expect(await watcher.set(TARGET, true)).toEqual({
      ...TARGET,
      armed: true,
      placement: 'sandbox',
      waitingOn: 'checks running: build'
    })
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true, placement: 'sandbox' })
    expect(sandbox.ops).toContain('arm acme/repo#7 cap=cap_secret')

    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('watches an isolated session’s arm in that session’s pod, leaving the agent pod untouched', async () => {
    const agentPod = fakeSandbox()
    const sessionPod = fakeSandbox()
    const held: string[] = []
    const renewed: string[] = []
    const placedFor: Array<string | undefined> = []
    const pods = inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: sessionPod }, { 'session-1': SESSION_POD })
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...pods,
      placementOf: async (agentId, sessionId) => {
        placedFor.push(sessionId)
        return await pods.placementOf(agentId, sessionId)
      },
      holdSandbox: (subject) => {
        held.push(subject)
        return () => {}
      },
      onArmed: (subject) => renewed.push(subject),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    expect(await watcher.set(TARGET, true, 'session-1')).toMatchObject({ armed: true, placement: 'sandbox' })
    expect(placedFor).toEqual(['session-1'])
    expect(sessionPod.ops).toContain('arm acme/repo#7 cap=cap')
    // The agent pod was only asked whether it already watches this pull request.
    expect(agentPod.ops).toEqual(['watching acme/repo#7'])
    // The sweep's hold is taken and renewed on the pod that runs the watcher.
    expect(held).toEqual([SESSION_POD])
    expect(renewed).toEqual([SESSION_POD])
  })

  it('arms a shared session, and an arm naming no session, in the agent pod', async () => {
    const agentPod = fakeSandbox()
    const sessionPod = fakeSandbox()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      // A shared session's tier places it with the agent, whatever pod is bound beside it.
      ...inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: sessionPod }, { 'shared-session': AGENT_POD }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: githubStub([
        prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }]),
        prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])
      ]).fetchImpl
    })

    await watcher.set(TARGET, true, 'shared-session')
    await watcher.set({ ...TARGET, prNumber: 8 }, true)
    expect(agentPod.ops.filter((op) => op.startsWith('arm'))).toEqual([
      'arm acme/repo#7 cap=cap',
      'arm acme/repo#8 cap=cap'
    ])
    expect(sessionPod.ops.filter((op) => op.startsWith('arm'))).toEqual([])
  })

  it('reads and disarms a watcher wherever it lives, asking every bound pod', async () => {
    const agentPod = fakeSandbox()
    const sessionPod = fakeSandbox()
    sessionPod.armed.add('acme/repo#7')
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: sessionPod }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })

    // Found in the session pod although the read named no session.
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true, placement: 'sandbox' })
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(sessionPod.ops).toContain('disarm acme/repo#7')
    expect(agentPod.ops).toContain('disarm acme/repo#7')
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('answers the watcher another pod already runs, starting nothing where the new arm would place it', async () => {
    const opener = fakeSandbox()
    const reviewer = fakeSandbox()
    opener.armed.add('acme/repo#7')
    const renewed: string[] = []
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods(
        { [AGENT_POD]: fakeSandbox(), [SESSION_POD]: opener, [SIBLING_POD]: reviewer },
        {
          opener: SESSION_POD,
          reviewer: SIBLING_POD
        }
      ),
      onArmed: (subject) => renewed.push(subject),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    expect(await watcher.set(TARGET, true, 'reviewer')).toMatchObject({ armed: true, placement: 'sandbox' })
    expect(reviewer.ops.filter((op) => op.startsWith('arm'))).toEqual([])
    expect(opener.ops.filter((op) => op.startsWith('arm'))).toEqual([])
    // Still the sweep's reason to keep the pod that runs it.
    expect(renewed).toEqual([SESSION_POD])
  })

  it('starts ONE watcher when two sessions arm the same pull request at once', async () => {
    // Both would find nothing if their scans overlapped; the per-pull-request queue makes the second scan see the first arm.
    const first = fakeSandbox()
    const second = fakeSandbox()
    let probes = 0
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => (open = resolve))
    const fetchImpl = vi.fn(async () => {
      probes += 1
      await opened
      return json(prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }]))
    })
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods(
        { [AGENT_POD]: fakeSandbox(), [SESSION_POD]: first, [SIBLING_POD]: second },
        {
          a: SESSION_POD,
          b: SIBLING_POD
        }
      ),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl
    })

    const one = watcher.set(TARGET, true, 'a')
    const two = watcher.set(TARGET, true, 'b')
    await vi.waitFor(() => expect(probes).toBe(1))
    // Time for an unqueued second arm to reach its own probe, which is the race this pins.
    await new Promise((resolve) => setTimeout(resolve, 20))
    open()
    expect(await one).toMatchObject({ armed: true })
    expect(await two).toMatchObject({ armed: true, placement: 'sandbox' })
    const arms = [...first.ops, ...second.ops].filter((op) => op.startsWith('arm'))
    expect(arms).toEqual(['arm acme/repo#7 cap=cap'])
    expect(first.ops).toContain('arm acme/repo#7 cap=cap')
    // The second arm never reached the pre-arm probe: its scan answered first.
    expect(probes).toBe(1)
  })

  it('asks a pod again when a renewal loses the scan, and refuses the arm when it loses it twice', async () => {
    const lost = () => new ShimChannelLostError('shim channel renewed')
    const agentPod = fakeSandbox()
    const sessionPod = fakeSandbox()
    let losses = 1
    const watching = sessionPod.watching
    sessionPod.watching = async (c) => {
      if (losses-- > 0) throw lost()
      return await watching(c)
    }
    sessionPod.armed.add('acme/repo#7')
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: sessionPod }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    // One loss: asked again on the re-attached channel, which answers that it watches already.
    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true })
    expect(agentPod.ops.filter((op) => op.startsWith('arm'))).toEqual([])

    // Two: unknown, so nothing is armed anywhere rather than a second watcher beside a live one.
    losses = 2
    await expect(watcher.set(TARGET, true)).rejects.toBeInstanceOf(ShimChannelLostError)
    expect(agentPod.ops.filter((op) => op.startsWith('arm'))).toEqual([])
  })

  it('answers a disarm only once every pod has disarmed, and never `armed:false` over a pod that failed', async () => {
    const agentPod = fakeSandbox()
    const sessionPod = fakeSandbox()
    sessionPod.armed.add('acme/repo#7')
    let exited: (() => void) | undefined
    const disarm = sessionPod.disarm
    // The pod's disarm waits for its watcher child to exit, which fences the tick in flight.
    sessionPod.disarm = async (c) => {
      await new Promise<void>((resolve) => (exited = resolve))
      return await disarm(c)
    }
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: sessionPod }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })

    let answered = false
    const off = watcher.set(TARGET, false).then((state) => {
      answered = true
      return state
    })
    await vi.waitFor(() => expect(exited).toBeDefined())
    await vi.waitFor(() => expect(agentPod.ops).toContain('disarm acme/repo#7'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(answered).toBe(false)
    exited!()
    expect(await off).toEqual({ ...TARGET, armed: false })

    sessionPod.disarm = async () => {
      throw new Error('shim timed out')
    }
    await expect(watcher.set(TARGET, false)).rejects.toThrow(/timed out/)
  })

  it('skips a pod whose image ships no watcher, and leaves a read unknown when a pod cannot answer', async () => {
    const unsupported = () => {
      throw new AutoMergeViolationError('unsupported-image', 'no watcher in this image')
    }
    const agentPod = fakeSandbox()
    const oldPod: AutoMergeSandbox = {
      arm: async () => unsupported(),
      disarm: async () => unsupported(),
      state: async () => unsupported(),
      watching: async () => unsupported()
    }
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: agentPod, [SESSION_POD]: oldPod }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true })
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })

    const broken: AutoMergeSandbox = { ...oldPod, state: async () => Promise.reject(new Error('shim timed out')) }
    const unsure = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: fakeSandbox(), [SESSION_POD]: broken }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })
    await expect(unsure.state(TARGET)).rejects.toThrow(/timed out/)
  })

  it('reads back unchecked once a retired session’s pod, and its watcher, are gone', async () => {
    const sessionPod = fakeSandbox()
    const pods: Record<string, AutoMergeSandbox | undefined> = { [AGENT_POD]: fakeSandbox(), [SESSION_POD]: sessionPod }
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods(pods, { 'session-1': SESSION_POD }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })
    await watcher.set(TARGET, true, 'session-1')
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true })

    // Retirement deletes the claim: the pod leaves this member's launches, its watcher with it.
    delete pods[SESSION_POD]
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
  })

  it('runs the loop HERE for a local agent, and reports `daemon` placement', async () => {
    const github = githubStub([
      prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }])
    ])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...LOCAL, // a daemon that runs no sandboxes at all
      capabilityFor: () => 'cap_secret',
      // The daemon's own clamped credential path is what a local loop polls with.
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })

    // A session names no pod here: the loop is this process's whatever armed it.
    const armed = await watcher.set(TARGET, true, 'session-1')
    expect(armed).toMatchObject({ armed: true, placement: 'daemon' })
    expect(await watcher.state(TARGET)).toMatchObject({ armed: true, placement: 'daemon' })

    // Disarming drops the entry, and the state read then answers a plain "not armed".
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
  })

  it('starts ONE local loop when two arms of the same pull request overlap', async () => {
    // The pre-arm probe is a round trip between the "already held?" check and the map write, so unserialized arms both passed it.
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => (open = resolve))
    const fetchImpl = vi.fn(async () => {
      await opened
      return json(prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }]))
    })
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...LOCAL,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl,
      timers
    })

    const one = watcher.set(TARGET, true)
    const two = watcher.set(TARGET, true)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    open()
    expect(await one).toMatchObject({ armed: true, placement: 'daemon' })
    expect(await two).toMatchObject({ armed: true, placement: 'daemon' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    // One probe and one tick: the second arm found the loop the first had started.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses an agent this daemon does not hold, with the machine reason the CP maps to a status', async () => {
    const watcher = new AutoMergeWatcher({
      knownAgent: () => false,
      ...LOCAL,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({ reason: 'unknown-agent' })
    await expect(watcher.state(TARGET)).rejects.toBeInstanceOf(AutoMergeViolationError)
  })

  it('refuses to arm a cluster agent whose pod is asleep, rather than starting a loop elsewhere', async () => {
    // Placement is a property of the daemon, not of attachment: a local loop started here would poll — and merge — where no later read of the pods could see it.
    const github = githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])])
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: undefined }, { 'session-1': SESSION_POD }),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({
      reason: 'sandbox-asleep',
      message: expect.stringContaining('agent’s sandbox')
    })
    // An isolated session's own pod asleep says so, whatever the agent's is doing.
    await expect(watcher.set(TARGET, true, 'session-1')).rejects.toMatchObject({
      reason: 'sandbox-asleep',
      message: expect.stringContaining('session’s sandbox')
    })
    // And the reads agree: nothing is watching, which is the truth for a pod that is down.
    expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false })
    expect(await watcher.set(TARGET, false)).toEqual({ ...TARGET, armed: false })
  })

  it('holds the pod across an arm and renews the idle sweep’s own hold before letting go', async () => {
    // The sweep asks the pod, then suspends in the tick it re-reads its holds: this order is what leaves no gap an arm can land in unseen.
    const sandbox = fakeSandbox()
    const events: string[] = []
    const arm = sandbox.arm
    sandbox.arm = async (call) => {
      events.push('sent')
      return await arm(call)
    }
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: sandbox }),
      holdSandbox: (subject) => {
        events.push(`held ${subject}`)
        return () => events.push('released')
      },
      onArmed: (subject) => events.push(`renewed ${subject}`),
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    await watcher.set(TARGET, true)
    expect(events).toEqual(['held agent-1', 'sent', 'renewed agent-1', 'released'])

    // A failed arm renews nothing and still lets go.
    events.length = 0
    sandbox.arm = async () => {
      throw new Error('the shim went away')
    }
    await expect(watcher.set({ ...TARGET, prNumber: 8 }, true)).rejects.toThrow(/went away/)
    expect(events).toEqual(['held agent-1', 'released'])
  })

  it('refuses to arm a pod the idle sweep is already suspending, sending nothing', async () => {
    // Its channel is still attached until the suspend write lands; a watcher started now would die with it behind a checked box.
    const sandbox = fakeSandbox()
    const onArmed = vi.fn()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...inPods({ [AGENT_POD]: sandbox }),
      holdSandbox: () => undefined,
      onArmed,
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x',
      fetchImpl: QUEUED()
    })

    await expect(watcher.set(TARGET, true)).rejects.toMatchObject({ reason: 'sandbox-asleep' })
    expect(sandbox.ops.filter((op) => op.startsWith('arm'))).toEqual([])
    expect(onArmed).not.toHaveBeenCalled()
  })

  it('refuses to arm a pull request that is mergeable NOW — one click must not squash-merge', async () => {
    // The loop's first tick is immediate, so arming a green pull request would merge it inside one
    // round trip. The direct Merge button is that action, and it takes two presses.
    const github = githubStub([prAnswer()])
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...LOCAL,
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
      ...LOCAL,
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
      ...LOCAL,
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
      ...LOCAL,
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
      ...LOCAL,
      capabilityFor: () => 'cap_secret',
      tokenFor: async () => 'ghs_x',
      fetchImpl: github.fetchImpl,
      timers
    })

    await watcher.set(TARGET, true)
    // The closed tick is terminal: the entry goes, not just its timer.
    await vi.waitFor(async () => expect(await watcher.state(TARGET)).toEqual({ ...TARGET, armed: false }))

    // Reopened: arming must build a NEW loop rather than hand back the stale stopped one forever.
    expect(await watcher.set(TARGET, true)).toMatchObject({ armed: true, placement: 'daemon' })
  })

  it('reports nothing armed after stop() — the restart the console projects as an unchecked box', async () => {
    const github = githubStub([prAnswer([{ __typename: 'CheckRun', name: 'build', status: 'QUEUED' }])])
    const { timers } = fakeTimers()
    const watcher = new AutoMergeWatcher({
      knownAgent: () => true,
      ...LOCAL,
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

describe('asking a pod whether anything is armed, across a channel renewal', () => {
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout)
  }

  /** A pod connection at the session's generation that answers every request with `armed`, or never answers when it is undefined. */
  function podConnection(armed?: boolean) {
    const listeners: Array<(text: string) => void> = []
    const sent: string[] = []
    const connection = {
      binding: {
        agentId: 'agent-1',
        sandboxUid: 'sb-1',
        generation: 3,
        grants: ['automerge'],
        podName: 'p',
        podUid: 'u',
        expiresAtMs: Number.MAX_SAFE_INTEGER
      },
      issuedCredential: `cred-${Math.random()}`,
      send: (frame: { type: string; id: string }) => {
        if (frame.type !== 'shim/request') return
        sent.push(frame.id)
        if (armed === undefined) return
        const reply = JSON.stringify({ type: 'shim/response', id: frame.id, ok: true, payload: { armed } })
        queueMicrotask(() => listeners.forEach((listener) => listener(reply)))
      },
      onFrame: (listener: (text: string) => void) => listeners.push(listener),
      close: () => {}
    } as unknown as ShimConnection
    return { connection, sent }
  }

  it('asks the renewed channel again rather than reading a lost request as "nothing armed"', async () => {
    // A routine same-generation rebind fails the requests in flight and keeps the session; the watcher it asked about is untouched.
    const session = new ShimSession('agent-1', 3, timers)
    const first = podConnection()
    session.attach(first.connection)
    const asking = askArmed(async () => session, 'agent-1')
    const state = new ShimAutoMergeClient(session).state({ agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 })
    await vi.waitFor(() => expect(first.sent).toHaveLength(2))

    session.attach(podConnection(true).connection)
    await expect(asking).resolves.toBe(true)
    // The box's own reads keep their answer: a lost channel there is a pod that went away.
    await expect(state).resolves.toEqual({ armed: false })
  })

  it('reports a channel lost on the retry too as unknown, never as nothing armed', async () => {
    const session = new ShimSession('agent-1', 3, timers)
    const first = podConnection()
    session.attach(first.connection)
    const asking = askArmed(async () => session, 'agent-1')
    await vi.waitFor(() => expect(first.sent).toHaveLength(1))
    const second = podConnection()
    session.attach(second.connection)
    await vi.waitFor(() => expect(second.sent).toHaveLength(1))

    session.attach(podConnection(true).connection)
    await expect(asking).rejects.toBeInstanceOf(ShimChannelLostError)
  })

  it('answers false for a pod with no channel at all, as before', async () => {
    expect(await askArmed(async () => undefined, 'agent-1')).toBe(false)
  })

  /** A pod connection that records each request's op and answers with `answer`, or never answers when it is undefined. */
  function recordingConnection(answer?: Record<string, unknown>) {
    const listeners: Array<(text: string) => void> = []
    const ops: string[] = []
    const connection = {
      binding: {
        agentId: 'agent-1',
        sandboxUid: 'sb-1',
        generation: 3,
        grants: ['automerge'],
        podName: 'p',
        podUid: 'u',
        expiresAtMs: Number.MAX_SAFE_INTEGER
      },
      issuedCredential: `cred-${Math.random()}`,
      send: (frame: { type: string; id: string; payload?: { op?: string } }) => {
        if (frame.type !== 'shim/request') return
        ops.push(String(frame.payload?.op))
        if (answer === undefined) return
        const reply = JSON.stringify({ type: 'shim/response', id: frame.id, ok: true, payload: answer })
        queueMicrotask(() => listeners.forEach((listener) => listener(reply)))
      },
      onFrame: (listener: (text: string) => void) => listeners.push(listener),
      close: () => {}
    } as unknown as ShimConnection
    return { connection, ops }
  }

  /** A watcher over ONE session pod whose channel is the real session, as the plane hands it out. */
  function watcherOver(session: ShimSession) {
    return new AutoMergeWatcher({
      knownAgent: () => true,
      clusterPlaced: () => true,
      podsOf: () => ['agent-1/session-aaa'],
      sandboxAt: async () => new ShimAutoMergeClient(session),
      placementOf: async () => 'agent-1/session-aaa',
      capabilityFor: () => 'cap',
      tokenFor: async () => 'ghs_x'
    })
  }

  it('asks a disarm again on the channel a rebind re-attached, so the watcher really stops', async () => {
    // A same-generation rebind fails the request in flight while the pod's registry and its watcher live on.
    const session = new ShimSession('agent-1', 3, timers)
    const first = recordingConnection()
    session.attach(first.connection)
    const off = watcherOver(session).set(TARGET, false)
    await vi.waitFor(() => expect(first.ops).toEqual(['disarm']))

    const second = recordingConnection({ armed: false })
    session.attach(second.connection)
    expect(await off).toEqual({ ...TARGET, armed: false })
    expect(second.ops).toEqual(['disarm'])
  })

  it('fails a disarm lost twice rather than report the box off over a watcher that may still tick', async () => {
    const session = new ShimSession('agent-1', 3, timers)
    const first = recordingConnection()
    session.attach(first.connection)
    let answer: unknown
    const off = watcherOver(session)
      .set(TARGET, false)
      .then(
        (state) => (answer = state),
        (err: unknown) => (answer = err)
      )
    await vi.waitFor(() => expect(first.ops).toEqual(['disarm']))
    const second = recordingConnection()
    session.attach(second.connection)
    await vi.waitFor(() => expect(second.ops).toEqual(['disarm']))

    session.attach(recordingConnection({ armed: false }).connection)
    await off
    expect(answer).toBeInstanceOf(ShimChannelLostError)
  })

  it('lets an arm’s scan see the lost channel that the box’s own read answers as nothing armed', async () => {
    const session = new ShimSession('agent-1', 3, timers)
    const first = podConnection()
    session.attach(first.connection)
    const client = new ShimAutoMergeClient(session)
    const call = { agentId: 'agent-1', repoFullName: 'acme/repo', prNumber: 7 }
    const scan = client.watching(call)
    const read = client.state(call)
    await vi.waitFor(() => expect(first.sent).toHaveLength(2))

    session.attach(podConnection(true).connection)
    await expect(scan).rejects.toBeInstanceOf(ShimChannelLostError)
    await expect(read).resolves.toEqual({ armed: false })
  })
})

// The keep-alive decision and the lease behind it: what an open console page may hold a pod for, and
// how that hold ends. Nothing here persists — the page closing IS the release, and these tests pin the
// two halves of that: what renews, and what lapses. Since §11 they also pin WHICH pod each answer is
// about: a page watching an isolated session watches that session's own pod, not "any pod of the agent".
import { describe, expect, it, vi } from 'vitest'
import { createSandboxKeepAlive, type SandboxKeepAliveDepsInternal } from '../src/cp/sandbox-keepalive.js'
import { SANDBOX_HOLD_TTL_MS, SandboxHolds } from '../src/k8s/sandbox-hold.js'

const AGENT_POD = 'agent-1'
const SESSION_POD = 'agent-1/session-abc'

interface Overrides {
  /** Pods that are bound right now; a pod not listed is asleep and holds nothing. */
  bound: string[]
  /** The pod this page's worktree lives on, as the routing resolves it. */
  podOf: (agentId: string, sessionId?: string) => string
  knownAgent: boolean
  armed: boolean | Error
  status: { isRepo?: boolean; clean?: boolean } | Error
  statusOf: (agentId: string, sessionId?: string) => { isRepo?: boolean; clean?: boolean }
}

function build(overrides: Partial<Overrides> = {}) {
  let now = 1_000
  const holds = new SandboxHolds({ now: () => now })
  // What the pod-hold seam saw: taken before the status read, released after it, in order.
  const heldDuring: string[] = []
  const released: string[] = []
  const bound = new Set(overrides.bound ?? [AGENT_POD, SESSION_POD])
  const gitStatus = vi.fn(async (agentId: string, sessionId?: string) => {
    if (overrides.status instanceof Error) throw overrides.status
    return overrides.statusOf?.(agentId, sessionId) ?? overrides.status ?? { isRepo: true, clean: true }
  })
  const deps: SandboxKeepAliveDepsInternal = {
    podFor: async (agentId, sessionId) => overrides.podOf?.(agentId, sessionId) ?? AGENT_POD,
    agentPod: (agentId) => agentId,
    holdIfBound: (subject) => {
      if (!bound.has(subject)) return undefined
      heldDuring.push(subject)
      return () => released.push(subject)
    },
    knownAgent: () => overrides.knownAgent ?? true,
    armedFor: async () => {
      if (overrides.armed instanceof Error) throw overrides.armed
      return overrides.armed === true
    },
    gitStatus,
    holds
  }
  return {
    keepAlive: createSandboxKeepAlive(deps),
    deps,
    holds,
    gitStatus,
    heldDuring,
    released,
    advance: (ms: number) => (now += ms)
  }
}

const REQ = { agentId: 'agent-1', sessionId: 'session-1' }

describe('sandbox keep-alive', () => {
  it('holds an uncommitted tree, and names the reason', async () => {
    const { keepAlive, holds } = build({ status: { isRepo: true, clean: false } })

    expect(await keepAlive(REQ)).toEqual({
      agentId: 'agent-1',
      held: true,
      reasons: ['uncommitted-files'],
      ttlMs: SANDBOX_HOLD_TTL_MS,
      placement: 'sandbox'
    })
    expect(holds.holds('agent-1')).toBe(true)
  })

  it('holds an armed merge-when-ready watcher even on a clean tree — the watcher lives in that pod', async () => {
    const { keepAlive, holds } = build({ armed: true })

    expect(await keepAlive(REQ)).toMatchObject({ held: true, reasons: ['auto-merge-armed'] })
    expect(holds.reasons('agent-1')).toEqual(['auto-merge-armed'])
  })

  it('reports both reasons when both apply', async () => {
    const { keepAlive } = build({ armed: true, status: { isRepo: true, clean: false } })
    expect((await keepAlive(REQ)).reasons).toEqual(['auto-merge-armed', 'uncommitted-files'])
  })

  it('RELEASES on a clean tree with nothing armed, rather than letting a stale hold lapse', async () => {
    const first = build({ status: { isRepo: true, clean: false } })
    await first.keepAlive(REQ)
    expect(first.holds.holds('agent-1')).toBe(true)

    // The next poll finds the work committed: the pod becomes suspendable on the sweep's own schedule,
    // not one TTL later because of the hold the previous poll took.
    const clean = createSandboxKeepAlive({ ...first.deps, gitStatus: async () => ({ isRepo: true, clean: true }) })
    expect(await clean(REQ)).toMatchObject({ held: false, reasons: [] })
    expect(first.holds.holds('agent-1')).toBe(false)
  })

  it('holds nothing for a workspace that is not a checkout', async () => {
    const { keepAlive } = build({ status: { isRepo: false } })
    expect(await keepAlive(REQ)).toMatchObject({ held: false, reasons: [] })
  })

  it('never wakes an already-suspended pod, and says so', async () => {
    const { keepAlive, gitStatus } = build({ bound: [], status: { isRepo: true, clean: false } })

    expect(await keepAlive(REQ)).toEqual({
      agentId: 'agent-1',
      held: false,
      reasons: [],
      placement: 'sandbox',
      asleep: true
    })
    // Not even a status read: there is nothing to read in a pod that is down, and reading would wake it.
    expect(gitStatus).not.toHaveBeenCalled()
  })

  it('holds nothing for an agent this daemon does not hold', async () => {
    const { keepAlive } = build({ knownAgent: false, status: { isRepo: true, clean: false } })
    expect(await keepAlive(REQ)).toEqual({ agentId: 'agent-1', held: false, reasons: [] })
  })

  it('keeps the other reason when one of the two reads fails', async () => {
    const statusFailed = build({ armed: true, status: new Error('sandbox unavailable') })
    expect(await statusFailed.keepAlive(REQ)).toMatchObject({ held: true, reasons: ['auto-merge-armed'] })

    const armedFailed = build({ armed: new Error('channel lost'), status: { isRepo: true, clean: false } })
    expect(await armedFailed.keepAlive(REQ)).toMatchObject({ held: true, reasons: ['uncommitted-files'] })
  })

  it('lapses one TTL after the last renewal — the page closing is the whole release mechanism', async () => {
    const { keepAlive, holds, advance } = build({ status: { isRepo: true, clean: false } })
    await keepAlive(REQ)

    advance(SANDBOX_HOLD_TTL_MS - 1)
    expect(holds.holds('agent-1')).toBe(true) // still renewable, still held
    advance(2)
    expect(holds.holds('agent-1')).toBe(false)
    expect(holds.reasons('agent-1')).toEqual([])
  })

  it('a renewal is a fresh deadline, and replaces the reasons it was taken for', async () => {
    const { keepAlive, deps, holds, advance } = build({ armed: true, status: { isRepo: true, clean: false } })
    await keepAlive(REQ)
    advance(SANDBOX_HOLD_TTL_MS - 1_000)

    const armedOnly = createSandboxKeepAlive({ ...deps, gitStatus: async () => ({ isRepo: true, clean: true }) })
    await armedOnly(REQ)
    advance(2_000) // past the FIRST deadline
    expect(holds.holds('agent-1')).toBe(true)
    // The committed tree stops being reported: reasons describe what the last poll saw, not a union.
    expect(holds.reasons('agent-1')).toEqual(['auto-merge-armed'])
  })

  it('a clean session page does not release the pod another session page is holding dirty', async () => {
    // Two console pages, one agent, two worktrees on ONE pod. The lease is keyed by the page's session,
    // so the clean one releasing its own lease must not suspend the pod out from under the dirty one.
    const { keepAlive, holds, advance } = build({
      statusOf: (_agentId, sessionId) => ({ isRepo: true, clean: sessionId !== 'dirty-session' })
    })

    expect(await keepAlive({ agentId: 'agent-1', sessionId: 'dirty-session' })).toMatchObject({
      held: true,
      reasons: ['uncommitted-files']
    })
    // The clean page answers for ITSELF — `held:false` is true of its session and claims no lease.
    expect(await keepAlive({ agentId: 'agent-1', sessionId: 'clean-session' })).toMatchObject({ held: false })

    expect(holds.holds('agent-1')).toBe(true)
    expect(holds.reasons('agent-1')).toEqual(['uncommitted-files'])

    // …and the dirty page's own lease still lapses on its own schedule once it stops polling.
    advance(SANDBOX_HOLD_TTL_MS + 1)
    expect(holds.holds('agent-1')).toBe(false)
  })

  it('an asleep pod drops EVERY page’s lease, not just the polling one’s', async () => {
    const { keepAlive, holds } = build({ bound: [] })
    holds.renew('agent-1', 'other-session', ['uncommitted-files'])

    expect(await keepAlive(REQ)).toMatchObject({ held: false, asleep: true })
    // The volume those leases were taken on is gone with the pod; none of them survives it.
    expect(holds.holds('agent-1')).toBe(false)
  })

  it('unions the reasons across live pages, deduped', async () => {
    const holds = new SandboxHolds({ now: () => 1_000 })
    holds.renew('agent-1', 'session-a', ['uncommitted-files'])
    holds.renew('agent-1', 'session-b', ['uncommitted-files', 'auto-merge-armed'])

    expect(holds.reasons('agent-1')).toEqual(['uncommitted-files', 'auto-merge-armed'])
    holds.release('agent-1', 'session-b')
    expect(holds.reasons('agent-1')).toEqual(['uncommitted-files'])
    holds.release('agent-1', 'session-a')
    expect(holds.holds('agent-1')).toBe(false)
  })

  describe('one pod per session (git-workspace-model §11)', () => {
    it('neither reads nor wakes an idle-suspended session pod, however up the agent pod is', async () => {
      // The bug this pins: "any pod of the agent is up" let a bound agent pod carry a session page's
      // poll into a status read, which the routed runner then served by WAKING that session's pod —
      // a visible clean page undoing the idle sweep every 60 seconds.
      const { keepAlive, holds, gitStatus } = build({
        bound: [AGENT_POD],
        podOf: () => SESSION_POD,
        armed: true,
        status: { isRepo: true, clean: false }
      })

      expect(await keepAlive(REQ)).toEqual({
        agentId: 'agent-1',
        held: false,
        reasons: [],
        placement: 'sandbox',
        asleep: true
      })
      expect(gitStatus).not.toHaveBeenCalled()
      expect(holds.holds(SESSION_POD)).toBe(false)
      // Nor does the page keep a lease on the agent's pod for a worktree it can no longer see.
      expect(holds.holds(AGENT_POD)).toBe(false)
    })

    it('holds the pod the dirty tree is ON, never the agent pod or a sibling session pod', async () => {
      // An agent-keyed lease made one dirty session page pin every running session pod of the agent,
      // because the sweep judged each of them on the same key.
      const sibling = 'agent-1/session-xyz'
      const { keepAlive, holds } = build({
        bound: [AGENT_POD, SESSION_POD, sibling],
        podOf: () => SESSION_POD,
        status: { isRepo: true, clean: false }
      })

      expect(await keepAlive(REQ)).toMatchObject({ held: true, reasons: ['uncommitted-files'] })
      expect(holds.holds(SESSION_POD)).toBe(true)
      expect(holds.holds(AGENT_POD)).toBe(false)
      expect(holds.holds(sibling)).toBe(false)
    })

    it('an armed watcher holds the AGENT pod while the dirty tree holds this page’s session pod', async () => {
      // The two facts are about two pods: the watcher is a process in the agent's own pod, the edits
      // are on the session volume. One poll reports both and leases each where it belongs.
      const { keepAlive, holds } = build({
        podOf: () => SESSION_POD,
        armed: true,
        status: { isRepo: true, clean: false }
      })

      expect(await keepAlive(REQ)).toMatchObject({
        held: true,
        reasons: ['auto-merge-armed', 'uncommitted-files']
      })
      expect(holds.reasons(AGENT_POD)).toEqual(['auto-merge-armed'])
      expect(holds.reasons(SESSION_POD)).toEqual(['uncommitted-files'])
    })

    it('holds the pod ACROSS the status read, so the sweep cannot suspend it underneath one', async () => {
      // Checking "bound" and then awaiting the read would leave the window the finding is about: the
      // sweep suspends in between and the routed runner wakes the pod to answer after all. The hold is
      // the idle gate's own, read synchronously by `suspendIfIdle`, so this excludes it rather than
      // narrowing it.
      const state = build({ podOf: () => SESSION_POD, status: { isRepo: true, clean: true } })
      // Recorded rather than asserted in place: the keep-alive treats a failing status read as no
      // evidence, so an expectation thrown inside it would be swallowed and the case would pass blind.
      const during: Array<{ held: string[]; released: string[] }> = []
      state.gitStatus.mockImplementation(async () => {
        during.push({ held: [...state.heldDuring], released: [...state.released] })
        return { isRepo: true, clean: true }
      })

      await state.keepAlive(REQ)
      expect(during).toEqual([{ held: [SESSION_POD], released: [] }])
      // And handed back once the read is done — a keep-alive defers a suspend, it does not cancel one.
      expect(state.released).toEqual([SESSION_POD])
    })

    it('releases the pod even when the status read throws', async () => {
      const state = build({ podOf: () => SESSION_POD, status: new Error('channel lost') })
      await state.keepAlive(REQ)
      expect(state.released).toEqual([SESSION_POD])
    })

    it('a session page whose pod cannot be routed falls back to the agent’s own pod', async () => {
      // `gitRoot` answers undefined for a shared session, and a rejection is not a reason to stop
      // answering: an unrouted path lives on the agent's pod, which is what the old predicate assumed.
      const { keepAlive, holds } = build({
        podOf: () => {
          throw new Error('no scope for this session')
        },
        status: { isRepo: true, clean: false }
      })

      expect(await keepAlive(REQ)).toMatchObject({ held: true, reasons: ['uncommitted-files'] })
      expect(holds.holds(AGENT_POD)).toBe(true)
    })
  })
})

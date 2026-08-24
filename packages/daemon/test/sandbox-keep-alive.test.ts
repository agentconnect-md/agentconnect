// The keep-alive decision and the lease behind it: what an open console page may hold a pod for, and
// how that hold ends. Nothing here persists — the page closing IS the release, and these tests pin the
// two halves of that: what renews, and what lapses.
import { describe, expect, it, vi } from 'vitest'
import { createSandboxKeepAlive } from '../src/cp/sandbox-keepalive.js'
import { SANDBOX_HOLD_TTL_MS, SandboxHolds } from '../src/k8s/sandbox-hold.js'

function build(
  overrides: Partial<{
    runsInSandbox: boolean
    knownAgent: boolean
    armed: boolean | Error
    status: { isRepo?: boolean; clean?: boolean } | Error
  }> = {}
) {
  let now = 1_000
  const holds = new SandboxHolds({ now: () => now })
  const gitStatus = vi.fn(async () => {
    if (overrides.status instanceof Error) throw overrides.status
    return overrides.status ?? { isRepo: true, clean: true }
  })
  const keepAlive = createSandboxKeepAlive({
    runsInSandbox: () => overrides.runsInSandbox ?? true,
    knownAgent: () => overrides.knownAgent ?? true,
    armedFor: async () => {
      if (overrides.armed instanceof Error) throw overrides.armed
      return overrides.armed === true
    },
    gitStatus,
    holds
  })
  return { keepAlive, holds, gitStatus, advance: (ms: number) => (now += ms) }
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
    const { keepAlive, holds } = build({ status: { isRepo: true, clean: false } })
    await keepAlive(REQ)
    expect(holds.holds('agent-1')).toBe(true)

    // The next poll finds the work committed: the pod becomes suspendable on the sweep's own schedule,
    // not one TTL later because of the hold the previous poll took.
    const clean = createSandboxKeepAlive({
      runsInSandbox: () => true,
      knownAgent: () => true,
      armedFor: async () => false,
      gitStatus: async () => ({ isRepo: true, clean: true }),
      holds
    })
    expect(await clean(REQ)).toMatchObject({ held: false, reasons: [] })
    expect(holds.holds('agent-1')).toBe(false)
  })

  it('holds nothing for a workspace that is not a checkout', async () => {
    const { keepAlive } = build({ status: { isRepo: false } })
    expect(await keepAlive(REQ)).toMatchObject({ held: false, reasons: [] })
  })

  it('never wakes an already-suspended pod, and says so', async () => {
    const { keepAlive, gitStatus } = build({ runsInSandbox: false, status: { isRepo: true, clean: false } })

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
    const { keepAlive, holds, advance } = build({ armed: true, status: { isRepo: true, clean: false } })
    await keepAlive(REQ)
    advance(SANDBOX_HOLD_TTL_MS - 1_000)

    const armedOnly = createSandboxKeepAlive({
      runsInSandbox: () => true,
      knownAgent: () => true,
      armedFor: async () => true,
      gitStatus: async () => ({ isRepo: true, clean: true }),
      holds
    })
    await armedOnly(REQ)
    advance(2_000) // past the FIRST deadline
    expect(holds.holds('agent-1')).toBe(true)
    // The committed tree stops being reported: reasons describe what the last poll saw, not a union.
    expect(holds.reasons('agent-1')).toEqual(['auto-merge-armed'])
  })

  it('a clean session page does not release the pod another session page is holding dirty', async () => {
    // Two console pages, one agent, two worktrees. The lease is keyed by the page's session, so the
    // clean one releasing its own lease must not suspend the pod out from under the dirty one.
    let now = 1_000
    const holds = new SandboxHolds({ now: () => now })
    const keepAlive = createSandboxKeepAlive({
      runsInSandbox: () => true,
      knownAgent: () => true,
      armedFor: async () => false,
      gitStatus: async (_agentId, sessionId) => ({ isRepo: true, clean: sessionId !== 'dirty-session' }),
      holds
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
    now += SANDBOX_HOLD_TTL_MS + 1
    expect(holds.holds('agent-1')).toBe(false)
  })

  it('an asleep pod drops EVERY page’s lease, not just the polling one’s', async () => {
    const now = 1_000
    const holds = new SandboxHolds({ now: () => now })
    holds.renew('agent-1', 'other-session', ['uncommitted-files'])
    const asleep = createSandboxKeepAlive({
      runsInSandbox: () => false,
      knownAgent: () => true,
      armedFor: async () => false,
      gitStatus: async () => ({ isRepo: true, clean: true }),
      holds
    })

    expect(await asleep(REQ)).toMatchObject({ held: false, asleep: true })
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
})

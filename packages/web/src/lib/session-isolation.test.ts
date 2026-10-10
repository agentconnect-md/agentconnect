// The rows of git-workspace-model.md §11: the label follows the EFFECTIVE boundary, which the agent's strategy and placement decide.
import { describe, it, expect } from 'vitest'
import { agentSessionIsolationLabel, hasRuntimeBoundary, sessionIsolationLabel } from '@/lib/session-isolation'

const selfHosted = { pool: false, execution: 'host' }

describe('sessionIsolationLabel', () => {
  it('names a worktree when nothing encloses the runtime — self-hosted daemon, host strategy', () => {
    expect(sessionIsolationLabel(selfHosted)).toEqual({
      mode: 'Worktree',
      checkout: 'worktree',
      checkouts: 'worktrees'
    })
    expect(hasRuntimeBoundary(selfHosted)).toBe(false)
  })

  it('names session isolation on a self-hosted daemon under any sandboxing strategy', () => {
    expect(sessionIsolationLabel({ ...selfHosted, execution: 'srt' }).mode).toBe('Session isolation')
    expect(sessionIsolationLabel({ ...selfHosted, execution: 'microsandbox' }).mode).toBe('Session isolation')
    // A slug the console does not know still names a boundary: only `host` is none.
    expect(hasRuntimeBoundary({ ...selfHosted, execution: 'firecracker' })).toBe(true)
  })

  it('names session isolation on a managed-pool runtime, which the pod encloses whatever strategy the agent names', () => {
    expect(sessionIsolationLabel({ ...selfHosted, pool: true })).toEqual({
      mode: 'Session isolation',
      checkout: 'session checkout',
      checkouts: 'session checkouts'
    })
  })
})

describe('agentSessionIsolationLabel', () => {
  const agent = { execution: 'host' }
  // The org's own groups. The pool is org-less, so its set id is never in this list — that is the whole test.
  const orgSetIds = new Set(['set_group_a'])

  it('reads a pool placement as enclosed even though the agent names host', () => {
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'pool' }, orgSetIds).mode).toBe('Session isolation')
    // What the CP actually stores for the pool is `set` (daemon-groups.md §2); both spellings are the pool here.
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'set', setId: 'set_pool' }, orgSetIds).mode).toBe(
      'Session isolation'
    )
  })

  it('reads an ORG-OWNED set through the agent’s strategy, because a group is machines and not the pool', () => {
    const group = { ...agent, placementKind: 'set' as const, setId: 'set_group_a' }
    // Nothing encloses a host group member, so §11 gives it a plain linked worktree.
    expect(agentSessionIsolationLabel(group, orgSetIds).mode).toBe('Worktree')
    expect(agentSessionIsolationLabel({ ...group, execution: 'srt' }, orgSetIds).mode).toBe('Session isolation')
  })

  it('reads a machine placement through the agent’s strategy', () => {
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'daemon' }, orgSetIds).mode).toBe('Worktree')
    expect(
      agentSessionIsolationLabel({ ...agent, placementKind: 'daemon', execution: 'microsandbox' }, orgSetIds).mode
    ).toBe('Session isolation')
  })
})

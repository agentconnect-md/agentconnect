// The three rows of git-workspace-model.md §11: the label follows the EFFECTIVE boundary, not the stored flag.
import { describe, it, expect } from 'vitest'
import { agentSessionIsolationLabel, hasRuntimeBoundary, sessionIsolationLabel } from '@/lib/session-isolation'

const selfHosted = { pool: false, runInSandbox: false, sandboxSupported: false, sandboxRequired: false }

describe('sessionIsolationLabel', () => {
  it('names a worktree when nothing encloses the runtime — self-hosted daemon, sandbox not effective', () => {
    expect(sessionIsolationLabel(selfHosted)).toEqual({
      mode: 'Worktree',
      checkout: 'worktree',
      checkouts: 'worktrees'
    })
  })

  it('names session isolation on a self-hosted daemon whose sandbox is effective', () => {
    expect(sessionIsolationLabel({ ...selfHosted, sandboxSupported: true, runInSandbox: true }).mode).toBe(
      'Session isolation'
    )
    // Forced on by daemon policy is just as effective, whatever the stored preference says.
    expect(sessionIsolationLabel({ ...selfHosted, sandboxRequired: true }).mode).toBe('Session isolation')
  })

  it('names session isolation on a managed-pool runtime, which the pod encloses whatever the sandbox triple says', () => {
    expect(sessionIsolationLabel({ ...selfHosted, pool: true })).toEqual({
      mode: 'Session isolation',
      checkout: 'session checkout',
      checkouts: 'session checkouts'
    })
  })

  it('ignores a stored preference the daemon cannot honour — that is the flag/effective split', () => {
    expect(sessionIsolationLabel({ ...selfHosted, runInSandbox: true }).mode).toBe('Worktree')
    expect(hasRuntimeBoundary({ ...selfHosted, runInSandbox: true })).toBe(false)
  })
})

describe('agentSessionIsolationLabel', () => {
  const agent = { runInSandbox: false, sandboxSupported: false, sandboxRequired: false }
  // The org's own groups. The pool is org-less, so its set id is never in this list — that is the whole test.
  const orgSetIds = new Set(['set_group_a'])

  it('reads a pool placement as enclosed even though the pool advertises no sandbox capability', () => {
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'pool' }, orgSetIds).mode).toBe('Session isolation')
    // What the CP actually stores for the pool is `set` (daemon-groups.md §2); both spellings are the pool here.
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'set', setId: 'set_pool' }, orgSetIds).mode).toBe(
      'Session isolation'
    )
  })

  it('reads an ORG-OWNED set through the sandbox triple, because a group is machines and not the pool', () => {
    const group = { ...agent, placementKind: 'set' as const, setId: 'set_group_a' }
    // Nothing encloses an unsandboxed group member, so §11 gives it a plain linked worktree.
    expect(agentSessionIsolationLabel(group, orgSetIds).mode).toBe('Worktree')
    expect(agentSessionIsolationLabel({ ...group, sandboxRequired: true }, orgSetIds).mode).toBe('Session isolation')
  })

  it('reads a machine placement through its projected sandbox triple', () => {
    expect(agentSessionIsolationLabel({ ...agent, placementKind: 'daemon' }, orgSetIds).mode).toBe('Worktree')
    expect(
      agentSessionIsolationLabel({ ...agent, placementKind: 'daemon', sandboxRequired: true }, orgSetIds).mode
    ).toBe('Session isolation')
  })
})

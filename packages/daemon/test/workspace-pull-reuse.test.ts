import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

const ROOT = { cloneUrl: 'https://github.com/acme/repo.git', branch: 'main' } as never

describe("a checkout's pull, shared by the sessions that prepare from it", () => {
  afterEach(() => vi.useRealTimers())

  it('runs once for sessions asking together, serves the next ones for a while, then pulls again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const workspaces = new WorkspaceManager()
    let release!: () => void
    const pulls: string[] = []
    const pullNow = vi
      .spyOn(
        workspaces as unknown as { pullRootNow: (a: string, r: unknown, c: string) => Promise<boolean> },
        'pullRootNow'
      )
      .mockImplementation(async (_agent, _root, cwd) => {
        pulls.push(cwd)
        await new Promise<void>((resolve) => (release = resolve))
        return true
      })

    const together = [
      workspaces.pullRoot('agent', ROOT, '/w/primary'),
      workspaces.pullRoot('agent', ROOT, '/w/primary')
    ]
    await Promise.resolve()
    expect(pulls).toEqual(['/w/primary'])
    release()
    await Promise.all(together)

    vi.setSystemTime(Date.now() + 29_000)
    await workspaces.pullRoot('agent', ROOT, '/w/primary')
    expect(pullNow).toHaveBeenCalledTimes(1)

    // Another checkout, or another agent's, is its own pull.
    const elsewhere = workspaces.pullRoot('other', ROOT, '/w/primary')
    await Promise.resolve()
    release()
    await elsewhere
    expect(pullNow).toHaveBeenCalledTimes(2)

    vi.setSystemTime(Date.now() + 2_000)
    const again = workspaces.pullRoot('agent', ROOT, '/w/primary')
    await Promise.resolve()
    release()
    await again
    expect(pullNow).toHaveBeenCalledTimes(3)
  })

  it('pulls again for another branch of the same checkout, and after a pull that failed', async () => {
    const workspaces = new WorkspaceManager()
    const outcomes = [true, true, false, true]
    const branches: string[] = []
    const pullNow = vi
      .spyOn(
        workspaces as unknown as { pullRootNow: (a: string, r: { branch: string }, c: string) => Promise<boolean> },
        'pullRootNow'
      )
      .mockImplementation(async (_agent, root) => {
        branches.push(root.branch)
        return outcomes[branches.length - 1]!
      })
    const release = { cloneUrl: 'https://github.com/acme/repo.git', branch: 'release' } as never

    await workspaces.pullRoot('agent', ROOT, '/w/primary')
    await workspaces.pullRoot('agent', release, '/w/primary')
    expect(branches).toEqual(['main', 'release'])

    // The checkout left main, so the earlier pull of main no longer describes it; this one fails and is not reused.
    await workspaces.pullRoot('agent', ROOT, '/w/primary')
    await workspaces.pullRoot('agent', ROOT, '/w/primary')
    expect(branches).toEqual(['main', 'release', 'main', 'main'])
    await workspaces.pullRoot('agent', ROOT, '/w/primary')
    expect(pullNow).toHaveBeenCalledTimes(4)
  })
})

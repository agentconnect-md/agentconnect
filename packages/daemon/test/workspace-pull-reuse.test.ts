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
        workspaces as unknown as { pullRootNow: (a: string, r: unknown, c: string) => Promise<void> },
        'pullRootNow'
      )
      .mockImplementation(async (_agent, _root, cwd) => {
        pulls.push(cwd)
        await new Promise<void>((resolve) => (release = resolve))
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
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { setSandboxWorkspaceMode, setWorkspaceGitRunnerResolver } from '../src/workspace/workspace-manager.js'

/**
 * What the console's git seam answers for a cluster agent whose sandbox is not reachable.
 *
 * Before this, the seam fell through to a daemon-local runner pointed at a path in the POD's
 * coordinates: git failed, `isRepo` swallowed the failure the way it swallows every git failure, and
 * the panel reported "not a git checkout" — for a checkout that is intact and comes back on the
 * agent's next turn. That is the one degraded answer a reader cannot act on.
 */

const AGENT = 'bot-cluster'

afterEach(() => {
  setSandboxWorkspaceMode(false)
  setWorkspaceGitRunnerResolver(undefined)
})

/** Answers the first call and nothing after it — a detach timed to land between two resolutions. */
function detachAfterFirst<T>(value: T): () => T | undefined {
  let served = false
  return () => {
    if (served) return undefined
    served = true
    return value
  }
}

/** A runner that reports a healthy top-level checkout, recording what it was asked. */
function answeringRunner(seen: string[][]) {
  const runner = {
    withEnv: () => runner,
    raw: async () => '',
    clone: async () => {},
    pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
    status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async (args: string[]) => {
      seen.push(args)
      // Empty `--show-prefix` ⇒ the cwd IS the top level, which is what the preflight requires.
      return { out: Buffer.from(''), overflow: false }
    }
  }
  return runner
}

describe('the console git seam without a bound sandbox', () => {
  it('refuses with a machine-readable reason instead of reporting "not a git checkout"', async () => {
    setSandboxWorkspaceMode(true)
    // No resolver registered for this agent — what the plane answers with no bound channel.
    const git = createWorkspaceGit(() => '/agent/repo')
    for (const read of [
      () => git.status(AGENT),
      () => git.log({ agentId: AGENT, limit: 20 }),
      () => git.diff({ agentId: AGENT, path: 'a.ts', staged: false })
    ]) {
      await expect(read()).rejects.toMatchObject({
        name: 'WorkspaceViolationError',
        reason: 'sandbox-unavailable'
      })
    }
    // A write must not fall through either: it would mutate whatever sits at that path on this disk.
    await expect(git.commit({ agentId: AGENT, message: 'nope' })).rejects.toMatchObject({
      reason: 'sandbox-unavailable'
    })
    await expect(git.stage({ agentId: AGENT, paths: ['a.ts'] })).rejects.toMatchObject({
      reason: 'sandbox-unavailable'
    })
  })

  it('never fires on a self-hosted daemon, whose workspace is always right here', async () => {
    // Cluster mode off: an empty resolver is the NORMAL state, not an unreachable workspace, so the
    // answer comes from git on this filesystem — a real directory that simply is not a checkout.
    const plain = mkdtempSync(join(tmpdir(), 'ac-git-sandbox-'))
    try {
      const status = await createWorkspaceGit(() => plain).status(AGENT)
      expect(status.isRepo).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('holds the runner it resolved when the channel drops mid-request', async () => {
    setSandboxWorkspaceMode(true)
    // The shim re-dials at half its credential TTL, so "the resolver answered once" is not a promise
    // that it answers the same way again. A fence that probes and then resolves is check-then-use: the
    // second answer would be a daemon-local runner against a pod path, so a read reports no checkout
    // and a write mutates this disk. The refusal rides on the resolution, which happens once.
    const seen: string[][] = []
    setWorkspaceGitRunnerResolver(detachAfterFirst(answeringRunner(seen) as never))
    const status = await createWorkspaceGit(() => '/agent/repo').status(AGENT)
    expect(status.isRepo).toBe(true)
    expect(seen.some((args) => args.includes('--show-prefix'))).toBe(true)
  })

  it('still refuses an unknown agent as an unknown agent, ahead of reachability', async () => {
    setSandboxWorkspaceMode(true)
    await expect(createWorkspaceGit(() => undefined).status('nope')).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
  })
})

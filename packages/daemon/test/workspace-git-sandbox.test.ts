import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { ShimChannelLostError } from '../src/shim/channels.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()

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
  workspaces.setSandboxMode(false)
  workspaces.setGitRunnerResolver(undefined)
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
    workspaces.setSandboxMode(true)
    // No resolver registered for this agent — what the plane answers with no bound channel.
    const git = createWorkspaceGit(workspaces, async () => '/agent/repo')
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
      const status = await createWorkspaceGit(workspaces, async () => plain).status(AGENT)
      expect(status.isRepo).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('holds the runner it resolved when the channel drops mid-request', async () => {
    workspaces.setSandboxMode(true)
    // The shim re-dials at half its credential TTL, so "the resolver answered once" is not a promise
    // that it answers the same way again. A fence that probes and then resolves is check-then-use: the
    // second answer would be a daemon-local runner against a pod path, so a read reports no checkout
    // and a write mutates this disk. The refusal rides on the resolution, which happens once.
    const seen: string[][] = []
    workspaces.setGitRunnerResolver(detachAfterFirst(answeringRunner(seen) as never))
    const status = await createWorkspaceGit(workspaces, async () => '/agent/repo').status(AGENT)
    expect(status.isRepo).toBe(true)
    expect(seen.some((args) => args.includes('--show-prefix'))).toBe(true)
  })

  it('still refuses an unknown agent as an unknown agent, ahead of reachability', async () => {
    workspaces.setSandboxMode(true)
    await expect(createWorkspaceGit(workspaces, async () => undefined).status('nope')).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
  })
})

// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('a shim channel that goes away mid-request', () => {
  // The renewal is ROUTINE: the shim re-dials at half its credential TTL and `ShimSession.attach`
  // fails whatever was in flight. `isRepo` used to swallow that like any other git failure, so an
  // ordinary renewal settled as "not a git checkout" — the same misleading answer this seam was built
  // to remove, arriving from the transport instead of from a wrong path.
  afterEach(() => {
    workspaces.setSandboxMode(false)
    workspaces.setGitRunnerResolver(undefined)
  })

  /** A remote runner whose channel is lost on the Nth request, as a renewal loses it. */
  function losingRunner(loseOn: (n: number) => boolean, requester?: { calls: number }) {
    const state = requester ?? { calls: 0 }
    const session = {
      request: async () => {
        state.calls += 1
        if (loseOn(state.calls)) throw new ShimChannelLostError('shim channel renewed')
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    return { runner: new ShimGitRunner(session), state }
  }

  it('retries a read once across the renewal rather than reporting no checkout', async () => {
    workspaces.setSandboxMode(true)
    // The first `rev-parse` loses its channel; the second lands. The panel must never see the blip.
    const { runner, state } = losingRunner((n) => n === 1)
    workspaces.setGitRunnerResolver(() => runner)
    const status = await createWorkspaceGit(workspaces, async () => '/agent/repo').status(AGENT)
    expect(status.isRepo).toBe(true)
    expect(state.calls).toBeGreaterThan(1)
  })

  it('reports a channel that stays gone as transient, NOT as "not a git checkout"', async () => {
    workspaces.setSandboxMode(true)
    const { runner } = losingRunner(() => true)
    workspaces.setGitRunnerResolver(() => runner)
    await expect(createWorkspaceGit(workspaces, async () => '/agent/repo').status(AGENT)).rejects.toMatchObject({
      name: 'WorkspaceViolationError',
      reason: 'sandbox-unavailable'
    })
  })

  it('never repeats a write, whose first attempt may already have landed', async () => {
    workspaces.setSandboxMode(true)
    // The abort says a REPLY was lost, not whether the request arrived — so a repeated `commit` risks
    // a second commit. Reads are the only invocations this may resend.
    const seen: string[][] = []
    const session = {
      request: async (_capability: string, payload: unknown) => {
        const args = (payload as { args: string[] }).args
        seen.push(args)
        if (args[0] === 'rev-parse' && args[1] === '--show-prefix') return { code: 0, stdout: '', stderr: '' }
        throw new ShimChannelLostError('shim channel renewed')
      }
    }
    workspaces.setGitRunnerResolver(() => new ShimGitRunner(session))
    // Refused as transient rather than retried. `config` — the executable-config audit a stage runs
    // first — is left out of the repeatable set for the same reason: it CAN write, and the cheapest
    // way never to get that wrong is to repeat nothing that can.
    await expect(
      createWorkspaceGit(workspaces, async () => '/agent/repo').stage({ agentId: AGENT, paths: ['a.ts'] })
    ).rejects.toMatchObject({ reason: 'sandbox-unavailable' })
    // Nothing that mutates was sent twice — nor, here, even once.
    const sent = seen.map((args) => args.join(' '))
    expect(new Set(sent).size).toBe(sent.length)
    expect(sent.some((line) => line.startsWith('add ') || line.startsWith('commit'))).toBe(false)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { FakeClock } from './cp/fake-clock.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { PodWorkspaceFs } from './fixtures/pod-workspace-fs.js'
import { testPlane } from './workspace-plane-support.js'

/**
 * multi-repository-workspaces.md decision 12 at the daemon boundary: a retired secondary root is
 * removed only from the idle sweep, only while its agent holds nothing, and only under the
 * workspace admission fence. What this file claims is that GATE — the dirty/unique-commit rules
 * are the workspace manager's own and are proven against real repositories there.
 */

const AGENT = 'bot-roots'

function scaffold(additionalRepos: unknown[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-retired-roots-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      // No `always` row, so every subtree seeded below is retired by construction.
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace'), additionalRepos },
      integrations: [],
      output: { mode: 'low' }
    })
  )
  return root
}

/** A materialized secondary subtree with an empty checkout — attested, idle, nothing to keep. */
function seedRetiredRoot(root: string, repoFullName: string, repoId: string): string {
  const subtree = join(root, 'agents', AGENT, 'repos', ...repoFullName.split('/'))
  mkdirSync(join(subtree, 'checkout'), { recursive: true })
  writeFileSync(
    join(subtree, '.materialization.json'),
    JSON.stringify({ repoId, repoFullName, branch: 'main' }, null, 2)
  )
  return subtree
}

/** Boot, then let the startup sweep settle so each case seeds into a quiet daemon. */
async function boot(root: string) {
  const clock = new FakeClock()
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => ({}) as any, clock })
  await daemon.start()
  const inner = daemon as any
  await vi.waitFor(() => expect(inner.sessionRetentionSweepInFlight).toBe(false))
  return { daemon, inner }
}

describe('retired workspace roots are swept only while the agent is quiescent (decision 12)', () => {
  it('keeps a retired root while a turn holds the agent and removes it once nothing does', async () => {
    const root = scaffold()
    const { daemon, inner } = await boot(root)
    const subtree = seedRetiredRoot(root, 'acme/infra', '42')

    // An admitted dispatch is exactly what the workspace admission fence protects the tree from.
    const release = inner.beginActiveDispatch(AGENT, `slack:C1:t1:${AGENT}`)
    await inner.sweepSessionRetention()
    expect(existsSync(subtree)).toBe(true)

    release()
    await inner.sweepSessionRetention()
    expect(existsSync(subtree)).toBe(false)
    await daemon.stop()
  })

  it('keeps a retired root while a durable inbox row is still open for the agent', async () => {
    const root = scaffold()
    const { daemon, inner } = await boot(root)
    const subtree = seedRetiredRoot(root, 'example-co/shared-library', '815')
    expect(await inner.store.agentHasPendingInboxRows(AGENT)).toBe(false)
    // Admitted work that has not reached a live dispatch yet: the row is the only thing that says so.
    inner.store.agentHasPendingInboxRows = async () => true

    await inner.sweepSessionRetention()
    expect(existsSync(subtree)).toBe(true)

    inner.store.agentHasPendingInboxRows = async () => false
    await inner.sweepSessionRetention()
    expect(existsSync(subtree)).toBe(false)
    await daemon.stop()
  })

  it('leaves a subtree that carries no attestation, and one whose worktrees are not empty', async () => {
    const root = scaffold()
    const { daemon, inner } = await boot(root)
    const attested = seedRetiredRoot(root, 'acme/infra', '42')
    mkdirSync(join(attested, 'worktrees', 'a1b2c3'), { recursive: true })
    const unattested = join(root, 'agents', AGENT, 'repos', 'acme', 'mystery')
    mkdirSync(join(unattested, 'checkout'), { recursive: true })

    await inner.sweepSessionRetention()

    expect(existsSync(attested)).toBe(true)
    expect(existsSync(unattested)).toBe(true)
    await daemon.stop()
  })
})

describe('a shared session’s on-demand clones are judged with its row (decision 20)', () => {
  it('keeps the row while its clone directory holds work, and removes both once it holds none', async () => {
    const root = scaffold([{ repoFullName: 'example-co/shared-library', repoId: '815', materialize: 'on-demand' }])
    const { daemon, inner } = await boot(root)
    const key = `slack:C1:t1:${AGENT}`
    await inner.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 't1',
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      workspaceIsolation: 'shared'
    })
    const clones = join(root, 'agents', AGENT, 'clones', inner.workspaces.sessionWorktreeId(key))
    // A file where only clones belong: the session's own work, which only a human removes.
    mkdirSync(join(clones, 'example-co'), { recursive: true })
    writeFileSync(join(clones, 'example-co', 'notes.txt'), 'kept\n')
    // A month on, well past the default retention window, without firing the clock's timers.
    vi.spyOn(inner.clock, 'now').mockReturnValue(30 * 86_400_000)

    await inner.sweepExpiredSessions()
    expect(await inner.store.getSession(key)).toBeDefined()
    expect(existsSync(join(clones, 'example-co', 'notes.txt'))).toBe(true)

    rmSync(join(clones, 'example-co', 'notes.txt'))
    await inner.sweepExpiredSessions()
    expect(await inner.store.getSession(key)).toBeUndefined()
    expect(existsSync(clones)).toBe(false)
    await daemon.stop()
  })
})

describe('on a pool, retired roots are swept only while the agent pod itself is bound (#1896)', () => {
  it.each([false, true])(
    'never holds the agent pod for a bound session pod (agent pod bound: %s)',
    async (agentBound) => {
      const { daemon, inner } = await boot(scaffold())
      // Any bound pod of the agent, a session's included, answers a workspace mount for it.
      const plane = {
        ...testPlane({
          workspacesOffDisk: true,
          workspaceFsFor: () => ({ fs: new PodWorkspaceFs('/agent'), mount: '/agent' })
        }),
        sandboxBound: (subject: string) => subject === `${AGENT}/session-0` || (agentBound && subject === AGENT),
        withSandbox: vi.fn(async (_subject: string, work: () => Promise<unknown>) => await work()),
        ensureChannel: async () => {},
        stop: async () => {}
      }
      inner.k8sPlane = plane
      inner.wirePlaneResolver(plane)
      const list = vi.spyOn(inner.workspaces, 'retiredSecondaryRoots').mockResolvedValue([])
      try {
        await inner.sweepSessionRetention()
        if (agentBound) {
          expect(plane.withSandbox).toHaveBeenCalledExactlyOnceWith(AGENT, expect.any(Function))
          expect(list).toHaveBeenCalledOnce()
        } else {
          // Holding the agent pod for the listing is what claims and wakes a suspended one.
          expect(plane.withSandbox).not.toHaveBeenCalled()
          expect(list).not.toHaveBeenCalled()
        }
      } finally {
        await daemon.stop()
      }
    }
  )
})

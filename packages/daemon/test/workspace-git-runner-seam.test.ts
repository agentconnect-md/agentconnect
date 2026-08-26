import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkspaceManager, type WorkspaceGitRunnerResolver } from '../src/workspace/workspace-manager.js'

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import { gitFor } from '../src/workspace/git-injection.js'
import type { Agent } from '../src/agents/agent-schema.js'

// The resolver seam that lets a cluster workspace run git on its sandbox pod instead of this disk.
// Its value is completeness: one site left on gitFor passes every local test, then reports a clean
// tree for a workspace it cannot see. So both halves are covered — routed, and unbypassable.

const roots: string[] = []

afterEach(() => {
  workspaces.setGitRunnerResolver(undefined)
  workspaces.setSandboxMode(false)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e'
    }
  })
}

/** A real agent whose workspace is a real repository with a real session worktree. */
function agentWithWorktree(sessionKey: string): { agent: Agent; worktree: string } {
  // CANONICAL: removal re-derives cwd from the realpath'd root, so a symlinked tmpdir (macOS) renames the argv.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ac-seam-')))
  roots.push(home)
  const path = join(home, 'checkout')
  mkdirSync(path, { recursive: true })
  git(path, ['init', '--initial-branch=main'])
  writeFileSync(join(path, 'a.txt'), 'a\n')
  git(path, ['add', 'a.txt'])
  git(path, ['commit', '-m', 'base'])
  // A real workspace is a CLONE, so commits are reachable from a remote ref. Without one every
  // commit is unique to the worktree and removal is correctly refused.
  const origin = join(home, 'origin.git')
  git(home, ['init', '--bare', '--initial-branch=main', origin])
  git(path, ['remote', 'add', 'origin', origin])
  git(path, ['push', '-u', 'origin', 'main'])

  const agent = {
    id: 'bot-seam',
    dir: home,
    name: 'bot-seam',
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: 'git-repo',
      path,
      gitRepo: 'https://github.com/acme/repo.git',
      gitBranch: 'main',
      pullOnNewSession: false,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent

  // The real worktree the removal path judges, registered by real git.
  const id = createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)
  const worktree = join(workspaces.sessionWorktreeRoot(agent), id)
  mkdirSync(dirname(worktree), { recursive: true })
  git(path, ['worktree', 'add', '--detach', worktree, 'HEAD'])
  return { agent, worktree }
}

/** Delegates to the local runner but records what the seam was asked to do. */
/** Same shared path, different agent — the case the cwd-only key could not tell apart. */
function clusterAgent(id: string, path: string): Agent {
  return {
    id,
    dir: dirname(path),
    name: id,
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: 'git-repo',
      path,
      gitRepo: 'https://github.com/acme/repo.git',
      gitBranch: 'main',
      pullOnNewSession: false,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

function recording(): {
  resolver: WorkspaceGitRunnerResolver
  calls: Array<{ agentId: string; cwd?: string }>
  argv: string[][]
} {
  const calls: Array<{ agentId: string; cwd?: string }> = []
  const argv: string[][] = []
  const resolver: WorkspaceGitRunnerResolver = (agentId, cwd, abort) => {
    calls.push({ agentId, ...(cwd === undefined ? {} : { cwd }) })
    const inner: GitRunner = new LocalGitRunner(gitFor(cwd, abort), cwd, (env) => gitFor(cwd, abort).env(env))
    const wrap = (runner: GitRunner): GitRunner => {
      const recorder: Omit<GitRunner, 'readBounded'> = {
        withEnv: (env) => wrap(runner.withEnv(env)),
        raw: async (args) => {
          argv.push(args)
          return runner.raw(args)
        },
        clone: async (repo, target, options) => {
          argv.push(['clone', ...(options ?? []), repo, target])
          return runner.clone(repo, target, options)
        },
        pull: async (remote, branch, options) => {
          argv.push(['pull', ...(options ?? []), remote, branch])
          return runner.pull(remote, branch, options)
        },
        status: async () => {
          argv.push(['status'])
          return runner.status()
        },
        log: async (options) => {
          argv.push(['log', String(options.maxCount)])
          return runner.log(options)
        }
      }
      return recorder as GitRunner
    }
    return wrap(inner)
  }
  return { resolver, calls, argv }
}

describe('workspace-manager git runner seam', () => {
  it('routes worktree removal through the resolver, with the agent it belongs to', async () => {
    const { agent, worktree } = agentWithWorktree('session-1')
    const { resolver, calls, argv } = recording()
    workspaces.setGitRunnerResolver(resolver)

    const outcome = await workspaces.removeSessionWorktree(agent, 'session-1')

    // Real removal against a real worktree — the outcome proves the routed argv actually ran.
    expect(outcome).toEqual({ outcome: 'removed' })
    expect(existsSync(worktree)).toBe(false)
    // The resolver needs the agent: a cwd-only seam could not pick which sandbox channel to use.
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map((call) => call.agentId))).toEqual(new Set(['bot-seam']))
    const flat = argv.map((args) => args.join(' '))
    expect(flat).toContain('status --porcelain')
    expect(flat.some((line) => line.startsWith('rev-list --count HEAD'))).toBe(true)
    expect(flat).toContain(`worktree remove ${worktree}`)
    expect(flat).toContain('worktree prune')
    expect(flat.some((line) => line.startsWith('update-ref -d refs/agentconnect/reviews/'))).toBe(true)
  })

  it('retains a DIRTY worktree, judged through the resolver rather than around it', async () => {
    const { agent, worktree } = agentWithWorktree('session-2')
    writeFileSync(join(worktree, 'dirty.txt'), 'x\n')
    const { resolver } = recording()
    workspaces.setGitRunnerResolver(resolver)

    // The decision must come from the runner's answer, not from this daemon's own disk.
    expect(await workspaces.removeSessionWorktree(agent, 'session-2')).toEqual({ outcome: 'retained', reason: 'dirty' })
    expect(existsSync(worktree)).toBe(true)
  })

  it('cannot be bypassed: a refusing resolver stops the operation instead of falling back', async () => {
    const { agent, worktree } = agentWithWorktree('session-3')
    // A site still reaching git directly would succeed despite the seam refusing everything.
    workspaces.setGitRunnerResolver(() => {
      throw new Error('seam refused')
    })
    const outcome = await workspaces.removeSessionWorktree(agent, 'session-3')
    expect(outcome.outcome).toBe('failed')
    expect(existsSync(worktree)).toBe(true)
  })

  it('leaves the local path unregistered, so a self-hosted daemon needs no wiring', async () => {
    const { agent, worktree } = agentWithWorktree('session-4')
    // No resolver installed: undefined means local, and the default must still work.
    expect(await workspaces.removeSessionWorktree(agent, 'session-4')).toEqual({ outcome: 'removed' })
    expect(existsSync(worktree)).toBe(false)
  })

  it('does not coalesce two CLUSTER agents onto one clone, even at the same path', async () => {
    // The single-flight lock was keyed on the textual cwd. For local agents that is the intent:
    // one path means one checkout. For cluster agents the same path is a different filesystem per
    // agent, so coalescing hands one agent the other's clone — and it looks like success.
    const home = mkdtempSync(join(tmpdir(), 'ac-seam-clone-'))
    roots.push(home)
    const shared = join(home, 'checkout')
    const cloned: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    // Clone is intercepted, so nothing reaches the network; the point is who asks and how often.
    workspaces.setGitRunnerResolver((agentId) => {
      const runner = {
        withEnv: () => runner,
        raw: async () => '',
        clone: async () => {
          cloned.push(agentId)
          await blocked
        },
        pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
        status: async () => ({ current: null, tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
        log: async () => []
      } as unknown as GitRunner
      return runner
    })

    const first = workspaces.prefetchWorkspace(clusterAgent('bot-one', shared))
    const second = workspaces.prefetchWorkspace(clusterAgent('bot-two', shared))
    // Both arrive while the other is in flight, which is the race the lock exists for.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])
    expect(cloned.sort()).toEqual(['bot-one', 'bot-two'])
  })

  it('has no git call site left outside the seam', () => {
    // Source-level because the failure mode is a NEW site added later, which every local test
    // would pass. `runnerFor` is the one permitted caller.
    const source = readFileSync(new URL('../src/workspace/workspace-manager.ts', import.meta.url), 'utf8')
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bgitFor\(/.test(line))
      // The permitted site, matched on its SHAPE rather than a byte-exact string: the local
      // runner also carries `cwd` so its bounded read can spawn in the same directory, and
      // pinning the literal made that addition look like a new escape.
      .filter(({ line }) => !/new LocalGitRunner\(gitFor\(cwd, abort\)/.test(line))
    expect(offenders.map((entry) => `${entry.number}: ${entry.line.trim()}`)).toEqual([])
  })

  it('has no git call site left outside the seam in the console git surface either', () => {
    // The same failure mode one file over, and it matters more there since M3: a stage/commit/push
    // resolved locally for a cluster agent mutates this daemon's disk instead of the sandbox's. No
    // permitted site at all here — the whole file goes through `workspaceGitRunnerFor`.
    const source = readFileSync(new URL('../src/cp/workspace-git.ts', import.meta.url), 'utf8')
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bgitFor\(|new LocalGitRunner\(/.test(line))
    expect(offenders.map((entry) => `${entry.number}: ${entry.line.trim()}`)).toEqual([])
  })
})

// The other half of the same seam: WHERE the console's git runs, not just which runner runs it.
// A resolver that routes into the sandbox is worthless if it is handed a path from this daemon's
// filesystem — the shim's cwd fence refuses it, `isRepo` swallows the refusal, and the Git panel
// reports "not a git checkout" over a checkout that is there.
// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('consoleWorkspaceRoot', () => {
  const agentAt = (path: string, workspace: Partial<Agent['workspace']> = {}): Agent =>
    ({
      ...clusterAgent('bot-root', path),
      workspace: { ...clusterAgent('bot-root', path).workspace, ...workspace }
    }) as Agent

  it('is the daemon-local path for a self-hosted daemon', () => {
    expect(
      workspaces.consoleWorkspaceRoot(
        agentAt('/var/lib/ac/agents/bot/workspace'),
        '/var/lib/ac/agents/bot/workspace',
        undefined
      )
    ).toBe('/var/lib/ac/agents/bot/workspace')
  })

  it('is the POD checkout under --k8s, never the daemon path the runtime cannot see', () => {
    workspaces.setSandboxMode(true)
    const local = '/var/lib/agentconnect/agents/bot/workspace'
    expect(workspaces.consoleWorkspaceRoot(agentAt(local), local, '/agent')).toBe('/agent/repo')
  })

  it('falls back to the legacy mount when the bound shim reported no root', () => {
    workspaces.setSandboxMode(true)
    expect(workspaces.consoleWorkspaceRoot(agentAt('/local/ws'), '/local/ws', undefined)).toBe('/agent/repo')
  })

  it('is the mounted volume itself for a from-scratch workspace', () => {
    workspaces.setSandboxMode(true)
    expect(workspaces.consoleWorkspaceRoot(agentAt('/local/ws', { mode: 'from-scratch' }), '/local/ws', '/agent')).toBe(
      '/agent'
    )
  })

  it('stops at the CHECKOUT root, not the runtime cwd, when a working subdirectory is configured', () => {
    workspaces.setSandboxMode(true)
    // The distinction is the local path's: it has always addressed `workspace.path` (the clone root)
    // while the ACP cwd went one level in. Routing the console through `clusterWorkspaceCwd` instead
    // put every agentDir-configured cluster agent on "not a git checkout" — `isRepo` accepts only an
    // empty `--show-prefix`, so a descendant cwd is rejected before any operation runs, and no status
    // ever reaches the panel to be corrected downstream.
    expect(
      workspaces.consoleWorkspaceRoot(agentAt('/local/ws', { agentDir: 'services/api' }), '/local/ws', '/agent')
    ).toBe('/agent/repo')
    // The RUNTIME still gets the subdirectory — the two answers differ on purpose.
    expect(workspaces.clusterWorkspaceCwd(agentAt('/local/ws', { agentDir: 'services/api' }), '/agent')).toBe(
      '/agent/repo/services/api'
    )
  })

  it('keeps an absent workspace absent, so a shared-workspace sessionId stays refused', () => {
    workspaces.setSandboxMode(true)
    // The local resolver answers undefined for a sessionId naming a session that is NOT isolated.
    // Turning that into the shared checkout would answer a question about a worktree that has none.
    expect(workspaces.consoleWorkspaceRoot(agentAt('/local/ws'), undefined, '/agent')).toBeUndefined()
  })

  it('names the per-session worktree on the volume, never the shared checkout', () => {
    workspaces.setSandboxMode(true)
    // The console addresses the repository the session stands in, and for an isolated session that
    // is its own worktree — naming the shared checkout would answer about a different tree.
    const id = workspaces.sessionWorktreeId('sess-1')
    expect(
      workspaces.consoleWorkspaceRoot(agentAt('/local/ws'), '/local/ws/.sessions/abc', '/agent', {
        isolation: 'session',
        sessionKey: 'sess-1'
      })
    ).toBe(`/agent/worktrees/${id}`)
  })
})

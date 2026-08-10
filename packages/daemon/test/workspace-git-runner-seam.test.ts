import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  removeSessionWorktree,
  sessionWorktreeRoot,
  setWorkspaceGitRunnerResolver,
  type WorkspaceGitRunnerResolver
} from '../src/workspace/workspace-manager.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import { gitFor } from '../src/workspace/git-injection.js'
import type { Agent } from '../src/agents/agent-schema.js'

/**
 * The resolver seam in workspace-manager, which is what lets a cluster-backed workspace run its
 * git on the sandbox pod's volume instead of this daemon's disk.
 *
 * The migration it exists for is only as good as its completeness: a single site left calling
 * `gitFor` keeps passing every local test and then, for a cluster agent, runs git against the
 * WRONG filesystem — reporting a clean tree for a workspace it cannot see. So this covers both
 * halves: the operations do route through the resolver, and no operation gets to bypass it.
 */

const roots: string[] = []

afterEach(() => {
  setWorkspaceGitRunnerResolver(undefined)
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
  const home = mkdtempSync(join(tmpdir(), 'ac-seam-'))
  roots.push(home)
  const path = join(home, 'checkout')
  mkdirSync(path, { recursive: true })
  git(path, ['init', '--initial-branch=main'])
  writeFileSync(join(path, 'a.txt'), 'a\n')
  git(path, ['add', 'a.txt'])
  git(path, ['commit', '-m', 'base'])
  // A real workspace is a CLONE, so its commits are reachable from a remote ref. Without one
  // every commit counts as unique to the worktree and removal is refused — which is the
  // judgement working, not a fixture detail to assert around.
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
  const worktree = join(sessionWorktreeRoot(agent), id)
  mkdirSync(dirname(worktree), { recursive: true })
  git(path, ['worktree', 'add', '--detach', worktree, 'HEAD'])
  return { agent, worktree }
}

/** Delegates to the local runner but records what the seam was asked to do. */
function recording(): {
  resolver: WorkspaceGitRunnerResolver
  calls: Array<{ agentId: string; cwd?: string }>
  argv: string[][]
} {
  const calls: Array<{ agentId: string; cwd?: string }> = []
  const argv: string[][] = []
  const resolver: WorkspaceGitRunnerResolver = (agentId, cwd, abort) => {
    calls.push({ agentId, ...(cwd === undefined ? {} : { cwd }) })
    const inner: GitRunner = new LocalGitRunner(gitFor(cwd, abort))
    const wrap = (runner: GitRunner): GitRunner => ({
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
    })
    return wrap(inner)
  }
  return { resolver, calls, argv }
}

describe('workspace-manager git runner seam', () => {
  it('routes worktree removal through the resolver, with the agent it belongs to', async () => {
    const { agent, worktree } = agentWithWorktree('session-1')
    const { resolver, calls, argv } = recording()
    setWorkspaceGitRunnerResolver(resolver)

    const outcome = await removeSessionWorktree(agent, 'session-1')

    // Real removal against a real worktree — the outcome proves the routed argv actually ran.
    expect(outcome).toEqual({ outcome: 'removed' })
    expect(existsSync(worktree)).toBe(false)
    // The resolver has to be told WHICH agent: the runner for a cluster workspace is bound to
    // that agent's own sandbox channel, so a seam taking only a cwd could not pick one.
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
    setWorkspaceGitRunnerResolver(resolver)

    // The decision has to come from the runner's answer: a site reading the daemon's own disk
    // instead would judge a cluster workspace it cannot see.
    expect(await removeSessionWorktree(agent, 'session-2')).toEqual({ outcome: 'retained', reason: 'dirty' })
    expect(existsSync(worktree)).toBe(true)
  })

  it('cannot be bypassed: a refusing resolver stops the operation instead of falling back', async () => {
    const { agent, worktree } = agentWithWorktree('session-3')
    // If any site still reached git directly, the removal would succeed despite the seam
    // refusing everything — which is exactly the silent failure this guards.
    setWorkspaceGitRunnerResolver(() => {
      throw new Error('seam refused')
    })
    const outcome = await removeSessionWorktree(agent, 'session-3')
    expect(outcome.outcome).toBe('failed')
    expect(existsSync(worktree)).toBe(true)
  })

  it('leaves the local path unregistered, so a self-hosted daemon needs no wiring', async () => {
    const { agent, worktree } = agentWithWorktree('session-4')
    // No resolver installed: undefined means local, and the default must still work.
    expect(await removeSessionWorktree(agent, 'session-4')).toEqual({ outcome: 'removed' })
    expect(existsSync(worktree)).toBe(false)
  })

  it('has no git call site left outside the seam', () => {
    // A source-level check because the alternative is booting all twelve call sites, and the
    // failure mode is a NEW site added later: it would pass every local test while running a
    // cluster agent's git on the wrong machine. `runnerFor` is the one permitted caller.
    const source = readFileSync(new URL('../src/workspace/workspace-manager.ts', import.meta.url), 'utf8')
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\bgitFor\(/.test(line))
      .filter(({ line }) => !line.includes('new LocalGitRunner(gitFor(cwd, abort))'))
    expect(offenders.map((entry) => `${entry.number}: ${entry.line.trim()}`)).toEqual([])
  })
})

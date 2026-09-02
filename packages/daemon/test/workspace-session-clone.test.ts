import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { createWorkspaceScope } from '../src/cp/workspace-scope.js'
import {
  daemonGitCredentialTarget,
  gitFor,
  initGitInjection,
  workspaceGitLocalEnv
} from '../src/workspace/git-injection.js'
import { LocalGitRunner, type GitRunner, type GitLogEntry, type GitPullSummary } from '../src/workspace/git-runner.js'
import { WorkspaceManager, type PrepareSessionWorkspaceRequest } from '../src/workspace/workspace-manager.js'

// Real git against real repositories (git-workspace-model.md §11): the claims are about the disk — where a confined session's clones land, that nothing of theirs reaches the primary, that a review is fetched and verified inside the clone, and what retirement removes or keeps.

const workspaces = new WorkspaceManager()

const SHIM = join(mkdtempSync(join(tmpdir(), 'ac-session-clone-shim-')), 'git-credential-helper.sh')
initGitInjection({
  targetFor: () => daemonGitCredentialTarget({ shimPath: SHIM, runDir: join(SHIM, '..') }),
  preWarm: async () => undefined,
  capabilityFor: (agentId) => `cap-${agentId}`
})

const KEY = 'slack:C1:1700000000.000100'
const PRIMARY_URL = 'https://github.com/acme/primary-service.git'
const roots: string[] = []
/** Authorized clone URL (minus any `.git`) → the `file://` bare repository standing in for it. */
const remotes = new Map<string, string>()

afterAll(() => rmSync(join(SHIM, '..'), { recursive: true, force: true }))
afterEach(() => {
  workspaces.setGitRunnerResolver(undefined)
  remotes.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Setup-only env: the daemon's own local policy widened to `file:`, plus a fixture identity. */
function fixtureEnv(): Record<string, string> {
  return {
    ...workspaceGitLocalEnv(),
    GIT_ALLOW_PROTOCOL: 'file:https:ssh',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
  }
}

function git(cwd: string, args: string[]): string {
  const quiesced = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args]
  return execFileSync('git', quiesced, { cwd, env: fixtureEnv(), encoding: 'utf8' }).trim()
}

/** A bare repository serving `branch` with one commit (partial clones allowed, as a code host allows them) plus the seed checkout that pushes more to it; served over `file://`, so `--filter` is honoured. */
function bareRepo(branch = 'main'): { bare: string; seed: string; url: string } {
  const root = tempRoot('ac-session-clone-remote-')
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  git(root, ['init', '-q', '--bare', `--initial-branch=${branch}`, bare])
  git(bare, ['config', 'receive.autogc', 'false'])
  git(bare, ['config', 'uploadpack.allowFilter', 'true'])
  mkdirSync(seed)
  git(seed, ['init', '-q', `--initial-branch=${branch}`, '.'])
  writeFileSync(join(seed, 'README.md'), 'seed\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'initial'])
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-q', 'origin', branch])
  return { bare, seed, url: `file://${bare}` }
}

function agentFixture(
  opts: {
    mode?: 'git-repo' | 'from-scratch'
    githubApp?: boolean
    additionalRepos?: Array<{ repoFullName: string; repoId: string }>
  } = {}
): Agent {
  const home = tempRoot('ac-session-clone-agent-')
  return {
    id: 'bot-clone',
    dir: home,
    name: 'bot-clone',
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: opts.mode ?? 'git-repo',
      isolation: 'session',
      path: join(home, 'workspace'),
      gitRepo: PRIMARY_URL,
      gitBranch: 'main',
      ...(opts.githubApp ? { gitCredential: 'github-app' } : {}),
      additionalRepos: opts.additionalRepos ?? [],
      pullOnNewSession: false,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

function serve(cloneUrl: string, url: string): void {
  remotes.set(cloneUrl.replace(/\.git$/i, ''), url)
}

function substitute(value: string): string {
  return remotes.get(value.replace(/\.git$/i, '')) ?? value
}

/** Real git through the workspace runner seam, with exactly one substitution: a fixture repository's authorized URL becomes its `file://` bare, and `file:` joins the protocol allowlist. */
class SeamRunner implements GitRunner {
  constructor(
    private readonly cwd: string | undefined,
    private readonly abort: AbortSignal | undefined,
    private readonly env: Record<string, string> = {}
  ) {}

  withEnv(env: Record<string, string>): GitRunner {
    return new SeamRunner(this.cwd, this.abort, env)
  }

  private delegate(): GitRunner {
    const env: Record<string, string> = { ...this.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
    for (let index = 0; index < Number(env.GIT_CONFIG_COUNT ?? 0); index += 1) {
      if (/^remote\..*\.url$/i.test(env[`GIT_CONFIG_KEY_${index}`] ?? '')) {
        env[`GIT_CONFIG_VALUE_${index}`] = substitute(env[`GIT_CONFIG_VALUE_${index}`] ?? '')
      }
    }
    const make = (value: Record<string, string>) => gitFor(this.cwd, this.abort).env(value)
    return new LocalGitRunner(gitFor(this.cwd, this.abort), this.cwd, make).withEnv(env)
  }

  raw(args: string[]): Promise<string> {
    return this.delegate().raw(args[0] === 'ls-remote' ? args.map(substitute) : args)
  }

  clone(repo: string, target: string, options?: string[]): Promise<void> {
    return this.delegate().clone(substitute(repo), target, options)
  }

  pull(remote: string, branch: string, options?: string[]): Promise<GitPullSummary> {
    return this.delegate().pull(remote, branch, options)
  }

  status() {
    return this.delegate().status()
  }

  log(options: { maxCount: number }): Promise<GitLogEntry[]> {
    return this.delegate().log(options)
  }

  readBounded(args: string[], maxBytes: number) {
    return this.delegate().readBounded(args, maxBytes)
  }
}

/** Serve the primary (when there is one) and every secondary root from fresh bare repositories. */
function serveAll(agent: Agent, branches: Record<string, string> = {}): Record<string, ReturnType<typeof bareRepo>> {
  workspaces.setGitRunnerResolver((_agentId, cwd, abort) => new SeamRunner(cwd, abort))
  const served: Record<string, ReturnType<typeof bareRepo>> = {}
  if (agent.workspace.mode === 'git-repo') {
    served.primary = bareRepo('main')
    serve(workspaces.primaryRoot(agent).cloneUrl, served.primary.url)
  }
  for (const root of workspaces.secondaryRoots(agent)) {
    served[root.repoFullName] = bareRepo(branches[root.repoFullName] ?? 'main')
    serve(root.cloneUrl, served[root.repoFullName]!.url)
  }
  return served
}

const confined = (extra: Partial<PrepareSessionWorkspaceRequest> = {}): PrepareSessionWorkspaceRequest => ({
  sessionKey: KEY,
  isolation: 'session',
  initiatedBy: 'Ada Lovelace',
  confined: true,
  ...extra
})

const leafOf = (agent: Agent) => workspaces.sessionDir(agent, KEY)
const idOf = () => workspaces.sessionWorktreeId(KEY)

/** One pull request on the served primary: a commit on top of `main`, published as `refs/pull/7/head`. */
function publishPullRequest(seed: string, content: string): { base: string; head: string } {
  writeFileSync(join(seed, 'feature.md'), content)
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', `feature: ${content.trim()}`])
  git(seed, ['push', '-q', 'origin', 'HEAD:refs/pull/7/head'])
  return { base: git(seed, ['rev-parse', 'origin/main']), head: git(seed, ['rev-parse', 'HEAD']) }
}

describe('a confined session gets its own clone of every root (git-workspace-model §11)', () => {
  it('lays the session out under sessions/<leaf>: a blobless clone as the cwd on its own branch, the primary untouched', async () => {
    const agent = agentFixture()
    const { primary } = serveAll(agent)
    const home = workspaces.agentRootFor(agent)

    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())

    const leaf = leafOf(agent)
    expect(leaf).toBe(join(home, 'sessions', hostKeyDirName(sessionHostKey(agent.id, KEY))))
    expect(cwd).toBe(realpathSync(join(leaf, 'workspace')))
    expect(statSync(join(cwd, '.git')).isDirectory()).toBe(true)
    expect(git(cwd, ['symbolic-ref', '--short', 'HEAD'])).toMatch(/^dev\/ada-lovelace\/[a-z]+-[a-z]+$/)
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(git(primary!.seed, ['rev-parse', 'origin/main']))
    // A blobless partial clone straight from the remote: no alternates, no upstream on the session branch.
    expect(git(cwd, ['config', '--get', 'remote.origin.partialclonefilter'])).toBe('blob:none')
    expect(existsSync(join(cwd, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    expect(() => git(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toThrow()
    // The primary is not the parent of anything: no worktrees parent, no session branch, one checkout.
    const checkout = agent.workspace.path
    expect(existsSync(join(checkout, '.git'))).toBe(true)
    expect(existsSync(join(home, 'worktrees'))).toBe(false)
    expect(git(checkout, ['branch', '--list', 'dev/*'])).toBe('')
    expect(git(checkout, ['worktree', 'list']).split('\n')).toHaveLength(1)
  })

  it('keeps the clone, its branch and its files across turns', async () => {
    const agent = agentFixture()
    serveAll(agent)
    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())
    const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD'])
    writeFileSync(join(cwd, 'notes.md'), 'kept\n')

    const again = await workspaces.prepareSessionWorkspace(agent, confined())

    expect(again).toBe(cwd)
    expect(git(cwd, ['symbolic-ref', '--short', 'HEAD'])).toBe(branch)
    expect(existsSync(join(cwd, 'notes.md'))).toBe(true)
    expect(workspaces.sessionWorktreePath(agent, KEY)).toBe(join(leafOf(agent), 'workspace'))
  })

  it('pins the credential helper in a github-app clone and converges its origin on resume', async () => {
    const agent = agentFixture({ githubApp: true })
    serveAll(agent)
    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())

    expect(git(cwd, ['config', '--get-all', 'credential.https://github.com.helper'])).toContain(SHIM)
    // The fixture's `file://` origin is what a real clone would have recorded as the authorized URL.
    git(agent.workspace.path, ['remote', 'set-url', 'origin', PRIMARY_URL])
    // A resumed clone is converged like a resumed primary: an origin off the managed host is refused...
    await expect(workspaces.prepareSessionWorkspace(agent, confined())).rejects.toThrow(/trusted GitHub remote/)
    // ...and one on it is repointed at the authorized repository.
    git(cwd, ['remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git'])
    expect(await workspaces.prepareSessionWorkspace(agent, confined())).toBe(cwd)
    expect(git(cwd, ['remote', 'get-url', 'origin'])).toBe(PRIMARY_URL)
  })

  it('clones every secondary root under repos/<owner>/<repo> of the same leaf and hands them out', async () => {
    const agent = agentFixture({ additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42' }] })
    const served = serveAll(agent, { 'acme/infra': 'trunk' })
    const home = workspaces.agentRootFor(agent)

    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())

    const infra = join(leafOf(agent), 'repos', 'acme', 'infra')
    expect(statSync(join(infra, '.git')).isDirectory()).toBe(true)
    expect(git(infra, ['symbolic-ref', '--short', 'HEAD'])).toMatch(/^dev\/ada-lovelace\//)
    expect(git(infra, ['rev-parse', 'HEAD'])).toBe(git(served['acme/infra']!.seed, ['rev-parse', 'origin/trunk']))
    expect(git(infra, ['config', '--get', 'remote.origin.partialclonefilter'])).toBe('blob:none')
    expect(existsSync(join(infra, '.git', 'objects', 'info', 'alternates'))).toBe(false)
    const scope = { sessionKey: KEY, isolation: 'session' as const }
    expect(await workspaces.sessionAdditionalRoots(agent, scope)).toEqual([
      { path: realpathSync(infra), repoFullName: 'acme/infra', branch: 'trunk' }
    ])
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd, scope)).toEqual([realpathSync(infra)])
    // The shared secondary checkout stays what it was: materialized for the console, no worktrees.
    expect(existsSync(join(home, 'repos', 'acme', 'infra', 'checkout', '.git'))).toBe(true)
    expect(existsSync(join(home, 'repos', 'acme', 'infra', 'worktrees'))).toBe(false)
  })

  it('keeps a scratch primary as the cwd while its secondaries get session clones', async () => {
    const agent = agentFixture({
      mode: 'from-scratch',
      additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42' }]
    })
    serveAll(agent)

    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())

    expect(cwd).toBe(agent.workspace.path)
    const infra = join(leafOf(agent), 'repos', 'acme', 'infra')
    expect(statSync(join(infra, '.git')).isDirectory()).toBe(true)
    expect(existsSync(join(leafOf(agent), 'workspace'))).toBe(false)
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, cwd, { sessionKey: KEY, isolation: 'session' })
    ).toEqual([realpathSync(infra)])
  })

  it('fetches a review into the clone, verifies HEAD exactly, and leaves no ref in the primary', async () => {
    const agent = agentFixture()
    const { primary } = serveAll(agent)
    const first = publishPullRequest(primary!.seed, 'pr\n')

    const cwd = await workspaces.prepareSessionWorkspace(
      agent,
      confined({ review: { pullNumber: 7, baseSha: first.base, headSha: first.head } })
    )

    const headRef = `refs/agentconnect/reviews/${idOf()}/head`
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(first.head)
    expect(git(cwd, ['rev-parse', headRef])).toBe(first.head)
    expect(git(cwd, ['rev-parse', `refs/agentconnect/reviews/${idOf()}/base`])).toBe(first.base)
    expect(existsSync(join(cwd, 'feature.md'))).toBe(true)
    expect(() => git(agent.workspace.path, ['rev-parse', '--verify', '--quiet', headRef])).toThrow()

    // A later delivery re-fetches the exact revision and resets the clone, dirt and all.
    const second = publishPullRequest(primary!.seed, 'pr v2\n')
    writeFileSync(join(cwd, 'scratch.txt'), 'dropped\n')
    const again = await workspaces.prepareSessionWorkspace(
      agent,
      confined({ review: { pullNumber: 7, baseSha: second.base, headSha: second.head } })
    )
    expect(again).toBe(cwd)
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(second.head)
    expect(existsSync(join(cwd, 'scratch.txt'))).toBe(false)
    expect(git(cwd, ['status', '--porcelain'])).toBe('')
  })

  it('fails the session when the clone fails, leaving no worktree behind', async () => {
    const agent = agentFixture()
    serveAll(agent)
    await workspaces.prepareWorkspace(agent)
    serve(PRIMARY_URL, `file://${join(tempRoot('ac-session-clone-missing-'), 'nowhere.git')}`)

    await expect(workspaces.prepareSessionWorkspace(agent, confined())).rejects.toThrow(/session clone of .* failed/)

    expect(existsSync(join(workspaces.agentRootFor(agent), 'worktrees'))).toBe(false)
    expect(existsSync(join(leafOf(agent), 'workspace'))).toBe(false)
    expect(workspaces.confinedSessionDir(agent, KEY)).toBeUndefined()
  })

  it('resolves the console session root, and a repo-scoped one, to the clone', async () => {
    const agent = agentFixture({ additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42' }] })
    serveAll(agent)
    await workspaces.prepareSessionWorkspace(agent, confined())
    const scope = createWorkspaceScope({
      workspaces,
      agentOf: () => agent,
      sessionOf: async () => ({ key: KEY, workspaceIsolation: 'session' }),
      runtimeRootOf: () => undefined
    })

    expect(await scope.gitRoot(agent.id, 'sid-1')).toBe(join(leafOf(agent), 'workspace'))
    expect(await scope.gitRoot(agent.id, 'sid-1', 'acme/infra')).toBe(join(leafOf(agent), 'repos', 'acme', 'infra'))
    expect(await scope.gitRoot(agent.id)).toBe(agent.workspace.path)
  })

  it('grants a confined session its own directory alone as a workspace write root', async () => {
    const agent = agentFixture()
    serveAll(agent)
    const home = workspaces.agentRootFor(agent)
    expect(workspaces.trustedWorkspaceWriteRoots(agent, KEY)).toEqual([join(home, 'worktrees'), join(home, 'repos')])

    await workspaces.prepareSessionWorkspace(agent, confined())

    expect(workspaces.trustedWorkspaceWriteRoots(agent, KEY)).toEqual([leafOf(agent)])
    // The agent's shared host, and a session without a directory of its own, keep the worktree tier's parents.
    expect(workspaces.trustedWorkspaceWriteRoots(agent)).toEqual([join(home, 'worktrees'), join(home, 'repos')])
    expect(workspaces.trustedWorkspaceWriteRoots(agent, 'slack:C1:other')).toEqual([
      join(home, 'worktrees'),
      join(home, 'repos')
    ])
  })

  it('keeps the worktree tier for an unconfined request', async () => {
    const agent = agentFixture()
    serveAll(agent)

    const cwd = await workspaces.prepareSessionWorkspace(agent, { sessionKey: KEY, isolation: 'session' })

    expect(cwd).toBe(realpathSync(join(workspaces.agentRootFor(agent), 'worktrees', idOf())))
    expect(statSync(join(cwd, '.git')).isFile()).toBe(true)
    expect(existsSync(join(workspaces.agentRootFor(agent), 'sessions'))).toBe(false)
  })
})

describe('retiring a confined session', () => {
  it('removes the whole session directory when every clone is clean and pushed', async () => {
    const agent = agentFixture({ additionalRepos: [{ repoFullName: 'acme/infra', repoId: '42' }] })
    serveAll(agent)
    await workspaces.prepareSessionWorkspace(agent, confined())
    expect(existsSync(leafOf(agent))).toBe(true)

    expect(await workspaces.removeSessionWorktree(agent, KEY)).toEqual({ outcome: 'removed' })

    expect(existsSync(leafOf(agent))).toBe(false)
    expect(workspaces.confinedSessionDir(agent, KEY)).toBeUndefined()
    expect(existsSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout', '.git'))).toBe(true)
  })

  it('retains a dirty clone', async () => {
    const agent = agentFixture()
    serveAll(agent)
    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())
    writeFileSync(join(cwd, 'wip.md'), 'unsaved\n')

    expect(await workspaces.removeSessionWorktree(agent, KEY)).toEqual({ outcome: 'retained', reason: 'dirty' })
    expect(existsSync(join(cwd, 'wip.md'))).toBe(true)
  })

  it('retains a clone with commits no remote holds, on any of its branches', async () => {
    const agent = agentFixture()
    serveAll(agent)
    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())
    git(cwd, ['checkout', '-q', '-b', 'side'])
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'only here'])
    git(cwd, ['checkout', '-q', '-'])

    expect(await workspaces.removeSessionWorktree(agent, KEY)).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })
    expect(existsSync(cwd)).toBe(true)
  })

  it('removes a dirty review snapshot — its refs mark it daemon-owned and reset on delivery', async () => {
    const agent = agentFixture()
    const { primary } = serveAll(agent)
    const pr = publishPullRequest(primary!.seed, 'pr\n')
    const cwd = await workspaces.prepareSessionWorkspace(
      agent,
      confined({ review: { pullNumber: 7, baseSha: pr.base, headSha: pr.head } })
    )
    writeFileSync(join(cwd, 'wip.md'), 'disposable\n')
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'disposable too'])

    expect(await workspaces.removeSessionWorktree(agent, KEY)).toEqual({ outcome: 'removed' })
    expect(existsSync(leafOf(agent))).toBe(false)
  })

  it('sweeps a legacy worktree of the same session along with its directory', async () => {
    const agent = agentFixture()
    serveAll(agent)
    const worktree = await workspaces.prepareSessionWorkspace(agent, { sessionKey: KEY, isolation: 'session' })
    expect(statSync(join(worktree, '.git')).isFile()).toBe(true)
    const clone = await workspaces.prepareSessionWorkspace(agent, confined())
    expect(clone).toBe(realpathSync(join(leafOf(agent), 'workspace')))

    expect(await workspaces.removeSessionWorktree(agent, KEY)).toEqual({ outcome: 'removed' })

    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(leafOf(agent))).toBe(false)
    expect(git(agent.workspace.path, ['worktree', 'list']).split('\n')).toHaveLength(1)
    expect(git(agent.workspace.path, ['branch', '--list', 'dev/*'])).toBe('')
  })
})

describe('a confined session across workspace changes', () => {
  // A replaced workspace makes every session directory describe a repository the agent no longer has: they go with the worktrees, and the next turn re-clones from the new definition.
  it('discards every session directory when the workspace is replaced, and re-clones on the next turn', async () => {
    const agent = agentFixture()
    const { primary } = serveAll(agent)
    const cwd = await workspaces.prepareSessionWorkspace(agent, confined())
    const oldTip = git(cwd, ['rev-parse', 'HEAD'])
    git(primary!.seed, ['checkout', '-q', '-b', 'trunk'])
    writeFileSync(join(primary!.seed, 'TRUNK.md'), 'trunk\n')
    git(primary!.seed, ['add', '-A'])
    git(primary!.seed, ['commit', '-q', '-m', 'trunk only'])
    git(primary!.seed, ['push', '-q', 'origin', 'trunk'])
    const trunkTip = git(primary!.seed, ['rev-parse', 'HEAD'])
    const onTrunk = { ...agent, workspace: { ...agent.workspace, gitBranch: 'trunk' } } as Agent

    const rollback = await workspaces.prepareWorkspaceForActivation(onTrunk, { reconcileMaterialization: true })

    expect(existsSync(join(workspaces.agentRootFor(agent), 'sessions'))).toBe(false)
    expect(workspaces.confinedSessionDir(onTrunk, KEY)).toBeUndefined()
    expect(git(onTrunk.workspace.path, ['symbolic-ref', '--short', 'HEAD'])).toBe('trunk')
    const again = await workspaces.prepareSessionWorkspace(onTrunk, confined())
    expect(again).toBe(cwd)
    expect(git(again, ['rev-parse', 'HEAD'])).toBe(trunkTip)
    expect(git(again, ['rev-parse', 'HEAD'])).not.toBe(oldTip)
    expect(existsSync(join(again, 'TRUNK.md'))).toBe(true)
    expect(rollback).toBeTypeOf('function')
  })

  it('follows a canonical rename onto every session clone with the primary, reporting the ones that will not', async () => {
    const agent = agentFixture({ githubApp: true })
    serveAll(agent)
    const other = 'slack:C1:1700000000.000200'
    const first = await workspaces.prepareSessionWorkspace(agent, confined())
    // The fixture's `file://` origin is what a real clone would have recorded as the authorized URL.
    git(agent.workspace.path, ['remote', 'set-url', 'origin', PRIMARY_URL])
    const second = await workspaces.prepareSessionWorkspace(agent, confined({ sessionKey: other }))
    for (const checkout of [agent.workspace.path, first, second]) {
      git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/acme/old-name.git'])
    }

    expect(await workspaces.convergeGithubAppWorkspaceRename(agent)).toEqual({ unconvergedSessions: [] })

    for (const checkout of [agent.workspace.path, first, second]) {
      expect(git(checkout, ['remote', 'get-url', 'origin'])).toBe(PRIMARY_URL)
    }
    // A clone whose origin left the managed host is reported by its leaf and left alone; the rest still follow.
    git(first, ['remote', 'set-url', 'origin', 'https://other-host.example/acme/elsewhere.git'])
    git(second, ['remote', 'set-url', 'origin', 'https://github.com/acme/old-name.git'])
    expect(await workspaces.convergeGithubAppWorkspaceRename(agent)).toEqual({
      unconvergedSessions: [hostKeyDirName(sessionHostKey(agent.id, KEY))]
    })
    expect(git(first, ['remote', 'get-url', 'origin'])).toBe('https://other-host.example/acme/elsewhere.git')
    expect(git(second, ['remote', 'get-url', 'origin'])).toBe(PRIMARY_URL)
  })
})

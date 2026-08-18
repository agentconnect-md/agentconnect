import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import {
  daemonGitCredentialTarget,
  gitFor,
  initGitInjection,
  workspaceGitLocalEnv
} from '../src/workspace/git-injection.js'
import { LocalGitRunner, type GitRunner, type GitLogEntry, type GitPullSummary } from '../src/workspace/git-runner.js'
import { WorkspaceManager, parseSymrefDefaultBranch } from '../src/workspace/workspace-manager.js'

// Real git against real repositories, no simple-git mock: what this file claims is that the remote's
// OWN default branch decides a secondary root's checkout, that an existing one is converged rather
// than re-cloned, and that a failure degrades to "this root is unavailable" — all of which a mocked
// runner could only restate as the argv this code already builds.

const workspaces = new WorkspaceManager()

// The credential pointers a github-app root's clone carries. Nothing executes the helper here: the
// fixture remotes are local paths, so git never asks for a credential.
const SHIM = join(mkdtempSync(join(tmpdir(), 'ac-secondary-shim-')), 'git-credential-helper.sh')
initGitInjection({
  targetFor: () => daemonGitCredentialTarget({ shimPath: SHIM, runDir: join(SHIM, '..') }),
  preWarm: async () => undefined,
  capabilityFor: (agentId) => `cap-${agentId}`
})

const roots: string[] = []
/** Authorized clone URL (minus any `.git`) → the local bare repository standing in for it. */
const remotes = new Map<string, string>()

afterAll(() => rmSync(join(SHIM, '..'), { recursive: true, force: true }))

afterEach(() => {
  workspaces.setGitRunnerResolver(undefined)
  workspaces.setSandboxMode(false)
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
  return execFileSync('git', args, { cwd, env: fixtureEnv(), encoding: 'utf8' })
}

/** A bare repository whose HEAD names `branch`, holding one commit and an optional `.gitmodules`. */
function bareRepo(name: string, branch: string, gitmodules?: string): string {
  const root = tempRoot(`ac-secondary-${name}-`)
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  git(root, ['init', '-q', '--bare', `--initial-branch=${branch}`, bare])
  mkdirSync(seed, { recursive: true })
  git(seed, ['init', '-q', `--initial-branch=${branch}`, '.'])
  writeFileSync(join(seed, 'README.md'), `${name}\n`)
  if (gitmodules !== undefined) writeFileSync(join(seed, '.gitmodules'), gitmodules)
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'initial'])
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-q', 'origin', branch])
  return bare
}

/** A `.gitmodules` naming one github.com submodule. */
function gitmodulesFor(repoFullName: string): string {
  return `[submodule "${repoFullName}"]\n\tpath = vendor/${repoFullName.split('/')[1]}\n\turl = https://github.com/${repoFullName}.git\n`
}

function agentFixture(
  additionalRepos: Array<{ repoFullName: string; repoId: string }>,
  overrides: { mode?: 'git-repo' | 'from-scratch'; agentDir?: string; pullOnNewSession?: boolean } = {}
): Agent {
  const home = tempRoot('ac-secondary-agent-')
  return {
    id: 'bot-multi',
    dir: home,
    name: 'bot-multi',
    status: 'active',
    runtime: 'claude',
    workspace: {
      mode: overrides.mode ?? 'git-repo',
      isolation: 'shared',
      path: join(home, 'workspace'),
      gitRepo: 'https://github.com/acme/primary-service.git',
      gitBranch: 'main',
      gitCredential: 'github-app',
      ...(overrides.agentDir !== undefined ? { agentDir: overrides.agentDir } : {}),
      additionalRepos,
      pullOnNewSession: overrides.pullOnNewSession ?? true,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  } as unknown as Agent
}

/** Point one root's authorized clone URL at a local bare repository. */
function serve(cloneUrl: string, bare: string): void {
  remotes.set(cloneUrl.replace(/\.git$/i, ''), bare)
}

function substitute(value: string): string {
  return remotes.get(value.replace(/\.git$/i, '')) ?? value
}

/**
 * Real git through the workspace runner seam, with exactly one substitution: a fixture repository's
 * authorized GitHub URL becomes its local bare path, and `file:` joins the protocol allowlist. The
 * daemon's origin policy accepts no local path, so a test cannot otherwise reach a remote at all;
 * every other argument — refspecs, flags, hardening pairs, credential pointers — is what the
 * workspace manager built.
 */
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
    const env = { ...this.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
    for (let index = 0; index < Number(env.GIT_CONFIG_COUNT ?? 0); index += 1) {
      // Only a remote's URL: rewriting every matching value would flip the `url.*.insteadOf` guard
      // around and rewrite the substituted path back again.
      if (/^remote\..*\.url$/i.test(env[`GIT_CONFIG_KEY_${index}`] ?? '')) {
        env[`GIT_CONFIG_VALUE_${index}`] = substitute(env[`GIT_CONFIG_VALUE_${index}`] ?? '')
      }
    }
    const make = (value: Record<string, string>) => gitFor(this.cwd, this.abort).env(value)
    return new LocalGitRunner(gitFor(this.cwd, this.abort), this.cwd, make).withEnv(env)
  }

  raw(args: string[]): Promise<string> {
    // Only the one subcommand that takes a URL as argv. Substituting every argument would also
    // rewrite what `remote set-url` records, hiding whether convergence repointed the checkout.
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

function useSeamRunner(): void {
  workspaces.setGitRunnerResolver((_agentId, cwd, abort) => new SeamRunner(cwd, abort))
}

/** The agent's roots, each served by a bare repository whose HEAD names the given branch. */
function serveAll(agent: Agent, branches: Record<string, string>, gitmodules: Record<string, string> = {}): void {
  useSeamRunner()
  if (agent.workspace.mode === 'git-repo') {
    serve(workspaces.primaryRoot(agent).cloneUrl, bareRepo('primary', 'main', gitmodules['primary']))
  }
  for (const root of workspaces.secondaryRoots(agent)) {
    const branch = branches[root.repoFullName]
    if (branch === undefined) continue
    serve(root.cloneUrl, bareRepo(root.repoFullName.replace('/', '-'), branch, gitmodules[root.repoFullName]))
  }
}

/** Repoint every fixture checkout at the authorized URL its real clone would have recorded. */
function restoreAuthorizedOrigins(agent: Agent): void {
  if (agent.workspace.mode === 'git-repo') {
    git(agent.workspace.path, ['remote', 'set-url', 'origin', workspaces.primaryRoot(agent).cloneUrl])
  }
  for (const root of workspaces.secondaryRoots(agent)) {
    if (existsSync(join(root.path, '.git'))) git(root.path, ['remote', 'set-url', 'origin', root.cloneUrl])
  }
}

function materialization(agent: Agent, repoFullName: string): unknown {
  const [owner, repo] = repoFullName.split('/')
  return JSON.parse(
    readFileSync(join(workspaces.agentRootFor(agent), 'repos', owner!, repo!, '.materialization.json'), 'utf8')
  )
}

describe('secondaryRoots (layout)', () => {
  it('lays each authorized repository out beside the primary, sorted by name', () => {
    const agent = agentFixture([
      { repoFullName: 'example-co/shared-library', repoId: '815' },
      { repoFullName: 'acme/infra', repoId: '42' }
    ])
    const home = workspaces.agentRootFor(agent)

    expect(
      workspaces.secondaryRoots(agent).map((root) => ({
        repoFullName: root.repoFullName,
        repoId: root.repoId,
        path: root.path,
        worktreesPath: root.worktreesPath,
        cloneUrl: root.cloneUrl,
        githubApp: root.githubApp
      }))
    ).toEqual([
      {
        repoFullName: 'acme/infra',
        repoId: '42',
        path: join(home, 'repos', 'acme', 'infra', 'checkout'),
        worktreesPath: join(home, 'repos', 'acme', 'infra', 'worktrees'),
        cloneUrl: 'https://github.com/acme/infra',
        githubApp: true
      },
      {
        repoFullName: 'example-co/shared-library',
        repoId: '815',
        path: join(home, 'repos', 'example-co', 'shared-library', 'checkout'),
        worktreesPath: join(home, 'repos', 'example-co', 'shared-library', 'worktrees'),
        cloneUrl: 'https://github.com/example-co/shared-library',
        githubApp: true
      }
    ])
  })

  it('refuses a row that is not two plain path segments', () => {
    const agent = agentFixture([
      { repoFullName: '../../etc', repoId: '1' },
      { repoFullName: 'acme/../infra', repoId: '2' },
      { repoFullName: 'acme', repoId: '3' },
      { repoFullName: 'acme/infra/extra', repoId: '4' },
      { repoFullName: '', repoId: '5' },
      { repoFullName: 'acme/infra', repoId: '6' }
    ])

    expect(workspaces.secondaryRoots(agent).map((root) => root.repoFullName)).toEqual(['acme/infra'])
  })
})

describe('secondary root materialization', () => {
  it('clones each root at the remote HEAD it actually reports and records that branch', async () => {
    const agent = agentFixture([
      { repoFullName: 'example-co/shared-library', repoId: '815' },
      { repoFullName: 'acme/infra', repoId: '42' }
    ])
    // Neither remote is on `main`: the branch has to come from `ls-remote --symref`, not a default.
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'release/v2' })

    const cwd = await workspaces.prepareWorkspace(agent)

    const home = workspaces.agentRootFor(agent)
    expect(existsSync(join(home, 'repos', 'acme', 'infra', 'checkout', '.git'))).toBe(true)
    expect(materialization(agent, 'acme/infra')).toEqual({
      repoId: '42',
      repoFullName: 'acme/infra',
      branch: 'trunk'
    })
    expect(materialization(agent, 'example-co/shared-library')).toEqual({
      repoId: '815',
      repoFullName: 'example-co/shared-library',
      branch: 'release/v2'
    })
    expect(workspaces.readySecondaryRoots(agent).map((root) => [root.repoFullName, root.branch])).toEqual([
      ['acme/infra', 'trunk'],
      ['example-co/shared-library', 'release/v2']
    ])
    expect(workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
      realpathSync(join(home, 'repos', 'acme', 'infra', 'checkout')),
      realpathSync(join(home, 'repos', 'example-co', 'shared-library', 'checkout'))
    ])
  })

  it('converges and pulls an existing checkout instead of cloning it again', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    const checkout = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout')
    writeFileSync(join(checkout, 'local-note.txt'), 'kept across sessions\n')
    // A historical origin the convergence has to repoint at the authorized URL.
    git(checkout, ['remote', 'set-url', 'origin', 'https://github.com/acme/infra-old.git'])

    await workspaces.prepareWorkspace(agent)

    expect(existsSync(join(checkout, 'local-note.txt'))).toBe(true)
    expect(git(checkout, ['remote', 'get-url', 'origin']).trim()).toBe('https://github.com/acme/infra')
    expect(workspaces.readySecondaryRoots(agent).map((root) => root.repoFullName)).toEqual(['acme/infra'])
  })

  it('skips a checkout that does not attest the row repository id, and removes nothing', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    const subtree = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra')
    const recorded = materialization(agent, 'acme/infra') as object
    writeFileSync(join(subtree, '.materialization.json'), JSON.stringify({ ...recorded, repoId: '999' }))

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([])
    // Retirement, never deletion (decision 12): the checkout is left exactly where it was.
    expect(existsSync(join(subtree, 'checkout', '.git'))).toBe(true)
    expect(readdirSync(subtree).sort()).toEqual(['.materialization.json', 'checkout'])
  })

  it('omits a root whose clone fails and still prepares the session', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    // Only one remote is reachable; the other's clone URL resolves to nothing.
    serveAll(agent, { 'acme/infra': 'trunk' })

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(cwd).toBe(realpathSync(agent.workspace.path))
    expect(workspaces.readySecondaryRoots(agent).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    expect(
      existsSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library', 'checkout', '.git'))
    ).toBe(false)
  })

  it('coalesces two sessions racing into the same root', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })

    const [first, second] = await Promise.all([workspaces.prepareWorkspace(agent), workspaces.prepareWorkspace(agent)])

    expect(second).toBe(first)
    expect(workspaces.readySecondaryRoots(agent).map((root) => root.repoFullName)).toEqual(['acme/infra'])
  })
})

describe('submodule roots (decision 11)', () => {
  it('withholds a root the primary already carries as a submodule', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' }, { primary: gitmodulesFor('acme/infra') })

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([])
    // Not handed out AND not cloned: the parent's own submodule path is where it is reachable.
    expect(existsSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'))).toBe(false)
  })

  it('withholds a root an earlier secondary carries as a submodule', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    // `acme/infra` sorts first, so its `.gitmodules` is read before the root it names is considered.
    serveAll(
      agent,
      { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' },
      { 'acme/infra': gitmodulesFor('example-co/shared-library') }
    )

    await workspaces.prepareWorkspace(agent)

    expect(workspaces.readySecondaryRoots(agent).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    expect(existsSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library', 'checkout'))).toBe(
      false
    )
  })
})

describe('additionalWorkspaceDirectories with secondary roots', () => {
  it('widens an agentDir cwd and appends the roots for a shared-isolation session', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { agentDir: 'services/api' })
    useSeamRunner()
    const primary = bareRepo('primary-with-subdir', 'main')
    const seed = join(tempRoot('ac-secondary-seed-'), 'seed')
    git(join(seed, '..'), ['clone', '-q', primary, seed])
    mkdirSync(join(seed, 'services', 'api'), { recursive: true })
    writeFileSync(join(seed, 'services', 'api', 'index.ts'), 'export {}\n')
    git(seed, ['add', '-A'])
    git(seed, ['commit', '-q', '-m', 'subdir'])
    git(seed, ['push', '-q', 'origin', 'main'])
    serve(workspaces.primaryRoot(agent).cloneUrl, primary)
    serve(workspaces.secondaryRoots(agent)[0]!.cloneUrl, bareRepo('acme-infra', 'trunk'))

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(cwd).toBe(realpathSync(join(agent.workspace.path, 'services', 'api')))
    expect(workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
      realpathSync(agent.workspace.path),
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'))
    ])
  })

  it('leaves a session-isolated session exactly as it was', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const request = { sessionKey: 'session-a', isolation: 'session' as const }
    const cwd = await workspaces.prepareSessionWorkspace(agent, request)

    expect(cwd).toBe(realpathSync(workspaces.sessionWorktreePath(agent, 'session-a')))
    expect(workspaces.additionalWorkspaceDirectories(agent, cwd, request)).toEqual([])
    expect(workspaces.readySecondaryRoots(agent, { isolation: 'session' })).toEqual([])
    expect(workspaces.readySecondaryRoots(agent, { isolation: 'shared' })).toHaveLength(1)
  })

  it('hands the roots to a from-scratch agent, which has no checkout of its own', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'))
    ])
  })

  it('prepares and hands out nothing when workspaces live in sandboxes', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    workspaces.setSandboxMode(true)

    expect(await workspaces.prepareSecondaryRoots(agent)).toEqual([])
    expect(workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(existsSync(join(workspaces.agentRootFor(agent), 'repos'))).toBe(false)
  })
})

describe('parseSymrefDefaultBranch', () => {
  it('reads the branch out of a real `ls-remote --symref` reply', () => {
    const out = `ref: refs/heads/release/v2\tHEAD\n${'a'.repeat(40)}\tHEAD\n`
    expect(parseSymrefDefaultBranch(out)).toBe('release/v2')
  })

  it('returns undefined for a detached or option-shaped HEAD', () => {
    expect(parseSymrefDefaultBranch(`${'a'.repeat(40)}\tHEAD\n`)).toBeUndefined()
    expect(parseSymrefDefaultBranch('ref: refs/heads/-oops\tHEAD\n')).toBeUndefined()
    expect(parseSymrefDefaultBranch('')).toBeUndefined()
  })
})

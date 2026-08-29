import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
    const env: Record<string, string> = { ...this.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
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
    expect((await workspaces.readySecondaryRoots(agent)).map((root) => [root.repoFullName, root.branch])).toEqual([
      ['acme/infra', 'trunk'],
      ['example-co/shared-library', 'release/v2']
    ])
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
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
    expect((await workspaces.readySecondaryRoots(agent)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
  })

  it('publishes the clone only after its attestation, so a checkout is never left unattributable', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })

    await workspaces.prepareWorkspace(agent)

    // Every state a crash can leave: no checkout, or a checkout WITH its record. The record is
    // written before the staged clone is moved into place, so the pair cannot land the other way.
    const subtree = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra')
    expect(existsSync(join(subtree, '.materialization.json'))).toBe(true)
    expect(readdirSync(subtree).filter((entry) => entry.startsWith('checkout.clone-'))).toEqual([])
  })

  it('withholds an unattributable checkout rather than re-attesting it from its origin', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    const subtree = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra')
    // An origin still names the SLUG, which is exactly what a reused name keeps — so a checkout
    // with no record stays withheld even though its origin matches the row.
    rmSync(join(subtree, '.materialization.json'))

    await workspaces.prepareWorkspace(agent)

    expect(await workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(existsSync(join(subtree, '.materialization.json'))).toBe(false)
    expect(existsSync(join(subtree, 'checkout', '.git'))).toBe(true)
  })

  it('leaves a half-staged clone from an interrupted attempt alone', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const subtree = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra')
    mkdirSync(join(subtree, 'checkout.clone-8a1f9c02-0000-4000-8000-000000000000'), { recursive: true })
    writeFileSync(join(subtree, 'checkout.clone-8a1f9c02-0000-4000-8000-000000000000', 'partial.txt'), 'half\n')

    await workspaces.prepareWorkspace(agent)

    expect((await workspaces.readySecondaryRoots(agent)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    expect(existsSync(join(subtree, 'checkout.clone-8a1f9c02-0000-4000-8000-000000000000', 'partial.txt'))).toBe(true)
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

    expect(await workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([])
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
    expect((await workspaces.readySecondaryRoots(agent)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    expect(
      existsSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library', 'checkout', '.git'))
    ).toBe(false)
  })

  it('coalesces two sessions racing into the same root', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })

    const [first, second] = await Promise.all([workspaces.prepareWorkspace(agent), workspaces.prepareWorkspace(agent)])

    expect(second).toBe(first)
    expect((await workspaces.readySecondaryRoots(agent)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
  })
})

describe('submodule roots (decision 11)', () => {
  it('withholds a root the primary already carries as a submodule', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' }, { primary: gitmodulesFor('acme/infra') })

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(await workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([])
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

    expect((await workspaces.readySecondaryRoots(agent)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
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
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
      realpathSync(agent.workspace.path),
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'))
    ])
  })

  it('hands a session-isolated session each root at its own per-session worktree', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'release/v2' })
    const request = { sessionKey: 'session-a', isolation: 'session' as const }

    const cwd = await workspaces.prepareSessionWorkspace(agent, request)

    // The SAME id across every root of one session, which is what makes the set removable as one.
    const id = workspaces.sessionWorktreeId('session-a')
    const subtree = (repoFullName: string) => join(workspaces.agentRootFor(agent), 'repos', ...repoFullName.split('/'))
    const worktree = (repoFullName: string) => join(subtree(repoFullName), 'worktrees', id)
    expect(cwd).toBe(realpathSync(workspaces.sessionWorktreePath(agent, 'session-a')))
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd, request)).toEqual([
      realpathSync(worktree('acme/infra')),
      realpathSync(worktree('example-co/shared-library'))
    ])
    // Each at its own default branch, and never the shared checkout a session-isolated agent asked
    // not to be given.
    expect(git(worktree('acme/infra'), ['rev-parse', 'HEAD']).trim()).toBe(
      git(join(subtree('acme/infra'), 'checkout'), ['rev-parse', 'refs/remotes/origin/trunk']).trim()
    )
    expect((await workspaces.readySecondaryRoots(agent, request)).map((root) => [root.path, root.branch])).toEqual([
      [realpathSync(worktree('acme/infra')), 'trunk'],
      [realpathSync(worktree('example-co/shared-library')), 'release/v2']
    ])
    // The shared view of the same prepared set still names the checkouts.
    expect((await workspaces.readySecondaryRoots(agent, { isolation: 'shared' })).map((root) => root.path)).toEqual([
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout')),
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library', 'checkout'))
    ])
  })

  it('gives a from-scratch agent secondary worktrees while its scratch directory stays the cwd', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })
    const request = { sessionKey: 'session-a', isolation: 'session' as const }

    const cwd = await workspaces.prepareSessionWorkspace(agent, request)

    expect(cwd).toBe(agent.workspace.path)
    const worktree = join(
      workspaces.agentRootFor(agent),
      'repos',
      'acme',
      'infra',
      'worktrees',
      workspaces.sessionWorktreeId('session-a')
    )
    expect(existsSync(join(worktree, '.git'))).toBe(true)
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd, request)).toEqual([realpathSync(worktree)])
  })

  it('omits a root whose session worktree cannot be created and still prepares the session', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    // A symlinked worktrees parent is refused for a secondary exactly as it is for the primary.
    const subtree = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra')
    symlinkSync(tempRoot('ac-secondary-elsewhere-'), join(subtree, 'worktrees'), 'dir')
    const request = { sessionKey: 'session-a', isolation: 'session' as const }

    const cwd = await workspaces.prepareSessionWorkspace(agent, request)

    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd, request)).toEqual([
      realpathSync(
        join(
          workspaces.agentRootFor(agent),
          'repos',
          'example-co',
          'shared-library',
          'worktrees',
          workspaces.sessionWorktreeId('session-a')
        )
      )
    ])
  })

  it('hands the roots to a from-scratch agent, which has no checkout of its own', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })

    const cwd = await workspaces.prepareWorkspace(agent)

    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd)).toEqual([
      realpathSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'))
    ])
  })
})

describe('sandbox write roots', () => {
  it('grants the secondary parent to every sandboxed agent, scratch workspaces included', () => {
    const repo = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    const scratch = agentFixture([], { mode: 'from-scratch' })

    // A row added under a long-lived host must already be inside the boundary, so the PARENT is
    // granted rather than the roots that happen to exist right now.
    expect(workspaces.trustedWorkspaceWriteRoots(repo)).toEqual([
      join(workspaces.agentRootFor(repo), 'worktrees'),
      join(workspaces.agentRootFor(repo), 'repos')
    ])
    expect(workspaces.trustedWorkspaceWriteRoots(scratch)).toEqual([join(workspaces.agentRootFor(scratch), 'repos')])
  })
})

describe('review of a secondary root (decisions 5, 6 and 11)', () => {
  /** The local bare repository standing in for one root's authorized clone URL. */
  function remoteOf(repoFullName: string): string {
    return remotes.get(`https://github.com/${repoFullName}`)!
  }

  /** The refs GitHub publishes for one pull request, seeded into a fixture remote. */
  function seedPullRequest(
    bare: string,
    branch: string,
    pullNumber: number,
    options: { merge?: boolean } = {}
  ): { base: string; head: string; merge?: string } {
    const home = tempRoot('ac-secondary-pull-')
    const seed = join(home, 'seed')
    git(home, ['clone', '-q', bare, 'seed'])
    const base = git(seed, ['rev-parse', 'HEAD']).trim()
    git(seed, ['checkout', '-q', '-b', `pull-${pullNumber}`])
    writeFileSync(join(seed, `feature-${pullNumber}.txt`), 'proposed change\n')
    git(seed, ['add', '-A'])
    git(seed, ['commit', '-q', '-m', `feature ${pullNumber}`])
    const head = git(seed, ['rev-parse', 'HEAD']).trim()
    const refs = [`${head}:refs/pull/${pullNumber}/head`]
    let merge: string | undefined
    if (options.merge !== false) {
      git(seed, ['checkout', '-q', branch])
      git(seed, ['merge', '-q', '--no-ff', '-m', `merge ${pullNumber}`, head])
      merge = git(seed, ['rev-parse', 'HEAD']).trim()
      refs.push(`${merge}:refs/pull/${pullNumber}/merge`)
    }
    // The branch itself stays where it was: a pull request is its refs, not a pushed base.
    git(seed, ['push', '-q', 'origin', ...refs])
    // The daemon fetches the base BY SHA, which a fixture remote has to allow the way GitHub does.
    git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    return { base, head, ...(merge !== undefined ? { merge } : {}) }
  }

  function reviewRequest(
    sessionKey: string,
    repoFullName: string,
    pullNumber: number,
    pull: { base: string; head: string; merge?: string }
  ) {
    return {
      sessionKey,
      isolation: 'session' as const,
      reviewRepoFullName: repoFullName,
      review: {
        pullNumber,
        baseSha: pull.base,
        headSha: pull.head,
        ...(pull.merge !== undefined ? { mergeCommitSha: pull.merge } : {})
      }
    }
  }

  const worktreeOf = (agent: Agent, repoFullName: string, sessionKey: string) =>
    join(
      workspaces.agentRootFor(agent),
      'repos',
      ...repoFullName.split('/'),
      'worktrees',
      workspaces.sessionWorktreeId(sessionKey)
    )

  it('makes the reviewed root the cwd at the exact merge, with every other root a default-branch reference', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 7)
    const request = reviewRequest('session-review', 'acme/infra', 7, pull)

    const cwd = await workspaces.prepareSessionWorkspace(agent, request)

    expect(cwd).toBe(realpathSync(worktreeOf(agent, 'acme/infra', 'session-review')))
    expect(git(cwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.merge)
    // The primary and the other secondary ride along, each at its own default branch.
    const primaryWorktree = realpathSync(workspaces.sessionWorktreePath(agent, 'session-review'))
    const shared = realpathSync(worktreeOf(agent, 'example-co/shared-library', 'session-review'))
    expect(await workspaces.additionalWorkspaceDirectories(agent, cwd, request)).toEqual([primaryWorktree, shared])
    // And the same answer without the request naming the review, which is how a session's later
    // hand-outs ask: the reviewed root's own subtree attests that it took the cwd.
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, cwd, {
        sessionKey: 'session-review',
        isolation: 'session'
      })
    ).toEqual([primaryWorktree, shared])
    expect(
      (await workspaces.sessionAdditionalRoots(agent, { sessionKey: 'session-review', isolation: 'session' })).map(
        (root) => [root.repoFullName, root.branch]
      )
    ).toEqual([
      ['acme/primary-service', 'main'],
      ['example-co/shared-library', 'main']
    ])
    // The reviewed root is the working directory, so it is nobody's additional directory.
    expect((await workspaces.readySecondaryRoots(agent, request)).map((root) => root.repoFullName)).toEqual([
      'example-co/shared-library'
    ])
    expect(git(primaryWorktree, ['rev-parse', 'HEAD']).trim()).toBe(
      git(agent.workspace.path, ['rev-parse', 'refs/remotes/origin/main']).trim()
    )
  })

  it('keeps a resumed session in the reviewed root, in a process that never prepared it', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 17)
    const cwd = await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-resume', 'acme/infra', 17, pull))
    restoreAuthorizedOrigins(agent)

    // A daemon restart or a host eviction re-prepares the SAME session from a request carrying no
    // review at all, in a manager that remembers nothing.
    const restarted = new WorkspaceManager()
    restarted.setGitRunnerResolver((_agentId, dir, abort) => new SeamRunner(dir, abort))
    const resumed = { sessionKey: 'session-resume', isolation: 'session' as const }

    const resumedCwd = await restarted.prepareSessionWorkspace(agent, resumed)

    expect(resumedCwd).toBe(cwd)
    expect(git(resumedCwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.merge)
    expect(await restarted.additionalWorkspaceDirectories(agent, resumedCwd, resumed)).toEqual([
      realpathSync(restarted.sessionWorktreePath(agent, 'session-resume')),
      realpathSync(worktreeOf(agent, 'example-co/shared-library', 'session-resume'))
    ])
  })

  it('keeps a resumed scratch-workspace session in the reviewed root, whose isolation reads shared', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 19)
    const cwd = await workspaces.prepareSessionWorkspace(
      agent,
      reviewRequest('session-scratch-resume', 'acme/infra', 19, pull)
    )
    restoreAuthorizedOrigins(agent)

    // A scratch workspace has no clone to branch, so its sessions report `shared` isolation — which
    // must not send this one back to the scratch directory it never worked in.
    const restarted = new WorkspaceManager()
    restarted.setGitRunnerResolver((_agentId, dir, abort) => new SeamRunner(dir, abort))

    const resumedCwd = await restarted.prepareSessionWorkspace(agent, {
      sessionKey: 'session-scratch-resume',
      isolation: 'shared'
    })

    expect(resumedCwd).toBe(cwd)
    expect(git(resumedCwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.merge)
  })

  it('drops the attestation when the session degrades to a revision-only workspace', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 20)
    await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-degraded', 'acme/infra', 20, pull))

    // A later delivery whose exact checkout is unavailable takes the empty daemon-owned cwd instead.
    const revisionOnly = {
      sessionKey: 'session-degraded',
      isolation: 'session' as const,
      githubReviewRevisionOnly: true as const
    }
    const cwd = await workspaces.prepareSessionWorkspace(agent, revisionOnly)

    expect(cwd).toBe(realpathSync(workspaces.sessionWorktreePath(agent, 'session-degraded')))
    // No root still claims the working directory, so the fallback cwd is accepted rather than
    // measured against a checkout the session no longer stands in.
    await expect(
      workspaces.additionalWorkspaceDirectories(agent, cwd, {
        sessionKey: 'session-degraded',
        isolation: 'session'
      })
    ).resolves.toBeDefined()
  })

  it('lets a swept session fall back to the primary, so a stale attestation captures nothing', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 18)
    await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-swept', 'acme/infra', 18, pull))
    expect(await workspaces.removeSessionWorktree(agent, 'session-swept')).toEqual({ outcome: 'removed' })
    restoreAuthorizedOrigins(agent)

    const cwd = await workspaces.prepareSessionWorkspace(agent, {
      sessionKey: 'session-swept',
      isolation: 'session'
    })

    expect(cwd).toBe(realpathSync(workspaces.sessionWorktreePath(agent, 'session-swept')))
  })

  it('checks the reviewed root out at the exact head when the pull request has no merge ref', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 11, { merge: false })

    const cwd = await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-head', 'acme/infra', 11, pull))

    expect(cwd).toBe(realpathSync(worktreeOf(agent, 'acme/infra', 'session-head')))
    expect(git(cwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.head)
  })

  it('materializes a submodule root for its own review, which ordinary sessions still never see', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' }, { primary: gitmodulesFor('acme/infra') })
    const ordinary = { sessionKey: 'session-plain', isolation: 'session' as const }
    const ordinaryCwd = await workspaces.prepareSessionWorkspace(agent, ordinary)
    expect(await workspaces.additionalWorkspaceDirectories(agent, ordinaryCwd, ordinary)).toEqual([])
    restoreAuthorizedOrigins(agent)
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 4)

    const cwd = await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-sub', 'acme/infra', 4, pull))

    expect(cwd).toBe(realpathSync(worktreeOf(agent, 'acme/infra', 'session-sub')))
    expect(git(cwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.merge)
    // Its own review gets the exact checkout; an ordinary session still reaches it only through the
    // parent's submodule path, so it is handed to nobody as an additional directory.
    expect(await workspaces.readySecondaryRoots(agent)).toEqual([])
    expect(await workspaces.additionalWorkspaceDirectories(agent, ordinaryCwd, ordinary)).toEqual([])
  })

  it('refuses a review of a repository this agent has no root for, leaving nothing behind', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = { base: 'a'.repeat(40), head: 'b'.repeat(40) }

    await expect(
      workspaces.prepareSessionWorkspace(agent, reviewRequest('session-unknown', 'example-co/elsewhere', 9, pull))
    ).rejects.toThrow('is not a workspace root')

    // Nothing was materialized for it, and no worktree was left for the caller's fallback to remove.
    expect(existsSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co'))).toBe(false)
    expect(existsSync(workspaces.sessionWorktreePath(agent, 'session-unknown'))).toBe(false)
  })

  it('keeps the primary the working directory when the review names it', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/primary-service'), 'main', 12)

    const cwd = await workspaces.prepareSessionWorkspace(
      agent,
      reviewRequest('session-primary', 'acme/primary-service.git', 12, pull)
    )

    expect(cwd).toBe(realpathSync(workspaces.sessionWorktreePath(agent, 'session-primary')))
    expect(git(cwd, ['rev-parse', 'HEAD']).trim()).toBe(pull.merge)
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, cwd, {
        sessionKey: 'session-primary',
        isolation: 'session'
      })
    ).toEqual([realpathSync(worktreeOf(agent, 'acme/infra', 'session-primary'))])
  })

  it('hands a reviewed session the directories it was prepared with, whatever isolation a later read names', async () => {
    const agent = agentFixture(
      [
        { repoFullName: 'acme/infra', repoId: '42' },
        { repoFullName: 'example-co/shared-library', repoId: '815' }
      ],
      { mode: 'from-scratch' }
    )
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 31)

    const cwd = await workspaces.prepareSessionWorkspace(
      agent,
      reviewRequest('session-scratch', 'acme/infra', 31, pull)
    )

    expect(cwd).toBe(realpathSync(worktreeOf(agent, 'acme/infra', 'session-scratch')))
    // A scratch workspace reports `shared` isolation of its own, having no clone to branch: a
    // session standing in a reviewed root is per-session whatever that report says.
    expect(
      await workspaces.additionalWorkspaceDirectories(agent, cwd, {
        sessionKey: 'session-scratch',
        isolation: 'shared'
      })
    ).toEqual([realpathSync(worktreeOf(agent, 'example-co/shared-library', 'session-scratch'))])
  })

  it('sweeps the reviewed root’s worktree and its review refs with the rest of the session', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    const pull = seedPullRequest(remoteOf('acme/infra'), 'trunk', 21)
    const cwd = await workspaces.prepareSessionWorkspace(agent, reviewRequest('session-gc', 'acme/infra', 21, pull))
    const checkout = join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout')
    const id = workspaces.sessionWorktreeId('session-gc')
    expect(git(checkout, ['for-each-ref', '--format=%(refname)', `refs/agentconnect/reviews/${id}`]).trim()).not.toBe(
      ''
    )

    expect(await workspaces.removeSessionWorktree(agent, 'session-gc')).toEqual({ outcome: 'removed' })

    expect(existsSync(cwd)).toBe(false)
    expect(existsSync(workspaces.sessionWorktreePath(agent, 'session-gc'))).toBe(false)
    // The daemon-owned review refs are per root, and they go with that root's worktree.
    expect(git(checkout, ['for-each-ref', '--format=%(refname)', `refs/agentconnect/reviews/${id}`]).trim()).toBe('')
  })
})

describe('removeSessionWorktree across every root (decision 4)', () => {
  it('removes the primary and every secondary worktree of one session', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    const id = workspaces.sessionWorktreeId('session-a')
    const secondary = (repoFullName: string) =>
      join(workspaces.agentRootFor(agent), 'repos', ...repoFullName.split('/'), 'worktrees', id)

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })

    expect(existsSync(workspaces.sessionWorktreePath(agent, 'session-a'))).toBe(false)
    expect(existsSync(secondary('acme/infra'))).toBe(false)
    expect(existsSync(secondary('example-co/shared-library'))).toBe(false)
  })

  it('keeps the session when one secondary worktree is dirty, and reports that another root went', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    const secondary = join(
      workspaces.agentRootFor(agent),
      'repos',
      'acme',
      'infra',
      'worktrees',
      workspaces.sessionWorktreeId('session-a')
    )
    writeFileSync(join(secondary, 'scratch.txt'), 'unsaved\n')

    // `partial` is what the caller needs: the clean primary is already gone, so a warm attachment
    // pointed at it is stale even though the retained secondary keeps the session.
    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({
      outcome: 'retained',
      reason: 'dirty',
      partial: true
    })
    expect(existsSync(join(secondary, 'scratch.txt'))).toBe(true)
    expect(existsSync(workspaces.sessionWorktreePath(agent, 'session-a'))).toBe(false)
  })

  it('ignores a subtree a failed clone left behind instead of failing the whole cleanup', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    // Exactly what a failed secondary preparation leaves: the subtree exists with no checkout and
    // no worktrees, so there is no repository for Git to run in.
    mkdirSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library'), { recursive: true })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })
  })

  it('removes a scratch agent’s secondary worktrees, which have no primary beside them', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })

    expect(await workspaces.removeSessionWorktree(agent, 'session-a')).toEqual({ outcome: 'removed' })
    expect(await workspaces.hasSessionWorktreeRoots(agent)).toBe(true)
  })

  it('keeps a scratch agent in scope once its last row is gone, because the root only retired', () => {
    // The prefilter the retention GC applies before it binds anything. A retired root keeps its
    // worktrees (decision 12), so the rows alone would let this session's worktree be purged
    // without the dirty/unique-commit rules ever running against it.
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }], { mode: 'from-scratch' })
    serveAll(agent, { 'acme/infra': 'trunk' })
    mkdirSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', 'checkout'), { recursive: true })
    const retired = { ...agent, workspace: { ...agent.workspace, additionalRepos: [] } } as Agent

    expect(workspaces.mayOwnSessionWorktrees(retired)).toBe(true)
    // A scratch agent that never had one is out of scope, and takes no admission fence for nothing.
    expect(workspaces.mayOwnSessionWorktrees(agentFixture([], { mode: 'from-scratch' }))).toBe(false)
  })

  it('reports absent when no root has a worktree for the session', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)

    expect(await workspaces.removeSessionWorktree(agent, 'session-never-opened')).toEqual({ outcome: 'absent' })
  })
})

describe('retire → sweep → remove (decision 12)', () => {
  /** The agent again, with a different set of authorized rows over the SAME agent directory. */
  function reauthorized(agent: Agent, rows: Array<{ repoFullName: string; repoId: string }>): Agent {
    return { ...agent, workspace: { ...agent.workspace, additionalRepos: rows } } as Agent
  }

  it('retires a subtree whose repository id is no longer authorized', async () => {
    const agent = agentFixture([
      { repoFullName: 'acme/infra', repoId: '42' },
      { repoFullName: 'example-co/shared-library', repoId: '815' }
    ])
    serveAll(agent, { 'acme/infra': 'trunk', 'example-co/shared-library': 'main' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)

    const after = reauthorized(agent, [{ repoFullName: 'acme/infra', repoId: '42' }])
    expect((await workspaces.retiredSecondaryRoots(after)).map((root) => root.repoFullName)).toEqual([
      'example-co/shared-library'
    ])
    // Retirement alone removes nothing, and it drops out of the hand-out at once.
    await workspaces.prepareWorkspace(after)
    expect((await workspaces.readySecondaryRoots(after)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    expect(
      existsSync(join(workspaces.agentRootFor(agent), 'repos', 'example-co', 'shared-library', 'checkout', '.git'))
    ).toBe(true)
  })

  it('retires the directory a rename moved the repository out of, and re-authorizing un-retires in place', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)

    // Same repository id, new slug: the old directory is retired while the new one materializes.
    const renamed = reauthorized(agent, [{ repoFullName: 'acme/infrastructure', repoId: '42' }])
    expect((await workspaces.retiredSecondaryRoots(renamed)).map((root) => root.repoFullName)).toEqual(['acme/infra'])
    // Re-authorizing the original slug un-retires it with nothing on disk having changed.
    expect(await workspaces.retiredSecondaryRoots(agent)).toEqual([])
  })

  it('leaves a subtree with no attestation alone rather than retiring it', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    rmSync(join(workspaces.agentRootFor(agent), 'repos', 'acme', 'infra', '.materialization.json'))

    expect(await workspaces.retiredSecondaryRoots(reauthorized(agent, []))).toEqual([])
  })

  it('refuses a retired root while any worktree of it survives, and removes it once none does', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareSessionWorkspace(agent, { sessionKey: 'session-a', isolation: 'session' })
    const after = reauthorized(agent, [])
    const [retired] = await workspaces.retiredSecondaryRoots(after)

    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({
      outcome: 'retained',
      reason: 'worktrees'
    })
    expect(existsSync(retired!.subtree)).toBe(true)

    await workspaces.removeSessionWorktree(after, 'session-a')
    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({ outcome: 'removed' })
    expect(existsSync(retired!.subtree)).toBe(false)
  })

  it('refuses a retired root whose checkout is dirty or holds commits no remote has', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    const after = reauthorized(agent, [])
    const [retired] = await workspaces.retiredSecondaryRoots(after)
    writeFileSync(join(retired!.path, 'unsaved.txt'), 'work\n')

    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({
      outcome: 'retained',
      reason: 'dirty'
    })

    git(retired!.path, ['add', '-A'])
    git(retired!.path, ['commit', '-q', '-m', 'local only'])
    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })
    expect(existsSync(retired!.subtree)).toBe(true)
  })

  it('refuses a retired root whose unique work is on another local ref, not the checked-out one', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    restoreAuthorizedOrigins(agent)
    const after = reauthorized(agent, [])
    const [retired] = await workspaces.retiredSecondaryRoots(after)
    // Removing the clone destroys its whole object store, so what the CHECKED-OUT branch can reach
    // does not speak for the work: a side branch and a stash are both invisible from `trunk`.
    git(retired!.path, ['checkout', '-q', '-b', 'side'])
    writeFileSync(join(retired!.path, 'sidework.txt'), 'work\n')
    git(retired!.path, ['add', '-A'])
    git(retired!.path, ['commit', '-q', '-m', 'side only'])
    git(retired!.path, ['checkout', '-q', 'trunk'])
    expect(git(retired!.path, ['status', '--porcelain']).trim()).toBe('')

    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })

    git(retired!.path, ['branch', '-q', '-D', 'side'])
    writeFileSync(join(retired!.path, 'stashed.txt'), 'work\n')
    git(retired!.path, ['add', '-A'])
    git(retired!.path, ['stash', '-q'])
    expect(git(retired!.path, ['status', '--porcelain']).trim()).toBe('')

    expect(await workspaces.removeRetiredSecondaryRoot(after, retired!)).toEqual({
      outcome: 'retained',
      reason: 'unique-commits'
    })
    expect(existsSync(retired!.subtree)).toBe(true)
  })

  it('never follows a symlinked subtree', async () => {
    const agent = agentFixture([{ repoFullName: 'acme/infra', repoId: '42' }])
    serveAll(agent, { 'acme/infra': 'trunk' })
    await workspaces.prepareWorkspace(agent)
    const after = reauthorized(agent, [])
    const [retired] = await workspaces.retiredSecondaryRoots(after)
    // A subtree that is itself a symlink is refused, so removal can never reach what it points at.
    const elsewhere = tempRoot('ac-secondary-outside-')
    writeFileSync(join(elsewhere, 'precious.txt'), 'not ours\n')
    rmSync(retired!.subtree, { recursive: true, force: true })
    symlinkSync(elsewhere, retired!.subtree, 'dir')

    const result = await workspaces.removeRetiredSecondaryRoot(after, retired!)

    expect(result.outcome).toBe('failed')
    expect(existsSync(join(elsewhere, 'precious.txt'))).toBe(true)
    // And a symlinked subtree is not even listed as a candidate on the next pass.
    expect(await workspaces.retiredSecondaryRoots(after)).toEqual([])
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

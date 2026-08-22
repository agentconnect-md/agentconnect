import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceGit } from '../src/cp/workspace-git.js'
import { WorkspaceViolationError } from '../src/cp/workspace-reader.js'
import {
  daemonGitCredentialTarget,
  initGitInjection,
  workspaceGitLocalEnv,
  gitFor
} from '../src/workspace/git-injection.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { parsePorcelainV2 } from '../src/shim/git-exec.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()
import { LocalGitRunner } from '../src/workspace/git-runner.js'

// Real git against real checkouts, no simple-git mock: the write half is a set of claims about what
// `git add` / `reset` / `commit` / `push` actually do to an index and a remote, and a mocked runner
// can only restate the argv this file already builds.

const IDENTITY = { name: 'acme-bot[bot]', email: '1234+acme-bot[bot]@users.noreply.github.com' }

// A github-app workspace's push has to carry the daemon's credential-helper pointer; the pointers
// are minted from this registration, exactly as the daemon registers them at boot.
const SHIM = join(mkdtempSync(join(tmpdir(), 'ac-gitwrite-shim-')), 'git-credential-helper.sh')
initGitInjection({
  targetFor: () => daemonGitCredentialTarget({ shimPath: SHIM, runDir: join(SHIM, '..') }),
  preWarm: async () => undefined,
  capabilityFor: (agentId) => `cap-${agentId}`
})

// The shim dir outlives every fixture, so it is reclaimed once rather than per test.
afterAll(() => rmSync(join(SHIM, '..'), { recursive: true, force: true }))

/** What the daemon passes for a github-app git-repo agent: the identity its credential helper answers as. */
const gitcredAgent = () => 'a'

/** Setup-only env: the daemon's own local policy, widened to `file:` so a fixture can build a bare
 *  remote (daemon policy forbids the protocol, which is why the seam needs the runner substitution
 *  below to reach one at all), plus an identity for the fixture's own commits. */
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

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-gitwrite-'))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixtureEnv(), encoding: 'utf8' })
}

/** A repo with one commit on `main` and a tracked file. */
function repo(): string {
  const root = tempRoot()
  const dir = join(root, 'co')
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main', '.'])
  writeFileSync(join(dir, 'tracked.txt'), 'one\n')
  git(dir, ['add', 'tracked.txt'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

/** A bare remote plus a clone of it whose `origin` URL is then repointed at the authorized GitHub
 *  URL — the checkout the seam will accept, over a remote a test can actually reach. */
function repoWithRemote(): { dir: string; bare: string; origin: string } {
  const root = tempRoot()
  const bare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const dir = join(root, 'co')
  const origin = 'https://github.com/acme/repo.git'
  git(root, ['init', '-q', '--bare', bare])
  mkdirSync(seed, { recursive: true })
  git(seed, ['init', '-q', '-b', 'main', '.'])
  writeFileSync(join(seed, 'tracked.txt'), 'one\n')
  git(seed, ['add', 'tracked.txt'])
  git(seed, ['commit', '-q', '-m', 'initial'])
  git(seed, ['remote', 'add', 'origin', bare])
  git(seed, ['push', '-q', 'origin', 'main'])
  git(root, ['clone', '-q', '--branch', 'main', bare, dir])
  git(dir, ['remote', 'set-url', 'origin', origin])
  return { dir, bare, origin }
}

type Call = { args: string[]; env: Record<string, string> }

/**
 * Runs REAL git in `cwd` through the workspace runner seam, recording argv, with exactly ONE
 * substitution: a `remote.*.url` whose value is the authorized HTTPS origin is repointed at the
 * local bare remote, and `file:` joins the protocol allowlist. The daemon's origin policy accepts
 * neither a local path nor a non-github host, so the network leg of a push is unreachable in a test
 * without it; everything else — the refspec, the flags, the hardening pairs, the credential
 * pointers — is exactly what the seam built.
 */
class SeamRunner implements GitRunner {
  constructor(
    private readonly cwd: string,
    private readonly calls: Call[],
    private readonly origin?: string,
    private readonly bare?: string,
    private readonly env: Record<string, string> = {}
  ) {}

  withEnv(env: Record<string, string>): GitRunner {
    return new SeamRunner(this.cwd, this.calls, this.origin, this.bare, env)
  }

  private effectiveEnv(): Record<string, string> {
    const env = { ...this.env }
    for (let index = 0; index < Number(env.GIT_CONFIG_COUNT ?? 0); index += 1) {
      const key = env[`GIT_CONFIG_KEY_${index}`]
      // Only a remote's fetch/push URL: rewriting every matching value would also flip the
      // `url.*.insteadOf` guard around and rewrite the substituted path back again.
      if (this.origin && this.bare && /^remote\..*\.url$/.test(key ?? '')) {
        if (env[`GIT_CONFIG_VALUE_${index}`] === this.origin) env[`GIT_CONFIG_VALUE_${index}`] = this.bare
      }
    }
    if (env.GIT_ALLOW_PROTOCOL !== undefined) env.GIT_ALLOW_PROTOCOL = `file:${env.GIT_ALLOW_PROTOCOL}`
    return env
  }

  private run(args: string[]): string {
    const env = this.effectiveEnv()
    this.calls.push({ args, env })
    const result = spawnSync('git', args, { cwd: this.cwd, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`)
    return result.stdout
  }

  async raw(args: string[]): Promise<string> {
    return this.run(args)
  }

  async readBounded(args: string[], maxBytes: number): Promise<{ out: Buffer; overflow: boolean }> {
    const out = Buffer.from(this.run(args), 'utf8')
    return out.byteLength <= maxBytes ? { out, overflow: false } : { out: out.subarray(0, maxBytes), overflow: true }
  }

  async status() {
    return parsePorcelainV2(this.run(['status', '--porcelain=v2', '--branch', '-u', '-z']))
  }

  async clone(): Promise<void> {
    throw new Error('clone is not part of the console write seam')
  }

  async pull(): Promise<never> {
    throw new Error('pull has its own coverage')
  }

  async log(): Promise<never> {
    throw new Error('log has its own coverage')
  }
}

/** By path: simple-git groups untracked entries after the tracked ones, so the wire order is its
 *  own and not something these assertions should pin. */
function byPath(files: unknown[] | undefined): unknown[] {
  return [...(files ?? [])].sort((left, right) =>
    String((left as { path: string }).path).localeCompare(String((right as { path: string }).path))
  )
}

const githubTarget = (branch = 'main') => ({
  repo: 'https://github.com/acme/repo.git',
  branch,
  githubApp: true
})

afterEach(() => {
  workspaces.setGitRunnerResolver(undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workspace git stage / unstage (real repo, real index)', () => {
  it('stages a modified and an untracked path, and answers with the FRESH status', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const seam = createWorkspaceGit(workspaces, async () => dir)

    const before = await seam.status('a')
    expect(byPath(before.files)).toEqual([
      { path: 'new.txt', index: '?', workingDir: '?' },
      { path: 'tracked.txt', index: ' ', workingDir: 'M', additions: 1, deletions: 1 }
    ])

    const after = await seam.stage({ agentId: 'a', paths: ['tracked.txt', 'new.txt'] })
    expect(after.clean).toBe(false)
    expect(byPath(after.files)).toEqual([
      { path: 'new.txt', index: 'A', workingDir: ' ', additions: 1, deletions: 0 },
      { path: 'tracked.txt', index: 'M', workingDir: ' ', additions: 1, deletions: 1 }
    ])
    // The REP is the real index state, not an echo: git agrees.
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('new.txt\ntracked.txt\n')
  })

  it('unstages back to a modified file, and back to untracked for a never-committed one', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const seam = createWorkspaceGit(workspaces, async () => dir)
    await seam.stage({ agentId: 'a', paths: ['tracked.txt', 'new.txt'] })

    const after = await seam.unstage({ agentId: 'a', paths: ['tracked.txt', 'new.txt'] })
    expect(byPath(after.files)).toEqual([
      { path: 'new.txt', index: '?', workingDir: '?' },
      { path: 'tracked.txt', index: ' ', workingDir: 'M', additions: 1, deletions: 1 }
    ])
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  })

  it('unstages a first commit, where a `reset HEAD` form would fail on the unborn branch', async () => {
    const root = tempRoot()
    const dir = join(root, 'co')
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main', '.'])
    writeFileSync(join(dir, 'first.txt'), 'first\n')
    git(dir, ['add', 'first.txt'])
    const seam = createWorkspaceGit(workspaces, async () => dir)

    const after = await seam.unstage({ agentId: 'a', paths: ['first.txt'] })
    expect(after.files).toEqual([{ path: 'first.txt', index: '?', workingDir: '?' }])
    expect(after.lastCommit).toBeUndefined()
  })

  it('treats every no-op as data: an empty list, an unchanged path, and a path git does not report', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(workspaces, async () => dir)

    // Empty selection: the fresh status, and nothing staged behind the caller's back.
    const untouched = await seam.stage({ agentId: 'a', paths: [] })
    expect(untouched.files).toEqual([{ path: 'tracked.txt', index: ' ', workingDir: 'M', additions: 1, deletions: 1 }])

    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    // Staging it again has nothing unstaged to add, and naming a clean/absent path matches nothing:
    // both would be a `git add` pathspec failure if the seam passed them through.
    const again = await seam.stage({ agentId: 'a', paths: ['tracked.txt', 'absent.txt'] })
    expect(again.files).toEqual([{ path: 'tracked.txt', index: 'M', workingDir: ' ', additions: 1, deletions: 1 }])
    // …and unstaging an untracked path is a no-op too (there is nothing of it in the index).
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const untracked = await seam.unstage({ agentId: 'a', paths: ['new.txt'] })
    expect(untracked.files).toContainEqual({ path: 'new.txt', index: '?', workingDir: '?' })
  })

  it('reports a from-scratch workspace as isRepo:false instead of failing', async () => {
    const dir = join(tempRoot(), 'scratch')
    mkdirSync(dir, { recursive: true })
    const seam = createWorkspaceGit(workspaces, async () => dir)
    expect(await seam.stage({ agentId: 'a', paths: ['x.txt'] })).toEqual({ agentId: 'a', isRepo: false, clean: true })
    expect(await seam.unstage({ agentId: 'a', paths: ['x.txt'] })).toEqual({ agentId: 'a', isRepo: false, clean: true })
  })

  it('refuses a pathspec that escapes the workspace or reaches into .git', async () => {
    const dir = repo()
    const seam = createWorkspaceGit(workspaces, async () => dir)
    await expect(seam.stage({ agentId: 'a', paths: ['../agent.json'] })).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(seam.stage({ agentId: 'a', paths: ['/etc/passwd'] })).rejects.toMatchObject({
      reason: 'path-escape'
    })
    await expect(seam.unstage({ agentId: 'a', paths: ['.git/config'] })).rejects.toMatchObject({
      reason: 'git-internals'
    })
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  })

  it('refuses to stage in a checkout whose local config carries a disallowed override', async () => {
    // `git add` runs the repository's own clean filter, which is why the audit gates a stage at all.
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    git(dir, ['config', 'filter.evil.process', 'sh -c "touch /tmp/pwned"'])
    const seam = createWorkspaceGit(workspaces, async () => dir)
    await expect(seam.stage({ agentId: 'a', paths: ['tracked.txt'] })).rejects.toThrow(/disallowed/)
    expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  })
})

describe('workspace git commit (real repo, real commit)', () => {
  it('commits the staged changes with the REGISTERED identity as author and committer', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })

    const result = await seam.commit({ agentId: 'a', message: 'feat: second\n\nBody.' })
    expect(result).toMatchObject({ agentId: 'a', isRepo: true, ok: true })
    expect(result.sha).toBe(git(dir, ['rev-parse', 'HEAD']).trim())
    expect(result.detail).toBe(`Committed ${result.sha!.slice(0, 7)} — 1 file.`)
    expect(result.reason).toBeUndefined()
    expect(git(dir, ['log', '-1', '--format=%an|%ae|%cn|%ce'])).toBe(
      `${IDENTITY.name}|${IDENTITY.email}|${IDENTITY.name}|${IDENTITY.email}\n`
    )
    // `%B` is the raw message plus git's own trailing newline, so the body survived intact.
    expect(git(dir, ['log', '-1', '--format=%B'])).toBe('feat: second\n\nBody.\n\n')
    expect((await seam.status('a')).clean).toBe(true)
  })

  it('keeps a `#` line in the message, which the reader approved and git would otherwise delete', async () => {
    // `--cleanup=strip` deletes every line beginning with `#`, so a generated `## Why` heading
    // silently disappears from the commit and a message that is ONLY such lines makes git abort
    // on an empty message while the box still shows the text. Verified against real git.
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'three\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })

    const message = 'fix: guard the parser\n\n## Why\n\nCloses #123 and #456.'
    const result = await seam.commit({ agentId: 'a', message })
    expect(result).toMatchObject({ ok: true })
    expect(git(dir, ['log', '-1', '--format=%B'])).toBe(`${message}\n\n`)

    // And a message whose body is nothing but `#` lines still commits rather than aborting.
    writeFileSync(join(dir, 'tracked.txt'), 'four\n')
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    const hashOnly = await seam.commit({ agentId: 'a', message: '#123 fix the parser' })
    expect(hashOnly).toMatchObject({ ok: true })
    expect(git(dir, ['log', '-1', '--format=%s'])).toBe('#123 fix the parser\n')
  })

  it('REFUSES as data when no commit identity was registered, and creates no commit', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(workspaces, async () => dir)
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    const head = git(dir, ['rev-parse', 'HEAD']).trim()

    const result = await seam.commit({ agentId: 'a', message: 'feat: second' })
    expect(result).toMatchObject({ agentId: 'a', isRepo: true, ok: false, reason: 'no-identity' })
    expect(result.detail).toMatch(/no registered Git commit identity/)
    expect(result.sha).toBeUndefined()
    // The point of refusing: git 2.43 would otherwise GUESS the host operator's passwd identity and
    // commit as them (measured), rather than failing the way "tell me who you are" suggests.
    expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(head)
  })

  it('reports nothing staged, an empty message and a from-scratch workspace as data', async () => {
    const dir = repo()
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    writeFileSync(join(dir, 'tracked.txt'), 'two\n') // dirty, but nothing STAGED
    expect(await seam.commit({ agentId: 'a', message: 'feat: x' })).toMatchObject({
      ok: false,
      reason: 'nothing-staged',
      detail: 'Nothing is staged, so there is nothing to commit.'
    })
    expect(await seam.commit({ agentId: 'a', message: '   \n  ' })).toMatchObject({
      ok: false,
      reason: 'empty-message'
    })

    const scratch = join(tempRoot(), 'scratch')
    mkdirSync(scratch, { recursive: true })
    const scratchSeam = createWorkspaceGit(
      workspaces,
      async () => scratch,
      () => undefined,
      async () => undefined,
      () => IDENTITY
    )
    expect(await scratchSeam.commit({ agentId: 'a', message: 'feat: x' })).toMatchObject({
      isRepo: false,
      ok: false,
      reason: 'not-a-repo'
    })
  })

  it('refuses to commit in a checkout with a disallowed local override, as data', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    git(dir, ['config', 'diff.external', 'sh -c "touch /tmp/pwned"'])
    const head = git(dir, ['rev-parse', 'HEAD']).trim()

    expect(await seam.commit({ agentId: 'a', message: 'feat: second' })).toMatchObject({
      ok: false,
      reason: 'unsafe-config'
    })
    expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(head)
  })

  it('does not run the checkout own commit hooks', async () => {
    const dir = repo()
    const marker = join(dir, 'hook-ran')
    const hooks = join(dir, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })

    expect(await seam.commit({ agentId: 'a', message: 'feat: second' })).toMatchObject({ ok: true })
    expect(existsSync(marker)).toBe(false)
  })
})

describe('workspace git push (real repo; local bare remote through the runner seam)', () => {
  it('pushes the branch, then advances origin/<branch> so the commits stop reading as unpushed', async () => {
    const { dir, bare, origin } = repoWithRemote()
    const calls: Call[] = []
    workspaces.setGitRunnerResolver((_agentId, cwd) => new SeamRunner(cwd ?? dir, calls, origin, bare))
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      gitcredAgent,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    await seam.commit({ agentId: 'a', message: 'feat: second' })
    const head = git(dir, ['rev-parse', 'HEAD']).trim()

    const result = await seam.push({ agentId: 'a' })
    expect(result).toEqual({
      agentId: 'a',
      isRepo: true,
      ok: true,
      ahead: 0,
      detail: 'Pushed 1 commit to main.'
    })
    // The remote really has it, and the local tracking ref moved with it.
    expect(git(bare, ['rev-parse', 'refs/heads/main']).trim()).toBe(head)
    expect(git(dir, ['rev-parse', 'refs/remotes/origin/main']).trim()).toBe(head)
    expect((await seam.status('a')).ahead).toBe(0)

    // Never a force, and both refspec sides explicit so no checkout-owned push.default decides.
    const push = calls.find((call) => call.args[0] === 'push')!
    expect(push.args).toEqual([
      'push',
      '--porcelain',
      expect.stringMatching(/^agentconnect-[0-9a-f-]{36}$/),
      'refs/heads/main:refs/heads/main'
    ])
    expect(push.args.some((arg) => /force/.test(arg))).toBe(false)
    expect(push.env.GIT_TERMINAL_PROMPT).toBe('0')
    // The credential channel reached the invocation: the socket pair plus a helper pointer listed
    // AFTER the command-scope reset that would otherwise have wiped it.
    expect(push.env.AC_GITCRED_CAPABILITY).toBe('cap-a')
    const pairs = Array.from({ length: Number(push.env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
      push.env[`GIT_CONFIG_KEY_${index}`],
      push.env[`GIT_CONFIG_VALUE_${index}`]
    ])
    const reset = pairs.findIndex(([key, value]) => key === 'credential.helper' && value === '')
    const helper = pairs.findIndex(
      ([key, value]) => key === 'credential.https://github.com.helper' && (value ?? '').includes(SHIM)
    )
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(helper).toBeGreaterThan(reset)
  })

  it('reports a non-fast-forward rejection as diverged, and leaves the remote alone', async () => {
    const { dir, bare, origin } = repoWithRemote()
    // A third party advances the remote branch behind this checkout's back.
    const other = join(tempRoot(), 'other')
    git(join(bare, '..'), ['clone', '-q', '--branch', 'main', bare, other])
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, ['add', 'theirs.txt'])
    git(other, ['commit', '-q', '-m', 'theirs'])
    git(other, ['push', '-q', 'origin', 'main'])
    const remoteHead = git(bare, ['rev-parse', 'refs/heads/main']).trim()

    workspaces.setGitRunnerResolver((_agentId, cwd) => new SeamRunner(cwd ?? dir, [], origin, bare))
    writeFileSync(join(dir, 'tracked.txt'), 'mine\n')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    await seam.commit({ agentId: 'a', message: 'feat: mine' })

    expect(await seam.push({ agentId: 'a' })).toEqual({
      agentId: 'a',
      isRepo: true,
      ok: false,
      reason: 'diverged',
      detail: 'Rejected — the remote has commits this branch does not. Pull, then push.'
    })
    expect(git(bare, ['rev-parse', 'refs/heads/main']).trim()).toBe(remoteHead)
  })

  it('chunks the pathspecs so one invocation stays inside the sandbox argv cap', async () => {
    const dir = repo()
    const calls: Call[] = []
    workspaces.setGitRunnerResolver((_agentId, cwd) => new SeamRunner(cwd ?? dir, calls))
    const paths = Array.from({ length: 120 }, (_, index) => `f${index}.txt`)
    for (const path of paths) writeFileSync(join(dir, path), `${path}\n`)
    const seam = createWorkspaceGit(workspaces, async () => dir)

    const after = await seam.stage({ agentId: 'a', paths })
    expect(after.files?.filter((file) => file.index === 'A')).toHaveLength(120)
    const adds = calls.filter((call) => call.args[0] === 'add')
    expect(adds).toHaveLength(3)
    // 64 is the shim exec channel's hard argv ceiling; one over it and a cluster stage fails.
    for (const add of adds) expect(add.args.length).toBeLessThanOrEqual(64)
  })
})

describe('workspace git push preconditions (data, not errors)', () => {
  const seamFor = (dir: string) =>
    createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => githubTarget(),
      () => IDENTITY
    )

  it('reports a detached HEAD — which every session worktree is', async () => {
    const dir = repo()
    git(dir, ['checkout', '-q', '--detach'])
    expect(await seamFor(dir).push({ agentId: 'a' })).toMatchObject({
      isRepo: true,
      ok: false,
      reason: 'detached-head'
    })
  })

  it('reports a branch that tracks nothing', async () => {
    const dir = repo()
    expect(await seamFor(dir).push({ agentId: 'a' })).toMatchObject({
      isRepo: true,
      ok: false,
      reason: 'no-upstream',
      detail: 'Branch "main" tracks no upstream, so the daemon has no ref to push it to.'
    })
  })

  it('reports nothing to push as ok, not as a failure', async () => {
    const { dir } = repoWithRemote()
    const result = await seamFor(dir).push({ agentId: 'a' })
    expect(result).toEqual({
      agentId: 'a',
      isRepo: true,
      ok: true,
      ahead: 0,
      detail: 'Everything is already pushed.'
    })
  })

  it('refuses when the checkout origin is not the authorized remote, without counting against it', async () => {
    // This case used to assert `ahead: 1` alongside the refusal. That premise was the bug: the count
    // was taken against `@{upstream}`, which is checkout-owned, BEFORE the origin was authorized — so
    // an upstream pointing at some other remote that happened to be current answered
    // "Everything is already pushed" having sent nothing. The count now comes after the check, and a
    // refusal that never reached the authorized remote reports no distance to it.
    const { dir } = repoWithRemote()
    git(dir, ['remote', 'set-url', 'origin', 'https://github.com/attacker/repo.git'])
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = seamFor(dir)
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    await seam.commit({ agentId: 'a', message: 'feat: second' })

    expect(await seam.push({ agentId: 'a' })).toEqual({
      agentId: 'a',
      isRepo: true,
      ok: false,
      reason: 'unsafe-origin',
      detail: 'workspace origin is not a safe remote'
    })
  })

  it('never reports success when the tracked branch is not the branch being pushed', async () => {
    // Same-remote, DIFFERENT branch: `feature` tracking `origin/main` is on the authorized remote, so
    // a URL-only check passes and `ahead(origin/main)` can be zero while `origin/feature` does not
    // exist. The shortcut has to match the branch too, or the button reports success for a ref it
    // never sent. Verified against real git.
    const { dir, bare, origin } = repoWithRemote()
    const calls: Call[] = []
    workspaces.setGitRunnerResolver((_agentId, cwd) => new SeamRunner(cwd ?? dir, calls, origin, bare))
    // `feature` branches off main at the SAME commit and adds nothing, so `ahead(origin/main)` is
    // zero — while `origin/feature` does not exist, which means there is very much something to
    // send. A URL-only check reports "Everything is already pushed" here and creates nothing.
    git(dir, ['checkout', '-q', '-b', 'feature'])
    git(dir, ['branch', '--set-upstream-to=origin/main', 'feature'])
    expect(git(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim()).toBe('0')
    expect(git(dir, ['ls-remote', '--heads', bare, 'feature']).trim()).toBe('')
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      gitcredAgent,
      async () => githubTarget(),
      () => IDENTITY
    )

    const result = await seam.push({ agentId: 'a' })
    expect(result.ok).toBe(true)
    // It actually pushed rather than short-circuiting: the destination branch now exists on the remote.
    expect(git(dir, ['ls-remote', '--heads', bare, 'feature'])).toContain('refs/heads/feature')
  })

  it('never reports success for a push the authorized remote did not receive', async () => {
    // `branch.<b>.remote` / `branch.<b>.merge` are checkout-owned and are NOT disallowed overrides,
    // so an upstream can point somewhere this daemon may not push. Counting against that ref and
    // finding nothing ahead used to report success with an empty remote on the other side.
    const { dir, bare } = repoWithRemote()
    const decoy = join(tempRoot(), 'decoy.git')
    git(dir, ['init', '--bare', decoy])
    git(dir, ['remote', 'add', 'decoy', decoy])
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const seam = seamFor(dir)
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    await seam.commit({ agentId: 'a', message: 'feat: second' })
    // Park the branch's upstream on the decoy and make the decoy current, so `ahead` reads zero.
    git(dir, ['push', 'decoy', 'HEAD:refs/heads/main'])
    git(dir, ['branch', '--set-upstream-to=decoy/main', 'main'])

    const result = await seam.push({ agentId: 'a' })
    expect(result).toMatchObject({ ok: false, reason: 'no-upstream' })
    expect(result.detail).toContain('not the remote this workspace is authorized to push to')
    // The authorized remote really did not receive the new commit.
    const head = git(dir, ['rev-parse', 'HEAD']).trim()
    expect(git(dir, ['ls-remote', '--heads', bare])).not.toContain(head)
  })

  it('answers a stage through the runner it mutated, not one resolved again afterwards', async () => {
    // A resolver that works ONCE and then goes away is what a detaching sandbox session looks like.
    // Resolving again for the reply would read a daemon-local checkout — or answer isRepo:false — for
    // a mutation that landed in the sandbox.
    const { dir } = repoWithRemote()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    let resolutions = 0
    workspaces.setGitRunnerResolver((_agentId, cwd) => {
      resolutions += 1
      if (resolutions > 1) return undefined
      return new LocalGitRunner(gitFor(cwd ?? dir), cwd ?? dir, (env) => gitFor(cwd ?? dir).env(env))
    })
    try {
      const status = await seamFor(dir).stage({ agentId: 'a', paths: ['tracked.txt'] })
      expect(resolutions).toBe(1)
      expect(status.isRepo).toBe(true)
      expect(status.files?.map((f) => f.path)).toEqual(['tracked.txt'])
    } finally {
      workspaces.setGitRunnerResolver(undefined)
    }
  })

  it('refuses a from-scratch workspace that merely SITS INSIDE another repository', async () => {
    // `--is-inside-work-tree` is true from every descendant of a checkout, so a workspace under an
    // unrelated ancestor repo would pass a naive preflight — and a commit here would then operate on
    // that ancestor, including whatever it already had staged outside this workspace.
    const outer = join(tempRoot(), 'outer')
    mkdirSync(outer, { recursive: true })
    git(outer, ['init', '-q', '-b', 'main'])
    writeFileSync(join(outer, 'outer.txt'), 'theirs\n')
    git(outer, ['add', 'outer.txt'])
    const inner = join(outer, 'workspace')
    mkdirSync(inner, { recursive: true })

    const seam = seamFor(inner)
    expect(await seam.status('a')).toMatchObject({ isRepo: false })
    expect(await seam.commit({ agentId: 'a', message: 'feat: not mine to commit' })).toMatchObject({
      isRepo: false,
      ok: false,
      reason: 'not-a-repo'
    })
    // The ancestor is untouched: its staged file is STILL staged, which a commit would have cleared.
    expect(git(outer, ['diff', '--cached', '--name-only']).trim()).toBe('outer.txt')
  })

  it('reports a from-scratch workspace as isRepo:false', async () => {
    const dir = join(tempRoot(), 'scratch')
    mkdirSync(dir, { recursive: true })
    expect(await seamFor(dir).push({ agentId: 'a' })).toMatchObject({
      isRepo: false,
      ok: false,
      reason: 'not-a-repo'
    })
  })

  it('refuses an unknown agent as a BAD_PAYLOAD violation, not as data', async () => {
    const seam = createWorkspaceGit(workspaces, async () => undefined)
    await expect(seam.push({ agentId: 'ghost' })).rejects.toMatchObject({ reason: 'unknown-agent' })
    await expect(seam.commit({ agentId: 'ghost', message: 'x' })).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(seam.stage({ agentId: 'ghost', paths: [] })).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(seam.message({ agentId: 'ghost' })).rejects.toBeInstanceOf(WorkspaceViolationError)
  })
})

describe('workspace git message — the AI commit-message pass (real staged diff, injected pass)', () => {
  type Pass = { calls: { systemPrompt: string; prompt: string }[] }

  /** A seam whose model pass is a recorded stub: the pass itself is daemon.ts's business, so what is
   *  under test here is WHAT it is handed and WHAT is done with what it returns. */
  function seamWith(dir: string, answer: () => Promise<{ output: string; stopReason: string }>) {
    const pass: Pass = { calls: [] }
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      undefined,
      undefined,
      undefined,
      (_agentId, systemPrompt, prompt, signal) => {
        pass.calls.push({ systemPrompt, prompt })
        void signal
        return answer()
      }
    )
    return { seam, pass }
  }

  const ok = (output: string) => () => Promise.resolve({ output, stopReason: 'end_turn' })

  it('feeds the STAGED diff and the staged name list, and returns the sanitised message', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'staged\n')
    writeFileSync(join(dir, 'added.txt'), 'brand new\n')
    const { seam, pass } = seamWith(dir, ok('Here it is:\n\n```\nfeat(core): rewrite the tracked file\n\nWhy.\n```'))
    await seam.stage({ agentId: 'a', paths: ['tracked.txt', 'added.txt'] })
    // Only in the working tree, never in the index — this must NOT reach the model.
    writeFileSync(join(dir, 'tracked.txt'), 'unstaged-edit\n')

    const result = await seam.message({ agentId: 'a' })
    expect(result).toEqual({ agentId: 'a', ok: true, message: 'feat(core): rewrite the tracked file\n\nWhy.' })
    expect(pass.calls).toHaveLength(1)
    const { prompt, systemPrompt } = pass.calls[0]!
    expect(systemPrompt).toContain('untrusted data')
    expect(prompt).toContain('M\ttracked.txt')
    expect(prompt).toContain('A\tadded.txt')
    expect(prompt).toContain('+staged')
    expect(prompt).not.toContain('unstaged-edit')
  })

  it('describes the FIRST commit of a repo, where HEAD does not exist yet', async () => {
    const dir = join(tempRoot(), 'fresh')
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q', '-b', 'main', '.'])
    writeFileSync(join(dir, 'first.txt'), 'hello\n')
    const { seam, pass } = seamWith(dir, ok('feat: add the first file'))
    await seam.stage({ agentId: 'a', paths: ['first.txt'] })

    expect(await seam.message({ agentId: 'a' })).toEqual({
      agentId: 'a',
      ok: true,
      message: 'feat: add the first file'
    })
    expect(pass.calls[0]!.prompt).toContain('A\tfirst.txt')
  })

  it('names a staged RENAME with both of its paths (git writes that record with two)', async () => {
    const dir = repo()
    git(dir, ['mv', 'tracked.txt', 'renamed.txt'])
    const { seam, pass } = seamWith(dir, ok('refactor(core): rename the tracked file'))
    await seam.stage({ agentId: 'a', paths: ['tracked.txt', 'renamed.txt'] })

    expect(await seam.message({ agentId: 'a' })).toMatchObject({ ok: true })
    expect(pass.calls[0]!.prompt).toContain('R100\ttracked.txt -> renamed.txt')
  })

  it('reports an empty index as data and never spends a model call on it', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'only in the working tree\n')
    const { seam, pass } = seamWith(dir, ok('feat: never asked'))
    expect(await seam.message({ agentId: 'a' })).toEqual({
      agentId: 'a',
      ok: false,
      detail: 'Nothing is staged, so there is nothing to describe.'
    })
    expect(pass.calls).toHaveLength(0)
  })

  it('tells the model when the diff hit its cap, and still names every staged file', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 4_000 }, (_, i) => `line ${i} of padding`).join('\n'))
    const { seam, pass } = seamWith(dir, ok('chore: add a large fixture file'))
    await seam.stage({ agentId: 'a', paths: ['big.txt'] })

    expect(await seam.message({ agentId: 'a' })).toMatchObject({ ok: true })
    const { prompt } = pass.calls[0]!
    expect(prompt).toContain('cut off at its size limit')
    expect(prompt).toContain('A\tbig.txt')
    // The cap is on the diff, so the prompt stays a bounded size whatever was staged.
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(40 * 1024)
  })

  it('names the runtime own terminal reason when it produced nothing', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const cases: Record<string, string> = {
      refusal: 'The runtime declined to draft a commit message for this diff.',
      cancelled: 'Message generation was canceled before the runtime answered.',
      max_tokens: 'The runtime ran out of budget before writing a commit message.'
    }
    for (const [stopReason, detail] of Object.entries(cases)) {
      const { seam } = seamWith(dir, () => Promise.resolve({ output: '  \n ', stopReason }))
      await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
      expect(await seam.message({ agentId: 'a' })).toEqual({ agentId: 'a', ok: false, detail })
    }
  })

  it('keeps the sanitiser reason when the runtime answered with prose', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const { seam } = seamWith(dir, ok('I think this change renames a few things, but I am not sure.'))
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    const result = await seam.message({ agentId: 'a' })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('conventional-commit')
    expect(result.message).toBeUndefined()
  })

  it('never leaks a failing pass error text (it carries adapter argv and host paths)', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const { seam } = seamWith(dir, () =>
      Promise.reject(new Error(`spawn ${dir}/../../node_modules/.bin/claude-acp failed: ENOENT`))
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })
    const result = await seam.message({ agentId: 'a' })
    expect(result).toEqual({ agentId: 'a', ok: false, detail: 'This agent runtime could not draft a commit message.' })
    expect(result.detail).not.toContain(dir)
  })

  it('bounds the pass in time and reports the timeout as data', async () => {
    const dir = repo()
    // Every git call synchronous through the seam runner, so the only thing this test has to wait for
    // is the fake clock — a real simple-git read would still be in flight when the clock advanced.
    workspaces.setGitRunnerResolver((_agentId, cwd) => new SeamRunner(cwd ?? dir, []))
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    let aborted = false
    const seam = createWorkspaceGit(
      workspaces,
      async () => dir,
      undefined,
      undefined,
      undefined,
      (_agentId, _systemPrompt, _prompt, signal) =>
        new Promise((_resolve, reject) => {
          // A runtime that never answers: only the seam's own budget ends this. The budget timer is
          // armed before the pass is entered, so driving the clock from here always finds it.
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
          void vi.advanceTimersByTimeAsync(46_000)
        })
    )
    await seam.stage({ agentId: 'a', paths: ['tracked.txt'] })

    vi.useFakeTimers()
    try {
      const result = await seam.message({ agentId: 'a' })
      expect(aborted).toBe(true)
      expect(result.ok).toBe(false)
      expect(result.detail).toContain('did not answer within 45s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers as data when the daemon wired no model pass at all, and for a from-scratch workspace', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'tracked.txt'), 'two\n')
    const bare = createWorkspaceGit(workspaces, async () => dir)
    await bare.stage({ agentId: 'a', paths: ['tracked.txt'] })
    expect(await bare.message({ agentId: 'a' })).toEqual({
      agentId: 'a',
      ok: false,
      detail: 'This daemon cannot draft commit messages.'
    })

    const scratch = join(tempRoot(), 'scratch')
    mkdirSync(scratch, { recursive: true })
    expect(await seamWith(scratch, ok('feat: never asked')).seam.message({ agentId: 'a' })).toEqual({
      agentId: 'a',
      ok: false,
      detail: 'This workspace is not a git checkout, so there is no staged diff.'
    })
  })
})

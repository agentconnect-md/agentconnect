import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock simple-git so status/pull/log don't shell out. Impls are reassignable per test.
let statusImpl: (...args: any[]) => Promise<unknown>
let pullImpl: (...args: any[]) => Promise<unknown>
let logImpl: (...args: any[]) => Promise<unknown>
let rawImpl: (...args: any[]) => Promise<unknown>
let envImpl: (...args: any[]) => unknown
let simpleGitArgs: unknown[]
vi.mock('simple-git', () => ({
  simpleGit: (options?: unknown) => {
    simpleGitArgs.push(options)
    const git = {
      status: (...a: any[]) => statusImpl(...a),
      pull: (...a: any[]) => pullImpl(...a),
      log: (...a: any[]) => logImpl(...a),
      raw: (...a: any[]) => rawImpl(...a),
      env: (...a: any[]) => {
        envImpl(...a)
        return git
      }
    }
    return git
  }
}))

const { createWorkspaceGit } = await import('../src/cp/workspace-git.js')

const { WorkspaceManager } = await import('../src/workspace/workspace-manager.js')
// One plane per test file — the isolation Vitest's per-file module registry used to give.
const workspaces = new WorkspaceManager()
const { WorkspaceViolationError } = await import('../src/cp/workspace-reader.js')

const { daemonGitCredentialTarget, initGitInjection } = await import('../src/workspace/git-injection.js')
// The credential channel a pull builds is real here: the seam is handed the agent the helper answers
// as, and `gitCredentialEnv` mints the pair — so an uninitialized injection is a failing pull, not an
// empty env. `vi.mock` keeps this file isolated, so the registration cannot reach another file.
const SHIM = join(mkdtempSync(join(tmpdir(), 'ac-git-shim-')), 'git-credential-helper.sh')
initGitInjection({
  targetFor: () => daemonGitCredentialTarget({ shimPath: SHIM, runDir: join(SHIM, '..') }),
  preWarm: async () => undefined,
  capabilityFor: (agentId) => `cap-${agentId}`
})

/** A temp dir; `repo:true` seeds a `.git/` so it reads as a git-repo checkout. */
function ws(repo: boolean): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ac-git-')), 'co')
  mkdirSync(dir, { recursive: true })
  // A REAL `git init`, not a bare `.git` directory: the seam asks whether this is a checkout
  // through the runner (`rev-parse --is-inside-work-tree`) rather than by looking for a `.git` on
  // the daemon's own disk, because a cluster-backed agent's checkout is not on that disk at all.
  if (repo) execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
  return dir
}

const githubTarget = async () => ({
  repo: 'https://github.com/acme/repo.git',
  branch: 'main',
  githubApp: false
})

const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)

/** `raw` as the sync path sees it: the origin for `remote get-url`, and every probe answered like a checkout on `current` whose HEAD `checkout -B` moves from `before` to `after`. */
function syncRaw(
  opts: { origin?: string; before?: string; after?: string; current?: string; numstat?: string; unique?: string } = {}
) {
  const before = opts.before ?? BEFORE
  const after = opts.after ?? before
  let head = before
  return vi.fn().mockImplementation(async (args: string[]) => {
    switch (args[0]) {
      case 'remote':
        return `${opts.origin ?? 'https://github.com/acme/repo.git'}\n`
      case 'rev-parse':
        return `${args[2] === 'HEAD' ? head : before}\n`
      case 'symbolic-ref':
        return `${opts.current ?? 'main'}\n`
      case 'rev-list':
        return `${opts.unique ?? '0'}\n`
      case 'checkout':
        head = after
        return ''
      case 'diff':
        return opts.numstat ?? ''
      default:
        return ''
    }
  })
}

/** The `raw` calls that reach the network or move the checkout — what a refused sync must never make. */
function syncWrites(raw: ReturnType<typeof vi.fn>): string[][] {
  return raw.mock.calls
    .map((call) => call[0] as string[])
    .filter((args) => args[0] === 'fetch' || args[0] === 'checkout')
}

beforeEach(() => {
  simpleGitArgs = []
  statusImpl = vi.fn()
  pullImpl = vi.fn()
  envImpl = vi.fn()
  rawImpl = vi.fn().mockResolvedValue('https://github.com/acme/repo.git\n')
  // Default: empty repo (no commits) ⇒ git log errors ⇒ lastCommit omitted.
  logImpl = vi.fn().mockRejectedValue(new Error('does not have any commits yet'))
})

describe('createWorkspaceGit.status', () => {
  it('reports isRepo:false / clean:true for a from-scratch (no .git) workspace', async () => {
    const dir = ws(false)
    const git = createWorkspaceGit(workspaces, async () => dir)
    expect(await git.status('a')).toEqual({ agentId: 'a', isRepo: false, clean: true })
    expect(statusImpl).not.toHaveBeenCalled() // short-circuits before touching git
  })

  it('maps a clean checkout: branch/tracking/ahead/behind, no files', async () => {
    const dir = ws(true)
    statusImpl = vi.fn().mockResolvedValue({
      current: 'main',
      tracking: 'origin/main',
      ahead: 0,
      behind: 0,
      files: [],
      isClean: () => true
    })
    const git = createWorkspaceGit(workspaces, async () => dir)
    const s = await git.status('a')
    expect(s).toMatchObject({ agentId: 'a', isRepo: true, clean: true, branch: 'main', tracking: 'origin/main' })
    expect(s.files).toBeUndefined()
    expect(envImpl).toHaveBeenCalledWith(expect.objectContaining({ GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0' }))
  })

  it('maps a dirty checkout: clean:false + changed files (index/workingDir chars)', async () => {
    const dir = ws(true)
    statusImpl = vi.fn().mockResolvedValue({
      current: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
      files: [
        { path: 'a.ts', index: 'M', working_dir: ' ' },
        { path: 'b.ts', index: '?', working_dir: '?' }
      ],
      isClean: () => false
    })
    const git = createWorkspaceGit(workspaces, async () => dir)
    const s = await git.status('a')
    expect(s.clean).toBe(false)
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(2)
    expect(s.files).toEqual([
      { path: 'a.ts', index: 'M', workingDir: ' ' },
      { path: 'b.ts', index: '?', workingDir: '?' }
    ])
    expect(s.truncated).toBeUndefined()
  })

  it('caps the files list and flags truncated when the working tree is huge', async () => {
    const dir = ws(true)
    const files = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.ts`, index: 'M', working_dir: ' ' }))
    statusImpl = vi.fn().mockResolvedValue({ current: 'main', ahead: 0, behind: 0, files, isClean: () => false })
    const git = createWorkspaceGit(workspaces, async () => dir)
    const s = await git.status('a')
    expect(s.files).toHaveLength(500)
    expect(s.truncated).toBe(true)
  })

  it('includes the HEAD commit and the last-fetch time when available', async () => {
    const dir = ws(true)
    // A real FETCH_HEAD so the mtime read resolves; pin its mtime deterministically.
    writeFileSync(join(dir, '.git', 'FETCH_HEAD'), '')
    const fetchedAt = new Date('2026-07-02T09:00:00.000Z')
    utimesSync(join(dir, '.git', 'FETCH_HEAD'), fetchedAt, fetchedAt)
    statusImpl = vi.fn().mockResolvedValue({ current: 'main', ahead: 0, behind: 0, files: [], isClean: () => true })
    // simple-git populates BOTH `all` and `latest`; the runner reads `all`, so a mock
    // supplying only `latest` describes a response simple-git never returns.
    const commit = {
      hash: 'a3f9c21deadbeef0000000000000000000000000',
      date: '2026-07-02T07:00:00+00:00',
      subject: 'Pin deploy image'
    }
    logImpl = vi.fn().mockResolvedValue({ all: [commit], latest: commit })
    const git = createWorkspaceGit(workspaces, async () => dir)
    const s = await git.status('a')
    expect(s.lastCommit).toEqual({
      sha: 'a3f9c21deadbeef0000000000000000000000000',
      shortSha: 'a3f9c21',
      subject: 'Pin deploy image',
      committedAt: '2026-07-02T07:00:00+00:00'
    })
    expect(s.lastFetchAt).toBe(fetchedAt.toISOString())
  })

  it('omits lastCommit for an empty repo (git log errors)', async () => {
    const dir = ws(true)
    statusImpl = vi.fn().mockResolvedValue({ current: 'main', ahead: 0, behind: 0, files: [], isClean: () => true })
    // logImpl rejects by default (beforeEach)
    const git = createWorkspaceGit(workspaces, async () => dir)
    const s = await git.status('a')
    expect(s.lastCommit).toBeUndefined()
  })

  // The numstat join, the binary/untracked cases and the no-HEAD failure moved to
  // workspace-git-read.test.ts when the read moved off simple-git onto a bounded
  // execFile: this suite mocks simple-git, so it can no longer feed or observe that
  // read, and a case that cannot construct its own state is worse than no case.

  it('throws WorkspaceViolationError for an unknown agent', async () => {
    const git = createWorkspaceGit(workspaces, async () => undefined)
    await expect(git.status('nope')).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(git.diff({ agentId: 'nope', path: 'a.ts', staged: false })).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
    await expect(git.log({ agentId: 'nope', limit: 20 })).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('short-circuits diff and log for a from-scratch workspace without touching git', async () => {
    const dir = ws(false)
    const git = createWorkspaceGit(workspaces, async () => dir)
    expect(await git.diff({ agentId: 'a', path: 'a.ts', staged: false })).toEqual({
      agentId: 'a',
      path: 'a.ts',
      isRepo: false,
      exists: false
    })
    expect(await git.log({ agentId: 'a', limit: 20 })).toEqual({
      agentId: 'a',
      isRepo: false,
      commits: [],
      truncated: false
    })
    expect(rawImpl).not.toHaveBeenCalled()
  })
})

describe('createWorkspaceGit.pull', () => {
  it('reports isRepo:false / ok:false for a from-scratch workspace (nothing to sync)', async () => {
    const dir = ws(false)
    const git = createWorkspaceGit(workspaces, async () => dir)
    expect(await git.pull('a')).toEqual({
      agentId: 'a',
      isRepo: false,
      ok: false,
      detail: 'workspace is not a git checkout'
    })
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([])
  })

  it('syncs the configured branch to the remote and summarizes the update on success', async () => {
    const dir = ws(true)
    rawImpl = syncRaw({ after: AFTER, numstat: '10\t3\ta.ts\n0\t0\tb.ts\n' })
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      (id) => id,
      githubTarget
    )
    const r = await git.pull('a')
    expect(
      simpleGitArgs.some((options) => (options as { abort?: unknown } | undefined)?.abort instanceof AbortSignal)
    ).toBe(true)
    // Fetch the configured branch through the credential alias, then pin and check out — never a merge.
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([
      [
        'fetch',
        '--no-recurse-submodules',
        expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
        '+refs/heads/main:refs/remotes/origin/main'
      ],
      ['checkout', '--no-recurse-submodules', '--no-track', '-B', 'main', 'refs/remotes/origin/main']
    ])
    expect(envImpl).toHaveBeenCalledWith(
      expect.objectContaining({ AC_GITCRED_CAPABILITY: 'cap-a', GIT_ALLOW_PROTOCOL: 'https:ssh' })
    )
    expect(r).toMatchObject({ isRepo: true, ok: true, changed: 2, insertions: 10, deletions: 3 })
    expect(r.detail).toBe('Synced main — updated 2 files.')
  })

  it('names the branch it had to leave when the checkout was parked elsewhere', async () => {
    const dir = ws(true)
    rawImpl = syncRaw({ current: 'dev/agent/canary', after: AFTER, numstat: '1\t1\tREADME.md\n' })
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )
    const r = await git.pull('a')
    expect(r).toMatchObject({ ok: true, changed: 1 })
    expect(r.detail).toBe('Switched from dev/agent/canary to main — updated 1 file.')
  })

  it('refuses, as data, a local commit the remote lacks instead of discarding it', async () => {
    const dir = ws(true)
    rawImpl = syncRaw({ unique: '2' })
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )
    const r = await git.pull('a')
    expect(r).toMatchObject({ isRepo: true, ok: false })
    expect(r.detail).toMatch(/local main has 2 commits the remote does not/)
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>).map((args) => args[0])).toEqual(['fetch'])
  })

  it('sanitizes host git context before inspecting the origin', async () => {
    const dir = ws(true)
    const previousGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = '/tmp/attacker-controlled-git-dir'
    const probes = syncRaw()
    rawImpl = vi.fn().mockImplementation(async (args: string[]) => {
      expect(envImpl).toHaveBeenCalled()
      const firstEnv = (envImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, string>
      expect(firstEnv).not.toHaveProperty('GIT_DIR')
      expect(firstEnv.GIT_ALLOW_PROTOCOL).toBe('')
      return probes(args)
    })

    try {
      await expect(
        createWorkspaceGit(
          workspaces,
          async () => dir,
          () => undefined,
          githubTarget
        ).pull('a')
      ).resolves.toMatchObject({
        ok: true
      })
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }
  })

  it('pulls the SCOPED root: its own target, its credentials, and no fallback to the primary', async () => {
    const dir = ws(true)
    rawImpl = syncRaw({ origin: 'https://github.com/acme/infra.git' })
    const roots: (string | undefined)[] = []
    const credentialScopes: (string | undefined)[] = []
    const git = createWorkspaceGit(
      workspaces,
      async (_id, _sessionId, repo) => {
        roots.push(repo)
        return dir
      },
      // A manual GitHub primary authorizes an App-covered repository: the SECONDARY root needs the
      // helper the primary does not, so the decision must follow the scope rather than the workspace.
      (id, repo) => {
        credentialScopes.push(repo)
        return repo ? id : undefined
      },
      async (_id, repo) =>
        repo
          ? { repo: 'https://github.com/acme/infra.git', branch: 'trunk', githubApp: true }
          : { repo: 'https://github.com/acme/repo.git', branch: 'main', githubApp: false }
    )

    expect(await git.pull('a', 'acme/infra')).toMatchObject({ ok: true })
    expect(roots).toEqual(['acme/infra'])
    expect(credentialScopes).toEqual(['acme/infra'])
    // The refspec git was asked for names the secondary root's branch, never the primary's.
    expect(rawImpl).toHaveBeenCalledWith([
      'fetch',
      '--no-recurse-submodules',
      expect.any(String),
      '+refs/heads/trunk:refs/remotes/origin/trunk'
    ])
  })

  it('reports "Already in sync." when nothing changed', async () => {
    const dir = ws(true)
    rawImpl = syncRaw()
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )
    const r = await git.pull('a')
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('Already in sync.')
  })

  it('refuses an unsafe origin without syncing or echoing its secrets', async () => {
    const dir = ws(true)
    rawImpl = vi.fn().mockResolvedValue('https://legacy-user:super-secret@invalid.invalid/repo?token=query-secret\n')
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )

    const result = await git.pull('a')

    expect(result).toEqual({
      agentId: 'a',
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('query-secret')
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([])
  })

  it('refuses a safe but mismatched origin for an App-backed workspace', async () => {
    const dir = ws(true)
    rawImpl = vi.fn().mockResolvedValue('git@github.com:acme/repo.git\n')
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => ({ repo: 'https://github.com/acme/repo.git', branch: 'main', githubApp: true })
    )

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([])
  })

  it('refuses to sync without the configured workspace target', async () => {
    const dir = ws(true)
    const git = createWorkspaceGit(workspaces, async () => dir)

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([])
  })

  it('refuses checkout-owned URL rewrites before pull', async () => {
    const dir = ws(true)
    rawImpl = vi
      .fn()
      .mockImplementation(async (args: string[]) =>
        args[0] === 'remote'
          ? 'https://github.com/acme/repo.git\n'
          : 'url.https://127.0.0.1.invalid/redirected/.insteadof\0'
      )
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace Git configuration contains a disallowed network override or executable setting'
    })
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>)).toEqual([])
  })

  it('pulls normally when local includes only configure repository hooks', async () => {
    const dir = ws(true)
    const probes = syncRaw()
    rawImpl = vi
      .fn()
      .mockImplementation(async (args: string[]) =>
        args[0] === 'config' ? 'include.path\0core.hookspath\0' : probes(args)
      )
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )

    await expect(git.pull('a')).resolves.toMatchObject({ isRepo: true, ok: true })
    expect(syncWrites(rawImpl as ReturnType<typeof vi.fn>).map((args) => args[0])).toEqual(['fetch', 'checkout'])
  })

  it('ignores a checkout-controlled upstream and syncs the configured target explicitly', async () => {
    const dir = ws(true)
    rawImpl = syncRaw()
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      async () => ({ repo: 'https://github.com/acme/repo.git', branch: 'release/v2', githubApp: true })
    )

    await expect(git.pull('a')).resolves.toMatchObject({ ok: true })

    expect(rawImpl).toHaveBeenCalledWith([
      'fetch',
      '--no-recurse-submodules',
      expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
      '+refs/heads/release/v2:refs/remotes/origin/release/v2'
    ])
    expect(
      (envImpl as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        Object.values(call[0] as Record<string, string>).includes('https://github.com/acme/repo.git')
      )
    ).toBe(true)
  })

  it('surfaces a refused sync as ok:false and scrubs the host path out of the detail', async () => {
    const dir = ws(true)
    const probes = syncRaw()
    rawImpl = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout') throw new Error(`Your local changes would be overwritten by checkout: ${dir}/x`)
      return probes(args)
    })
    const git = createWorkspaceGit(
      workspaces,
      async () => dir,
      () => undefined,
      githubTarget
    )
    const r = await git.pull('a')
    expect(r.ok).toBe(false)
    expect(r.detail).not.toContain(dir) // absolute host path must not leak
    expect(r.detail).toContain('<workspace>')
  })
})

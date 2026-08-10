import { describe, it, expect, vi, beforeEach } from 'vitest'
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
const { WorkspaceViolationError } = await import('../src/cp/workspace-reader.js')

/** A temp dir; `repo:true` seeds a `.git/` so it reads as a git-repo checkout. */
function ws(repo: boolean): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ac-git-')), 'co')
  mkdirSync(dir, { recursive: true })
  if (repo) mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

const githubTarget = () => ({
  repo: 'https://github.com/acme/repo.git',
  branch: 'main',
  githubApp: false
})

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
    const git = createWorkspaceGit(() => dir)
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
    const git = createWorkspaceGit(() => dir)
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
    const git = createWorkspaceGit(() => dir)
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
    const git = createWorkspaceGit(() => dir)
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
    logImpl = vi.fn().mockResolvedValue({
      latest: {
        hash: 'a3f9c21deadbeef0000000000000000000000000',
        date: '2026-07-02T07:00:00+00:00',
        subject: 'Pin deploy image'
      }
    })
    const git = createWorkspaceGit(() => dir)
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
    const git = createWorkspaceGit(() => dir)
    const s = await git.status('a')
    expect(s.lastCommit).toBeUndefined()
  })

  // The numstat join, the binary/untracked cases and the no-HEAD failure moved to
  // workspace-git-read.test.ts when the read moved off simple-git onto a bounded
  // execFile: this suite mocks simple-git, so it can no longer feed or observe that
  // read, and a case that cannot construct its own state is worse than no case.

  it('throws WorkspaceViolationError for an unknown agent', async () => {
    const git = createWorkspaceGit(() => undefined)
    await expect(git.status('nope')).rejects.toBeInstanceOf(WorkspaceViolationError)
    await expect(git.diff({ agentId: 'nope', path: 'a.ts', staged: false })).rejects.toBeInstanceOf(
      WorkspaceViolationError
    )
    await expect(git.log({ agentId: 'nope', limit: 20 })).rejects.toBeInstanceOf(WorkspaceViolationError)
  })

  it('short-circuits diff and log for a from-scratch workspace without touching git', async () => {
    const dir = ws(false)
    const git = createWorkspaceGit(() => dir)
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
  it('reports isRepo:false / ok:false for a from-scratch workspace (nothing to pull)', async () => {
    const dir = ws(false)
    const git = createWorkspaceGit(() => dir)
    expect(await git.pull('a')).toEqual({
      agentId: 'a',
      isRepo: false,
      ok: false,
      detail: 'workspace is not a git checkout'
    })
    expect(pullImpl).not.toHaveBeenCalled()
  })

  it('ff-only pulls and summarizes the update on success', async () => {
    const dir = ws(true)
    pullImpl = vi.fn().mockResolvedValue({ files: ['a.ts', 'b.ts'], summary: { insertions: 10, deletions: 3 } })
    const git = createWorkspaceGit(
      () => dir,
      () => ({ AC_GITCRED_CAPABILITY: 'cap-a' }),
      githubTarget
    )
    const r = await git.pull('a')
    expect(
      simpleGitArgs.some((options) => (options as { abort?: unknown } | undefined)?.abort instanceof AbortSignal)
    ).toBe(true)
    expect(pullImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
      '+refs/heads/main:refs/remotes/origin/main',
      ['--ff-only', '--no-recurse-submodules']
    )
    expect(envImpl).toHaveBeenCalledWith(
      expect.objectContaining({ AC_GITCRED_CAPABILITY: 'cap-a', GIT_ALLOW_PROTOCOL: 'https:ssh' })
    )
    expect(r).toMatchObject({ isRepo: true, ok: true, changed: 2, insertions: 10, deletions: 3 })
    expect(r.detail).toMatch(/updated 2 files/i)
  })

  it('sanitizes host git context before inspecting the origin', async () => {
    const dir = ws(true)
    const previousGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = '/tmp/attacker-controlled-git-dir'
    rawImpl = vi.fn().mockImplementation(async () => {
      expect(envImpl).toHaveBeenCalled()
      const firstEnv = (envImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, string>
      expect(firstEnv).not.toHaveProperty('GIT_DIR')
      expect(firstEnv.GIT_ALLOW_PROTOCOL).toBe('')
      return 'https://github.com/acme/repo.git\n'
    })
    pullImpl = vi.fn().mockResolvedValue({ files: [], summary: { insertions: 0, deletions: 0 } })

    try {
      await expect(
        createWorkspaceGit(
          () => dir,
          () => ({}),
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

  it('reports "Already up to date." when nothing changed', async () => {
    const dir = ws(true)
    pullImpl = vi.fn().mockResolvedValue({ files: [], summary: { insertions: 0, deletions: 0 } })
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
      githubTarget
    )
    const r = await git.pull('a')
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('Already up to date.')
  })

  it('refuses an unsafe origin without running pull or echoing its secrets', async () => {
    const dir = ws(true)
    rawImpl = vi.fn().mockResolvedValue('https://legacy-user:super-secret@invalid.invalid/repo?token=query-secret\n')
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
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
    expect(pullImpl).not.toHaveBeenCalled()
  })

  it('refuses a safe but mismatched origin for an App-backed workspace', async () => {
    const dir = ws(true)
    rawImpl = vi.fn().mockResolvedValue('git@github.com:acme/repo.git\n')
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
      () => ({ repo: 'https://github.com/acme/repo.git', branch: 'main', githubApp: true })
    )

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
    expect(pullImpl).not.toHaveBeenCalled()
  })

  it('refuses to pull without the configured workspace target', async () => {
    const dir = ws(true)
    const git = createWorkspaceGit(() => dir)

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace origin is not a safe remote'
    })
    expect(pullImpl).not.toHaveBeenCalled()
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
      () => dir,
      () => ({}),
      githubTarget
    )

    expect(await git.pull('a')).toMatchObject({
      isRepo: true,
      ok: false,
      detail: 'workspace Git configuration contains a disallowed network override or executable setting'
    })
    expect(pullImpl).not.toHaveBeenCalled()
  })

  it('pulls normally when local includes only configure repository hooks', async () => {
    const dir = ws(true)
    rawImpl = vi
      .fn()
      .mockImplementation(async (args: string[]) =>
        args[0] === 'remote' ? 'https://github.com/acme/repo.git\n' : 'include.path\0core.hookspath\0'
      )
    pullImpl = vi.fn().mockResolvedValue({ files: [], summary: { insertions: 0, deletions: 0 } })
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
      githubTarget
    )

    await expect(git.pull('a')).resolves.toMatchObject({ isRepo: true, ok: true })
    expect(pullImpl).toHaveBeenCalledOnce()
  })

  it('ignores a checkout-controlled upstream and pulls the configured target explicitly', async () => {
    const dir = ws(true)
    rawImpl = vi
      .fn()
      .mockImplementation(async (args: string[]) => (args[0] === 'remote' ? 'https://github.com/acme/repo.git\n' : ''))
    pullImpl = vi.fn().mockResolvedValue({ files: [], summary: { insertions: 0, deletions: 0 } })
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
      () => ({ repo: 'https://github.com/acme/repo.git', branch: 'release/v2', githubApp: true })
    )

    await expect(git.pull('a')).resolves.toMatchObject({ ok: true })

    expect(pullImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^agentconnect-[0-9a-f-]+$/),
      '+refs/heads/release/v2:refs/remotes/origin/release/v2',
      ['--ff-only', '--no-recurse-submodules']
    )
    expect(
      (envImpl as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        Object.values(call[0] as Record<string, string>).includes('https://github.com/acme/repo.git')
      )
    ).toBe(true)
  })

  it('surfaces a failed pull as ok:false and scrubs the host path out of the detail', async () => {
    const dir = ws(true)
    pullImpl = vi.fn().mockRejectedValue(new Error(`cannot fast-forward in ${dir}/x`))
    const git = createWorkspaceGit(
      () => dir,
      () => ({}),
      githubTarget
    )
    const r = await git.pull('a')
    expect(r.ok).toBe(false)
    expect(r.detail).not.toContain(dir) // absolute host path must not leak
    expect(r.detail).toContain('<workspace>')
  })
})

import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFor, workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import { GitExecError, GitExecPayloadSchema, ShimGitRunner, parsePorcelainV2 } from '../src/shim/git-exec.js'
import type { ShimRequester } from '../src/shim/channels.js'

/**
 * ONE contract, both runners.
 *
 * The local runner executes git on this daemon's disk; the remote one sends the same argv to a
 * sandbox. Both are run against the SAME real repository here, and their answers compared —
 * because the risk this seam introduces is not a crash, it is a quiet divergence, where a
 * cluster-backed agent reads a different workspace state than a self-hosted one.
 *
 * The remote side is exercised through a requester that actually invokes git in the target
 * directory, standing in for the shim's exec handler. It is deliberately NOT a canned
 * response: a fake that returns what the runner expects would only confirm the runner's own
 * assumptions, which is exactly how earlier defects in this workstream survived their tests.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
      ...extraEnv
    }
  })
}

/** A repository with two commits, one staged change and one untracked file. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-gitrunner-'))
  roots.push(root)
  git(root, ['init', '--initial-branch=main'])
  writeFileSync(join(root, 'first.txt'), 'one\n')
  git(root, ['add', 'first.txt'])
  git(root, ['commit', '-m', 'first commit'])
  writeFileSync(join(root, 'second.txt'), 'two\n')
  git(root, ['add', 'second.txt'])
  git(root, ['commit', '-m', 'second commit'])
  writeFileSync(join(root, 'staged.txt'), 'staged\n')
  git(root, ['add', 'staged.txt'])
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n')
  return root
}

/** Stands in for the shim: actually runs the requested git argv in the target directory. */
function sandboxRequester(root: string): ShimRequester & { seen: unknown[] } {
  const seen: unknown[] = []
  return {
    seen,
    request: async (capability, payload) => {
      seen.push(payload)
      expect(capability).toBe('exec')
      const parsed = GitExecPayloadSchema.parse(payload)
      try {
        // As given, never merged into ambient env: merging here would have concealed the
        // runner merging, which is the defect this parity suite exists to surface.
        const stdout = parsed.env
          ? execFileSync('git', parsed.args, { cwd: parsed.cwd ?? root, encoding: 'utf8', env: parsed.env })
          : git(parsed.cwd ?? root, parsed.args)
        return { code: 0, stdout, stderr: '' }
      } catch (err) {
        const failure = err as { status?: number; stdout?: string; stderr?: string }
        return {
          code: failure.status ?? 1,
          stdout: String(failure.stdout ?? ''),
          stderr: String(failure.stderr ?? '')
        }
      }
    }
  }
}

function runners(root: string): {
  local: GitRunner
  remote: GitRunner
  requester: ReturnType<typeof sandboxRequester>
} {
  const requester = sandboxRequester(root)
  return { local: new LocalGitRunner(gitFor(root)), remote: new ShimGitRunner(requester, root), requester }
}

describe('git runner contract, local and shim-backed', () => {
  it('reports the same status summary from both sides', async () => {
    const root = repository()
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.status(), remote.status()])

    expect(fromRemote.current).toBe(fromLocal.current)
    expect(fromRemote.current).toBe('main')
    expect(fromRemote.ahead).toBe(fromLocal.ahead)
    expect(fromRemote.behind).toBe(fromLocal.behind)
    // Compare the file set rather than array order, which neither format guarantees.
    const paths = (summary: typeof fromLocal) => summary.files.map((file) => file.path).sort()
    expect(paths(fromRemote)).toEqual(paths(fromLocal))
    expect(paths(fromRemote)).toEqual(['staged.txt', 'untracked.txt'])
  })

  it('reports the same commit log from both sides', async () => {
    const root = repository()
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.log({ maxCount: 5 }), remote.log({ maxCount: 5 })])
    expect(fromRemote.map((entry) => entry.message)).toEqual(fromLocal.map((entry) => entry.message))
    expect(fromRemote.map((entry) => entry.message)).toEqual(['second commit', 'first commit'])
    expect(fromRemote.map((entry) => entry.hash)).toEqual(fromLocal.map((entry) => entry.hash))
  })

  it('returns the same output for the raw subcommands the daemon actually uses', async () => {
    const root = repository()
    const { local, remote } = runners(root)
    for (const args of [
      ['rev-parse', '--verify', 'HEAD'],
      ['rev-list', '--count', 'HEAD'],
      ['status', '--porcelain'],
      ['remote'],
      ['check-ref-format', '--branch', 'main']
    ]) {
      const [fromLocal, fromRemote] = await Promise.all([local.raw(args), remote.raw(args)])
      expect(fromRemote.trim(), `raw ${args.join(' ')}`).toBe(fromLocal.trim())
    }
  })

  it('sends argv rather than a shell string, so a crafted branch name cannot inject', async () => {
    const root = repository()
    const { remote, requester } = runners(root)
    await remote.raw(['check-ref-format', '--branch', 'main']).catch(() => undefined)
    for (const payload of requester.seen) {
      expect(Array.isArray((payload as { args: unknown }).args)).toBe(true)
      // No element may smuggle a second command: the shim spawns argv directly.
      for (const arg of (payload as { args: string[] }).args) expect(typeof arg).toBe('string')
    }
    // A hostile-looking argument stays one argument rather than becoming a command.
    const hostile = 'main; rm -rf /'
    const result = await remote.raw(['check-ref-format', '--branch', hostile]).catch((err: unknown) => err)
    expect(result).toBeInstanceOf(GitExecError)
    expect((requester.seen.at(-1) as { args: string[] }).args).toEqual(['check-ref-format', '--branch', hostile])
  })

  it('surfaces a git failure with its exit code and stderr, from both sides', async () => {
    const root = repository()
    const { local, remote } = runners(root)
    const localError = await local.raw(['rev-parse', '--verify', 'refs/heads/missing']).catch((err: unknown) => err)
    const remoteError = await remote.raw(['rev-parse', '--verify', 'refs/heads/missing']).catch((err: unknown) => err)
    expect(localError).toBeInstanceOf(Error)
    expect(remoteError).toBeInstanceOf(GitExecError)
    expect((remoteError as GitExecError).code).not.toBe(0)
  })

  it('applies a complete per-invocation env on both sides, and scopes it to the request remotely', async () => {
    // Every call site threads env per invocation — the credential-helper pointers among it —
    // so a seam that could not carry env could not preserve behaviour. Remotely it must also
    // stay ON the request: setting it on the sandbox would leave a runtime able to read the
    // pointers back out of its own environment afterwards.
    const root = repository()
    const { local, remote, requester } = runners(root)
    // The env REPLACES rather than extends, because callers build it by sanitizing — so a
    // caller supplies a whole environment including identity. Passing only an author, as an
    // earlier version of this test did, leaves git with no committer and fails anywhere the
    // ambient config does not happen to supply one. It passed on my machine and was red in CI.
    const marker = { GIT_AUTHOR_NAME: 'Env Applied' }
    // Built from the production helper rather than raw process.env: that is what call sites
    // pass, and it is also what simple-git's own checker accepts — raw process.env carries
    // names it refuses, such as GIT_EDITOR, which is the sanitization earning its keep.
    const complete = (extra: Record<string, string>): Record<string, string> => ({
      ...workspaceGitLocalEnv(),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
      ...extra
    })

    writeFileSync(join(root, 'third.txt'), 'three\n')
    git(root, ['add', 'third.txt'])
    await local
      .withEnv(complete({ ...marker, GIT_AUTHOR_EMAIL: 'env@example.com' }))
      .raw(['commit', '-m', 'local env commit'])
    const localAuthor = git(root, ['log', '-1', '--format=%an']).trim()
    expect(localAuthor).toBe('Env Applied')

    writeFileSync(join(root, 'fourth.txt'), 'four\n')
    git(root, ['add', 'fourth.txt'])
    await remote
      .withEnv(complete({ ...marker, GIT_AUTHOR_EMAIL: 'env@example.com' }))
      .raw(['commit', '-m', 'remote env commit'])
    expect(git(root, ['log', '-1', '--format=%an']).trim()).toBe('Env Applied')

    // The env travelled with the request rather than being set globally.
    const payload = requester.seen.at(-1) as { env?: Record<string, string> }
    expect(payload.env).toMatchObject(marker)
  })

  it('replaces rather than extends a chained environment, as simple-git does', async () => {
    // remote.withEnv(A).withEnv(B) must behave like two .env() calls: B alone. Merging would
    // keep a variable A had and B deliberately dropped — and the omission IS the sanitization.
    const root = repository()
    const { remote, requester } = runners(root)
    const base = { ...workspaceGitLocalEnv(), GIT_AUTHOR_NAME: 'First', DROPPED_BY_SECOND: 'yes' }
    const second = { ...workspaceGitLocalEnv(), GIT_AUTHOR_NAME: 'Second' }
    await remote.withEnv(base).withEnv(second).raw(['rev-parse', '--verify', 'HEAD'])
    const payload = requester.seen.at(-1) as { env?: Record<string, string> }
    expect(payload.env?.GIT_AUTHOR_NAME).toBe('Second')
    expect(payload.env?.DROPPED_BY_SECOND).toBeUndefined()
  })

  it('reports a nested untracked FILE, not just its directory, on both sides', async () => {
    // simple-git runs status with `-u`, so it lists nested untracked files individually. An
    // argv without it collapses them to `nested/`, which is a different answer to the same
    // question depending on where git ran.
    const root = mkdtempSync(join(tmpdir(), 'ac-gitnested-'))
    roots.push(root)
    git(root, ['init', '--initial-branch=main'])
    writeFileSync(join(root, 'tracked.txt'), 'x\n')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-m', 'base'])
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'nested', 'file.txt'), 'deep\n')
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.status(), remote.status()])
    expect(fromRemote.files.map((file) => file.path)).toEqual(fromLocal.files.map((file) => file.path))
    expect(fromRemote.files.map((file) => file.path)).toContain('nested/file.txt')
  })

  it('reports a staged RENAME identically on both sides', async () => {
    // porcelain-v2 gives a rename nine fields before the path plus the original path after a
    // separator. An earlier parser treated it like an ordinary entry, so `path` came back as
    // "R100 new.txt\told.txt" — a value no caller could match against a real file.
    const root = repository()
    git(root, ['commit', '-m', 'stage base'])
    git(root, ['mv', 'first.txt', 'renamed.txt'])
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.status(), remote.status()])
    const renamed = (summary: typeof fromLocal) => summary.files.map((file) => file.path).sort()
    expect(renamed(fromRemote)).toEqual(renamed(fromLocal))
    expect(renamed(fromRemote)).toContain('renamed.txt')
    for (const path of renamed(fromRemote)) expect(path).not.toMatch(/^R\d/)
  })

  it('reports a CONFLICT on both sides, so a conflicted tree is never seen as clean', async () => {
    // Unmerged records were dropped entirely, so files.length was 0 on a conflicted workspace —
    // and callers derive cleanliness from exactly that.
    const root = mkdtempSync(join(tmpdir(), 'ac-gitconflict-'))
    roots.push(root)
    git(root, ['init', '--initial-branch=main'])
    writeFileSync(join(root, 'shared.txt'), 'base\n')
    git(root, ['add', 'shared.txt'])
    git(root, ['commit', '-m', 'base'])
    git(root, ['checkout', '-b', 'other'])
    writeFileSync(join(root, 'shared.txt'), 'theirs\n')
    git(root, ['commit', '-am', 'theirs'])
    git(root, ['checkout', 'main'])
    writeFileSync(join(root, 'shared.txt'), 'ours\n')
    git(root, ['commit', '-am', 'ours'])
    try {
      git(root, ['merge', 'other'])
    } catch {
      /* the conflict is the point */
    }
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.status(), remote.status()])
    expect(fromLocal.files.length).toBeGreaterThan(0)
    expect(fromRemote.files.map((file) => file.path)).toEqual(fromLocal.files.map((file) => file.path))
    expect(fromRemote.files.map((file) => file.path)).toContain('shared.txt')
  })

  it('parses a detached HEAD and upstream tracking the way git reports them', () => {
    // Unit-level, because a detached checkout is awkward to stage and the format is the part
    // that can silently drift.
    const detached = parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0')
    expect(detached.current).toBeNull()
    const tracking = parsePorcelainV2(
      '# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0? new.txt\0'
    )
    expect(tracking).toMatchObject({ current: 'main', tracking: 'origin/main', ahead: 2, behind: 3 })
    expect(tracking.files).toEqual([{ path: 'new.txt', index: '?', working_dir: '?' }])
    // A rename record consumes the following original-path entry rather than parsing it.
    const renames = parsePorcelainV2('2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\0old.txt\0')
    expect(renames.files).toEqual([{ path: 'new.txt', index: 'R', working_dir: ' ' }])
    const unmerged = parsePorcelainV2('u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0')
    expect(unmerged.files).toEqual([{ path: 'conflict.txt', index: 'U', working_dir: 'U' }])
  })
})

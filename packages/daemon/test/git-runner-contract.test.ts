import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFor } from '../src/workspace/git-injection.js'
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
        const stdout = git(parsed.cwd ?? root, parsed.args, parsed.env)
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

  it('applies per-invocation env on both sides, and scopes it to the request remotely', async () => {
    // Every call site threads env per invocation — the credential-helper pointers among it —
    // so a seam that could not carry env could not preserve behaviour. Remotely it must also
    // stay ON the request: setting it on the sandbox would leave a runtime able to read the
    // pointers back out of its own environment afterwards.
    const root = repository()
    const { local, remote, requester } = runners(root)
    const marker = { GIT_AUTHOR_NAME: 'Env Applied' }

    writeFileSync(join(root, 'third.txt'), 'three\n')
    git(root, ['add', 'third.txt'])
    await local.withEnv({ ...marker, GIT_AUTHOR_EMAIL: 'env@example.com' }).raw(['commit', '-m', 'local env commit'])
    const localAuthor = git(root, ['log', '-1', '--format=%an']).trim()
    expect(localAuthor).toBe('Env Applied')

    writeFileSync(join(root, 'fourth.txt'), 'four\n')
    git(root, ['add', 'fourth.txt'])
    await remote.withEnv({ ...marker, GIT_AUTHOR_EMAIL: 'env@example.com' }).raw(['commit', '-m', 'remote env commit'])
    expect(git(root, ['log', '-1', '--format=%an']).trim()).toBe('Env Applied')

    // The env travelled with the request rather than being set globally.
    const payload = requester.seen.at(-1) as { env?: Record<string, string> }
    expect(payload.env).toMatchObject(marker)
  })

  it('parses a detached HEAD and upstream tracking the way git reports them', () => {
    // Unit-level, because a detached checkout is awkward to stage and the format is the part
    // that can silently drift.
    const detached = parsePorcelainV2('# branch.oid abc\n# branch.head (detached)\n')
    expect(detached.current).toBeNull()
    const tracking = parsePorcelainV2(
      '# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n? new.txt\n'
    )
    expect(tracking).toMatchObject({ current: 'main', tracking: 'origin/main', ahead: 2, behind: 3 })
    expect(tracking.files).toEqual([{ path: 'new.txt', index: '?', working_dir: '?' }])
  })
})

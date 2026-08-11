import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitFor, workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import { GitExecError, ShimGitRunner, parsePorcelainV2, parseShortstat } from '../src/shim/git-exec.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
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

/**
 * The shim side, served by the handler that actually ships.
 *
 * An earlier version ran git itself here. That made the parity claim weaker than it looked: it
 * held between the runner and a test helper, while production paired the runner with
 * `createExecHandler`. Routing through the real handler also means every argv the daemon
 * genuinely sends is checked against the declared inventory by this suite — the inventory was
 * derived by reading call sites, and a call site the reading missed fails here.
 */
function sandboxRequester(root: string): ShimRequester & { seen: unknown[] } {
  const seen: unknown[] = []
  const handle = createExecHandler({ workspaceRoot: root, log: { info: () => {}, warn: () => {} } })
  return {
    seen,
    request: async (capability, payload) => {
      seen.push(payload)
      expect(capability).toBe('exec')
      return await handle(capability, payload)
    }
  }
}

function runners(root: string): {
  local: GitRunner
  remote: GitRunner
  requester: ReturnType<typeof sandboxRequester>
} {
  const requester = sandboxRequester(root)
  return {
    local: new LocalGitRunner(gitFor(root), root, (env) => gitFor(root).env(env)),
    remote: new ShimGitRunner(requester, root),
    requester
  }
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
    // `clean` comes from simple-git locally and is derived remotely; this is what establishes
    // that the two agree rather than my assumption about isClean()'s semantics.
    expect(fromRemote.clean).toBe(fromLocal.clean)
    expect(fromRemote.clean).toBe(false)
  })

  it('returns the same bytes from a bounded read, and the same flag when it overflows', async () => {
    // `readBounded` exists so a large diff or numstat cannot stream unbounded into the daemon's
    // memory or the wire frame. Both sides must answer the same question the same way; they are
    // allowed to differ in HOW they stop (the local child dies at the cap, the sandbox refuses
    // past its own frame ceiling) but not in what the caller observes.
    const root = repository()
    const { local, remote } = runners(root)

    const args = ['status', '--porcelain', '-z']
    const [fromLocal, fromRemote] = await Promise.all([
      local.readBounded(args, 64 * 1024),
      remote.readBounded(args, 64 * 1024)
    ])
    expect(fromRemote.overflow).toBe(false)
    expect(fromLocal.overflow).toBe(false)
    expect(fromRemote.out.toString('utf8')).toBe(fromLocal.out.toString('utf8'))
    expect(fromLocal.out.toString('utf8')).toContain('staged.txt')

    // A ceiling below the real output: both report overflow rather than throwing, and neither
    // hands back more than it was allowed.
    const [tinyLocal, tinyRemote] = await Promise.all([local.readBounded(args, 4), remote.readBounded(args, 4)])
    expect(tinyLocal.overflow).toBe(true)
    expect(tinyRemote.overflow).toBe(true)
    expect(tinyLocal.out.byteLength).toBeLessThanOrEqual(4)
    expect(tinyRemote.out.byteLength).toBeLessThanOrEqual(4)
  })

  it('agrees on cleanliness across clean, dirty and CONFLICTED trees', async () => {
    // The console gates on `clean`, and unmerged records were once dropped entirely — so a
    // conflicted tree reporting clean is the failure this pins.
    const pristine = mkdtempSync(join(tmpdir(), 'ac-gitclean-'))
    roots.push(pristine)
    git(pristine, ['init', '--initial-branch=main'])
    writeFileSync(join(pristine, 'a.txt'), 'a\n')
    git(pristine, ['add', 'a.txt'])
    git(pristine, ['commit', '-m', 'only'])
    const cleanPair = runners(pristine)
    const [cleanLocal, cleanRemote] = await Promise.all([cleanPair.local.status(), cleanPair.remote.status()])
    expect(cleanRemote.clean).toBe(cleanLocal.clean)
    expect(cleanRemote.clean).toBe(true)

    const conflicted = mkdtempSync(join(tmpdir(), 'ac-gitclean-conflict-'))
    roots.push(conflicted)
    git(conflicted, ['init', '--initial-branch=main'])
    writeFileSync(join(conflicted, 'shared.txt'), 'base\n')
    git(conflicted, ['add', 'shared.txt'])
    git(conflicted, ['commit', '-m', 'base'])
    git(conflicted, ['checkout', '-b', 'other'])
    writeFileSync(join(conflicted, 'shared.txt'), 'theirs\n')
    git(conflicted, ['commit', '-am', 'theirs'])
    git(conflicted, ['checkout', 'main'])
    writeFileSync(join(conflicted, 'shared.txt'), 'ours\n')
    git(conflicted, ['commit', '-am', 'ours'])
    try {
      git(conflicted, ['merge', 'other'])
    } catch {
      /* the conflict is the point */
    }
    const conflictPair = runners(conflicted)
    const [conflictLocal, conflictRemote] = await Promise.all([
      conflictPair.local.status(),
      conflictPair.remote.status()
    ])
    expect(conflictRemote.clean).toBe(conflictLocal.clean)
    expect(conflictRemote.clean).toBe(false)
  })

  it('reports the same commit log from both sides', async () => {
    const root = repository()
    const { local, remote } = runners(root)
    const [fromLocal, fromRemote] = await Promise.all([local.log({ maxCount: 5 }), remote.log({ maxCount: 5 })])
    expect(fromRemote.map((entry) => entry.subject)).toEqual(fromLocal.map((entry) => entry.subject))
    expect(fromRemote.map((entry) => entry.subject)).toEqual(['second commit', 'first commit'])
    expect(fromRemote.map((entry) => entry.hash)).toEqual(fromLocal.map((entry) => entry.hash))
    // The committer date is consumed by the console's workspace view, so parity covers it too:
    // an interface that dropped it could not serve "when did HEAD last move".
    expect(fromRemote.map((entry) => entry.committedAt)).toEqual(fromLocal.map((entry) => entry.committedAt))
    for (const entry of fromRemote) expect(entry.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
    // Proven through `config`, a subcommand the daemon actually calls. An earlier version used
    // `commit` and the shim handler refused it — correctly, since the daemon never commits and
    // the inventory is the list of what it does. Widening the inventory to suit a test would
    // have removed the guard the inventory exists to be.
    const globalConfig = join(root, 'from-request.gitconfig')
    writeFileSync(globalConfig, '[user]\n\tname = Env Applied\n')
    // Built from the production helper rather than raw process.env: that is what call sites
    // pass, and it is also what simple-git's own checker accepts — raw process.env carries
    // names it refuses, such as GIT_EDITOR, which is the sanitization earning its keep.
    const complete: Record<string, string> = { ...workspaceGitLocalEnv(), GIT_CONFIG_GLOBAL: globalConfig }

    const [fromLocal, fromRemote] = await Promise.all([
      local.withEnv(complete).raw(['config', '--get', 'user.name']),
      remote.withEnv(complete).raw(['config', '--get', 'user.name'])
    ])
    // git only reads that file if the env reached the child, so agreeing on its content is what
    // establishes both sides applied it.
    expect(fromRemote.trim()).toBe(fromLocal.trim())
    expect(fromRemote.trim()).toBe('Env Applied')

    // The env travelled with the request rather than being set globally.
    const payload = requester.seen.at(-1) as { env?: Record<string, string> }
    expect(payload.env).toMatchObject({ GIT_CONFIG_GLOBAL: globalConfig })
  })

  it('keeps two runners derived from ONE base independent (local: simple-git mutates its handle)', async () => {
    // Only the local runner can have this bug: simple-git's `.env()` mutates its instance and returns
    // it, so a `withEnv` that applied the env at derivation made siblings share one handle and the
    // LAST derivation silently win. Not academic — resolving the runner once per request and deriving
    // both an identity-carrying runner and a config-audit runner from it made a commit land as the
    // host's OS user. The shim carries the environment with each request, so it cannot alias.
    const root = repository()
    const { local } = runners(root)
    const shared = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
    const first = local.withEnv({
      ...shared,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'ac.who',
      GIT_CONFIG_VALUE_0: 'first'
    })
    const second = local.withEnv({
      ...shared,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'ac.who',
      GIT_CONFIG_VALUE_0: 'second'
    })

    // `second` was derived AFTER `first`; asking `first` must still answer with its OWN environment.
    expect((await first.raw(['config', '--get', 'ac.who'])).trim()).toBe('first')
    expect((await second.raw(['config', '--get', 'ac.who'])).trim()).toBe('second')
    expect((await first.raw(['config', '--get', 'ac.who'])).trim()).toBe('first')

    // CONCURRENTLY, which is what a shared executor cannot survive: both chains would read whichever
    // environment was mutated in last. A sequential assertion above passes even then.
    const [a, b] = await Promise.all([
      first.raw(['config', '--get', 'ac.who']),
      second.raw(['config', '--get', 'ac.who'])
    ])
    expect([a.trim(), b.trim()]).toEqual(['first', 'second'])

    // And the BASE must not have inherited a child's environment — with a shared root executor the
    // empty-env branch never resets it, so the base silently keeps the last child's value. Asserted
    // on the VALUE rather than on whether git exits non-zero for a missing key, which varies.
    const fromBase = await local.raw(['config', '--get', 'ac.who']).catch(() => '')
    expect(['first', 'second']).not.toContain(fromBase.trim())
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

  it('reports the same pull summary from both sides', async () => {
    // The console shows how many files a pull moved and by how much, so the summary is part of
    // the contract rather than a convenience: an interface returning void could not serve it.
    // A real upstream is needed, so this clones from one and pushes a change into it.
    const upstream = mkdtempSync(join(tmpdir(), 'ac-gitupstream-'))
    roots.push(upstream)
    git(upstream, ['init', '--bare', '--initial-branch=main'])
    const seed = mkdtempSync(join(tmpdir(), 'ac-gitseed-'))
    roots.push(seed)
    git(seed, ['clone', upstream, '.'])
    writeFileSync(join(seed, 'shared.txt'), 'one\n')
    git(seed, ['add', 'shared.txt'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'main'])

    const makeClone = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'ac-gitclone-'))
      roots.push(dir)
      git(dir, ['clone', upstream, '.'])
      return dir
    }
    const forLocal = makeClone()
    const forRemote = makeClone()

    // One more upstream commit touching two files, so the summary is non-trivial.
    writeFileSync(join(seed, 'shared.txt'), 'one\ntwo\n')
    writeFileSync(join(seed, 'added.txt'), 'new\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'upstream change'])
    git(seed, ['push', 'origin', 'main'])

    const fromLocal = await new LocalGitRunner(gitFor(forLocal), forLocal, (env) => gitFor(forLocal).env(env)).pull(
      'origin',
      'main'
    )
    const fromRemote = await new ShimGitRunner(sandboxRequester(forRemote), forRemote).pull('origin', 'main')

    expect([...fromRemote.files].sort()).toEqual([...fromLocal.files].sort())
    expect([...fromRemote.files].sort()).toEqual(['added.txt', 'shared.txt'])
    expect(fromRemote.insertions).toBe(fromLocal.insertions)
    expect(fromRemote.deletions).toBe(fromLocal.deletions)
    expect(fromRemote.insertions).toBeGreaterThan(0)
  })

  it('reports an up-to-date pull as no change on both sides', async () => {
    const upstream = mkdtempSync(join(tmpdir(), 'ac-gitupstream2-'))
    roots.push(upstream)
    git(upstream, ['init', '--bare', '--initial-branch=main'])
    const seed = mkdtempSync(join(tmpdir(), 'ac-gitseed2-'))
    roots.push(seed)
    git(seed, ['clone', upstream, '.'])
    writeFileSync(join(seed, 'only.txt'), 'x\n')
    git(seed, ['add', 'only.txt'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'main'])
    const clone = mkdtempSync(join(tmpdir(), 'ac-gitclone2-'))
    roots.push(clone)
    git(clone, ['clone', upstream, '.'])

    const fromLocal = await new LocalGitRunner(gitFor(clone), clone, (env) => gitFor(clone).env(env)).pull(
      'origin',
      'main'
    )
    const fromRemote = await new ShimGitRunner(sandboxRequester(clone), clone).pull('origin', 'main')
    expect(fromRemote).toEqual({ files: [], insertions: 0, deletions: 0 })
    expect(fromLocal.files).toEqual([])
    expect(fromLocal.insertions).toBe(0)
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
    expect(parseShortstat(' 2 files changed, 3 insertions(+), 1 deletion(-)\n')).toEqual({
      insertions: 3,
      deletions: 1
    })
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ insertions: 1, deletions: 0 })
    const unmerged = parsePorcelainV2('u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0')
    expect(unmerged.files).toEqual([{ path: 'conflict.txt', index: 'U', working_dir: 'U' }])
  })
})

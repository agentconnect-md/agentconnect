import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
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
import { afterAll, describe, expect, it } from 'vitest'
import {
  SKILL_GIT_MAX_STREAM_BYTES,
  SkillGitAbortedError,
  SkillGitPlanRefusedError,
  SkillGitTimeoutError,
  acquireSkillGitSource,
  gitSupportsInPodSkills,
  lsRemoteSkillRef,
  runLocalSkillGit,
  skillGitEnv,
  type SkillGitAcquireInput,
  type SkillGitInvocation,
  type SkillGitOutput,
  type SkillGitRunner
} from '../src/shim/skill-git-acquire.js'
import type { GitSkillPlan } from '../src/shim/skill-protocol.js'
import { ExecRefusedError, assertNoRefusedArguments } from '../src/workspace/git-command-policy.js'

// Shim-internal Git skill acquisition (source-cache.md §8) against real Git over file:// fixtures.

const ORIGIN_URL = 'https://git.test/skills.git'
const BUNDLE_URL = 'https://cache.test/src/o/anon/x/bundles/b.bundle?X-Amz-Signature=secret'
const SHA = 'a'.repeat(40)

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function privateStaging(root: string): string {
  const staging = join(root, 'staging')
  mkdirSync(staging, { mode: 0o700 })
  chmodSync(staging, 0o700)
  return staging
}

describe('gitSupportsInPodSkills', () => {
  it.each([
    ['git version 2.54.0 (Apple Git-157)', true],
    ['git version 2.45.1', true],
    ['git version 2.45.0', false],
    ['git version 2.46.0.windows.1', true],
    ['git version 2.44.1', true],
    ['git version 2.44.0', false],
    ['git version 2.43.4', true],
    ['git version 2.43.3', false],
    ['git version 2.39.4', true],
    ['git version 2.39.3', false],
    ['git version 2.38.5', false],
    ['git version 2.37.1', false],
    ['git version 3.0.0', true],
    ['not git', false]
  ])('%s -> %s', (version, expected) => {
    expect(gitSupportsInPodSkills(version)).toBe(expected)
  })
})

describe('plan and environment checks (no Git spawned)', () => {
  const plan: GitSkillPlan = {
    sourceId: 's',
    sourceKind: 'git',
    url: ORIGIN_URL,
    ref: 'refs/heads/main',
    plannedCommit: SHA,
    subDir: 'skills',
    selections: []
  }

  function refusing(overrides: Record<string, unknown>) {
    const root = tempRoot('ac-skill-git-plan-')
    const calls: string[][] = []
    const git: SkillGitRunner = async (invocation) => {
      calls.push(invocation.args)
      return { code: 0, stdout: '', stderr: '' }
    }
    const run = acquireSkillGitSource({
      plan: { ...plan, ...overrides } as GitSkillPlan,
      stagingRoot: privateStaging(root),
      git
    })
    return { run, calls }
  }

  it.each([
    [{ subDir: '../escape' }],
    [{ subDir: 'skills/../..' }],
    [{ subDir: '-skills' }],
    [{ ref: '-refs/heads/main' }],
    [{ ref: 'refs/heads/a..b' }],
    [{ ref: 'main' }],
    [{ url: '-https://git.test/x' }],
    [{ url: 'https://git.test/../x' }],
    [{ url: 'file:///etc' }],
    [{ plannedCommit: '-' + 'a'.repeat(39) }],
    [{ plannedCommit: 'HEAD' }],
    [{ getUrl: '-https://cache.test/b' }],
    [{ getUrl: 'file:///etc/passwd' }]
  ])('refuses %j before any spawn', async (overrides) => {
    const r = refusing(overrides)
    await expect(r.run).rejects.toBeInstanceOf(SkillGitPlanRefusedError)
    expect(r.calls).toEqual([])
  })

  it('refuses a staging directory another user could write, before any spawn', async () => {
    const root = tempRoot('ac-skill-git-staging-')
    const staging = privateStaging(root)
    chmodSync(staging, 0o755)
    const calls: string[][] = []
    await expect(
      acquireSkillGitSource({
        plan,
        stagingRoot: staging,
        git: async (invocation) => {
          calls.push(invocation.args)
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    ).rejects.toBeInstanceOf(ExecRefusedError)
    expect(calls).toEqual([])
  })

  it('forwards only the gitcred helper variables from the credential env', async () => {
    const root = tempRoot('ac-skill-git-cred-')
    const staging = privateStaging(root)
    const envs: Array<Record<string, string>> = []
    await acquireSkillGitSource({
      plan,
      stagingRoot: staging,
      shimEnv: { PATH: '/bin' },
      credential: {
        host: 'https://github.com',
        helper: '!sh /h',
        env: {
          AC_GITCRED_CAPABILITY: 'cap',
          AC_GITCRED_SOCKET: '/run/gitcred.sock',
          PATH: '/evil',
          LD_PRELOAD: '/evil.so',
          GIT_CONFIG_COUNT: '9',
          GIT_SSH_COMMAND: 'evil'
        }
      },
      git: async (invocation) => {
        envs.push(invocation.env)
        return { code: 128, stdout: '', stderr: 'fatal: nope' }
      }
    })
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env).toMatchObject({ AC_GITCRED_CAPABILITY: 'cap', AC_GITCRED_SOCKET: '/run/gitcred.sock', PATH: '/bin' })
      expect(env.LD_PRELOAD).toBeUndefined()
      expect(env.GIT_SSH_COMMAND).toBeUndefined()
      expect(Number(env.GIT_CONFIG_COUNT)).not.toBe(9)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(staging)
    }
  })

  it('builds an environment that reads no system, global or home config and appends the credential window last', () => {
    const env = skillGitEnv(
      {
        home: '/staging/home',
        ceiling: '/staging',
        shimEnv: {
          PATH: '/bin',
          HOME: '/agent',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/agent/hooks',
          GIT_DIR: '/agent/.git',
          GIT_SSH_COMMAND: 'evil'
        },
        credential: { host: 'https://github.com', helper: '!sh /helper a1', env: { AC_GITCRED_CAPABILITY: 'cap' } },
        allowFileProtocol: false
      },
      { lazyFetch: false }
    )
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/staging/home',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CEILING_DIRECTORIES: '/staging',
      AC_GITCRED_CAPABILITY: 'cap'
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`]
    ])
    expect(pairs).toContainEqual(['core.hooksPath', '/dev/null'])
    expect(pairs).toContainEqual(['core.fsmonitor', 'false'])
    expect(pairs.slice(-3)).toEqual([
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', '!sh /helper a1'],
      ['credential.https://github.com.useHttpPath', 'true']
    ])
    expect(
      skillGitEnv({ home: '/h', ceiling: '/', shimEnv: {}, allowFileProtocol: false }, { lazyFetch: true })
        .GIT_NO_LAZY_FETCH
    ).toBe(undefined)
  })
})

describe('classification without real Git', () => {
  const plan: GitSkillPlan = {
    sourceId: 's',
    sourceKind: 'git',
    url: ORIGIN_URL,
    ref: 'refs/heads/main',
    plannedCommit: SHA,
    selections: [],
    getUrl: BUNDLE_URL
  }

  it('treats a timeout as not-a-fallback: no retry without the bundle, the Source is skipped', async () => {
    const root = tempRoot('ac-skill-git-timeout-')
    const calls: string[][] = []
    const result = await acquireSkillGitSource({
      plan,
      stagingRoot: privateStaging(root),
      git: async (invocation) => {
        calls.push(invocation.args)
        throw new SkillGitTimeoutError('git clone was terminated after 1ms')
      }
    })
    expect(result).toMatchObject({ kind: 'skipped', code: 'fetch_failed' })
    expect(calls).toHaveLength(1)
    expect(readdirSync(join(root, 'staging'))).toEqual([])
  })

  it('propagates an abort without a retry', async () => {
    const root = tempRoot('ac-skill-git-abort-')
    const calls: string[][] = []
    await expect(
      acquireSkillGitSource({
        plan,
        stagingRoot: privateStaging(root),
        git: async (invocation) => {
          calls.push(invocation.args)
          throw new SkillGitAbortedError('cancelled')
        }
      })
    ).rejects.toBeInstanceOf(SkillGitAbortedError)
    expect(calls).toHaveLength(1)
    expect(readdirSync(join(root, 'staging'))).toEqual([])
  })

  it('retries a bundled refusal once without the bundle, which reports access_denied', async () => {
    const root = tempRoot('ac-skill-git-denied-')
    const calls: string[][] = []
    const result = await acquireSkillGitSource({
      plan,
      stagingRoot: privateStaging(root),
      git: async (invocation) => {
        calls.push(invocation.args)
        return { code: 128, stdout: '', stderr: 'remote: Repository not found.\nfatal: Authentication failed' }
      }
    })
    expect(result).toMatchObject({ kind: 'skipped', code: 'access_denied' })
    const clones = calls.filter((args) => args[0] === 'clone')
    expect(clones).toHaveLength(2)
    expect(clones[1]!.some((arg) => arg.startsWith('--bundle-uri='))).toBe(false)
    expect(readdirSync(join(root, 'staging'))).toEqual([])
  })

  it('reports a local permission denied from the checkout as fetch_failed, not access_denied', async () => {
    const root = tempRoot('ac-skill-git-eacces-')
    const calls: string[][] = []
    const result = await acquireSkillGitSource({
      plan: { ...plan, getUrl: undefined },
      stagingRoot: privateStaging(root),
      git: async (invocation) => {
        calls.push(invocation.args)
        if (invocation.args[0] === 'cat-file' && invocation.args[1] === '-t')
          return { code: 0, stdout: 'tree\n', stderr: '' }
        if (invocation.args[0] === 'read-tree') {
          return { code: 128, stdout: '', stderr: 'error: unable to create file a/SKILL.md: Permission denied' }
        }
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    expect(result).toMatchObject({ kind: 'skipped', code: 'fetch_failed' })
    expect(calls.map((args) => args[0])).toContain('read-tree')
  })

  it('logs raw stderr with the presigned URL scrubbed and reports only a §11 code', async () => {
    const root = tempRoot('ac-skill-git-scrub-')
    const logs: string[] = []
    const result = await acquireSkillGitSource({
      plan,
      stagingRoot: privateStaging(root),
      log: { warn: (message) => logs.push(message) },
      git: async (invocation) => ({
        code: 128,
        stdout: '',
        stderr: `fatal: could not fetch ${BUNDLE_URL}\nfatal: Authentication failed for '${ORIGIN_URL}'`
      })
    })
    expect(result).toEqual({
      kind: 'skipped',
      sourceId: 's',
      code: 'access_denied',
      reason: expect.not.stringContaining('fatal') as unknown as string
    })
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain('secret')
    expect(logs.join('\n')).toContain('https://cache.test/src/o/anon/x/bundles/b.bundle')
  })
})

describe.skipIf(process.platform === 'win32')('acquireSkillGitSource (real Git)', () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@e',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  }
  // Every argv the module composed, across the whole suite, for the refused-argument check at the end.
  const composed: string[][] = []

  function git(cwd: string, args: string[], input?: Buffer | string): { code: number; stdout: string; stderr: string } {
    const result = spawnSync('git', args, { cwd, env, ...(input !== undefined ? { input } : {}) })
    return { code: result.status ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  function ok(cwd: string, args: string[]): string {
    const result = git(cwd, args)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  function commitAll(cwd: string, message: string): string {
    ok(cwd, ['add', '-A'])
    ok(cwd, ['commit', '-qm', message])
    return ok(cwd, ['rev-parse', 'HEAD'])
  }

  /** A bare origin with skills under `skills/` on main, two commits deep, and the seed checkout that wrote it. */
  function fixture() {
    const root = tempRoot('ac-skill-git-')
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    ok(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
    ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
    mkdirSync(join(seed, 'skills', 'alpha'), { recursive: true })
    ok(seed, ['init', '-q', '--initial-branch=main'])
    writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nalpha\n')
    writeFileSync(join(seed, 'README.md'), 'outside the subdirectory\n')
    const first = commitAll(seed, 'one')
    writeFileSync(join(seed, 'skills', 'alpha', 'notes.md'), 'more\n')
    const tip = commitAll(seed, 'two')
    ok(seed, ['remote', 'add', 'origin', origin])
    ok(seed, ['push', '-q', 'origin', 'main'])
    return { root, origin, seed, first, tip, staging: privateStaging(root) }
  }

  type Fixture = ReturnType<typeof fixture>

  interface Recorded {
    args: string[]
    env: Record<string, string>
    output?: SkillGitOutput
  }

  /** The real local runner behind the test's https names, recording each spawn; `v0` makes the host refuse non-tip SHA wants on `fetch`. */
  function runner(
    f: Fixture,
    opts: { bundle?: string; v0?: boolean; after?: (invocation: SkillGitInvocation) => void } = {}
  ): { git: SkillGitRunner; calls: Recorded[] } {
    const calls: Recorded[] = []
    const git: SkillGitRunner = async (invocation) => {
      composed.push(invocation.args)
      const args = invocation.args.map((arg) => {
        if (arg === ORIGIN_URL) return `file://${f.origin}`
        if (arg === `--bundle-uri=${BUNDLE_URL}`) return `--bundle-uri=${opts.bundle ?? join(f.root, 'none.bundle')}`
        return arg
      })
      let runEnv = invocation.env
      // Protocol v2 admits any want, so only an explicit fetch is forced to v0; a lazy fetch must still reach any blob.
      if (opts.v0 && invocation.args[0] === 'fetch') {
        const count = Number(runEnv.GIT_CONFIG_COUNT)
        runEnv = {
          ...runEnv,
          GIT_CONFIG_COUNT: String(count + 1),
          [`GIT_CONFIG_KEY_${count}`]: 'protocol.version',
          [`GIT_CONFIG_VALUE_${count}`]: '0'
        }
      }
      const recorded: Recorded = { args: invocation.args, env: invocation.env }
      calls.push(recorded)
      recorded.output = await runLocalSkillGit({ ...invocation, args, env: runEnv })
      opts.after?.(invocation)
      return recorded.output
    }
    return { git, calls }
  }

  function input(f: Fixture, plan: Partial<GitSkillPlan>, git: SkillGitRunner): SkillGitAcquireInput {
    return {
      plan: {
        sourceId: 'src-1',
        sourceKind: 'git',
        url: ORIGIN_URL,
        ref: 'refs/heads/main',
        plannedCommit: f.tip,
        subDir: 'skills',
        selections: [],
        ...plan
      } as GitSkillPlan,
      stagingRoot: f.staging,
      git,
      allowFileProtocol: true,
      shimEnv: { PATH: process.env.PATH }
    }
  }

  const clones = (calls: Recorded[]) => calls.filter((call) => call.args[0] === 'clone').map((call) => call.args)

  it('installs a tracked ref at the planned commit with only the subdirectory and no .git', async () => {
    const f = fixture()
    const r = runner(f)
    const result = await acquireSkillGitSource(input(f, {}, r.git))

    expect(result).toMatchObject({ kind: 'installed', commit: f.tip, bundle: { kind: 'uncached' } })
    if (result.kind !== 'installed') throw new Error('not installed')
    expect(readdirSync(result.root).sort()).toEqual(['alpha'])
    expect(readFileSync(join(result.root, 'alpha', 'notes.md'), 'utf8')).toBe('more\n')
    expect(existsSync(join(result.root, '.git'))).toBe(false)
    expect(result.snapshot.files.map((file) => file.path)).toEqual(['alpha/SKILL.md', 'alpha/notes.md'])
    // Never shallow, always blobless, quiet where Git allows it.
    expect(clones(r.calls)).toEqual([
      ['clone', '-q', '--filter=blob:none', '--no-checkout', '--', ORIGIN_URL, join(result.gitDir, '..')]
    ])
    expect(ok(result.gitDir, ['rev-parse', '--is-shallow-repository'])).toBe('false')
    // The checkout and the clone may fetch lazily; inspection never does.
    for (const call of r.calls) {
      const lazy = call.args[0] === 'clone' || call.args[0] === 'fetch' || call.args[0] === 'read-tree'
      expect(call.env.GIT_NO_LAZY_FETCH, call.args.join(' ')).toBe(lazy ? undefined : '1')
    }
    await result.release()
    expect(readdirSync(f.staging)).toEqual([])
  })

  it('installs the whole repository root when no subdirectory is planned, still without .git', async () => {
    const f = fixture()
    const result = await acquireSkillGitSource(input(f, { subDir: undefined }, runner(f).git))
    if (result.kind !== 'installed') throw new Error(`not installed: ${JSON.stringify(result)}`)
    expect(readdirSync(result.root).sort()).toEqual(['README.md', 'skills'])
    expect(result.snapshot.files.some((file) => file.path.startsWith('.git'))).toBe(false)
    await result.release()
  })

  it('skips with ref_moved when the ref no longer names the planned commit', async () => {
    const f = fixture()
    // Resolution saw a commit the origin's main no longer reaches (a force-push since).
    writeFileSync(join(f.seed, 'lost'), 'x\n')
    const lost = commitAll(f.seed, 'never pushed')
    const r = runner(f)
    const result = await acquireSkillGitSource(input(f, { plannedCommit: lost }, r.git))

    expect(result).toMatchObject({ kind: 'skipped', code: 'ref_moved' })
    expect(r.calls.map((call) => call.args[0])).toContain('fetch')
    expect(readdirSync(f.staging)).toEqual([])
  })

  it('skips with ref_moved when the ref is gone from the origin', async () => {
    const f = fixture()
    writeFileSync(join(f.seed, 'lost'), 'x\n')
    const lost = commitAll(f.seed, 'never pushed')
    const result = await acquireSkillGitSource(
      input(f, { ref: 'refs/heads/deleted', plannedCommit: lost }, runner(f).git)
    )
    expect(result).toMatchObject({ kind: 'skipped', code: 'ref_moved' })
  })

  it('falls back to fetching all branches and tags when the host refuses a SHA want', async () => {
    const f = fixture()
    ok(f.origin, ['config', 'uploadpack.allowReachableSHA1InWant', 'false'])
    writeFileSync(join(f.seed, 'skills', 'alpha', 'late.md'), 'late\n')
    const late = commitAll(f.seed, 'pushed after the clone')
    writeFileSync(join(f.seed, 'later'), 'later\n')
    commitAll(f.seed, 'on top')
    // The pinned commit reaches main only after the clone, and not as its tip, so the clone lacks it and the SHA want is refused.
    const r = runner(f, {
      v0: true,
      after: (invocation) => {
        if (invocation.args[0] === 'clone') ok(f.seed, ['push', '-q', 'origin', 'main'])
      }
    })
    const result = await acquireSkillGitSource(input(f, { ref: undefined, plannedCommit: late }, r.git))

    expect(result).toMatchObject({ kind: 'installed', commit: late })
    const fetches = r.calls.filter((call) => call.args[0] === 'fetch')
    expect(fetches.map((call) => call.args)).toEqual([
      ['fetch', '-q', '--no-tags', '--', 'origin', late],
      ['fetch', '-q', '--', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']
    ])
    expect(fetches[0]!.output!.code).not.toBe(0)
    if (result.kind === 'installed') await result.release()
  })

  it('skips with sha_fetch_refused when no branch or tag reaches a refused pinned commit', async () => {
    const f = fixture()
    ok(f.origin, ['config', 'uploadpack.allowReachableSHA1InWant', 'false'])
    ok(f.seed, ['checkout', '-q', '-b', 'pr'])
    writeFileSync(join(f.seed, 'p1'), '1\n')
    const hidden = commitAll(f.seed, 'p1')
    writeFileSync(join(f.seed, 'p2'), '2\n')
    commitAll(f.seed, 'p2')
    // Only a pull ref reaches it, and not as its tip: neither a SHA want nor heads and tags can fetch it.
    ok(f.seed, ['push', '-q', 'origin', 'HEAD:refs/pull/1/head'])
    const result = await acquireSkillGitSource(
      input(f, { ref: undefined, plannedCommit: hidden }, runner(f, { v0: true }).git)
    )
    expect(result).toMatchObject({ kind: 'skipped', code: 'sha_fetch_refused' })
    expect(readdirSync(f.staging)).toEqual([])
  })

  describe('hostile bundles are survived and the installed commit is the planned one', () => {
    function goodBundle(f: Fixture): string {
      const bundle = join(f.root, 'good.bundle')
      ok(f.seed, ['bundle', 'create', '-q', bundle, '--filter=blob:none', 'refs/heads/main'])
      return bundle
    }

    it('hits on a valid bundle and drops its refs', async () => {
      const f = fixture()
      const r = runner(f, { bundle: goodBundle(f) })
      const result = await acquireSkillGitSource(input(f, { getUrl: BUNDLE_URL }, r.git))
      expect(result).toMatchObject({ kind: 'installed', commit: f.tip, bundle: { kind: 'hit' } })
      if (result.kind !== 'installed') return
      expect(clones(r.calls)).toHaveLength(1)
      expect(ok(result.gitDir, ['rev-parse', '--symbolic-full-name', '--glob=refs/bundles/*'])).toBe('')
      await result.release()
    })

    it('installs from the origin whatever a foreign bundle advertises', async () => {
      const f = fixture()
      const other = join(f.root, 'other')
      mkdirSync(other)
      ok(other, ['init', '-q', '--initial-branch=main'])
      writeFileSync(join(other, 'x'), 'foreign\n')
      commitAll(other, 'foreign')
      const bundle = join(f.root, 'foreign.bundle')
      ok(other, ['bundle', 'create', '-q', bundle, 'refs/heads/main'])
      const result = await acquireSkillGitSource(input(f, { getUrl: BUNDLE_URL }, runner(f, { bundle }).git))
      expect(result).toMatchObject({ kind: 'installed', commit: f.tip })
      if (result.kind === 'installed') await result.release()
    })

    it('falls back with inspect-failed on a bundle carrying more refs than a single branch could', async () => {
      const f = fixture()
      // One packed-refs file gives the seed 64 more branches, so the bundle carries 65 refs under refs/heads/*.
      const branches = Array.from({ length: 64 }, (_, i) => `${f.tip} refs/heads/b-${String(i).padStart(3, '0')}`)
      writeFileSync(
        join(f.seed, '.git', 'packed-refs'),
        `# pack-refs with: peeled fully-peeled sorted \n${branches.join('\n')}\n`
      )
      const bundle = join(f.root, 'many.bundle')
      ok(f.seed, ['bundle', 'create', '-q', bundle, '--filter=blob:none', '--branches'])
      expect(ok(f.seed, ['bundle', 'list-heads', bundle]).split('\n')).toHaveLength(65)
      const logs: string[] = []
      const r = runner(f, { bundle })
      const result = await acquireSkillGitSource({
        ...input(f, { getUrl: BUNDLE_URL }, r.git),
        log: { warn: (message) => logs.push(message) }
      })
      expect(result).toMatchObject({
        kind: 'installed',
        commit: f.tip,
        bundle: { kind: 'fallback', reason: 'inspect-failed' }
      })
      expect(logs.join('\n')).toContain('65 refs under refs/bundles/')
      if (result.kind !== 'installed') return
      const attempts = clones(r.calls)
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.some((arg) => arg.startsWith('--bundle-uri='))).toBe(false)
      expect(ok(result.gitDir, ['cat-file', '-t', f.tip])).toBe('commit')
      await result.release()
    })

    const FILTERED = '# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n'
    const UNFILTERED = '# v2 git bundle\n'

    // Advertises main but its pack holds only the given commits: no trees, no blobs.
    function commitsOnlyBundle(f: Fixture, header: string, commits: string[]): string {
      const bundle = join(f.root, 'hostile.bundle')
      writeFileSync(bundle, `${header}${f.tip} refs/heads/main\n\n`)
      const pack = spawnSync('git', ['pack-objects', '--stdout'], {
        cwd: f.seed,
        env,
        input: `${commits.join('\n')}\n`
      })
      appendFileSync(bundle, pack.stdout)
      return bundle
    }

    it.each([
      // The production shape: a blob:none bundle unbundles as a promisor pack, so fsck passes and only the subtree read fails.
      ['a filtered bundle whose commits lack their trees', 'unreadable without the origin'],
      ['an unfiltered bundle whose commits lack their trees', 'fsck'],
      ['a filtered bundle missing the parent commit', 'Could not read'],
      ['a truncated file', undefined],
      ['an oversized file of trailing garbage', undefined],
      ['an absent object', 'download-warning']
    ])('retries without the bundle on %s', async (label, detail) => {
      const f = fixture()
      let bundle = join(f.root, 'hostile.bundle')
      if (label.endsWith('lack their trees')) {
        bundle = commitsOnlyBundle(f, label.startsWith('a filtered') ? FILTERED : UNFILTERED, [f.tip, f.first])
      } else if (label.endsWith('missing the parent commit')) {
        bundle = commitsOnlyBundle(f, FILTERED, [f.tip])
      } else if (label.startsWith('a truncated')) {
        const whole = readFileSync(goodBundle(f))
        writeFileSync(bundle, whole.subarray(0, Math.floor(whole.length / 2)))
      } else if (label.startsWith('an oversized')) {
        writeFileSync(bundle, readFileSync(goodBundle(f)))
        appendFileSync(bundle, Buffer.alloc(256 * 1024, 0x5a))
      }
      const logs: string[] = []
      const r = runner(f, { bundle })
      const result = await acquireSkillGitSource({
        ...input(f, { getUrl: BUNDLE_URL }, r.git),
        log: { warn: (message) => logs.push(message) }
      })

      expect(result).toMatchObject({ kind: 'installed', commit: f.tip, bundle: { kind: 'fallback' } })
      if (result.kind !== 'installed') return
      if (detail === 'download-warning') expect(result.bundle).toEqual({ kind: 'fallback', reason: detail })
      else if (detail) {
        expect(result.bundle).toEqual({ kind: 'fallback', reason: 'connectivity' })
        expect(logs.join('\n')).toContain(detail)
      }
      expect(result.commit).toBe(f.tip)
      const attempts = clones(r.calls)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.some((arg) => arg.startsWith('--bundle-uri='))).toBe(true)
      expect(attempts[1]!.some((arg) => arg.startsWith('--bundle-uri='))).toBe(false)
      expect(git(result.gitDir, ['fsck', '--connectivity-only', '--no-dangling']).code).toBe(0)
      expect(logs.join('\n')).not.toContain('secret')
      // Only the retry's staging directory is left.
      expect(readdirSync(f.staging)).toHaveLength(1)
      await result.release()
    })
  })

  describe('the snapshot gate', () => {
    it('skips a symlink with limits_exceeded and leaves nothing staged', async () => {
      const f = fixture()
      symlinkSync('/etc/passwd', join(f.seed, 'skills', 'alpha', 'leak'))
      const tip = commitAll(f.seed, 'link')
      ok(f.seed, ['push', '-q', 'origin', 'main'])
      const result = await acquireSkillGitSource(input(f, { plannedCommit: tip }, runner(f).git))
      expect(result).toMatchObject({ kind: 'skipped', code: 'limits_exceeded' })
      expect(readdirSync(f.staging)).toEqual([])
    })

    it('skips a special file with limits_exceeded', async () => {
      const f = fixture()
      // Git cannot carry a FIFO, so one is planted in the checked-out tree the moment the checkout finishes.
      const r = runner(f, {
        after: (invocation) => {
          if (invocation.args[0] !== 'read-tree') return
          const fifo = spawnSync('mkfifo', [join(invocation.env.GIT_WORK_TREE!, 'alpha', 'pipe')])
          if (fifo.status !== 0) throw new Error('mkfifo failed')
        }
      })
      const result = await acquireSkillGitSource(input(f, {}, r.git))
      expect(result).toMatchObject({ kind: 'skipped', code: 'limits_exceeded' })
    })

    it('skips an oversized subdirectory with limits_exceeded', async () => {
      const f = fixture()
      const result = await acquireSkillGitSource({ ...input(f, {}, runner(f).git), limits: { maxFiles: 1 } })
      expect(result).toMatchObject({ kind: 'skipped', code: 'limits_exceeded' })
    })

    it('skips a subdirectory the planned commit does not have', async () => {
      const f = fixture()
      const result = await acquireSkillGitSource(input(f, { subDir: 'nowhere' }, runner(f).git))
      expect(result).toMatchObject({ kind: 'skipped', code: 'commit_unavailable' })
    })
  })

  it('never runs hooks, fsmonitor or ssh commands from agent-reachable or repository config', async () => {
    const f = fixture()
    const marker = join(f.root, 'pwned')
    const hooks = join(f.root, 'hooks')
    mkdirSync(hooks)
    const script = `#!/bin/sh\necho "$0" >> '${marker}'\n`
    for (const hook of ['reference-transaction', 'post-checkout', 'post-index-change', 'post-merge']) {
      writeFileSync(join(hooks, hook), script, { mode: 0o755 })
    }
    writeFileSync(join(f.root, 'fsmonitor'), script, { mode: 0o755 })
    const hostileConfig = [
      '[core]',
      `  hooksPath = ${hooks}`,
      `  fsmonitor = ${join(f.root, 'fsmonitor')}`,
      `  sshCommand = ${join(f.root, 'fsmonitor')}`,
      `[protocol "ext"]`,
      '  allow = always'
    ].join('\n')
    const agentHome = join(f.root, 'agent-home')
    mkdirSync(join(agentHome, '.config', 'git'), { recursive: true })
    writeFileSync(join(agentHome, '.gitconfig'), hostileConfig)
    writeFileSync(join(agentHome, '.config', 'git', 'config'), hostileConfig)
    // The origin's own config and hooks, too: none of it may travel with a clone.
    writeFileSync(join(f.origin, 'config'), `${readFileSync(join(f.origin, 'config'), 'utf8')}\n${hostileConfig}\n`)
    for (const hook of ['reference-transaction', 'post-checkout']) {
      writeFileSync(join(f.origin, 'hooks', hook), script, { mode: 0o755 })
    }
    const shimEnv = {
      PATH: process.env.PATH,
      HOME: agentHome,
      XDG_CONFIG_HOME: join(agentHome, '.config'),
      GIT_CONFIG_GLOBAL: join(agentHome, '.gitconfig'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks
    }
    // Sanity: the same config does run the hook for a Git that reads it.
    const naive = join(f.root, 'naive')
    spawnSync('git', ['init', '-q', naive], { env: { ...env, ...shimEnv } })
    spawnSync('git', ['-C', naive, 'update-ref', 'refs/x', f.tip], { env: { ...env, ...shimEnv } })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const bundle = join(f.root, 'good.bundle')
    ok(f.seed, ['bundle', 'create', '-q', bundle, '--filter=blob:none', 'refs/heads/main'])
    const result = await acquireSkillGitSource({
      ...input(f, { getUrl: BUNDLE_URL }, runner(f, { bundle }).git),
      shimEnv
    })
    expect(result).toMatchObject({ kind: 'installed', commit: f.tip })
    expect(existsSync(marker)).toBe(false)
    if (result.kind === 'installed') await result.release()
  })

  describe('a repository whose refs alone overflow a shim frame', () => {
    function taggedFixture() {
      const f = fixture()
      // One packed-refs file, not thousands of loose refs.
      const tags = Array.from({ length: 3000 }, (_, i) => `${f.tip} refs/tags/release-${String(i).padStart(6, '0')}`)
      writeFileSync(
        join(f.origin, 'packed-refs'),
        `# pack-refs with: peeled fully-peeled sorted \n${tags.join('\n')}\n`
      )
      expect(ok(f.origin, ['show-ref']).length).toBeGreaterThan(SKILL_GIT_MAX_STREAM_BYTES)
      return f
    }

    const bounded = (calls: Recorded[]) => {
      for (const call of calls) {
        expect(Buffer.byteLength(call.output!.stdout), call.args.join(' ')).toBeLessThan(SKILL_GIT_MAX_STREAM_BYTES)
        expect(Buffer.byteLength(call.output!.stderr), call.args.join(' ')).toBeLessThan(SKILL_GIT_MAX_STREAM_BYTES)
      }
    }

    it('keeps clone, bundle-ref listing and fsck output bounded', async () => {
      const f = taggedFixture()
      const bundle = join(f.root, 'good.bundle')
      ok(f.seed, ['bundle', 'create', '-q', bundle, '--filter=blob:none', 'refs/heads/main'])
      const r = runner(f, { bundle })
      const result = await acquireSkillGitSource(input(f, { getUrl: BUNDLE_URL }, r.git))
      expect(result).toMatchObject({ kind: 'installed', commit: f.tip, bundle: { kind: 'hit' } })
      expect(r.calls.map((call) => call.args[0])).toEqual(expect.arrayContaining(['clone', 'rev-parse', 'fsck']))
      bounded(r.calls)
      if (result.kind === 'installed') await result.release()
    })

    it('keeps the all-branches-and-tags fetch bounded', async () => {
      const f = taggedFixture()
      ok(f.origin, ['config', 'uploadpack.allowReachableSHA1InWant', 'false'])
      writeFileSync(join(f.seed, 'skills', 'alpha', 'late.md'), 'late\n')
      const late = commitAll(f.seed, 'late')
      writeFileSync(join(f.seed, 'later'), 'later\n')
      commitAll(f.seed, 'on top')
      const r = runner(f, {
        v0: true,
        after: (invocation) => {
          if (invocation.args[0] === 'clone') ok(f.seed, ['push', '-q', 'origin', 'main'])
        }
      })
      const result = await acquireSkillGitSource(input(f, { ref: undefined, plannedCommit: late }, r.git))
      expect(result).toMatchObject({ kind: 'installed', commit: late })
      expect(r.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(2)
      bounded(r.calls)
      if (result.kind === 'installed') await result.release()
    })

    it('resolves a ref by name with ls-remote, bounded, as a pod-local commit', async () => {
      const f = taggedFixture()
      ok(f.seed, ['tag', '-a', '-m', 'annotated', 'v1', f.first])
      ok(f.seed, ['push', '-q', 'origin', 'refs/tags/v1'])
      const r = runner(f)
      const common = { url: ORIGIN_URL, stagingRoot: f.staging, git: r.git, allowFileProtocol: true, shimEnv: {} }
      expect(await lsRemoteSkillRef({ ...common, ref: 'refs/heads/main' })).toEqual({
        commit: f.tip,
        trust: 'pod-local'
      })
      // An annotated tag resolves to the commit it peels to, not the tag object.
      expect(await lsRemoteSkillRef({ ...common, ref: 'refs/tags/v1' })).toEqual({
        commit: f.first,
        trust: 'pod-local'
      })
      expect(await lsRemoteSkillRef({ ...common, ref: 'refs/heads/absent' })).toBeUndefined()
      expect(r.calls.map((call) => call.args)).toContainEqual([
        'ls-remote',
        '-q',
        '--',
        ORIGIN_URL,
        'refs/heads/main',
        'refs/heads/main^{}'
      ])
      bounded(r.calls)
      expect(readdirSync(f.staging)).toEqual([])
      await expect(lsRemoteSkillRef({ ...common, ref: '-refs/heads/main' })).rejects.toBeInstanceOf(
        SkillGitPlanRefusedError
      )
    })
  })

  it('ls-remote ignores the config of a repository enclosing the staging root', async () => {
    const f = fixture()
    // An enclosing repository whose insteadOf would redirect the origin to a path that does not exist.
    ok(f.root, ['init', '-q'])
    ok(f.root, ['config', `url.file://${join(f.root, 'absent.git')}.insteadOf`, `file://${f.origin}`])
    const r = runner(f)
    expect(
      await lsRemoteSkillRef({
        url: ORIGIN_URL,
        ref: 'refs/heads/main',
        stagingRoot: f.staging,
        git: r.git,
        allowFileProtocol: true,
        shimEnv: {}
      })
    ).toEqual({ commit: f.tip, trust: 'pod-local' })
    expect(r.calls[0]?.env.GIT_CEILING_DIRECTORIES).toBe(f.staging)
  })

  it('ran the refused-argument check on every composed argv (Attempt.run refuses before spawn)', () => {
    expect(composed.length).toBeGreaterThan(20)
    for (const args of composed) expect(() => assertNoRefusedArguments(args), args.join(' ')).not.toThrow()
  })
})

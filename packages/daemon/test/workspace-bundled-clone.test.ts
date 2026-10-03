import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ShimChannelLostError, ShimRequestTimeoutError, type ShimRequester } from '../src/shim/channels.js'
import { createExecHandler } from '../src/shim/exec-handler.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import {
  BUNDLE_DOWNLOAD_WARNINGS,
  bundleRefsOf,
  cloneFromBundle,
  type BundledCloneInput,
  type BundledCloneReport
} from '../src/workspace/bundled-clone.js'
import { GitExecError } from '../src/workspace/command-git-runner.js'
import { workspaceGitLocalEnv } from '../src/workspace/git-injection.js'
import { GitTransportError, type GitCloneOutput, type GitRunner } from '../src/workspace/git-runner.js'

// The §7 retry contract around a bundled workspace clone: scripted Git first, then real Git against local repositories.

const SHA = 'a'.repeat(40)
const URL = 'https://cache.example/src/o/anon/x/bundles/b.bundle?X-Amz-Signature=secret'

type Answer = string | Error

/** A scripted runner: each subcommand answers from `answers`, every call is recorded. */
function scripted(answers: Partial<Record<string, Answer>>, calls: string[][]): GitRunner {
  const runner: GitRunner = {
    withEnv: () => runner,
    raw: async (args) => {
      calls.push(args)
      const answer = answers[args[0]!] ?? ''
      if (answer instanceof Error) throw answer
      return answer
    },
    clone: async () => undefined,
    pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
    status: async () => ({ current: null, tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  }
  return runner
}

const execError = (code: number, stderr = 'fatal: nope', args = ['clone']) => new GitExecError(code, '', stderr, args)
const showRef = (...refs: string[]) => refs.map((ref) => `${SHA} ${ref}`).join('\n') + '\n'

function harness(
  opts: {
    bundle?: boolean
    shape?: 'blobless' | 'full'
    clones?: Array<GitCloneOutput | Error | 'no-stderr'>
    answers?: Partial<Record<string, Answer>>
    emptyError?: Error
  } = {}
) {
  const clones: string[][] = []
  const calls: string[][] = []
  const reports: BundledCloneReport[] = []
  let emptied = 0
  const results = [...(opts.clones ?? [])]
  const input: BundledCloneInput = {
    ...(opts.bundle === false ? {} : { bundle: { url: URL, key: 'src/o/anon/x/bundles/b.bundle' } }),
    shape: opts.shape ?? 'blobless',
    clone: async (extra) => {
      clones.push(extra)
      const next = results.shift()
      if (next instanceof Error) throw next
      // An unscripted attempt is a clean clone; 'no-stderr' is a runner that cannot see Git's output.
      return next === 'no-stderr' ? undefined : (next ?? { stderr: '' })
    },
    checkout: () => scripted(opts.answers ?? { 'show-ref': showRef('refs/heads/main', 'refs/bundles/main') }, calls),
    empty: async () => {
      emptied += 1
      if (opts.emptyError) throw opts.emptyError
    },
    report: (r) => reports.push(r)
  }
  return {
    run: () => cloneFromBundle(input),
    clones,
    calls,
    reports,
    emptied: () => emptied
  }
}

describe('bundleRefsOf', () => {
  it('keeps only refs under refs/bundles/, in both the 2.49 and 2.50 layouts', () => {
    expect(
      bundleRefsOf(
        showRef('refs/heads/main', 'refs/bundles/main', 'refs/bundles/heads/main', 'refs/remotes/origin/main') +
          'garbage line\n'
      )
    ).toEqual(['refs/bundles/main', 'refs/bundles/heads/main'])
  })
})

describe('cloneFromBundle (scripted Git)', () => {
  it('runs exactly today’s clone and nothing else with no bundle, even from a runner without stderr', async () => {
    const h = harness({ bundle: false, clones: ['no-stderr'] })
    expect(await h.run()).toBe('uncached')
    expect(h.clones).toEqual([[]])
    expect(h.calls).toEqual([])
    expect(h.reports).toEqual([])
  })

  it.each([
    ['2.49', ['refs/bundles/main']],
    ['2.50', ['refs/bundles/heads/main']],
    ['several', ['refs/bundles/main', 'refs/bundles/heads/main', 'refs/bundles/heads/release']]
  ])('seeds the clone and deletes every listed refs/bundles ref (%s layout)', async (_label, refs) => {
    const h = harness({ answers: { 'show-ref': showRef('refs/heads/main', 'refs/remotes/origin/main', ...refs) } })
    expect(await h.run()).toBe('hit')
    expect(h.clones).toEqual([[`--bundle-uri=${URL}`]])
    expect(h.calls).toEqual([
      ['show-ref'],
      ['fsck', '--connectivity-only'],
      ...refs.map((ref) => ['update-ref', '-d', ref])
    ])
    // The tip is captured before the refs go, for the write-back delta (source-cache.md §7).
    expect(h.reports).toEqual([{ kind: 'hit', tip: SHA }])
    expect(h.emptied()).toBe(0)
  })

  it('reports no tip when the bundle refs disagree on one', async () => {
    const other = 'e'.repeat(40)
    const h = harness({ answers: { 'show-ref': `${SHA} refs/bundles/main\n${other} refs/bundles/heads/main\n` } })
    expect(await h.run()).toBe('hit')
    expect(h.reports).toEqual([{ kind: 'hit' }])
  })

  it('checks connectivity for a full clone too, and falls back when its history is incomplete', async () => {
    const ok = harness({ shape: 'full' })
    expect(await ok.run()).toBe('hit')
    expect(ok.calls).toContainEqual(['fsck', '--connectivity-only'])
    const broken = harness({
      shape: 'full',
      answers: { 'show-ref': showRef('refs/bundles/main'), fsck: execError(2, 'missing tree', ['fsck']) }
    })
    expect(await broken.run()).toBe('fallback')
    expect(broken.clones).toEqual([[`--bundle-uri=${URL}`], []])
    expect(broken.emptied()).toBe(1)
  })

  it('empties and clones once without the bundle after a non-zero exit', async () => {
    const h = harness({ clones: [execError(128, `unable to parse commit; bundle ${URL}`)] })
    expect(await h.run()).toBe('fallback')
    expect(h.clones).toEqual([[`--bundle-uri=${URL}`], []])
    expect(h.emptied()).toBe(1)
    expect(h.reports).toEqual([{ kind: 'fallback', reason: 'clone-failed', detail: expect.any(String) }])
    // The presigned query never reaches a log line.
    const detail = (h.reports[0] as { detail: string }).detail
    expect(detail).not.toContain('secret')
    expect(detail).toContain('https://cache.example/src/o/anon/x/bundles/b.bundle')
  })

  it.each(BUNDLE_DOWNLOAD_WARNINGS)('classifies an exit-0 clone warning "%s" as a fallback', async (warning) => {
    const h = harness({ clones: [{ stderr: `Cloning into 'x'...\nwarning: ${warning} '${URL}'\n` }] })
    expect(await h.run()).toBe('fallback')
    expect(h.reports).toMatchObject([{ kind: 'fallback', reason: 'download-warning' }])
    expect(h.clones).toEqual([[`--bundle-uri=${URL}`], []])
    expect(h.emptied()).toBe(1)
  })

  it('falls back when no ref lands under refs/bundles, including a show-ref exit 1', async () => {
    const empty = harness({ answers: { 'show-ref': showRef('refs/heads/main') } })
    expect(await empty.run()).toBe('fallback')
    expect(empty.reports).toMatchObject([{ reason: 'no-bundle-refs' }])

    const none = harness({ answers: { 'show-ref': execError(1, '', ['show-ref']) } })
    expect(await none.run()).toBe('fallback')
    expect(none.reports).toMatchObject([{ reason: 'no-bundle-refs' }])
  })

  it('falls back when a blobless connectivity check fails, or an old shim refuses fsck', async () => {
    for (const failure of [
      execError(2, 'missing tree', ['fsck']),
      new Error('git fsck is not in the permitted inventory')
    ]) {
      const h = harness({ answers: { 'show-ref': showRef('refs/bundles/main'), fsck: failure } })
      expect(await h.run()).toBe('fallback')
      expect(h.reports).toMatchObject([{ reason: 'connectivity' }])
      expect(h.clones).toEqual([[`--bundle-uri=${URL}`], []])
    }
  })

  it('falls back when a bundle ref cannot be deleted', async () => {
    const h = harness({ answers: { 'show-ref': showRef('refs/bundles/main'), 'update-ref': execError(1) } })
    expect(await h.run()).toBe('fallback')
    expect(h.reports).toMatchObject([{ reason: 'cleanup-failed' }])
  })

  it('surfaces the second failure unchanged, once', async () => {
    const origin = execError(128, 'fatal: repository not found')
    const h = harness({ clones: [execError(128), origin] })
    await expect(h.run()).rejects.toBe(origin)
    expect(h.clones).toHaveLength(2)
  })

  it.each([
    ['a lost channel', new GitTransportError('lost')],
    ['a raw channel loss', new ShimChannelLostError('lost')],
    ['a request timeout', new ShimRequestTimeoutError('timeout')]
  ])('propagates %s without emptying or retrying', async (_label, error) => {
    const h = harness({ clones: [error] })
    await expect(h.run()).rejects.toBe(error)
    expect(h.emptied()).toBe(0)
    expect(h.clones).toHaveLength(1)
    expect(h.reports).toEqual([])
  })

  it('falls back when a bundled attempt’s runner reports no stderr, since a failed download would look like a hit', async () => {
    const h = harness({ clones: ['no-stderr', 'no-stderr'] })
    expect(await h.run()).toBe('fallback')
    expect(h.reports).toMatchObject([{ kind: 'fallback', reason: 'stderr-unavailable' }])
    expect(h.clones).toEqual([[`--bundle-uri=${URL}`], []])
    expect(h.emptied()).toBe(1)
    // The bundle-less retry needs no stderr: nothing in it is a cache outcome.
    expect(h.calls.some((args) => args[0] === 'fsck')).toBe(false)
  })

  it('propagates a failure to empty the checkout, without a second clone', async () => {
    const refused = new Error('could not replace')
    const h = harness({ clones: [execError(128)], emptyError: refused })
    await expect(h.run()).rejects.toBe(refused)
    expect(h.clones).toHaveLength(1)
  })
})

// Real Git: the clone callback runs `git clone` directly so a local bundle can stand in for the https URL the shim policy requires; every check after it crosses the real exec handler.
describe.skipIf(process.platform === 'win32')('cloneFromBundle (real Git)', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@e',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  }

  function git(cwd: string, args: string[], input?: Buffer | string): { code: number; stdout: string; stderr: string } {
    const result = spawnSync('git', args, { cwd, env, ...(input !== undefined ? { input } : {}) })
    return { code: result.status ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  function ok(cwd: string, args: string[]): string {
    const result = git(cwd, args)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }

  /** An origin with two commits on main, a seed checkout, and the bundles a test may hand the clone. */
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-bundled-clone-')))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    ok(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
    ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
    mkdirSync(seed)
    ok(seed, ['init', '-q', '--initial-branch=main'])
    mkdirSync(join(seed, 'd'))
    writeFileSync(join(seed, 'd', 'a'), '1\n')
    ok(seed, ['add', '-A'])
    ok(seed, ['commit', '-qm', 'one'])
    writeFileSync(join(seed, 'd', 'b'), '2\n')
    ok(seed, ['add', '-A'])
    ok(seed, ['commit', '-qm', 'two'])
    ok(seed, ['remote', 'add', 'origin', origin])
    ok(seed, ['push', '-q', 'origin', 'main'])
    const tip = ok(seed, ['rev-parse', 'HEAD'])
    return { root, origin, seed, tip, url: `file://${origin}` }
  }

  /** A bundle advertising main whose pack holds the tip commit alone — no trees, no parent. */
  function incompleteBundle(seed: string, tip: string, path: string): void {
    writeFileSync(path, `# v2 git bundle\n${tip} refs/heads/main\n\n`)
    const pack = spawnSync('git', ['pack-objects', '--stdout'], { cwd: seed, env, input: `${tip}\n` })
    appendFileSync(path, pack.stdout)
  }

  function shimRunner(root: string, cwd: string): GitRunner {
    const handle = createExecHandler({ workspaceRoot: root, log: { info: () => {}, warn: () => {} } })
    const requester: ShimRequester = { request: async (capability, payload) => await handle(capability, payload) }
    return new ShimGitRunner(requester, cwd).withEnv(workspaceGitLocalEnv())
  }

  function run(
    f: ReturnType<typeof fixture>,
    bundlePath: string,
    shape: 'blobless' | 'full'
  ): { target: string; result: Promise<string>; reports: BundledCloneReport[]; argv: string[][] } {
    const target = join(f.root, 'checkout')
    const reports: BundledCloneReport[] = []
    const argv: string[][] = []
    const options = shape === 'blobless' ? ['--filter=blob:none', '--no-checkout'] : []
    const result = cloneFromBundle({
      bundle: { url: bundlePath, key: 'k' },
      shape,
      clone: async (extra) => {
        const args = ['clone', ...extra, ...options, '--branch', 'main', '--single-branch', f.url, target]
        argv.push(args)
        const out = git(f.root, args)
        if (out.code !== 0) throw new GitExecError(out.code, out.stdout, out.stderr, args)
        return { stderr: out.stderr }
      },
      checkout: () => shimRunner(f.root, target),
      empty: async () => rmSync(target, { recursive: true, force: true }),
      report: (r) => reports.push(r)
    })
    return { target, result, reports, argv }
  }

  const bundleRefs = (target: string) => bundleRefsOf(git(target, ['show-ref']).stdout)

  it('seeds a blobless clone from a valid bundle and leaves no refs/bundles ref', async () => {
    const f = fixture()
    const bundle = join(f.root, 'good.bundle')
    ok(f.seed, ['bundle', 'create', '-q', bundle, '--filter=blob:none', 'refs/heads/main'])
    const r = run(f, bundle, 'blobless')

    expect(await r.result).toBe('hit')
    expect(r.argv).toHaveLength(1)
    expect(bundleRefs(r.target)).toEqual([])
    expect(ok(r.target, ['rev-parse', 'refs/heads/main'])).toBe(f.tip)
  })

  it('empties and re-clones when an incomplete bundle passes a blobless clone', async () => {
    const f = fixture()
    const bundle = join(f.root, 'bad.bundle')
    incompleteBundle(f.seed, f.tip, bundle)
    const r = run(f, bundle, 'blobless')

    expect(await r.result).toBe('fallback')
    expect(r.reports).toMatchObject([{ kind: 'fallback', reason: 'connectivity' }])
    expect(r.argv[1]!.some((arg) => arg.startsWith('--bundle-uri'))).toBe(false)
    expect(git(r.target, ['fsck', '--connectivity-only']).code).toBe(0)
    expect(bundleRefs(r.target)).toEqual([])
  })

  it('classifies a bundle that cannot be downloaded, on exit 0, as a fallback', async () => {
    const f = fixture()
    const r = run(f, join(f.root, 'missing.bundle'), 'full')

    expect(await r.result).toBe('fallback')
    expect(r.reports).toMatchObject([{ reason: 'download-warning' }])
    expect(existsSync(join(r.target, 'd', 'b'))).toBe(true)
  })

  it('checks out the origin’s tip whatever a foreign bundle advertises, and drops its ref', async () => {
    const f = fixture()
    const other = join(f.root, 'other')
    mkdirSync(other)
    ok(other, ['init', '-q', '--initial-branch=main'])
    writeFileSync(join(other, 'x'), 'foreign\n')
    ok(other, ['add', '-A'])
    ok(other, ['commit', '-qm', 'foreign'])
    const bundle = join(f.root, 'foreign.bundle')
    ok(other, ['bundle', 'create', '-q', bundle, 'refs/heads/main'])
    const r = run(f, bundle, 'full')

    expect(await r.result).toBe('hit')
    expect(ok(r.target, ['rev-parse', 'HEAD'])).toBe(f.tip)
    expect(ok(r.target, ['rev-parse', 'refs/remotes/origin/main'])).toBe(f.tip)
    expect(bundleRefs(r.target)).toEqual([])
  })
})

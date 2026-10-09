import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShimBundleClient } from '../src/shim/bundle-client.js'
import { createBundleHandler, type BundleHandler } from '../src/shim/bundle-handler.js'
import { BUNDLE_PENDING_TAGGING } from '../src/shim/bundle-protocol.js'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'
import { ClusterSkillClient, type SkillWriteBackStager } from '../src/shim/skill-client.js'
import { runLocalSkillGit, type SkillGitRunner } from '../src/shim/skill-git-acquire.js'
import {
  SKILL_STAGE_BUDGET_MS,
  SKILL_STAGE_TIMEOUT_MS,
  skillWriteBackTrigger,
  stageSkillWriteBacks
} from '../src/shim/skill-git-writeback.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { GitSkillPlanSchema, type ClusterSkillReconcile, type GitSkillPlan } from '../src/shim/skill-protocol.js'

// The shim half of skill write-back (source-cache.md §9): real Git over file:// origins, the real bundle registry.

const HOST = 'https://github.com/acme/'
const GIT_URL = `${HOST}skills.git`
const GOOD_BUNDLE = 'https://cache.example/good.bundle?X-Amz-Signature=s'
const BAD_BUNDLE = 'https://cache.example/bad.bundle?X-Amz-Signature=s'
const ABSENT_BUNDLE = 'https://cache.example/absent.bundle?X-Amz-Signature=s'
const authority = { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'w', shimGeneration: 1 }
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
}
const ok = (cwd: string, args: string[], input?: string): string => {
  const result = spawnSync('git', args, { cwd, env, ...(input !== undefined ? { input } : {}) })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}
const body = (name: string): string => `---\nname: ${name}\ndescription: fixture\n---\n# ${name}\n`

const roots: string[] = []
const handlers: BundleHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) handler.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// An origin with `skills/alpha` on main (two commits) and on dev; a good bundle of main, a hostile one, and the shim's dirs.
async function world() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ac-skill-writeback-')))
  roots.push(root)
  const origin = join(root, 'skills.git')
  const seed = join(root, 'seed')
  ok(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
  ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
  ok(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  await mkdir(join(seed, 'skills', 'alpha'), { recursive: true })
  ok(seed, ['init', '-q', '--initial-branch=main'])
  writeFileSync(join(seed, 'skills', 'alpha', 'SKILL.md'), body('alpha'))
  ok(seed, ['add', '-A'])
  ok(seed, ['commit', '-qm', 'one'])
  const first = ok(seed, ['rev-parse', 'HEAD'])
  writeFileSync(join(seed, 'skills', 'alpha', 'notes.md'), 'notes\n')
  ok(seed, ['add', '-A'])
  ok(seed, ['commit', '-qm', 'two'])
  const tip = ok(seed, ['rev-parse', 'HEAD'])
  ok(seed, ['branch', 'dev', first])
  ok(seed, ['remote', 'add', 'origin', origin])
  ok(seed, ['push', '-q', 'origin', 'main', 'dev'])
  const good = join(root, 'good.bundle')
  ok(seed, ['bundle', 'create', '-q', good, '--filter=blob:none', 'refs/heads/main'])
  // Advertises main, but its pack holds only the tip commit: the clone falls back with `connectivity`.
  const bad = join(root, 'bad.bundle')
  writeFileSync(bad, `# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n${tip} refs/heads/main\n\n`)
  appendFileSync(bad, spawnSync('git', ['pack-objects', '--stdout'], { cwd: seed, env, input: `${tip}\n` }).stdout)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const staging = join(root, 'staging')
  await mkdir(staging, { mode: 0o700 })
  const bundleStaging = join(root, 'bundle-staging')
  prepareBundleStaging(bundleStaging)
  return { root, origin, seed, first, tip, good, bad, workspace, staging, bundleStaging }
}
type World = Awaited<ReturnType<typeof world>>

// The real runner behind the test's https names: the origin is file://, each GET URL a local bundle file.
function runner(w: World): SkillGitRunner {
  const bundles: Record<string, string> = {
    [GOOD_BUNDLE]: w.good,
    [BAD_BUNDLE]: w.bad,
    [ABSENT_BUNDLE]: join(w.root, 'absent.bundle')
  }
  return async (invocation) =>
    await runLocalSkillGit({
      ...invocation,
      args: invocation.args.map((arg) => {
        if (arg.startsWith('--bundle-uri=')) return `--bundle-uri=${bundles[arg.slice('--bundle-uri='.length)]}`
        return arg.startsWith(HOST) ? `file://${join(w.root, arg.slice(HOST.length))}` : arg
      })
    })
}

function shim(
  w: World,
  options: { writeBack?: boolean; stage?: BundleHandler['stage']; logs?: string[]; gitCalls?: string[][] } = {}
) {
  const bundles = createBundleHandler({
    workspaceRoot: w.workspace,
    stagingDir: w.bundleStaging,
    allowHttpUpload: true,
    shimEnv: { PATH: process.env.PATH }
  })
  handlers.push(bundles)
  const handler = new ClusterSkillHandler({
    stagingRoot: w.staging,
    workspaceRoot: w.workspace,
    stateRoot: join(w.root, 'state'),
    git: {
      git: async (invocation) => {
        options.gitCalls?.push(invocation.args)
        return await runner(w)(invocation)
      },
      allowFileProtocol: true,
      shimEnv: { PATH: process.env.PATH },
      credentialHelper: '/nonexistent/helper',
      credentialSocket: '/nonexistent/gitcred.sock',
      log: { warn: (message) => options.logs?.push(message) }
    },
    ...(options.writeBack === false
      ? {}
      : { writeBack: { stage: options.stage ?? bundles.stage, discard: (handle: string) => bundles.discard(handle) } })
  })
  const stager = new ShimBundleClient({ request: async (_capability, payload) => await bundles(payload) })
  return { bundles, handler, stager }
}

const plan = (w: World, overrides: Partial<GitSkillPlan> = {}): GitSkillPlan => ({
  sourceId: `agent:0:${'d'.repeat(64)}:${w.tip}`,
  sourceKind: 'git',
  url: GIT_URL,
  ref: 'refs/heads/main',
  plannedCommit: w.tip,
  subDir: 'skills',
  selections: ['alpha'],
  writeBack: { maxBytes: 16 * 1024 * 1024 },
  ...overrides
})

async function reconcile(
  handler: ClusterSkillHandler,
  sources: ClusterSkillReconcile['sources'],
  stager?: SkillWriteBackStager,
  priorRoots: ClusterSkillReconcile['priorRoots'] = []
) {
  const client = new ClusterSkillClient(
    { request: (_capability, payload) => handler.handle(payload) },
    true,
    true,
    true,
    true,
    stager
  )
  const operationId = randomUUID()
  const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files: [] })
  return await client.reconcile({
    operationId,
    handle,
    authority,
    priorRoots,
    replayKey: randomBytes(32).toString('hex'),
    allowDesiredAdoption: false,
    sources
  })
}

const staged = (w: World, handle: string): string => join(w.bundleStaging, `${handle}.bundle`)

describe.skipIf(process.platform === 'win32')('in-pod skill write-back staging (real Git)', () => {
  it('offers a miss as one candidate per branch whose handle uploads and discards through the bundle handler', async () => {
    const w = await world()
    const s = shim(w)
    const dev = plan(w, {
      sourceId: `agent:1:${'e'.repeat(64)}:${w.first}`,
      ref: 'refs/heads/dev',
      plannedCommit: w.first
    })
    const reply = await reconcile(s.handler, [plan(w), dev], s.stager)
    expect(reply.roots.map((root) => root.path.split('/').at(-1))).toEqual(['alpha'])
    expect(reply.writeBackCandidates).toEqual([
      expect.objectContaining({
        sourceId: plan(w).sourceId,
        branch: 'refs/heads/main',
        commit: w.tip,
        trigger: 'miss'
      }),
      expect.objectContaining({ sourceId: dev.sourceId, branch: 'refs/heads/dev', commit: w.first, trigger: 'miss' })
    ])
    const [main, other] = reply.writeBackCandidates!
    // Exactly the one planned ref at the planned commit, blobless, and the size and digest the reply declared.
    expect(ok(w.root, ['bundle', 'list-heads', staged(w, main!.handle)])).toBe(`${w.tip} refs/heads/main`)
    expect(ok(w.root, ['bundle', 'list-heads', staged(w, other!.handle)])).toBe(`${w.first} refs/heads/dev`)
    const file = await readFile(staged(w, main!.handle))
    expect(file.subarray(0, 64).toString()).toContain('@filter=blob:none')
    expect(file.length).toBe(main!.bytes)
    expect(createHash('sha256').update(file).digest('base64')).toBe(main!.sha256)

    const received: Buffer[] = []
    const server = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => received.push(chunk))
      req.on('end', () => res.writeHead(200).end())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/put`
      const headers = {
        'content-length': String(main!.bytes),
        'x-amz-checksum-sha256': main!.sha256,
        'x-amz-tagging': BUNDLE_PENDING_TAGGING
      }
      expect(await s.stager.upload({ handle: main!.handle, url, headers })).toEqual({
        bytes: main!.bytes,
        sha256: main!.sha256
      })
      expect(Buffer.concat(received).equals(file)).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    await s.stager.discard(main!.handle)
    await s.stager.discard(other!.handle)
    expect(existsSync(staged(w, main!.handle))).toBe(false)
    expect(existsSync(staged(w, other!.handle))).toBe(false)
  }, 120_000)

  it('offers a hit only when the daemon marked its bundle stale', async () => {
    const w = await world()
    const s = shim(w)
    const fresh = await reconcile(s.handler, [plan(w, { getUrl: GOOD_BUNDLE })], s.stager)
    expect(fresh.writeBackCandidates).toBeUndefined()
    const stale = await reconcile(
      s.handler,
      [plan(w, { getUrl: GOOD_BUNDLE, writeBack: { maxBytes: 16 * 1024 * 1024, stale: true } })],
      s.stager
    )
    expect(stale.writeBackCandidates).toEqual([expect.objectContaining({ trigger: 'stale', commit: w.tip })])
  }, 120_000)

  it('offers a bad-bundle fallback, but not a download-warning one', async () => {
    const w = await world()
    const s = shim(w)
    const absent = plan(w, { sourceId: `agent:1:${'e'.repeat(64)}:${w.tip}`, getUrl: ABSENT_BUNDLE })
    const reply = await reconcile(s.handler, [plan(w, { getUrl: BAD_BUNDLE }), absent], s.stager)
    expect(reply.skipped).toBeUndefined()
    expect(reply.writeBackCandidates).toEqual([
      expect.objectContaining({ sourceId: plan(w).sourceId, trigger: 'fallback', commit: w.tip })
    ])
  }, 120_000)

  it('offers nothing for a skipped Source, a pinned SHA, or a branch that moved after resolution', async () => {
    const w = await world()
    const s = shim(w)
    const { ref: _ref, writeBack: _writeBack, ...pinnedBase } = plan(w)
    const pinned = { ...pinnedBase, sourceId: 'agent:1' }
    const absent = plan(w, { sourceId: 'agent:2', url: `${HOST}absent.git` })
    // The daemon planned main at its first commit; main has since moved on, so the clone's branch names another commit.
    const moved = plan(w, { sourceId: 'agent:3', plannedCommit: w.first })
    const reply = await reconcile(s.handler, [pinned, absent, moved], s.stager)
    expect(reply.skipped?.map((entry) => entry.sourceId)).toEqual(['agent:2'])
    expect(reply.gitSources?.map((source) => [source.sourceId, source.resolvedCommit])).toEqual([
      ['agent:1', w.tip],
      ['agent:3', w.first]
    ])
    expect(reply.writeBackCandidates).toBeUndefined()
  }, 120_000)

  it('never asks a pinned SHA, a tag or a keepInstalled entry for write-back', () => {
    const base = { sourceId: 's', sourceKind: 'git', url: GIT_URL, plannedCommit: 'c'.repeat(40), selections: [] }
    const writeBack = { maxBytes: 1024 }
    expect(GitSkillPlanSchema.safeParse({ ...base, ref: 'refs/heads/main', writeBack }).success).toBe(true)
    expect(GitSkillPlanSchema.safeParse({ ...base, writeBack }).success).toBe(false)
    expect(GitSkillPlanSchema.safeParse({ ...base, ref: 'refs/tags/v1', writeBack }).success).toBe(false)
    expect(
      GitSkillPlanSchema.safeParse({ ...base, ref: 'refs/heads/main', keepInstalled: true, writeBack }).success
    ).toBe(false)
    expect(
      GitSkillPlanSchema.safeParse({ ...base, ref: 'refs/heads/main', writeBack: { maxBytes: 1024, extra: 1 } }).success
    ).toBe(false)
  })

  it('leaves the install intact when bundling fails, whether refused for size or broken', async () => {
    const w = await world()
    const logs: string[] = []
    const tiny = shim(w, { logs })
    const refused = await reconcile(tiny.handler, [plan(w, { writeBack: { maxBytes: 1 } })], tiny.stager)
    const broken = shim(w, {
      logs,
      stage: async () => {
        throw new Error('staging broke')
      }
    })
    // The second shim installs the same Source again, given the first one's receipt.
    const failed = await reconcile(broken.handler, [plan(w)], broken.stager, refused.roots)
    expect(failed.roots).toEqual(refused.roots)
    for (const reply of [refused, failed]) {
      expect(reply.roots.map((root) => root.path.split('/').at(-1))).toEqual(['alpha'])
      expect(reply.skipped).toBeUndefined()
      expect(reply.writeBackCandidates).toBeUndefined()
    }
    expect(logs.join('\n')).toMatch(/no write-back bundle \(bundle too-large/)
    expect(logs.join('\n')).toContain('no write-back bundle (staging broke)')
  }, 120_000)

  it('answers a plan without writeBack exactly as an S5b shim does', async () => {
    const w = await world()
    const { writeBack: _writeBack, ...s5bPlan } = plan(w)
    const withFeature = await reconcile(shim(w).handler, [s5bPlan])
    await rm(w.workspace, { recursive: true, force: true })
    await rm(join(w.root, 'state'), { recursive: true, force: true })
    await mkdir(w.workspace)
    const s5b = await reconcile(shim(w, { writeBack: false }).handler, [s5bPlan])
    expect(JSON.stringify(withFeature)).toBe(JSON.stringify(s5b))
    expect(withFeature).not.toHaveProperty('writeBackCandidates')
  }, 120_000)

  it('never sends writeBack from a daemon without the write-back grant, which a strict S5b plan schema would refuse', async () => {
    const sent: unknown[] = []
    const client = new ClusterSkillClient(
      {
        request: async (_capability, payload) => {
          sent.push(payload)
          return (payload as { op: string }).op === 'begin'
            ? { handle: 'opaque-handle-1234' }
            : { roots: [], conflicts: [] }
        }
      },
      true,
      true,
      true,
      true
    )
    const source = {
      sourceId: 's',
      sourceKind: 'git' as const,
      url: GIT_URL,
      ref: 'refs/heads/main',
      plannedCommit: 'c'.repeat(40),
      selections: [],
      writeBack: { maxBytes: 1024 }
    }
    await client.reconcile({
      operationId: randomUUID(),
      handle: 'opaque-handle-1234',
      authority,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: [source]
    })
    expect(JSON.stringify(sent)).not.toContain('writeBack')
  })
})

describe.skipIf(process.platform === 'win32')('unchanged Git plan short-circuit (real Git)', () => {
  // The coordinator's view: each reconcile is given the receipts the previous one returned.
  async function twice(
    w: World,
    first: ClusterSkillReconcile['sources'],
    second: ClusterSkillReconcile['sources'] = first,
    between?: (roots: ClusterSkillReconcile['priorRoots']) => Promise<void>,
    secondMayThrow = false
  ) {
    const gitCalls: string[][] = []
    const s = shim(w, { gitCalls })
    const one = await reconcile(s.handler, first, s.stager)
    for (const candidate of one.writeBackCandidates ?? []) await s.stager.discard(candidate.handle)
    const firstCalls = gitCalls.length
    await between?.(one.roots)
    // A tampered receipt fails publication after acquisition; only whether Git ran matters then.
    const second$ = reconcile(s.handler, second, s.stager, one.roots)
    const two = secondMayThrow ? await second$.catch(() => undefined) : await second$
    for (const candidate of two?.writeBackCandidates ?? []) await s.stager.discard(candidate.handle)
    return { one, two: two!, firstCalls, secondCalls: gitCalls.length - firstCalls }
  }

  it('answers a second identical plan from its receipts without running Git or offering write-back', async () => {
    const w = await world()
    const { one, two, firstCalls, secondCalls } = await twice(w, [plan(w)])
    expect(firstCalls).toBeGreaterThan(0)
    expect(one.writeBackCandidates).toHaveLength(1)
    expect(secondCalls).toBe(0)
    expect(two.roots).toEqual(one.roots)
    expect(two.gitSources).toEqual(one.gitSources)
    expect(two.conflicts).toEqual([])
    expect(two).not.toHaveProperty('writeBackCandidates')
    expect(two).not.toHaveProperty('skipped')
    expect(await readdir(w.staging)).toEqual([])
  }, 120_000)

  it('ignores a new GET URL or write-back request, which change per run but not what installs', async () => {
    const w = await world()
    const { writeBack: _writeBack, ...bare } = plan(w)
    const { secondCalls } = await twice(w, [plan(w)], [{ ...bare, getUrl: GOOD_BUNDLE }])
    expect(secondCalls).toBe(0)
  }, 120_000)

  it('clones again for a changed planned commit or selection', async () => {
    const w = await world()
    const moved = plan(w, {
      sourceId: `agent:0:${'d'.repeat(64)}:${w.first}`,
      ref: 'refs/heads/dev',
      plannedCommit: w.first
    })
    const commit = await twice(w, [plan(w)], [moved])
    expect(commit.secondCalls).toBeGreaterThan(0)
    expect(commit.two.gitSources).toEqual([{ sourceId: moved.sourceId, resolvedCommit: w.first, leaves: ['alpha'] }])
    const w2 = await world()
    const selection = await twice(w2, [plan(w2)], [plan(w2, { selections: [] })])
    expect(selection.secondCalls).toBeGreaterThan(0)
  }, 120_000)

  it('clones again when an installed file was tampered with or a root was deleted', async () => {
    const w = await world()
    const tampered = await twice(
      w,
      [plan(w)],
      undefined,
      async (roots) => {
        await writeFile(join(w.workspace, roots[0]!.path, 'SKILL.md'), 'edited\n')
      },
      true
    )
    expect(tampered.secondCalls).toBeGreaterThan(0)
    const w2 = await world()
    const deleted = await twice(w2, [plan(w2)], undefined, async (roots) => {
      await rm(join(w2.workspace, roots[0]!.path), { recursive: true, force: true })
    })
    expect(deleted.secondCalls).toBeGreaterThan(0)
    expect(deleted.two).toMatchObject({ roots: deleted.one.roots })
  }, 120_000)

  it('clones again after a run that skipped a Source, and when the receipts are not what it published', async () => {
    const w = await world()
    const absent = plan(w, { sourceId: 'agent:1', url: `${HOST}absent.git` })
    const failed = await twice(w, [plan(w), absent])
    expect(failed.one.skipped?.map((entry) => entry.sourceId)).toEqual(['agent:1'])
    expect(failed.secondCalls).toBeGreaterThan(0)
    const w2 = await world()
    const gitCalls: string[][] = []
    const s = shim(w2, { gitCalls })
    await reconcile(s.handler, [plan(w2)])
    const before = gitCalls.length
    // A daemon whose ledger never committed the first reply sends no receipts at all.
    await reconcile(s.handler, [plan(w2)], undefined, [])
    expect(gitCalls.length).toBeGreaterThan(before)
  }, 120_000)
})

describe('skill write-back candidate rules', () => {
  it.each([
    [undefined, { kind: 'uncached' as const }, undefined],
    [{ maxBytes: 1 }, { kind: 'uncached' as const }, 'miss'],
    [{ maxBytes: 1 }, { kind: 'hit' as const }, undefined],
    [{ maxBytes: 1, stale: true as const }, { kind: 'hit' as const }, 'stale'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'clone-failed' as const }, 'fallback'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'no-bundle-refs' as const }, 'fallback'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'inspect-failed' as const }, 'fallback'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'connectivity' as const }, 'fallback'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'cleanup-failed' as const }, 'fallback'],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'download-warning' as const }, undefined],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'stderr-unavailable' as const }, undefined],
    [{ maxBytes: 1 }, { kind: 'fallback' as const, reason: 'acquire-failed' as const }, undefined]
  ])('with writeBack %j a %j read is %s', (writeBack, bundle, trigger) => {
    expect(skillWriteBackTrigger(writeBack, bundle)).toBe(trigger)
  })

  it('stages nothing without a write-back ref and stops at an abort', async () => {
    const staged: string[] = []
    const timeouts: Array<number | undefined> = []
    let clock = 0
    const staging = {
      stage: async (input: { ref: string; timeoutMs?: number }) => {
        staged.push(input.ref)
        timeouts.push(input.timeoutMs)
        clock += 3 * 60_000
        return { handle: randomUUID(), bytes: 1, sha256: Buffer.alloc(32).toString('base64') }
      },
      discard: () => undefined
    }
    const acquired = (sourceId: string, writeBackRef?: string) => ({
      kind: 'acquired' as const,
      plan: {
        sourceId,
        sourceKind: 'git' as const,
        url: GIT_URL,
        ref: 'refs/heads/main',
        plannedCommit: 'c'.repeat(40),
        selections: [],
        writeBack: { maxBytes: 1 }
      },
      root: '/r',
      commit: 'c'.repeat(40),
      fileCount: 1,
      totalBytes: 1,
      cliSelections: [],
      expectedLeaves: [],
      repo: '/repo',
      bundle: { kind: 'uncached' as const },
      ...(writeBackRef ? { writeBackRef } : {})
    })
    const candidates = await stageSkillWriteBacks({
      outcomes: [acquired('a'), acquired('b', 'refs/heads/main')],
      staging,
      abort: new AbortController().signal
    })
    expect(candidates.map((candidate) => candidate.sourceId)).toEqual(['b'])
    const aborted = new AbortController()
    aborted.abort()
    expect(
      await stageSkillWriteBacks({ outcomes: [acquired('c', 'refs/heads/main')], staging, abort: aborted.signal })
    ).toEqual([])
    expect(staged).toEqual(['refs/heads/main'])
    expect(timeouts).toEqual([SKILL_STAGE_TIMEOUT_MS])

    // Each bundle gets at most what is left of the reconcile's bundling budget; past it, none is staged.
    clock = 0
    const budgeted = await stageSkillWriteBacks({
      outcomes: ['d', 'e', 'f'].map((id) => acquired(id, 'refs/heads/main')),
      staging,
      abort: new AbortController().signal,
      now: () => clock
    })
    expect(budgeted.map((candidate) => candidate.sourceId)).toEqual(['d', 'e'])
    expect(timeouts.slice(1)).toEqual([SKILL_STAGE_TIMEOUT_MS, SKILL_STAGE_BUDGET_MS - 3 * 60_000])
  })
})

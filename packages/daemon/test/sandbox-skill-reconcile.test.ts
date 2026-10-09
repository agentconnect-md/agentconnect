import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { AgentSkillEntry } from '@agentconnect.md/protocol'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ShimBundleClient } from '../src/shim/bundle-client.js'
import { createBundleHandler } from '../src/shim/bundle-handler.js'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { runLocalSkillGit, type SkillGitRunner } from '../src/shim/skill-git-acquire.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { MAX_CLUSTER_SKILL_CONTROL_BYTES, type ClusterSkillReconcile } from '../src/shim/skill-protocol.js'
import type { ClusterSkillJournalStore } from '../src/skills/cluster-skill-coordinator.js'
import { gitResolutionDigest, type LocalSkillSource } from '../src/skills/install-skills.js'
import {
  reconcileSandboxSkillSources,
  type InPodSkillDeps,
  type SandboxSkillReconcileDeps
} from '../src/skills/sandbox-skill-reconcile.js'
import type { SkillRefPlan } from '../src/skills/skill-ref-resolution.js'
import { bundleKey, parseSourceCacheObjectKey, skillPointerKey, anonRepoId } from '../src/source-cache/keys.js'
import { createSkillReadPlanner } from '../src/source-cache/read-plan.js'
import { createSkillCachePlanner } from '../src/source-cache/skill-write-back.js'
import { createSourceCacheWriter, type SourceCacheWriteOutcome } from '../src/source-cache/write-back.js'
import type { ClusterSkillLedger } from '../src/store/cluster-skill-ledger.js'
import { LocalStore, type SourceCacheObjectRow } from '../src/store/local-store.js'
import { memoryStoreDatabase } from './store-support.js'

// The S5b golden parity: one agent spec through the daemon-acquisition path and the in-pod path, over the real handler and file:// repos.

const HOST = 'https://github.com/'
const AUTHORITY = { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'w' }
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
}
const ok = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, env: gitEnv })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}
const body = (name: string): string => `---\nname: ${name}\ndescription: fixture\n---\n# ${name}\n`

const PUBLIC = AgentSkillEntry.parse({
  name: 'public',
  source: 'acme/skills',
  githubRepoId: '11',
  subDir: 'skills',
  skills: ['alpha']
})
const PRIVATE = AgentSkillEntry.parse({
  name: 'private',
  source: 'acme/private',
  githubRepoId: '22',
  subDir: 'skills',
  skills: ['gamma'],
  private: true
})

// Bare origins for both repositories, plus the managed and Dream directories the daemon uploads.
async function world() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ac-sandbox-skills-')))
  const tips: Record<string, string> = {}
  const repo = async (name: string, files: Record<string, string>): Promise<void> => {
    const origin = join(root, `${name}.git`)
    const seed = join(root, 'seed', name)
    await mkdir(join(root, name.split('/')[0]!), { recursive: true })
    ok(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
    ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
    ok(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(seed, path, '..'), { recursive: true })
      await writeFile(join(seed, path), text)
    }
    ok(seed, ['init', '-q', '--initial-branch=main'])
    ok(seed, ['add', '-A'])
    ok(seed, ['commit', '-qm', 'one'])
    ok(seed, ['remote', 'add', 'origin', origin])
    ok(seed, ['push', '-q', 'origin', 'main'])
    tips[name] = ok(seed, ['rev-parse', 'HEAD'])
  }
  await repo('acme/skills', {
    'skills/alpha/SKILL.md': body('alpha'),
    'skills/alpha/notes.md': 'alpha notes\n',
    'skills/beta/SKILL.md': body('beta'),
    'README.md': 'outside the subdirectory\n'
  })
  await repo('acme/private', { 'skills/gamma/SKILL.md': body('gamma'), 'skills/gamma/run.md': 'gamma\n' })
  const local = async (kind: 'managed' | 'dream', name: string, files: Record<string, string>) => {
    const sourceDir = join(root, kind)
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(sourceDir, path, '..'), { recursive: true })
      await writeFile(join(sourceDir, path), text)
    }
    return { kind, key: `${kind}:${name}`, name, sourceDir } satisfies LocalSkillSource
  }
  const managed = await local('managed', 'mskill', { 'mskill/SKILL.md': body('mskill'), 'mskill/extra.md': 'x\n' })
  const dream = await local('dream', 'dskill', { 'dskill/SKILL.md': body('dskill') })
  return { root, tips, managed, dream }
}
type World = Awaited<ReturnType<typeof world>>

// `https://github.com/<name>` is `<root>/<name>` on disk.
const runner =
  (w: World): SkillGitRunner =>
  async (invocation) =>
    await runLocalSkillGit({
      ...invocation,
      args: invocation.args.map((arg) =>
        arg.startsWith(HOST) ? `file://${join(w.root, arg.slice(HOST.length))}` : arg
      )
    })

// The real store, so a fallback resumes the journal exactly as a pool member's would.
async function realStore(agentId = 'a') {
  const store = await LocalStore.open({
    database: memoryStoreDatabase(),
    shared: true,
    ownerId: 'd',
    orgForAgent: () => 'org'
  })
  await store.projectDutyWriteFence({ groupId: 'g', term: '1', daemonId: 'd' })
  const ledger = async (): Promise<ClusterSkillLedger> =>
    (await store.clusterSkillLedger(agentId, 'w'))?.ledger ?? { roots: [] }
  const revision = async (): Promise<number> => (await store.clusterSkillLedger(agentId, 'w'))?.revision ?? 0
  return { store: store as ClusterSkillJournalStore, ledger, revision, close: () => store.close() }
}

/** One sandbox: the real handler behind a requester that records every request, and its own store. */
async function sandbox(
  w: World,
  name: string,
  limits = { maxFiles: 16_384, maxTotalBytes: 1024 ** 3 },
  agentId = 'a',
  options: { writeBack?: boolean } = {}
) {
  const dir = join(w.root, 'sandboxes', name)
  const workspace = join(dir, 'workspace')
  const staging = join(dir, 'staging')
  await mkdir(workspace, { recursive: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  // A `skill-git-writeback-v1` shim: its bundle registry, staged into from the skill handler and driven over `bundle`.
  const bundleStaging = join(dir, 'bundle-staging')
  const bundles = options.writeBack
    ? createBundleHandler({ workspaceRoot: workspace, stagingDir: bundleStaging, allowHttpUpload: true })
    : undefined
  if (bundles) prepareBundleStaging(bundleStaging)
  // Every Git invocation the pod runs that reaches an origin, by repository.
  const originCalls: string[] = []
  const handler = new ClusterSkillHandler({
    stagingRoot: staging,
    workspaceRoot: workspace,
    stateRoot: join(dir, 'state'),
    git: {
      git: async (invocation) => {
        const origin = invocation.args.find((arg) => arg.startsWith(HOST))
        if (origin) originCalls.push(origin.slice(HOST.length))
        return await runner(w)(invocation)
      },
      allowFileProtocol: true,
      shimEnv: { PATH: process.env.PATH },
      credentialHelper: '/nonexistent/gitcred-helper',
      credentialSocket: '/nonexistent/gitcred.sock'
    },
    manifestLimits: limits,
    ...(bundles ? { writeBack: { stage: bundles.stage, discard: (handle: string) => bundles.discard(handle) } } : {})
  })
  const requests: Array<Record<string, unknown>> = []
  let intercept: ((payload: Record<string, unknown>, reply: unknown) => unknown) | undefined
  const requester: ShimRequester = {
    request: async (_capability, payload) => {
      requests.push(payload as Record<string, unknown>)
      const reply = await handler.handle(payload)
      return intercept ? intercept(payload as Record<string, unknown>, reply) : reply
    }
  }
  const stager = bundles
    ? new ShimBundleClient({ request: async (_capability, payload) => await bundles(payload) })
    : undefined
  const client = (gitInPod: boolean): ClusterSkillClient => {
    const c = new ClusterSkillClient(requester, true, true, true, gitInPod, gitInPod ? stager : undefined)
    Object.defineProperty(c, 'manifestLimits', { get: () => limits })
    return c
  }
  return {
    workspace,
    staging,
    bundleStaging,
    originCalls,
    stop: () => bundles?.stop(),
    requests,
    client,
    intercept: (fn: typeof intercept) => (intercept = fn),
    store: await realStore(agentId),
    // Uploaded paths by source id, and the bytes the daemon sent.
    uploads: () => {
      const rows = requests.filter((r) => r.op === 'upload')
      return {
        sources: [...new Set(rows.map((r) => String(r.sourceId)))],
        bytes: rows.reduce((total, r) => total + Buffer.from(String(r.data), 'base64').length, 0)
      }
    },
    gitPlans: () =>
      requests
        .filter((r) => r.op === 'reconcile')
        .map((r) => (r.sources as ClusterSkillReconcile['sources']).filter((s) => s.sourceKind === 'git'))
  }
}
type Sandbox = Awaited<ReturnType<typeof sandbox>>

// The installed bundle set: every file under the workspace but the shim's own state, with its content digest.
async function installed(workspace: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (relative(workspace, path) === '.agentconnect') continue
      if (entry.isDirectory()) await walk(path)
      else
        out[relative(workspace, path)] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
    }
  }
  await walk(workspace)
  return out
}

interface Run {
  resolve?: (entry: AgentSkillEntry) => SkillRefPlan
  inPod?: Partial<InPodSkillDeps>
  logs?: string[]
  acquired?: string[]
}

async function run(w: World, box: Sandbox, mode: 'daemon' | 'pod', options: Run = {}) {
  const tipOf = (entry: AgentSkillEntry): string => w.tips[entry.source]!
  const resolve =
    options.resolve ??
    ((entry: AgentSkillEntry): SkillRefPlan => ({
      ok: true,
      commit: tipOf(entry),
      ref: 'refs/heads/main',
      pinned: false,
      credentialed: entry.private === true
    }))
  const deps: SandboxSkillReconcileDeps = {
    store: box.store.store,
    log: { info: () => {}, warn: (message) => options.logs?.push(message) },
    trackedCommit: async (entry) => {
      const resolved = resolve(entry)
      return resolved.ok ? resolved.commit : null
    },
    acquire: async (entry, plannedCommit, destination) => {
      options.acquired?.push(entry.name)
      await mkdir(destination, { recursive: true })
      ok(destination, ['clone', '-q', join(w.root, `${entry.source}.git`), 'repo'])
      const checkout = join(destination, 'repo')
      const commit = plannedCommit ?? ok(checkout, ['rev-parse', 'HEAD'])
      ok(checkout, ['checkout', '-q', commit])
      await rm(join(checkout, '.git'), { recursive: true, force: true })
      return { sourceDir: join(checkout, entry.subDir ?? ''), resolvedCommit: commit }
    },
    ...(mode === 'pod'
      ? {
          inPod: {
            resolve: async (entry) => resolve(entry),
            servesGitcred: true,
            windowAdmits: () => true,
            openWindow: (repos) => ({
              capability: `window-${repos.join('-')}`.replace(/[^A-Za-z0-9_-]/g, '_'),
              close() {}
            }),
            ...options.inPod
          }
        }
      : {})
  }
  return await reconcileSandboxSkillSources(deps, {
    agentId: 'a',
    skills: [PUBLIC, PRIVATE],
    managed: [w.managed],
    dreamed: [w.dream],
    priorLedger: await box.store.ledger(),
    target: {
      authority: AUTHORITY,
      skillsAgentId: 'codex',
      shimGeneration: 1,
      client: box.client(mode === 'pod'),
      isLaunchCurrent: () => true
    }
  })
}

const withWorld = async (work: (w: World) => Promise<void>): Promise<void> => {
  const w = await world()
  try {
    await work(w)
  } finally {
    await rm(w.root, { recursive: true, force: true })
  }
}

describe('sandbox skill reconcile: daemon path and in-pod path parity (source-cache.md §8)', () => {
  it('installs the same bundles, receipts and ledger, with a managed source over budget', async () => {
    await withWorld(async (w) => {
      // Git (3 + 2 files) leaves room for Dream (1) but not managed (2): both paths drop managed.
      const limits = { maxFiles: 6, maxTotalBytes: 1024 * 1024 }
      const daemon = await sandbox(w, 'daemon', limits)
      const pod = await sandbox(w, 'pod', limits)
      const daemonLogs: string[] = []
      const podLogs: string[] = []
      const viaDaemon = await run(w, daemon, 'daemon', { logs: daemonLogs })
      const viaPod = await run(w, pod, 'pod', { logs: podLogs })

      expect(await installed(pod.workspace)).toEqual(await installed(daemon.workspace))
      expect(Object.keys(await installed(pod.workspace)).sort()).toEqual([
        '.agents/skills/alpha/SKILL.md',
        '.agents/skills/alpha/notes.md',
        '.agents/skills/dskill/SKILL.md',
        '.agents/skills/gamma/SKILL.md',
        '.agents/skills/gamma/run.md'
      ])
      expect(await pod.store.ledger()).toEqual(await daemon.store.ledger())
      expect((await pod.store.ledger()).gitResolutions).toEqual(
        [PUBLIC, PRIVATE]
          .map((entry) => ({ definitionDigest: gitResolutionDigest(entry), resolvedCommit: w.tips[entry.source]! }))
          .sort((a, b) => a.definitionDigest.localeCompare(b.definitionDigest))
      )
      // Intended difference: the pod charges the budget itself, so it reports the drop; the daemon path only logs it.
      expect(viaPod.skipped).toEqual([
        { sourceId: 'managed:mskill', reason: expect.any(String), code: 'limits_exceeded' }
      ])
      expect(viaDaemon.skipped).toBeUndefined()
      expect(podLogs.join('\n')).toContain('skipped for a; not installed')
      expect(daemonLogs.join('\n')).toContain('does not fit the remaining skill manifest budget')
      // Byte accounting: no Git skill file crosses from the daemon on the in-pod path.
      expect(pod.uploads().sources.sort()).toEqual(['dream:dskill', 'managed:mskill'])
      expect(daemon.uploads().sources.filter((id) => id.startsWith('agent:'))).toHaveLength(2)
      expect(pod.uploads().bytes).toBeLessThan(daemon.uploads().bytes)
      const [plans] = pod.gitPlans()
      expect(plans!.map((plan) => [plan.sourceId.split(':')[1], plan.sourceKind, 'plannedCommit' in plan])).toEqual([
        ['0', 'git', true],
        ['1', 'git', true]
      ])
      expect(await readdir(pod.staging)).toEqual([])
    })
  }, 180_000)

  it('keeps an installed Source whose resolution failed, and charges it by its receipt where the daemon re-acquires', async () => {
    await withWorld(async (w) => {
      const daemon = await sandbox(w, 'daemon')
      const pod = await sandbox(w, 'pod')
      await run(w, daemon, 'daemon')
      await run(w, pod, 'pod')
      // The public Source's resolution now fails on both paths.
      const failing = (entry: AgentSkillEntry): SkillRefPlan =>
        entry.name === 'public'
          ? { ok: false }
          : { ok: true, commit: w.tips[entry.source]!, ref: 'refs/heads/main', pinned: false, credentialed: true }
      const acquired: string[] = []
      await run(w, daemon, 'daemon', { resolve: failing })
      await run(w, pod, 'pod', { resolve: failing, acquired })
      expect(await installed(pod.workspace)).toEqual(await installed(daemon.workspace))
      // A kept root is publication-order last in the pod; the receipts themselves are identical.
      const byPath = (ledger: ClusterSkillLedger) => ({
        ...ledger,
        roots: [...ledger.roots].sort((a, b) => a.path.localeCompare(b.path))
      })
      expect(byPath(await pod.store.ledger())).toEqual(byPath(await daemon.store.ledger()))
      expect(acquired).toEqual([])
      const kept = pod
        .gitPlans()
        .at(-1)!
        .find((plan) => plan.sourceId.startsWith('agent:0:'))!
      expect(kept).toMatchObject({ keepInstalled: true, plannedCommit: w.tips['acme/skills'] })
      expect(kept).not.toHaveProperty('getUrl')

      // Intended difference (source-cache.md §8): a kept Source costs its receipt's 2 files in the pod, the re-acquired subtree's 3 on the daemon path.
      const tight = { maxFiles: 5, maxTotalBytes: 1024 * 1024 }
      const daemonTight = await sandbox(w, 'daemon-tight', tight)
      const podTight = await sandbox(w, 'pod-tight', tight)
      for (const box of [daemonTight, podTight]) await run(w, box, box === podTight ? 'pod' : 'daemon')
      await run(w, daemonTight, 'daemon', { resolve: failing })
      await run(w, podTight, 'pod', { resolve: failing })
      expect(Object.keys(await installed(podTight.workspace))).toContain('.agents/skills/dskill/SKILL.md')
      expect(Object.keys(await installed(daemonTight.workspace))).not.toContain('.agents/skills/dskill/SKILL.md')
    })
  }, 240_000)
})

describe('sandbox skill reconcile: routing', () => {
  it('opens one pod window over exactly the planned private repositories and closes it', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      const opened: string[][] = []
      let closed = 0
      await run(w, pod, 'pod', {
        inPod: {
          openWindow: (repos) => {
            opened.push(repos)
            return { capability: 'w'.repeat(43), close: () => (closed += 1) }
          }
        }
      })
      expect(opened).toEqual([['acme/private']])
      expect(closed).toBe(1)
      const reconcile = pod.requests.find((r) => r.op === 'reconcile')!
      expect(reconcile.credentialWindow).toEqual({ capability: 'w'.repeat(43) })
    })
  }, 120_000)

  it('routes private Sources through the daemon for a pod bound without the gitcred tunnel', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      const acquired: string[] = []
      let opened = 0
      await run(w, pod, 'pod', {
        acquired,
        inPod: {
          servesGitcred: false,
          openWindow: () => {
            opened += 1
            return undefined
          }
        }
      })
      expect(acquired).toEqual(['private'])
      expect(opened).toBe(0)
      expect(pod.gitPlans()[0]!.map((plan) => plan.sourceId.split(':')[1])).toEqual(['0'])
      expect(pod.uploads().sources.filter((id) => id.startsWith('agent:1:'))).toHaveLength(1)
      expect(Object.keys(await installed(pod.workspace))).toContain('.agents/skills/gamma/SKILL.md')
    })
  }, 120_000)

  it('routes a private Source no pod window would admit through the daemon', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      const acquired: string[] = []
      let opened = 0
      await run(w, pod, 'pod', {
        acquired,
        inPod: {
          windowAdmits: (repo) => repo !== 'acme/private',
          openWindow: () => {
            opened += 1
            return undefined
          }
        }
      })
      expect(acquired).toEqual(['private'])
      expect(opened).toBe(0)
      expect(pod.gitPlans()[0]!.map((plan) => plan.sourceId.split(':')[1])).toEqual(['0'])
      expect(Object.keys(await installed(pod.workspace))).toContain('.agents/skills/gamma/SKILL.md')
    })
  }, 120_000)

  it('keeps an older image on daemon acquisition whatever the daemon could plan', async () => {
    await withWorld(async (w) => {
      const box = await sandbox(w, 'older')
      const acquired: string[] = []
      // In-pod deps exist, but the bound shim was not granted `skills-git`.
      await reconcileSandboxSkillSources(
        {
          store: box.store.store,
          log: { info: () => {}, warn: () => {} },
          trackedCommit: async (entry) => w.tips[entry.source]!,
          acquire: async (entry, plannedCommit, destination) => {
            acquired.push(entry.name)
            await mkdir(destination, { recursive: true })
            ok(destination, ['clone', '-q', join(w.root, `${entry.source}.git`), 'repo'])
            ok(join(destination, 'repo'), ['checkout', '-q', plannedCommit!])
            await rm(join(destination, 'repo', '.git'), { recursive: true, force: true })
            return { sourceDir: join(destination, 'repo', 'skills'), resolvedCommit: plannedCommit! }
          },
          inPod: {
            resolve: async () => {
              throw new Error('never asked')
            },
            servesGitcred: true,
            windowAdmits: () => true,
            openWindow: () => {
              throw new Error('never opened')
            }
          }
        },
        {
          agentId: 'a',
          skills: [PUBLIC, PRIVATE],
          managed: [],
          dreamed: [],
          target: {
            authority: AUTHORITY,
            skillsAgentId: 'codex',
            shimGeneration: 1,
            client: box.client(false),
            isLaunchCurrent: () => true
          }
        }
      )
      expect(acquired.sort()).toEqual(['private', 'public'])
      expect(box.gitPlans()).toEqual([[]])
    })
  }, 120_000)

  it('falls back to the daemon path when the Git plan reconcile throws, and the session prepares', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      pod.intercept((payload, reply) => {
        const sources = (payload.sources ?? []) as Array<{ sourceKind: string }>
        if (payload.op === 'reconcile' && sources.some((s) => s.sourceKind === 'git')) return { garbage: true }
        return reply
      })
      const logs: string[] = []
      const acquired: string[] = []
      const result = await run(w, pod, 'pod', { logs, acquired })
      // The shim published the plan before the reply was refused; the fallback resumes that operation.
      expect(pod.gitPlans()[0]).toHaveLength(2)
      expect(logs.join('\n')).toContain('in-pod Git skill install failed for a; acquiring through the daemon')
      expect(acquired.sort()).toEqual(['private', 'public'])
      expect(result.roots.map((root) => root.path).sort()).toEqual([
        '.agents/skills/alpha',
        '.agents/skills/dskill',
        '.agents/skills/gamma',
        '.agents/skills/mskill'
      ])
      expect(await pod.store.revision()).toBe(1)
    })
  }, 180_000)

  it('records no ledger resolution for a Source whose pod reported a commit other than the planned one', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      const forged = 'f'.repeat(40)
      pod.intercept((payload, reply) => {
        if (payload.op !== 'reconcile') return reply
        const page = reply as { gitSources?: Array<{ sourceId: string; resolvedCommit: string }> }
        return {
          ...page,
          gitSources: page.gitSources?.map((g) =>
            g.sourceId.startsWith('agent:0:') ? { ...g, resolvedCommit: forged } : g
          )
        }
      })
      const result = await run(w, pod, 'pod')
      expect(result.skipped).toEqual([expect.objectContaining({ sourceId: expect.stringMatching(/^agent:0:/) })])
      const resolutions = (await pod.store.ledger()).gitResolutions ?? []
      expect(resolutions.map((r) => r.definitionDigest)).toEqual([gitResolutionDigest(PRIVATE)])
      expect(resolutions.some((r) => r.resolvedCommit === forged)).toBe(false)
    })
  }, 120_000)

  it('skips a never-installed Source whose resolution failed, rather than planning a pod-local commit', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod')
      const logs: string[] = []
      const acquired: string[] = []
      await run(w, pod, 'pod', {
        logs,
        acquired,
        resolve: (entry) =>
          entry.name === 'private'
            ? { ok: false }
            : { ok: true, commit: w.tips[entry.source]!, ref: 'refs/heads/main', pinned: false, credentialed: false }
      })
      expect(pod.gitPlans()[0]!.map((plan) => plan.sourceId.split(':')[1])).toEqual(['0'])
      expect(acquired).toEqual([])
      expect(logs.join('\n')).toContain('Git source private unresolved and not installed')
    })
  }, 120_000)
})

describe('sandbox skill reconcile: plan frame bound', () => {
  it('routes Git Sources past the frame budget to the daemon so a plan without GET URLs always fits', async () => {
    // Uploaded forms that fit the frame together, plans (long subDir) that do not.
    const names = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}-${'x'.repeat(110)}`)
    const subDir = Array.from({ length: 5 }, () => 'd'.repeat(190)).join('/')
    const skills = Array.from({ length: 64 }, (_, i) =>
      AgentSkillEntry.parse({
        name: `s${i}`,
        source: `acme/r${i}`,
        githubRepoId: String(i + 1),
        subDir,
        skills: names(`k${i}`)
      })
    )
    const frames: string[] = []
    let attempt = 0
    const acquiredByAttempt: string[][] = [[], []]
    const requester: ShimRequester = {
      request: async (_capability, payload) => {
        const request = payload as { op: string; sources?: Array<{ sourceKind: string }> }
        if (request.op === 'begin') return { handle: 'h'.repeat(32) }
        if (request.op === 'upload') throw new Error('nothing is uploaded here')
        frames.push(JSON.stringify(payload))
        attempt += 1
        if (request.sources?.some((source) => source.sourceKind === 'git')) throw new Error('refused')
        return { roots: [], conflicts: [] }
      }
    }
    const client = new ClusterSkillClient(requester, true, true, true, true)
    const store = await realStore()
    const commit = 'c'.repeat(40)
    await reconcileSandboxSkillSources(
      {
        store: store.store,
        log: { info: () => {}, warn: () => {} },
        trackedCommit: async () => commit,
        acquire: async (entry) => {
          acquiredByAttempt[attempt]!.push(entry.name)
          throw new Error('offline')
        },
        inPod: {
          resolve: async () => ({ ok: true, commit, ref: 'refs/heads/main', pinned: false, credentialed: false }),
          servesGitcred: true,
          windowAdmits: () => true,
          openWindow: () => undefined,
          cachePlan: async () => ({ getUrl: `https://cache.example/${'q'.repeat(2000)}` })
        }
      },
      {
        agentId: 'a',
        skills,
        managed: [],
        dreamed: [],
        target: { authority: AUTHORITY, skillsAgentId: 'codex', shimGeneration: 1, client, isLaunchCurrent: () => true }
      }
    )
    const planned = JSON.parse(frames[0]!) as ClusterSkillReconcile
    const plans = planned.sources.filter((source) => source.sourceKind === 'git')
    expect(plans.length).toBeGreaterThan(0)
    expect(plans.length).toBeLessThan(64)
    // The overflow went to daemon acquisition in that same reconcile.
    expect(acquiredByAttempt[0]).toHaveLength(64 - plans.length)
    expect(Buffer.byteLength(frames[0]!)).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
    const withoutUrls = plans.map((plan) => ({ ...plan, getUrl: undefined }))
    expect(Buffer.byteLength(JSON.stringify({ ...planned, sources: withoutUrls }))).toBeLessThanOrEqual(
      MAX_CLUSTER_SKILL_CONTROL_BYTES
    )
    // Had every overflow Source acquired, its uploaded entry rides the same frame and it still fits.
    const plannedIndexes = new Set(plans.map((plan) => plan.sourceId.split(':')[1]))
    const uploaded = skills.flatMap((entry, index) =>
      plannedIndexes.has(String(index))
        ? []
        : [
            {
              sourceId: `agent:${index}:${gitResolutionDigest(entry)}:${commit}`,
              sourceKind: 'agent' as const,
              selections: entry.skills
            }
          ]
    )
    expect(
      Buffer.byteLength(JSON.stringify({ ...planned, sources: [...withoutUrls, ...uploaded] }))
    ).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
    await store.close()
  }, 60_000)
})

describe('sandbox skill reconcile: cross-agent isolation', () => {
  function readerFor(rows: Map<string, SourceCacheObjectRow>) {
    return createSkillReadPlanner({
      store: () => ({
        async getSourceCacheObject(orgId: string, key: string) {
          return rows.get(key)?.orgId === orgId ? rows.get(key) : undefined
        },
        async touchSourceCacheRead() {
          return true
        }
      }),
      presigner: {
        async presignGet(key) {
          return { method: 'GET', url: `https://cache.example/${key}?sig=1`, headers: {}, expiresAt: 0 }
        }
      },
      orgForAgent: () => 'org-1',
      log: { debug: () => {}, warn: () => {} }
    })
  }
  const seed = (rows: Map<string, SourceCacheObjectRow>, cls: 'anon' | 'cred', repo: string): string => {
    const row = (key: string, extra: Partial<SourceCacheObjectRow>): SourceCacheObjectRow => {
      const parsed = parseSourceCacheObjectKey(key)!
      return {
        orgId: 'org-1',
        key,
        kind: parsed.kind,
        state: 'committed',
        bytes: 1,
        repoClass: parsed.repoClass,
        repoId: parsed.repoId,
        refHash: parsed.kind === 'pointer' ? parsed.refHash : '',
        shape: 'blobless',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        lastReadAt: null,
        targetKey: null,
        unpointedAt: null,
        claimedBy: null,
        claimedAt: null,
        ...extra
      }
    }
    const latest = skillPointerKey({ org: 'org-1', class: cls, repo, ref: 'refs/heads/main' })
    const bundle = bundleKey({ org: 'org-1', class: cls, repo, id: '0b5c3f8e-8d0a-4c4e-9a1e-0123456789ab' })
    const pointer = row(latest, { targetKey: bundle })
    rows.set(latest, pointer)
    rows.set(bundle, row(bundle, { refHash: pointer.refHash }))
    return bundle
  }

  it('gives agent A’s pod its cred GET and agent B’s anonymous declaration of the same URL none', async () => {
    await withWorld(async (w) => {
      const rows = new Map<string, SourceCacheObjectRow>()
      const credBundle = seed(rows, 'cred', 'github:22')
      const reader = readerFor(rows)
      const asPublic = AgentSkillEntry.parse({ ...PRIVATE, private: undefined })
      const commitA = w.tips['acme/private']!
      // Agent A resolves the private Source with its own credential.
      const podA = await sandbox(w, 'a')
      await run(w, podA, 'pod', {
        inPod: { cachePlan: async (entry, resolution) => reader.plan({ agentId: 'a', entry, resolution }) }
      })
      const planA = podA.gitPlans()[0]!.find((plan) => plan.sourceId.startsWith('agent:1:'))!
      expect(planA).toMatchObject({ plannedCommit: commitA, getUrl: expect.stringContaining(credBundle) })

      // Agent B declares the same repository without `private`: its anonymous check is its own, and fails.
      const podB = await sandbox(w, 'b', undefined, 'b')
      const resolvedB: AgentSkillEntry[] = []
      await reconcileSandboxSkillSources(
        {
          store: podB.store.store,
          log: { info: () => {}, warn: () => {} },
          trackedCommit: async () => null,
          acquire: async () => {
            throw new Error('no daemon acquisition')
          },
          inPod: {
            resolve: async (entry) => {
              resolvedB.push(entry)
              return { ok: false }
            },
            servesGitcred: true,
            windowAdmits: () => true,
            openWindow: () => undefined,
            cachePlan: async (entry, resolution) => reader.plan({ agentId: 'b', entry, resolution })
          }
        },
        {
          agentId: 'b',
          skills: [asPublic],
          managed: [],
          dreamed: [],
          target: {
            authority: { ...AUTHORITY, agentId: 'b' },
            skillsAgentId: 'codex',
            shimGeneration: 1,
            client: podB.client(true),
            isLaunchCurrent: () => true
          }
        }
      )
      expect(resolvedB).toEqual([asPublic])
      const sent = JSON.stringify(podB.requests)
      expect(sent).not.toContain(commitA)
      expect(sent).not.toContain('cache.example')
      // Even had B's anonymous check answered, its read is the URL's anon entry, never A's cred bundle.
      const anonUrl = await reader.getUrl({
        agentId: 'b',
        entry: asPublic,
        resolution: { ok: true, commit: commitA, ref: 'refs/heads/main', pinned: false, credentialed: true }
      })
      expect(anonUrl).toBeUndefined()
      seed(rows, 'anon', anonRepoId('https://github.com/acme/private.git'))
      expect(
        await reader.getUrl({
          agentId: 'b',
          entry: asPublic,
          resolution: { ok: true, commit: commitA, ref: 'refs/heads/main', pinned: false, credentialed: false }
        })
      ).toContain('/anon/')
    })
  }, 120_000)
})

describe('sandbox skill reconcile: in-pod write-back (source-cache.md §9)', () => {
  // A bucket behind fakes that accept a real upload: reserve, sign, PUT, HEAD, commit, retag and pointer, all recorded.
  async function bucket() {
    const uploads = new Map<string, Buffer>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        uploads.set(req.url!.slice(1), Buffer.concat(chunks))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const calls: string[] = []
    const outcomes: SourceCacheWriteOutcome[] = []
    const store = {
      async getSourceCacheObject() {
        return undefined
      },
      async touchSourceCacheRead() {
        return true
      },
      async reserveBundle(input: { key: string }) {
        calls.push(`reserve ${input.key}`)
        return { admitted: true as const, committedBytes: 0, pendingBytes: 0 }
      },
      async commitBundle(input: { key: string }) {
        calls.push(`commit ${input.key}`)
        return { committed: true as const, alreadyCommitted: false, bytes: 0 }
      },
      async setSourceCachePointer(input: { pointerKey: string; expectedTargetKey?: string | null }) {
        calls.push(`pointer ${input.pointerKey} ${input.expectedTargetKey}`)
        return { set: true as const, previousBundleKey: undefined }
      }
    }
    const writer = createSourceCacheWriter({
      store: () => store as never,
      presigner: {
        async presignPut(key, input) {
          return {
            method: 'PUT',
            url: `${base}/${key}`,
            headers: {
              'content-length': String(input.contentLength),
              'x-amz-checksum-sha256': input.checksumSha256,
              'x-amz-tagging': 'ac-cache=pending'
            },
            expiresAt: 0
          }
        }
      },
      objects: {
        async head(key) {
          const body = uploads.get(key)
          return body
            ? {
                exists: true,
                contentLength: body.length,
                checksumSha256: createHash('sha256').update(body).digest('base64')
              }
            : { exists: false }
        },
        async putTagging(key, tag) {
          calls.push(`retag ${key} ${tag}`)
        }
      },
      limits: { maxBundleBytes: 64 * 1024 * 1024, orgQuotaBytes: 1024 ** 3, pendingReservationSeconds: 3600 },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
      onOutcome: (outcome) => outcomes.push(outcome)
    })
    const reads = createSkillReadPlanner({
      store: () => store as never,
      presigner: {
        async presignGet(key) {
          return { method: 'GET', url: `https://cache.example/${key}`, headers: {}, expiresAt: 0 }
        }
      },
      orgForAgent: () => 'org-1',
      log: { debug: () => {}, warn: () => {} }
    })
    const plan = createSkillCachePlanner({ reads, writer, maxBytes: 64 * 1024 * 1024 })
    const cachePlan: InPodSkillDeps['cachePlan'] = (entry, resolution, options) =>
      plan({ agentId: 'a', entry, resolution }, options)
    const reserved = (): string[] =>
      calls.filter((call) => call.startsWith('reserve ')).map((call) => call.split(' ')[1]!)
    return { calls, outcomes, cachePlan, reserved, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  it('writes each missed clone back in the class the daemon planned, after the ledger, without changing it', async () => {
    await withWorld(async (w) => {
      const plain = await sandbox(w, 'plain')
      const pod = await sandbox(w, 'pod', undefined, 'a', { writeBack: true })
      const b = await bucket()
      try {
        await run(w, plain, 'pod', { inPod: { cachePlan: b.cachePlan } })
        await run(w, pod, 'pod', { inPod: { cachePlan: b.cachePlan } })

        // The plan asked for exactly what the grant allows: write-back only on the granted pod.
        expect(JSON.stringify(plain.gitPlans())).not.toContain('writeBack')
        expect(pod.gitPlans()[0]!.map((source) => 'writeBack' in source)).toEqual([true, true])
        await vi.waitFor(() => expect(b.outcomes).toHaveLength(2), { timeout: 30_000 })
        expect(b.outcomes).toEqual([
          expect.objectContaining({ kind: 'written', trigger: 'miss' }),
          expect.objectContaining({ kind: 'written', trigger: 'miss' })
        ])
        expect(b.reserved().map((key) => parseSourceCacheObjectKey(key)?.repoClass)).toEqual(['anon', 'cred'])
        expect(b.reserved()[1]).toContain('/cred/github:22/')
        const anon = anonRepoId('https://github.com/acme/skills.git')
        expect(b.calls.filter((call) => call.startsWith('pointer '))).toEqual([
          `pointer ${skillPointerKey({ org: 'org-1', class: 'anon', repo: anon, ref: 'refs/heads/main' })} null`,
          `pointer ${skillPointerKey({ org: 'org-1', class: 'cred', repo: 'github:22', ref: 'refs/heads/main' })} null`
        ])
        // Every handle is spent, and the ledger and installed bundles are what a pod without write-back has.
        expect(await readdir(pod.bundleStaging)).toEqual([])
        expect(await pod.store.ledger()).toEqual(await plain.store.ledger())
        expect(await installed(pod.workspace)).toEqual(await installed(plain.workspace))
      } finally {
        pod.stop()
        await b.close()
      }
    })
  }, 180_000)

  it('clones each Source once and writes it back at most once across back-to-back reconciles of one spec', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod', undefined, 'a', { writeBack: true })
      const b = await bucket()
      try {
        await run(w, pod, 'pod', { inPod: { cachePlan: b.cachePlan } })
        await vi.waitFor(() => expect(b.outcomes).toHaveLength(2), { timeout: 30_000 })
        const once = { ledger: await pod.store.ledger(), files: await installed(pod.workspace) }
        const clones = [...pod.originCalls]
        expect(new Set(clones).size).toBe(2)
        // The launch gate's re-verify: the same spec on the same pod again.
        await run(w, pod, 'pod', { inPod: { cachePlan: b.cachePlan } })
        expect(pod.originCalls).toEqual(clones)
        expect(await pod.store.revision()).toBe(2)
        expect(await pod.store.ledger()).toEqual(once.ledger)
        expect(await installed(pod.workspace)).toEqual(once.files)
        expect(b.reserved()).toHaveLength(2)
        expect(b.outcomes).toHaveLength(2)
        expect(await readdir(pod.bundleStaging)).toEqual([])
        expect(await readdir(pod.staging)).toEqual([])
      } finally {
        pod.stop()
        await b.close()
      }
    })
  }, 180_000)

  it('never writes a private Source back when no window credentialed its clone, nor asks its pod to bundle it', async () => {
    await withWorld(async (w) => {
      const pod = await sandbox(w, 'pod', undefined, 'a', { writeBack: true })
      const b = await bucket()
      try {
        await run(w, pod, 'pod', { inPod: { cachePlan: b.cachePlan, openWindow: () => undefined } })
        await vi.waitFor(async () => expect(await readdir(pod.bundleStaging)).toEqual([]), { timeout: 30_000 })
        await vi.waitFor(() => expect(b.outcomes).toHaveLength(1), { timeout: 30_000 })
        expect(b.reserved().map((key) => parseSourceCacheObjectKey(key)?.repoClass)).toEqual(['anon'])
        const sent = pod.requests.find((request) => request.op === 'reconcile')!.sources as Array<{
          sourceKind: string
          writeBack?: unknown
        }>
        expect(sent.filter((source) => source.sourceKind === 'git')).toHaveLength(2)
        expect(sent.filter((source) => source.writeBack)).toHaveLength(1)
      } finally {
        pod.stop()
        await b.close()
      }
    })
  }, 180_000)
})

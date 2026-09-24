import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, hostKeyDirName, sessionHostKey, type HostKey } from '../src/acp/host-key.js'
import { buildCpClientDeps } from '../src/cp/cp-client-deps.js'
import { K8sDriver } from '../src/k8s/driver.js'
import { fenceFakeSandbox } from './fake-sandbox-fence.js'
import type { SandboxFence, Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import {
  agentSandboxSubject,
  sandboxClaimName,
  sandboxSubjectFor,
  sandboxSubjectForPath,
  sandboxSubjectSessionLeaf
} from '../src/k8s/sandbox-identity.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'
import { SANDBOX_CHECKOUT_DIR } from '../src/shim/sandbox-paths.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { RoutedWorkspaceFiles, WorkspaceViolationError, type WorkspaceFiles } from '../src/workspace/workspace-files.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { fakeGenerations } from './fake-generations.js'
import { PodWorkspaceFs } from './fixtures/pod-workspace-fs.js'

// The #1896 acceptance: an isolated pool session's real turns, sweep, console and retention over a real driver start one pod, while the agent pod refuses and records every call.

const AGENT = 'bot-a'
const MOUNT = '/agent'
const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`
const KEY = (thread: string): string => sessionKey('slack', 'C1', thread, AGENT, TRANSPORT_SCOPE)
const AGENT_POD = agentSandboxSubject(AGENT)
const podOf = (key: string): string => sandboxSubjectFor(sessionHostKey(AGENT, key))
const sessionDirOf = (key: string): string => `${MOUNT}/sessions/${hostKeyDirName(sessionHostKey(AGENT, key))}`

/** One Sandbox per claim, every call recorded by the claim or Sandbox it names; a claim `refused` names fails every call. */
function cluster(refused: (claimName: string) => boolean) {
  const claims = new Map<string, SandboxClaim>()
  const sandboxes = new Map<string, Sandbox>()
  const calls: string[] = []
  let minted = 0
  let versions = 0
  const record = (call: string, claimName: string): void => {
    calls.push(`${call} ${claimName}`)
    if (refused(claimName)) throw new K8sApiError(503, 'ServiceUnavailable', 'the agent pod refuses every call')
  }
  const api = {
    fenceSandbox: async (name: string, fence: SandboxFence) => fenceFakeSandbox(sandboxes.get(name)!, fence),
    ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
      record('ensureClaim', claim.metadata.name)
      const existing = claims.get(claim.metadata.name)
      if (existing) return { claim: existing, created: false }
      const name = `sb-${++minted}`
      sandboxes.set(name, {
        metadata: { name, uid: `uid-${name}` },
        spec: {
          operatingMode: 'Running',
          podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
        },
        status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: [`10.0.0.${minted}`] }
      })
      const stored: SandboxClaim = {
        ...claim,
        metadata: { ...claim.metadata, uid: `claim-${name}`, resourceVersion: `rv-${++versions}` },
        status: { sandbox: { name } }
      }
      claims.set(claim.metadata.name, stored)
      return { claim: stored, created: true }
    },
    stampClaim: async (name: string, annotations: Record<string, string>) => {
      record('stampClaim', name)
      const existing = claims.get(name)
      if (!existing) throw new K8sApiError(404, 'NotFound', 'no claim')
      const claim = {
        ...existing,
        metadata: {
          ...existing.metadata,
          annotations: { ...existing.metadata?.annotations, ...annotations },
          resourceVersion: `rv-${++versions}`
        }
      }
      claims.set(name, claim)
      return { claim }
    },
    getClaim: async (name: string) => {
      record('getClaim', name)
      const claim = claims.get(name)
      if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
      return claim
    },
    listClaims: async () => [...claims.values()],
    deleteClaim: async (name: string) => {
      record('deleteClaim', name)
      const bound = claims.get(name)?.status?.sandbox?.name
      claims.delete(name)
      if (bound) sandboxes.delete(bound)
    },
    getSandbox: async (name: string) => {
      const sandbox = sandboxes.get(name)
      if (!sandbox) throw new K8sApiError(404, 'NotFound', 'no sandbox')
      return sandbox
    },
    getWarmPool: async () => ({ spec: { sandboxTemplateRef: { name: 'runtime-template' } } }),
    getSandboxTemplate: async () => ({
      spec: { podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } } }
    }),
    setOperatingMode: async (name: string, desired: 'Running' | 'Suspended') => {
      calls.push(`${desired} ${name}`)
      const sandbox = sandboxes.get(name)!
      sandboxes.set(name, { ...sandbox, spec: { ...sandbox.spec, operatingMode: desired } })
      return sandboxes.get(name)!
    },
    resumeWithRuntimeImage: async (name: string) => {
      calls.push(`Running ${name}`)
      const sandbox = sandboxes.get(name)!
      sandboxes.set(name, { ...sandbox, spec: { ...sandbox.spec, operatingMode: 'Running' } })
      return sandboxes.get(name)!
    },
    reviewToken: vi.fn()
  }
  /** The Sandbox a subject's claim names, or undefined before it is claimed. */
  const sandboxOf = (subject: string): string | undefined =>
    claims.get(sandboxClaimName(subject))?.status?.sandbox?.name
  return { api, claims, sandboxes, calls, sandboxOf }
}

/** The pods' shims: each answers every request and can end its runtime; every dial of the agent pod is recorded, and refused while it is down. */
function podSide(reached: string[], agentPodDown: () => boolean) {
  const exits = new Map<string, () => void>()
  const streamId = randomUUID()
  const dialed: string[] = []
  const connect = async (record: SpawnRecord): Promise<ShimConnection> => {
    const subject = record.subject ?? record.agentId
    dialed.push(subject)
    if (subject === AGENT_POD) {
      reached.push(`dial ${subject}`)
      if (agentPodDown()) throw new Error('the agent pod refuses every call')
    }
    const listeners: Array<(text: string) => void> = []
    exits.set(subject, () => {
      const frame = { type: 'shim/event', streamId, event: { kind: 'exit', code: 0, signal: null } }
      for (const listener of listeners) listener(JSON.stringify(frame))
    })
    return {
      binding: { ...record, podName: `pod-${subject}`, podUid: `pod-${record.sandboxUid}` },
      issuedCredential: 'cred',
      send: (frame: { type: string; id: string }) => {
        if (frame.type !== 'shim/request') return
        const reply = { type: 'shim/response', id: frame.id, ok: true, payload: { streamId } }
        for (const listener of listeners) listener(JSON.stringify(reply))
      },
      onFrame: (listener: (text: string) => void) => listeners.push(listener),
      close: () => {}
    } as unknown as ShimConnection
  }
  return { connect, dialed, exit: (subject: string) => exits.get(subject)?.() }
}

/** The pods' volumes as one tree, remembering the origin each clone was taken from wherever it is moved. */
class Volume extends PodWorkspaceFs {
  readonly origins = new Map<string, string>()

  private moveOrigins(from: string, to?: string): void {
    for (const [path, origin] of [...this.origins]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue
      this.origins.delete(path)
      if (to !== undefined) this.origins.set(to + path.slice(from.length), origin)
    }
  }

  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to)
    this.moveOrigins(from, to)
  }

  override async rmTree(path: string): Promise<void> {
    await super.rmTree(path)
    this.moveOrigins(path)
  }
}

/** Git as a pod's shim would run it: recorded by where it ran, answering from the volume and from the origin each clone was taken from. */
function gitOn(pod: Volume, ran: Array<{ cwd?: string; args: string[] }>, cwd?: string): GitRunner {
  let head = 'a'.repeat(40)
  const originOf = (): string | undefined =>
    [...pod.origins].filter(([path]) => cwd === path || cwd?.startsWith(`${path}/`)).at(-1)?.[1]
  const run = async (args: string[]): Promise<string> => {
    ran.push({ cwd, args })
    if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
      if (cwd === undefined || (await pod.stat(`${cwd}/.git`)) === 'missing') throw new Error('not a git repository')
      return '.git'
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') return head
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main'
    if (args[0] === 'remote' && args[1] === 'get-url') return originOf() ?? ''
    if (args[0] === 'show-ref') throw new Error('no such ref')
    if (args[0] === 'branch' && args[1] === '--no-track') head = 'b'.repeat(40)
    if (args[0] === 'rev-list' && args.includes('--count')) return '0'
    if (args[0] === 'symbolic-ref') return 'dev/alice/quiet-harbor'
    return ''
  }
  return {
    withEnv: () => gitOn(pod, ran, cwd),
    raw: run,
    clone: async (repo, target, options = []) => {
      ran.push({ cwd, args: ['clone', repo, target, ...options] })
      const path = target.startsWith('/') ? target : join(cwd ?? MOUNT, target)
      await pod.mkdir(`${path}/.git`)
      pod.origins.set(path, repo)
    },
    pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
    status: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
    log: async () => [],
    readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
  } as GitRunner
}

/** A file port over the pod's volume: enough of the console's list and read to browse a session's tree. */
function filesOn(pod: PodWorkspaceFs): WorkspaceFiles {
  return {
    list: async (root) => {
      const names = await pod.readdir(root)
      return { entries: names.map((name) => ({ name, path: name, type: 'file' })), hasMore: false } as never
    },
    read: async (root, req) => {
      const content = await pod.readFile(join(root, (req as { path: string }).path))
      return { content: content ?? '', encoding: 'utf8', size: content?.length ?? 0 } as never
    },
    write: async () => {
      throw new Error('not in this test')
    },
    delete: async () => {
      throw new Error('not in this test')
    }
  }
}

/** The runtime plane over a real driver, routed as the real plane routes, off the path; every call naming the agent pod is recorded in `reached`. */
function planeOver(
  driver: K8sDriver,
  pod: Volume,
  reached: string[],
  git: Array<{ cwd?: string; args: string[] }>,
  agentPodDown: () => boolean
) {
  const bound = (subject: string): boolean => driver.sessionFor(subject)?.isAttached() === true
  const route = (agentId: string, path: string | undefined): string => sandboxSubjectForPath(agentId, path, MOUNT)
  /** Whether a call on `path` finds its pod unreachable, recording it when that pod is the agent's. */
  const refused = (kind: string, agentId: string, path: string | undefined): boolean => {
    const subject = route(agentId, path)
    if (sandboxSubjectSessionLeaf(subject) === undefined) {
      reached.push(`${kind} ${path ?? '(no path)'}`)
      return agentPodDown() || !bound(subject)
    }
    return !bound(subject)
  }
  pod.ownerAsleep = (path) => refused('fs', AGENT, path)
  const unavailable = (subject: string) =>
    new WorkspaceViolationError(`sandbox "${subject}" has no bound channel`, 'sandbox-unavailable')
  return {
    driver,
    memberId: 'member-under-test',
    runtimeImage: async () => 'runtime:1',
    workspacesOffDisk: true,
    ensureChannel: async (subject: string) => {
      await driver.ensureBoundChannel(subject)
    },
    withSandbox: <T>(subject: string, work: () => Promise<T>) => driver.withSandbox(subject, work),
    spawnFor: ({ hostKey, confined }: { hostKey?: string; confined: () => boolean }) => ({
      driver,
      ...(confined() ? { hostKey } : {})
    }),
    gitRunnerFor: (agentId: string, cwd?: string) => (refused('git', agentId, cwd) ? undefined : gitOn(pod, git, cwd)),
    workspaceFilesFor: (agentId: string) =>
      new RoutedWorkspaceFiles(async (root) => {
        if (refused('files', agentId, root)) throw unavailable(route(agentId, root))
        return filesOn(pod)
      }),
    workspaceFsFor: (agentId: string) =>
      [AGENT_POD, ...driver.sessionSubjectsOf(agentId)].some(bound) ? { fs: pod, mount: MOUNT } : undefined,
    autoMergeFor: () => {
      reached.push('auto-merge')
      return undefined
    },
    armedIn: async (subject: string) => {
      // A session pod is asked about its own watcher now that one may run there; only an ask of the agent pod counts.
      if (subject === AGENT_POD) reached.push(`armed ${subject}`)
      return false
    },
    memoryFsFor: () => {
      reached.push('memory')
      return undefined
    },
    runsInSandbox: (agentId: string) => [AGENT_POD, ...driver.sessionSubjectsOf(agentId)].some(bound),
    boundSubjects: (agentId: string) => [AGENT_POD, ...driver.sessionSubjectsOf(agentId)].filter(bound),
    subjectForPath: (agentId: string, path?: string) => route(agentId, path),
    sandboxBound: bound,
    holdIfBound: (subject: string) => (bound(subject) ? driver.retainLaunched(subject) : undefined),
    clearPath: async (agentId: string, root: string) => {
      if (refused('clear', agentId, root)) return `no bound channel for ${root}`
      await pod.rmTree(root)
      await pod.mkdir(root)
      return undefined
    },
    workspaceRootFor: () => MOUNT,
    sessionDirFor: (_agentId: string, leaf: string) => `${MOUNT}/sessions/${leaf}`,
    launched: () => driver.launched(),
    adoptAgent: async () => {},
    releaseAgent: () => {},
    suspendAgent: async () => {},
    suspendIdle: (subject: string) => driver.suspendIfIdle(subject),
    suspendStalled: (subject: string) => driver.suspendIfStalled(subject),
    discardAgent: async () => {},
    discardSession: async (agentId: string, leaf: string) => {
      await driver.removeSandbox(`${agentId}/${leaf}`)
    },
    discardSessions: async () => {},
    hasSandbox: (subject: string) => driver.hasClaim(subject),
    claimUidFor: (subject: string) => driver.claimUidFor(subject),
    resumeChannel: async (subject: string, claimUid: string) => {
      await driver.resumeBoundChannel(subject, claimUid)
    },
    stop: async () => {}
  }
}

/** A fake ACP adapter whose start launches through the plane, exactly where the real host's runtime would. */
function hostOver(launch: () => Promise<{ subject: string; stop: () => void }>, sessions: { minted: number }) {
  const live = new Set<string>()
  let runtime: { subject: string; stop: () => void } | undefined
  return {
    start: vi.fn(async () => {
      runtime = await launch()
    }),
    newSession: vi.fn(async (_cwd: string, ..._rest: unknown[]) => {
      const sid = `acp-${++sessions.minted}`
      live.add(sid)
      return sid
    }),
    hasSession: vi.fn((sid: string) => live.has(sid)),
    loadSupported: vi.fn(() => true),
    loadSession: vi.fn(async (sid: string) => void live.add(sid)),
    forgetSession: vi.fn((sid: string) => void live.delete(sid)),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => runtime?.stop()),
    // What a memory extraction pass asks of its host.
    usesMetaSystemPrompt: () => true,
    permissionModeOptions: () => ({ modes: ['read-only'] }),
    setSessionPermissionMode: vi.fn(async () => true),
    discardSession: vi.fn((sid: string) => void live.delete(sid))
  }
}

const dm = (ts: string, text: string, thread: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread,
  transportScope: TRANSPORT_SCOPE,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

/** A pool agent whose sessions are isolated by default, with nothing opting it into the agent pod: no autoDistill, no skills. */
function poolAgent(dir: string, autoDistill = false, isolation: 'shared' | 'session' | 'scratch' = 'session') {
  return {
    id: AGENT,
    name: AGENT,
    status: 'active',
    runtime: 'claude',
    runInSandbox: false,
    dir,
    memory: { provider: 'managed', home: 'control-plane', autoDistill },
    skills: [],
    managedSkills: [],
    mcpServers: [],
    crons: [],
    permissions: { policy: 'ask', autoApprove: [] },
    workspace:
      isolation === 'scratch'
        ? { mode: 'from-scratch', path: join(dir, 'workspace') }
        : {
            mode: 'git-repo',
            path: join(dir, 'workspace'),
            gitRepo: 'https://github.com/example-org/example-repo.git',
            gitBranch: 'main',
            isolation
          },
    integrations: [
      {
        id: 'int-a',
        platform: 'slack',
        core: { bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: 'b', appToken: 'p' }
      }
    ],
    output: { mode: 'medium' }
  }
}

async function poolMember(
  opts: { agentPodDown?: boolean; autoDistill?: boolean; isolation?: 'shared' | 'session' | 'scratch' } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'ac-one-pod-'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  const reached: string[] = []
  const git: Array<{ cwd?: string; args: string[] }> = []
  const agentPodDown = () => opts.agentPodDown !== false
  const fake = cluster((claimName) => agentPodDown() && claimName === sandboxClaimName(AGENT_POD))
  const pods = podSide(reached, agentPodDown)
  const volume = new Volume(MOUNT)
  const driver = new K8sDriver({
    api: fake.api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    connectChannel: (record) => pods.connect(record),
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  const plane = planeOver(driver, volume, reached, git, agentPodDown)
  const store = await LocalStore.open(':memory:')
  const sessions = { minted: 0 }
  const hosts: Array<ReturnType<typeof hostOver>> = []
  const instance = new Daemon({
    root,
    k8s: true,
    openDataPlane: async () =>
      ({
        store,
        transcripts: {
          appendTranscript: () => {},
          insertToolCall: () => {},
          updateToolCall: () => {},
          transcriptTailForAgent: async () => ({ rows: [], hasMore: false, cursor: 0 }),
          transcriptPageForAgentByEventTime: async () => ({ rows: [], hasMore: false }),
          transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
          currentTranscriptRevision: async () => 0,
          getToolBodyForAgent: async () => undefined
        },
        close: async () => {}
      }) as never,
    startK8sPlane: async () => plane as never,
    startControlPlane: (() => Promise.resolve()) as never,
    resolveCatalog: async () => ({
      entries: {
        claude: {
          runtime: { command: 'claude-acp', args: [], env: [] },
          source: 'registry',
          name: 'Claude Code',
          version: '1.0.0',
          skillsAgentId: 'claude'
        }
      },
      runtimes: { claude: { command: 'claude-acp', args: [], env: [] } }
    }),
    hostFactory: () => ({}) as never
  })
  await instance.start()
  const inner = instance as any
  const agent = poolAgent(mkdtempSync(join(tmpdir(), 'ac-one-pod-agent-')), opts.autoDistill, opts.isolation)
  inner.agents.set(AGENT, agent)
  let post = 0
  inner.connByIntegration.set('int-a', {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async () => `ts-${++post}`),
    updateBlocks: vi.fn(async () => true),
    finalizeResponse: vi.fn(async () => true)
  })
  // The host a turn builds, launched through the plane's own spawn rule; its stop ends the pod's runtime.
  vi.spyOn(inner, 'buildAcpHost').mockImplementation((...args: unknown[]) => {
    const { hostKey } = args[2] as { hostKey: string }
    const launch = async () => {
      const spawn = plane.spawnFor({ hostKey, confined: () => inner.podSubjectFor(agent, hostKey) !== undefined })
      const request = {
        command: 'claude-acp',
        args: [],
        env: { AC_AGENT_ID: AGENT },
        ...(spawn.hostKey ? { hostKey: spawn.hostKey } : {})
      }
      await spawn.driver.launch(request as never)
      const subject = spawn.hostKey ? sandboxSubjectFor(spawn.hostKey as HostKey) : AGENT_POD
      return { subject, stop: () => pods.exit(subject) }
    }
    const host = hostOver(launch, sessions)
    hosts.push(host)
    return { host }
  })
  return { root, instance, inner, agent, fake, pods, volume, driver, plane, store, reached, git, hosts }
}

/** Every call the fake cluster saw that names the agent pod's own claim or Sandbox. */
function agentPodCalls(pool: Awaited<ReturnType<typeof poolMember>>): string[] {
  const names = new Set([sandboxClaimName(AGENT_POD), pool.fake.sandboxOf(AGENT_POD)].filter(Boolean))
  return pool.fake.calls.filter((call) => names.has(call.split(' ').at(-1)!))
}

/** Stop a session's host as the idle reaper does, then run the pod sweep far enough past the window. */
async function goQuiet(pool: Awaited<ReturnType<typeof poolMember>>, key: string): Promise<void> {
  await pool.inner.stopHostByKey(sessionHostKey(AGENT, key))
  const ttl = pool.inner.cfg.limits.agentIdleTimeoutMs
  await pool.inner.sweepIdleSandboxes(Date.now() + 2 * ttl, ttl)
  await vi.waitFor(() => expect(pool.driver.currentLaunch(podOf(key))).toBeUndefined())
}

describe('an isolated pool session needs only its own pod (#1896)', () => {
  it('lives its whole life on one pod while the agent pod refuses every call', async () => {
    const pool = await poolMember()
    const pod = podOf(KEY('T1'))
    try {
      // First message: preparation, session/new, then more turns — all on the session pod.
      await pool.inner.dispatch(AGENT, dm('100', 'one', 'T1'), 'int-a')
      await pool.inner.dispatch(AGENT, dm('101', 'two', 'T1'), 'int-a')
      await pool.inner.dispatch(AGENT, dm('102', 'three', 'T1'), 'int-a')
      expect(pool.hosts).toHaveLength(1)
      expect(pool.hosts[0]!.newSession).toHaveBeenCalledTimes(1)
      expect(pool.hosts[0]!.prompt).toHaveBeenCalledTimes(3)
      expect(pool.hosts[0]!.newSession.mock.calls[0]![0]).toBe(`${sessionDirOf(KEY('T1'))}/workspace`)
      expect(pool.git.some((call) => call.args[0] === 'clone' && call.cwd === sessionDirOf(KEY('T1')))).toBe(true)
      expect([...pool.fake.claims.keys()]).toEqual([sandboxClaimName(pod)])

      // Idle: the host goes, and the sweep suspends the session pod, with nothing of the agent's to judge.
      await goQuiet(pool, KEY('T1'))
      expect(pool.fake.calls).toContain(`Suspended ${pool.fake.sandboxOf(pod)}`)

      // A later message resumes that same claim and loads the session in it.
      await pool.inner.dispatch(AGENT, dm('103', 'four', 'T1'), 'int-a')
      expect(pool.hosts).toHaveLength(2)
      expect(pool.hosts[1]!.loadSession).toHaveBeenCalledTimes(1)
      expect(pool.hosts[1]!.prompt).toHaveBeenCalledTimes(1)
      expect(pool.fake.calls.filter((call) => call === `Running ${pool.fake.sandboxOf(pod)}`)).toHaveLength(1)

      // The console: the session's page wakes, lists and keeps alive the session pod, awake or asleep.
      const deps = buildCpClientDeps(pool.inner.cpClientDepsHost(pool.root, 'wss://cp.example.test', () => {}))
      const sessionId = await pool.store.ensureOutwardSessionId(KEY('T1'), AGENT)
      const browse = async () => {
        expect(await deps.agentWake!.wake({ agentId: AGENT, sessionId })).toEqual({ agentId: AGENT, state: 'running' })
        const page = await deps.workspaceRead!.list({ agentId: AGENT, sessionId, path: '', limit: 50 })
        expect(page.entries.map((entry: { name: string }) => entry.name)).toContain('.git')
        expect(await deps.sandboxKeepAlive!({ agentId: AGENT, sessionId })).toMatchObject({ held: false })
      }
      await browse()
      await goQuiet(pool, KEY('T1'))
      expect(await deps.agentWake!.wake({ agentId: AGENT, sessionId })).toEqual({ agentId: AGENT, state: 'starting' })
      await vi.waitFor(() => expect(pool.plane.sandboxBound(pod)).toBe(true))
      await browse()

      // Retention: the clone is judged on its own pod, and the row's claim goes with it.
      const row = await pool.store.getSession(KEY('T1'))
      vi.spyOn(pool.store, 'listExpiredSessions').mockResolvedValue([row!])
      await pool.inner.sweepExpiredSessions()
      expect(await pool.store.getSession(KEY('T1'))).toBeUndefined()
      expect(pool.fake.claims.size).toBe(0)
      expect(pool.fake.calls).toContain(`deleteClaim ${sandboxClaimName(pod)}`)

      // One pod, first to last: the agent pod was never claimed, bound, dialled or read.
      expect(agentPodCalls(pool)).toEqual([])
      expect(new Set(pool.pods.dialed)).toEqual(new Set([pod]))
      expect(pool.reached).toEqual([])
    } finally {
      await pool.instance.stop()
    }
  })

  it('keeps a shared session in the agent pod, held while its host lives', async () => {
    const pool = await poolMember({ agentPodDown: false, isolation: 'shared' })
    try {
      await pool.inner.dispatch(AGENT, dm('100', 'one', 'T1'), 'int-a')
      expect([...pool.fake.claims.keys()]).toEqual([sandboxClaimName(AGENT_POD)])
      expect(new Set(pool.pods.dialed)).toEqual(new Set([AGENT_POD]))
      expect(pool.hosts[0]!.newSession.mock.calls[0]![0]).toBe(`${MOUNT}/${SANDBOX_CHECKOUT_DIR}`)

      // Its host runs in the agent pod, so the sweep leaves that pod alone however long the window has passed.
      const ttl = pool.inner.cfg.limits.agentIdleTimeoutMs
      await pool.inner.sweepIdleSandboxes(Date.now() + 2 * ttl, ttl)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(pool.driver.currentLaunch(AGENT_POD)).toBeDefined()
      expect(agentPodCalls(pool).filter((call) => call.startsWith('Suspended'))).toEqual([])

      // Host gone and its session quiet, the agent pod goes like any other.
      await pool.inner.stopHostByKey(agentHostKey(AGENT))
      await pool.inner.sweepIdleSandboxes(Date.now() + 2 * ttl, ttl)
      await vi.waitFor(() => expect(pool.driver.currentLaunch(AGENT_POD)).toBeUndefined())
      expect(pool.fake.calls).toContain(`Suspended ${pool.fake.sandboxOf(AGENT_POD)}`)
    } finally {
      await pool.instance.stop()
    }
  })

  it('still runs autoDistill in the agent pod, since its pass runs on the agent host (decision 2)', async () => {
    const pool = await poolMember({ agentPodDown: false, autoDistill: true })
    try {
      await pool.inner.dispatch(AGENT, dm('100', 'one', 'T1'), 'int-a')
      // The pass the managed provider runs after a turn when autoDistill is on: the agent's own host, in the agent pod.
      await pool.inner.runMemoryExtraction(AGENT, 'distill this turn', { agentId: AGENT })
      expect(pool.fake.claims.has(sandboxClaimName(AGENT_POD))).toBe(true)
      expect(pool.pods.dialed).toContain(AGENT_POD)
      expect(pool.inner.hosts.has(agentHostKey(AGENT))).toBe(true)
      expect(await pool.driver.suspendIfIdle(AGENT_POD)).toBe('busy')
    } finally {
      await pool.instance.stop()
    }
  })

  it('still reaches the agent pod for a conversion that is due, and for nothing once it is done', async () => {
    const pool = await poolMember({ agentPodDown: false })
    try {
      // The agent pod holds a checkout of the old repository, proven by this member's marker.
      await pool.plane.withSandbox(AGENT_POD, async () => {
        await pool.plane.ensureChannel(AGENT_POD)
        await pool.inner.workspaces.prepareClusterWorkspace(pool.agent, MOUNT)
      })
      expect(await pool.driver.suspendIfIdle(AGENT_POD)).toBe('suspended')
      const other = 'https://github.com/example-org/other-repo.git'
      const moved = { ...pool.agent, workspace: { ...pool.agent.workspace, gitRepo: other } }
      await pool.inner.workspaces.prepareWorkspaceForActivation(moved, { reconcileMaterialization: true })
      pool.inner.agents.set(AGENT, moved)
      pool.fake.calls.length = 0
      pool.git.length = 0

      await pool.inner.dispatch(AGENT, dm('100', 'one', 'T1'), 'int-a')
      // The agent pod was resumed for the conversion, and its checkout cloned afresh before the session's own clone.
      expect(pool.fake.calls).toContain(`Running ${pool.fake.sandboxOf(AGENT_POD)}`)
      expect(pool.git.filter((call) => call.args[0] === 'clone').map((call) => [call.cwd, call.args[1]])).toEqual([
        [MOUNT, other],
        [sessionDirOf(KEY('T1')), other]
      ])

      // Proven now: another session's first message stays on its own pod.
      expect(await pool.driver.suspendIfIdle(AGENT_POD)).toBe('suspended')
      pool.fake.calls.length = 0
      pool.reached.length = 0
      await pool.inner.dispatch(AGENT, dm('200', 'two', 'T2'), 'int-a')
      expect(pool.hosts.at(-1)!.newSession.mock.calls[0]![0]).toBe(`${sessionDirOf(KEY('T2'))}/workspace`)
      expect(agentPodCalls(pool)).toEqual([])
      expect(pool.reached).toEqual([])
    } finally {
      await pool.instance.stop()
    }
  })

  it('keeps a scratch agent’s isolated session page on its own pod, the one its wake resumes', async () => {
    // Its primary is no repository, so the tree its page shows is the session directory's, not a checkout of the agent's.
    const pool = await poolMember({ isolation: 'scratch' })
    const key = KEY('T9')
    const pod = podOf(key)
    try {
      await pool.store.upsertSession({
        key,
        agentId: AGENT,
        platform: 'slack',
        channel: 'C1',
        thread: 'T9',
        acpSessionId: null,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now(),
        workspaceIsolation: 'session'
      })
      const sessionId = await pool.store.ensureOutwardSessionId(key, AGENT)
      await pool.driver.ensureBoundChannel(pod)
      const holds = vi.spyOn(pool.plane, 'holdIfBound')
      const deps = buildCpClientDeps(pool.inner.cpClientDepsHost(pool.root, 'wss://cp.example.test', () => {}))

      // Judged on the session pod, which is up: not asleep, and nothing to hold for.
      expect(await deps.sandboxKeepAlive!({ agentId: AGENT, sessionId })).toEqual({
        agentId: AGENT,
        held: false,
        reasons: [],
        placement: 'sandbox'
      })
      expect(holds.mock.calls.map((call) => call[0])).toContain(pod)
      expect(await deps.agentWake!.wake({ agentId: AGENT, sessionId })).toEqual({ agentId: AGENT, state: 'running' })
      expect(agentPodCalls(pool)).toEqual([])
      expect(pool.reached).toEqual([])
    } finally {
      await pool.instance.stop()
    }
  })
})

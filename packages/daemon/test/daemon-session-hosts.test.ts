import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { sandboxSettingsDir } from '../src/acp/sandbox.js'
import { prepareRuntimeLaunch, privateRuntimeHomeFor } from '../src/launch/prepare.js'
import { sessionKey } from '../src/store/local-store.js'
import { pendingTurnKey, sdkLeaseKey } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** git-workspace-model §11: a confined self-hosted session gets its own ACP host; nothing else does, and the tier a session is served on is its own for life. */

const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`
const KEY = (thread: string) => sessionKey('slack', 'C1', thread, 'bot-a', TRANSPORT_SCOPE)

function scaffold(agent: Record<string, unknown> = {}, isolation: 'shared' | 'session' = 'session'): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-session-hosts-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      runInSandbox: true,
      workspace: {
        mode: 'git-repo',
        path: join(adir, 'workspace'),
        gitRepo: 'https://github.com/acme/primary-service.git',
        gitBranch: 'main',
        isolation
      },
      integrations: [],
      output: { mode: 'medium' },
      ...agent
    })
  )
  return root
}

/** A fake adapter that knows which ACP sessions it holds, so resume-after-restart takes the load path. */
function fakeHost(id: number) {
  const live = new Set<string>()
  let minted = 0
  return {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => {
      const sid = `acp-${id}-${++minted}`
      live.add(sid)
      return sid
    }),
    hasSession: vi.fn((sid: string) => live.has(sid)),
    loadSupported: vi.fn(() => true),
    loadSession: vi.fn(async (sid: string) => {
      live.add(sid)
    }),
    prompt: vi.fn(async () => 'end_turn'),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
}

function hostFactory() {
  const hosts: ReturnType<typeof fakeHost>[] = []
  const factory = vi.fn(() => {
    const host = fakeHost(hosts.length + 1)
    hosts.push(host)
    return host as never
  })
  return { hosts, factory }
}

function makeRoutable(daemon: Daemon): void {
  const agent = (daemon as any).agents.get('bot-a')
  agent.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  let post = 0
  ;(daemon as any).connByIntegration.set('int-a', {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async () => `ts-${++post}`),
    updateBlocks: vi.fn(async () => true),
    finalizeResponse: vi.fn(async () => true)
  })
}

function useMicrosandbox(daemon: Daemon, environments: string[] = []) {
  const manager = {
    driverFor: vi.fn(() => ({})),
    prepareEnvironment: vi.fn(async () => {}),
    refreshEnvironment: vi.fn(async () => {}),
    environmentIds: vi.fn(async () => environments),
    suspend: vi.fn(async () => {}),
    suspendUnlessBusy: vi.fn(async () => true),
    suspendIdle: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    collectImages: vi.fn(async () => {})
  }
  ;(daemon as any).cfg.sandbox.backend = 'microsandbox'
  // A probed, prepared microsandbox, whatever this test host could run itself.
  ;(daemon as any).microsandboxFailure = undefined
  ;(daemon as any).microsandbox = manager
  ;(daemon as any).microsandboxCatalog = (daemon as any).runtimeCatalog
  ;(daemon as any).microsandboxTable = { mcpBridge: { command: 'node', args: ['/image/mcp-bridge.js'] } }
  return manager
}

describe.each(['srt', 'microsandbox'])('sandbox.env (%s)', (backend) => {
  it.skipIf(process.platform === 'win32' && backend === 'microsandbox')(
    'applies defaults below runtime and agent env',
    async () => {
      const root = scaffold({ workspace: { mode: 'from-scratch', path: 'workspace' } }, 'shared')
      const path = join(root, 'config.json')
      const config = JSON.parse(readFileSync(path, 'utf8'))
      const defaults = {
        PNPM_CONFIG_STORE_DIR: '${HOME}/.local/share/pnpm/store',
        RUNTIME_VALUE: 'sandbox',
        AGENT_VALUE: 'sandbox',
        HOME: '/ignored-home',
        XDG_DATA_HOME: '/ignored-data',
        KUBECONFIG_DATA: 'apiVersion: v1\nclusters: []\n'
      }
      config.sandbox = { env: defaults }
      config.runtimes.claude.env = [
        { name: 'RUNTIME_VALUE', value: 'runtime' },
        { name: 'AGENT_VALUE', value: 'runtime' }
      ]
      writeFileSync(path, JSON.stringify(config))
      const daemon = new Daemon({
        root,
        slackAppFactory: fakeSlackAppFactory(),
        sandboxMechanism: 'bwrap',
        probeRuntimes: async () => []
      })
      try {
        await daemon.start()
        if (backend === 'microsandbox') useMicrosandbox(daemon)
        const agent = (daemon as any).agents.get('bot-a')
        agent.runtimeOverrides = { env: [{ name: 'AGENT_VALUE', value: 'agent' }] }
        const build = (runInSandbox: boolean) =>
          (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
            hostKey: sessionHostKey(agent.id, KEY('env')),
            strategy: runInSandbox ? backend : 'host',
            cwd: agent.workspace.path
          }).host.opts
        const launch = build(true)
        expect(launch.env).toMatchObject({
          PNPM_CONFIG_STORE_DIR: defaults.PNPM_CONFIG_STORE_DIR,
          RUNTIME_VALUE: 'runtime',
          AGENT_VALUE: 'agent'
        })
        expect(launch.env.HOME).not.toBe(defaults.HOME)
        expect(launch.env.XDG_DATA_HOME).toBe(join(launch.env.HOME, '.local', 'share'))
        expect(launch.env.KUBECONFIG_DATA).toBeUndefined()
        expect(readFileSync(launch.env.KUBECONFIG, 'utf8')).toBe(defaults.KUBECONFIG_DATA)
        expect((daemon as any).cfg.sandbox.env).toEqual(defaults)
        expect(build(false).env.PNPM_CONFIG_STORE_DIR).toBeUndefined()
      } finally {
        await daemon.stop()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

it.skipIf(process.platform === 'win32')(
  'does not reintroduce excluded agent secrets through the VM proxy',
  async () => {
    const root = scaffold({ runtime: 'dsh-acp', workspace: { mode: 'from-scratch', path: 'workspace' } }, 'shared')
    const path = join(root, 'config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.runtimes = { 'dsh-acp': { command: 'node', args: ['unused'] } }
    writeFileSync(path, JSON.stringify(config))
    vi.stubEnv('DSH_HOME', join(root, 'host-dsh'))
    vi.stubEnv('DEEPSEEK_API_KEY', undefined)
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    try {
      await daemon.start()
      const manager = useMicrosandbox(daemon)
      const agent = (daemon as any).agents.get('bot-a')
      agent.runtimeOverrides = { secrets: [{ name: 'DEEPSEEK_API_KEY', value: 'fixture-agent-secret' }] }
      for (const excludeAgentToolCredentials of [false, true]) {
        const host = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
          hostKey: sessionHostKey(agent.id, KEY(String(excludeAgentToolCredentials))),
          strategy: 'microsandbox',
          cwd: agent.workspace.path,
          excludeAgentToolCredentials
        }).host
        const environment = (manager.driverFor.mock.calls.at(-1) as any)[0]
        if (excludeAgentToolCredentials) {
          expect(environment.secrets).toBeUndefined()
          expect(host.opts.env.DEEPSEEK_API_KEY).toBeUndefined()
        } else {
          expect(environment.secrets[0].readValue()).toBe('fixture-agent-secret')
          expect(host.opts.env.DEEPSEEK_API_KEY).toBe(environment.secrets[0].placeholder)
        }
      }
    } finally {
      await daemon.stop()
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'launches a host through the plane that runs it: a VM only when prepared for one, a cluster plane whenever there is one',
  async () => {
    const root = scaffold({ workspace: { mode: 'from-scratch', path: 'workspace' } }, 'shared')
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    try {
      await daemon.start()
      const manager = useMicrosandbox(daemon)
      const agent = (daemon as any).agents.get('bot-a')
      const hostKey = sessionHostKey(agent.id, KEY('plane'))
      const build = (runInSandbox: boolean) =>
        (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
          hostKey,
          strategy: runInSandbox ? 'microsandbox' : 'host',
          cwd: agent.workspace.path
        }).host.opts

      // Prepared for a VM: the manager's driver for this host's own environment, and its key rides along.
      const vm = build(true)
      expect(vm.driver).toBe(manager.driverFor.mock.results.at(-1)!.value)
      expect((manager.driverFor.mock.calls.at(-1) as any)[0]).toMatchObject({
        id: `bot-a/${hostKeyDirName(hostKey)}`,
        workspaceRoot: realpathSync(agent.dir)
      })
      expect(vm.hostKey).toBe(hostKey)

      // An unsandboxed launch beside it names no plane, so AcpHost keeps its LocalDriver on this host.
      const local = build(false)
      expect(local.driver).toBeUndefined()
      expect(local.hostKey).toBeUndefined()

      // A cluster plane answers every host, and its own rule decides whether the driver sees the key.
      const driver = {}
      const spawnFor = vi.fn((launch: { hostKey: string; confined: () => boolean }) => ({
        driver,
        ...(launch.confined() ? { hostKey: launch.hostKey } : {})
      }))
      ;(daemon as any).k8sPlane = { spawnFor, stop: async () => {} }
      const podSubject = vi.spyOn(daemon as any, 'podSubjectFor').mockReturnValue(undefined)
      const sharedPod = build(false)
      expect(sharedPod.driver).toBe(driver)
      expect(sharedPod.hostKey).toBeUndefined()
      podSubject.mockReturnValue(`bot-a/${hostKeyDirName(hostKey)}`)
      expect(build(false).hostKey).toBe(hostKey)
      expect(spawnFor.mock.calls.at(-1)![0]).toMatchObject({ agent, hostKey, cwd: agent.workspace.path })
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  "carries a pool or placed launch's config-file secrets to the runtime's own filesystem, writing none on this disk",
  async () => {
    const root = scaffold({ workspace: { mode: 'from-scratch', path: 'workspace' } })
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    const kubeconfig = 'apiVersion: v1\nclusters: []\n'
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      agent.runtimeOverrides = { secrets: [{ name: 'KUBECONFIG_DATA', value: kubeconfig }] }
      const hostKey = sessionHostKey(agent.id, KEY('files'))
      const build = () =>
        (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
          hostKey,
          strategy: 'host',
          cwd: agent.workspace.path
        })
      const expectCarried = (built: any, dir: string) => {
        const opts = built.host.opts
        expect(opts.env.KUBECONFIG).toBe(`${dir}/kubeconfig`)
        expect(opts.env.KUBECONFIG_DATA).toBeUndefined()
        expect(opts.files).toContainEqual({ root: dir, relPath: ['kubeconfig'], content: kubeconfig })
        expect(opts.clearDirs).toEqual([dir])
        // Nothing of it rests here, so nothing here is left for the idle sweep to track.
        expect(built.configFileState).toBeUndefined()
        expect(existsSync(join(agent.dir, 'run', 'config-files'))).toBe(false)
      }

      // A pod reads them under its image's runtime root.
      ;(daemon as any).k8sPlane = { spawnFor: () => ({ driver: {} }), stop: async () => {} }
      expectCarried(build(), '/run/agentconnect/config-files')
      ;(daemon as any).k8sPlane = undefined

      // A session on another machine reads them under the runtime root its executor reported.
      const placed = {
        agentId: agent.id,
        sessionKey: KEY('files'),
        leaf: 'leaf',
        subject: 'bot-a/leaf',
        executorDaemonId: 'executor-a',
        strategy: 'host'
      }
      ;(daemon as any).executorPlane = {
        placementOf: (key: string) => (key === placed.sessionKey ? placed : undefined),
        homeFor: () => '/srv/executor/sessions/leaf/home',
        rootsFor: () => ({ runtimeRoot: '/srv/executor/hs/0a1b2c', missingHelpers: [] }),
        runtimeDefFor: (_key: string, runtime: unknown) => runtime,
        spawnFor: () => ({ driver: {}, hostKey }),
        stop: async () => {}
      }
      expectCarried(build(), '/srv/executor/hs/0a1b2c/config-files')
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  "starts a placed session's adapter from its executor's own install, and a local one from this machine's",
  async () => {
    const root = scaffold({ workspace: { mode: 'from-scratch', path: 'workspace' } })
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      const placedKey = KEY('placed')
      const build = (key: string) =>
        (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
          hostKey: sessionHostKey(agent.id, key),
          strategy: 'host',
          cwd: agent.workspace.path
        }).host
      const placed = {
        agentId: agent.id,
        sessionKey: placedKey,
        leaf: 'leaf',
        subject: 'bot-a/leaf',
        executorDaemonId: 'executor-a',
        strategy: 'host'
      }
      const installed = { command: '/srv/executor/bin/node', args: ['/srv/executor/runtimes/adapter/dist/index.js'] }
      const runtimeDefFor = vi.fn((_key: string, runtime: Record<string, unknown>) => ({ ...runtime, ...installed }))
      ;(daemon as any).executorPlane = {
        placementOf: (key: string) => (key === placedKey ? placed : undefined),
        homeFor: () => '/srv/executor/sessions/leaf/home',
        rootsFor: () => ({ runtimeRoot: '/srv/executor/hs/0a1b2c', missingHelpers: [] }),
        runtimeDefFor,
        spawnFor: () => ({ driver: {} }),
        stop: async () => {}
      }

      const remote = build(placedKey)
      expect(remote.runtime).toMatchObject(installed)
      expect(runtimeDefFor).toHaveBeenCalledWith(placedKey, expect.objectContaining({ args: ['unused'] }))
      // A session this machine runs keeps this machine's definition.
      const local = build(KEY('local'))
      expect(local.runtime).toMatchObject({ args: ['unused'] })
      expect(runtimeDefFor).toHaveBeenCalledTimes(1)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'starts a placed microsandbox session on a holder that runs no VM, and refuses the same strategy locally',
  async () => {
    const root = scaffold({ workspace: { mode: 'from-scratch', path: 'workspace' }, execution: 'microsandbox' })
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    try {
      await daemon.start()
      // This holder has no KVM: no VM catalog, and its own table offers no microsandbox.
      ;(daemon as any).microsandboxFailure = 'no KVM on this holder'
      ;(daemon as any).microsandboxCatalog = undefined
      const agent = (daemon as any).agents.get('bot-a')
      const placedKey = KEY('placed-vm')
      const build = (key: string) =>
        (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
          hostKey: sessionHostKey(agent.id, key),
          strategy: 'microsandbox',
          cwd: agent.workspace.path
        }).host
      const installed = { command: '/opt/agentconnect/runtime/bin/adapter', args: ['acp'] }
      const runtimeDefFor = vi.fn((_key: string, runtime: Record<string, unknown>) => ({ ...runtime, ...installed }))
      ;(daemon as any).executorPlane = {
        placementOf: (key: string) =>
          key === placedKey
            ? {
                agentId: agent.id,
                sessionKey: placedKey,
                leaf: 'leaf',
                subject: 'bot-a/leaf',
                executorDaemonId: 'executor-a',
                strategy: 'microsandbox'
              }
            : undefined,
        homeFor: () => '/srv/executor/sessions/leaf/home',
        rootsFor: () => ({ runtimeRoot: '/run/agentconnect', missingHelpers: [] }),
        runtimeDefFor,
        spawnFor: () => ({ driver: {} }),
        stop: async () => {}
      }

      // The executor's VM is the boundary, and its image's adapter starts; this holder's missing VM catalog is not consulted.
      expect(build(placedKey).runtime).toMatchObject(installed)
      expect(runtimeDefFor).toHaveBeenCalledWith(placedKey, expect.objectContaining({ args: ['unused'] }))
      expect(() => build(KEY('local-vm'))).toThrow(
        'runs its sessions in the microsandbox strategy, which this daemon cannot run: no KVM on this holder'
      )
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  "reopens a placed Codex session's clones' `.git` where they run, through the whole launch assembly",
  async () => {
    const root = scaffold({ runtime: 'codex-acp', workspace: { mode: 'from-scratch', path: 'workspace' } })
    const path = join(root, 'config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.runtimes = { 'codex-acp': { command: 'node', args: ['unused'] } }
    writeFileSync(path, JSON.stringify(config))
    const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
    try {
      await daemon.start()
      const agent = (daemon as any).agents.get('bot-a')
      const sessionKey = KEY('codex')
      const hostKey = sessionHostKey(agent.id, sessionKey)
      const placed = {
        agentId: agent.id,
        sessionKey,
        leaf: 'leaf',
        subject: 'bot-a/leaf',
        executorDaemonId: 'executor-a',
        strategy: 'host'
      }
      ;(daemon as any).executorPlane = {
        placementOf: (key: string) => (key === sessionKey ? placed : undefined),
        homeFor: () => '/srv/executor/sessions/leaf/home',
        rootsFor: () => ({ runtimeRoot: '/srv/executor/hs/0a1b2c', missingHelpers: [] }),
        runtimeDefFor: (_key: string, runtime: unknown) => runtime,
        spawnFor: () => ({ driver: {}, hostKey }),
        stop: async () => {}
      }
      const gitDir = '/srv/executor/sessions/leaf/workspace/.git'
      const { host } = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
        hostKey,
        strategy: 'host',
        cwd: '/srv/executor/sessions/leaf/workspace',
        sessionGitDirs: [gitDir]
      })
      const profile = JSON.parse(host.opts.env.CODEX_ACP_PERMISSION_PROFILE_CONFIG) as { configOverrides: string[] }
      const table = profile.configOverrides.find((value) => value.includes('protected-workspace.filesystem='))!
      expect(table).toContain(`"${gitDir}" = "write"`)
      expect(table).toContain(`"${gitDir}/hooks" = "read"`)
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

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

async function startDaemon(root: string, opts: { sandboxMechanism?: 'bwrap' | null } = {}) {
  const { hosts, factory } = hostFactory()
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: factory,
    sandboxMechanism: opts.sandboxMechanism === undefined ? 'bwrap' : opts.sandboxMechanism
  })
  await daemon.start()
  makeRoutable(daemon)
  stubWorkspacePreparation(daemon)
  return { daemon, hosts, factory }
}

/** No git here: preparation materializes the directory the request's tier names and nothing else. */
function stubWorkspacePreparation(daemon: Daemon): void {
  const workspaces = (daemon as any).workspaces
  vi.spyOn(workspaces, 'prepareWorkspace').mockImplementation(async (...args: unknown[]) => {
    const agent = args[0] as { workspace: { path: string } }
    mkdirSync(agent.workspace.path, { recursive: true })
    return agent.workspace.path
  })
  vi.spyOn(workspaces, 'prepareSessionWorkspace').mockImplementation(async (...args: unknown[]) => {
    const agent = args[0] as { workspace: { path: string } }
    const request = args[1] as { sessionKey: string; isolation: string; confined?: boolean }
    if (request.isolation !== 'session') return agent.workspace.path
    const cwd = request.confined
      ? join(workspaces.sessionDir(agent, request.sessionKey), 'workspace')
      : join(workspaces.localWorktreesPathFor(agent), workspaces.sessionWorktreeId(request.sessionKey))
    mkdirSync(cwd, { recursive: true })
    return cwd
  })
}

describe('one ACP host per session under a confined self-hosted launch', () => {
  it('keys the host by (agent, session) and launches it in the session directory prepared before the spawn', async () => {
    const { daemon, hosts, factory } = await startDaemon(scaffold())
    const prepare = vi.spyOn(daemon as any, 'runAgentWorkspacePreparation')
    // What preparation had seen by the time each host was constructed — the session request must be there.
    const requestsAtConstruction: unknown[][] = []
    factory.mockImplementation(() => {
      requestsAtConstruction.push(prepare.mock.calls.map((call) => call[1]))
      const host = fakeHost(hosts.length + 1)
      hosts.push(host)
      return host as never
    })

    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')

    const first = sessionHostKey('bot-a', KEY('T1'))
    const second = sessionHostKey('bot-a', KEY('T2'))
    expect(factory).toHaveBeenCalledTimes(2)
    expect([...(daemon as any).hosts.keys()].sort()).toEqual([first, second].sort())
    expect((daemon as any).hosts.get(agentHostKey('bot-a'))).toBeUndefined()
    expect((daemon as any).hosts.get(first)).toBe(hosts[0])
    expect((daemon as any).hosts.get(second)).toBe(hosts[1])
    expect(hosts[0]!.newSession).toHaveBeenCalledTimes(1)
    expect(hosts[1]!.newSession).toHaveBeenCalledTimes(1)
    // Reordered for this shape only: the session workspace is prepared before its host exists.
    expect(requestsAtConstruction[0]!.at(-1)).toMatchObject({ sessionKey: KEY('T1') })
    expect(requestsAtConstruction[1]!.at(-1)).toMatchObject({ sessionKey: KEY('T2') })
    // The runtime session opens exactly where its host launched.
    for (const [index, key] of [first, second].entries()) {
      const launch = (daemon as any).hostLaunch.get(key)
      expect(launch.cwd).toBeTypeOf('string')
      expect((hosts[index]!.newSession.mock.calls[0] as unknown as [string])[0]).toBe(launch.cwd)
    }
    await daemon.stop()
  })

  it('hands a session host the `.git` of its clones where they run, and nothing when they cannot be listed', async () => {
    const { daemon } = await startDaemon(scaffold())
    const build = vi.spyOn(daemon as any, 'buildAcpHost')
    const gitDir = '/srv/executor/sessions/leaf/workspace/.git'
    const listed = vi
      .spyOn((daemon as any).workspaces, 'offDiskSessionGitDirs')
      .mockImplementation(async (_agent: unknown, sessionKey: unknown) => {
        if (sessionKey === KEY('T1')) return [gitDir]
        throw new Error('the shim channel dropped')
      })

    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')

    expect(listed.mock.calls.map((call) => call[1])).toEqual([KEY('T1'), KEY('T2')])
    const optsFor = (thread: string) =>
      build.mock.calls.find((call) => (call[2] as any).hostKey === sessionHostKey('bot-a', KEY(thread)))![2]
    expect(optsFor('T1')).toMatchObject({ sessionGitDirs: [gitDir] })
    // A listing that failed grants nothing rather than failing the start.
    expect(optsFor('T2')).toMatchObject({ sessionGitDirs: [] })
    await daemon.stop()
  })

  it('keeps the self-hosted cold gate for a review host started in the cwd it prepared', async () => {
    const { daemon } = await startDaemon(scaffold())
    const preparation = vi.spyOn(daemon as any, 'runAgentWorkspacePreparation')
    const agent = (daemon as any).agents.get('bot-a')
    const cwd = join((daemon as any).workspaces.sessionDir(agent, KEY('T1')), 'workspace')
    mkdirSync(cwd, { recursive: true })

    await (daemon as any).sessions.deps.hostFor('bot-a', { sessionKey: KEY('T1'), isolation: 'session' }, cwd)

    expect(preparation.mock.calls.map((call) => call[1])).toEqual([undefined])
    expect((daemon as any).hostLaunch.get(sessionHostKey('bot-a', KEY('T1'))).cwd).toBe(cwd)
    await daemon.stop()
  })

  it('keys a session by the isolation ITS row reports, not the agent default it may differ from', async () => {
    // The console's workspace routing, retention and preparation all read that row: a tier chosen from
    // anything else would put the runtime in a directory none of them addresses.
    const { daemon } = await startDaemon(scaffold())
    const agent = (daemon as any).agents.get('bot-a')
    expect((daemon as any).confinedSession(agent, KEY('T1'))).toBe(true)
    expect((daemon as any).hostKeyForRequest('bot-a', { sessionKey: KEY('T1'), isolation: 'shared' })).toBe(
      agentHostKey('bot-a')
    )
    expect((daemon as any).hostKeyForRequest('bot-a', { sessionKey: KEY('T2'), isolation: 'session' })).toBe(
      sessionHostKey('bot-a', KEY('T2'))
    )
    // No pod is involved in a self-hosted launch, and the directory the policy names stays under the agent dir.
    expect((daemon as any).k8sPlane).toBeUndefined()
    expect((daemon as any).workspaces.sessionDir(agent, KEY('T2'))).toBe(
      join(agent.dir, 'sessions', hostKeyDirName(sessionHostKey('bot-a', KEY('T2'))))
    )
    // Not on disk yet ⇒ not confined yet: the disk decides the tier locally, never a policy.
    expect((daemon as any).workspaces.confinedSessionDir(agent, KEY('T2'))).toBeUndefined()
    await daemon.stop()
  })

  // Self-hosted keeps the agent default for a tier nothing has reported: there an over-eager answer costs
  // a directory, not a pod that lives as long as the session's row, and the disk still says what a session
  // already standing somewhere was born in.
  it('takes the agent default for a session nothing has reported yet', async () => {
    const isolated = await startDaemon(scaffold())
    const shared = await startDaemon(scaffold({}, 'shared'))
    expect((isolated.daemon as any).confinedSession((isolated.daemon as any).agents.get('bot-a'), KEY('T9'))).toBe(true)
    expect((isolated.daemon as any).hostKeyFor('bot-a', KEY('T9'))).toBe(sessionHostKey('bot-a', KEY('T9')))
    expect((shared.daemon as any).confinedSession((shared.daemon as any).agents.get('bot-a'), KEY('T9'))).toBe(false)
    expect((shared.daemon as any).hostKeyFor('bot-a', KEY('T9'))).toBe(agentHostKey('bot-a'))
    await isolated.daemon.stop()
    await shared.daemon.stop()
  })

  it('keeps one host per agent when the launch is not confined', async () => {
    const { daemon, hosts, factory } = await startDaemon(scaffold({ runInSandbox: false }))
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    expect(factory).toHaveBeenCalledTimes(1)
    expect([...(daemon as any).hosts.keys()]).toEqual([agentHostKey('bot-a')])
    expect(hosts[0]!.newSession).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  // §11: the confined tier serves `isolation: 'session'`. A sandboxed agent whose sessions are shared gets one host, one private HOME and no session directory — its boundary is the agent's, not each session's.
  it('keeps one host, one private HOME and no session directory when the agent is shared', async () => {
    const root = scaffold({}, 'shared')
    const { daemon, hosts, factory } = await startDaemon(root)
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')

    const agentDir = join(root, 'agents', 'bot-a')
    expect(factory).toHaveBeenCalledTimes(1)
    expect([...(daemon as any).hosts.keys()]).toEqual([agentHostKey('bot-a')])
    expect(hosts[0]!.newSession).toHaveBeenCalledTimes(2)
    // The HOME the launch would give that host is the agent's, and no session owns a directory here.
    expect(privateRuntimeHomeFor(agentDir, agentHostKey('bot-a'))).toBe(join(agentDir, 'home'))
    expect(privateRuntimeHomeFor(agentDir, sessionHostKey('bot-a', KEY('T1')))).toBe(join(agentDir, 'home'))
    expect(existsSync(join(agentDir, 'sessions'))).toBe(false)
    await daemon.stop()
  })

  it('gives new microsandbox sessions separate hosts while keeping their shared workspace', async () => {
    const root = scaffold({}, 'shared')
    const { daemon, hosts, factory } = await startDaemon(root)
    useMicrosandbox(daemon)
    try {
      await (daemon as any).hydrateMicrosandboxSessions()
      await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
      await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
      expect(factory).toHaveBeenCalledTimes(2)
      for (const [index, thread] of ['T1', 'T2'].entries()) {
        const key = sessionHostKey('bot-a', KEY(thread))
        expect((daemon as any).hosts.get(key)).toBe(hosts[index])
        expect((daemon as any).hostLaunch.get(key).cwd).toBe(join(root, 'agents', 'bot-a', 'workspace'))
      }
      await (daemon as any).stopHost('bot-a')
      await (daemon as any).dispatch('bot-a', dm('300', 'resume', 'T1'), 'int-a')
      expect(hosts[2]!.loadSession).toHaveBeenCalled()
      expect(hosts[2]!.newSession).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  it('completes a host stop whose VM still runs another execution, leaving the VM for the idle sweep', async () => {
    const root = scaffold({}, 'shared')
    const { daemon, hosts } = await startDaemon(root)
    const manager = useMicrosandbox(daemon)
    manager.suspendUnlessBusy.mockResolvedValue(false)
    manager.suspend.mockRejectedValue(new Error('microsandbox environment bot-a/agent has 1 active executions'))
    try {
      await (daemon as any).hydrateMicrosandboxSessions()
      await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
      await expect((daemon as any).stopHost('bot-a')).resolves.toBeUndefined()
      expect(hosts[0]!.stop).toHaveBeenCalled()
      expect(manager.suspendUnlessBusy).toHaveBeenCalledOnce()
      expect(manager.suspend).not.toHaveBeenCalled()
      expect((daemon as any).hosts.size).toBe(0)
    } finally {
      await daemon.stop()
    }
  })

  it("drains a session's own VM when its directory is removed, and never the agent's VM (#2246)", async () => {
    const root = scaffold({}, 'shared')
    const { daemon } = await startDaemon(root)
    const manager = Object.assign(useMicrosandbox(daemon), { environment: vi.fn(() => undefined) })
    try {
      const agent = (daemon as any).agents.get('bot-a')
      const leaf = `session-${'a'.repeat(24)}`
      const sessionDir = join(agent.dir, 'sessions', leaf)
      mkdirSync(join(sessionDir, 'workspace'), { recursive: true })
      const fs = (daemon as any).microsandboxWorkspaceFs('bot-a').fs
      await fs.rmTree(sessionDir)
      expect(manager.suspend).toHaveBeenCalledWith(`bot-a/${leaf}`, { drain: true })
      expect(existsSync(sessionDir)).toBe(false)

      manager.suspend.mockClear()
      mkdirSync(agent.workspace.path, { recursive: true })
      await fs.rmTree(agent.workspace.path)
      expect(manager.suspend).toHaveBeenCalledWith('bot-a/agent', { drain: false })
    } finally {
      await daemon.stop()
    }
  })

  it('purges every expired session even when one will not stop, and still retires its pod', async () => {
    // The row is deleted before the pod is, so a throw from stopping the host used to escape the
    // purge, abort the rest of the sweep, and leave a claim alive with this member's launch still
    // cached — a cached launch keeps re-stamping the claim, which reads as "in use" to the orphan
    // sweep forever, the one leak its session-pod half can never collect (k8s-daemon-pool.md §4).
    const root = scaffold({}, 'shared')
    const { daemon } = await startDaemon(root)
    try {
      await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
      await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
      await (daemon as any).stopHost('bot-a')
      const store = (daemon as any).store
      const retired: string[] = []
      ;(daemon as any).stopSessionHost = async (_agentId: string, key: string) => {
        throw new Error(`host of ${key} would not stop`)
      }
      ;(daemon as any).discardSessionSandbox = async (_agentId: string, key: string) => void retired.push(key)
      for (const thread of ['T1', 'T2']) {
        await store.db.prepare('UPDATE sessions SET updatedAt = ? WHERE key = ?').run(1, KEY(thread))
      }
      await (daemon as any).sweepExpiredSessions()
      // Both rows gone — the first session's failure is not the second session's problem …
      expect(await store.getSession(KEY('T1'))).toBeUndefined()
      expect(await store.getSession(KEY('T2'))).toBeUndefined()
      // … and each pod was still retired, which is the half that must never be skipped.
      expect(retired.sort()).toEqual([KEY('T1'), KEY('T2')].sort())
    } finally {
      await daemon.stop()
    }
  })

  it('preserves legacy shared VM sessions through restart and retires that VM only with its last session', async () => {
    const root = scaffold({}, 'shared')
    const { daemon, hosts } = await startDaemon(root)
    try {
      await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
      await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
      await (daemon as any).stopHost('bot-a')
      const environments = ['bot-a/agent']
      const manager = useMicrosandbox(daemon, environments)
      vi.spyOn(daemon as any, 'microsandboxContext').mockReturnValue({
        environment: { id: 'bot-a/agent', mounts: [], workspaceRoot: '/workspace' }
      })
      await (daemon as any).hydrateMicrosandboxSessions()
      await (daemon as any).dispatch('bot-a', dm('300', 'resume', 'T1'), 'int-a')
      expect((daemon as any).hosts.get(agentHostKey('bot-a'))).toBe(hosts[1])
      expect(hosts[1]!.loadSession).toHaveBeenCalled()
      await (daemon as any).dispatch('bot-a', dm('400', 'new', 'T3'), 'int-a')
      const fresh = sessionHostKey('bot-a', KEY('T3'))
      expect((daemon as any).hosts.get(fresh)).toBe(hosts[2])
      environments.push(`bot-a/${hostKeyDirName(fresh)}`)
      await (daemon as any).hydrateMicrosandboxSessions()
      expect((daemon as any).hostKeyFor('bot-a', KEY('T1'))).toBe(agentHostKey('bot-a'))
      expect((daemon as any).hostKeyFor('bot-a', KEY('T3'))).toBe(fresh)

      const store = (daemon as any).store
      const expire = async (thread: string) => {
        await store.db.prepare('UPDATE sessions SET updatedAt = ? WHERE key = ?').run(1, KEY(thread))
        await (daemon as any).sweepExpiredSessions()
        expect(await store.getSession(KEY(thread))).toBeUndefined()
      }
      await expire('T1')
      expect(manager.discard).not.toHaveBeenCalledWith('bot-a/agent')
      await expire('T2')
      expect(manager.discard).toHaveBeenCalledWith('bot-a/agent')
      expect(hosts[2]!.stop).not.toHaveBeenCalled()
      const home = join(root, 'agents', 'bot-a', 'runtime-homes', hostKeyDirName(fresh), 'home')
      mkdirSync(home, { recursive: true })
      manager.discard.mockRejectedValueOnce(new Error('disk is still busy'))
      await store.db.prepare('UPDATE sessions SET updatedAt = ? WHERE key = ?').run(1, KEY('T3'))
      await (daemon as any).sweepExpiredSessions()
      expect(await store.getSession(KEY('T3'))).toBeDefined()
      expect(existsSync(home)).toBe(true)
      await expire('T3')
      expect(manager.discard).toHaveBeenCalledWith(`bot-a/${hostKeyDirName(fresh)}`)
      expect(existsSync(home)).toBe(false)
    } finally {
      await daemon.stop()
    }
  })

  // A session is served in the tier it was BORN in (§11): its clones record that, so losing the
  // boundary cannot leave the host key disagreeing with what preparation already prepared.
  it('keeps a session-bound host for a session born confined, after the agent loses its sandbox', async () => {
    const root = scaffold()
    const { daemon } = await startDaemon(root)
    const agent = (daemon as any).agents.get('bot-a')
    const key = KEY('T1')
    const request = { sessionKey: key, isolation: 'session' as const }
    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(sessionHostKey('bot-a', key))

    mkdirSync(join(root, 'agents', 'bot-a', 'sessions', hostKeyDirName(sessionHostKey('bot-a', key)), 'workspace'), {
      recursive: true
    })
    agent.runInSandbox = false
    agent.workspace.isolation = 'shared'

    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(sessionHostKey('bot-a', key))
    // ...while a session that stands nowhere yet follows the agent's current settings onto the shared host.
    expect((daemon as any).hostKeyFor('bot-a', KEY('T2'))).toBe(agentHostKey('bot-a'))
    await daemon.stop()
  })

  // The other half of the same rule, and the one that was failing in the field: a session born on the
  // worktree tier stays there when its agent later gains isolation or a boundary.
  it('keeps a session born on the worktree tier on the agent host after the agent gains a boundary', async () => {
    const root = scaffold({ runInSandbox: false })
    const { daemon } = await startDaemon(root)
    const agent = (daemon as any).agents.get('bot-a')
    const key = KEY('T1')
    const request = { sessionKey: key, isolation: 'session' as const }
    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(agentHostKey('bot-a'))

    // What its preparation left: a real worktree of the primary, its `.git` link file and all.
    const worktree = join(root, 'agents', 'bot-a', 'worktrees', (daemon as any).workspaces.sessionWorktreeId(key))
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /nowhere\n')
    agent.runInSandbox = true

    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(agentHostKey('bot-a'))
    // An EMPTY stub is not that record: it is what a degraded preparation leaves, and a session whose
    // stub was all that stood between it and a tier is free to take the one it would get now.
    rmSync(join(worktree, '.git'))
    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(sessionHostKey('bot-a', key))
    await daemon.stop()
  })

  // The tier follows THIS session's isolation, not the agent's default: a formal review forces `session`
  // on a shared agent, and that session must still get its own host, clones and HOME.
  it('gives a session forced to session isolation its own host on a shared agent', async () => {
    const { daemon } = await startDaemon(scaffold({}, 'shared'))
    const agent = (daemon as any).agents.get('bot-a')
    const key = KEY('T1')
    expect((daemon as any).hostKeyFor('bot-a', key)).toBe(agentHostKey('bot-a'))

    const request = { sessionKey: key, isolation: 'session' as const }
    const prepare = vi.spyOn((daemon as any).workspaces, 'prepareSessionWorkspace')

    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(sessionHostKey('bot-a', key))
    await (daemon as any).runAgentWorkspacePreparation(agent, request)

    // Preparation was told the same thing the host key was, and every later read of the key agrees.
    expect(prepare.mock.calls[0]![1]).toMatchObject({ sessionKey: key, confined: true })
    expect((daemon as any).hostKeyFor('bot-a', key)).toBe(sessionHostKey('bot-a', key))
    await daemon.stop()
  })

  it('keeps a session forced to shared isolation on the agent host, whatever the agent defaults to', async () => {
    const { daemon } = await startDaemon(scaffold())
    const agent = (daemon as any).agents.get('bot-a')
    const key = KEY('T1')
    const request = { sessionKey: key, isolation: 'shared' as const }
    const prepare = vi.spyOn((daemon as any).workspaces, 'prepareSessionWorkspace')

    expect((daemon as any).hostKeyForRequest('bot-a', request)).toBe(agentHostKey('bot-a'))
    await (daemon as any).runAgentWorkspacePreparation(agent, request)

    expect(prepare.mock.calls[0]![1]).toEqual(request)
    expect((daemon as any).hostKeyFor('bot-a', key)).toBe(agentHostKey('bot-a'))
    await daemon.stop()
  })

  it('keeps a sandboxed agent sandboxed on a host with no mechanism: its sessions are refused, never folded onto an unconfined host', async () => {
    const { daemon } = await startDaemon(scaffold(), { sandboxMechanism: null })
    const agent = (daemon as any).agents.get('bot-a')
    // No downgrade (session-executors.md §5): the agent still asks for srt, and the launch refuses it with the probe's reason.
    expect((daemon as any).agentStrategy(agent)).toBe('srt')
    expect((daemon as any).agentRunsInSandbox(agent)).toBe(true)
    expect((daemon as any).strategyRefusal('srt')).toBe('this host has no supported SRT mechanism')
    expect(() => (daemon as any).assertStrategyRunnable(agent)).toThrow('which this daemon cannot run')
    await daemon.stop()
  })

  it('stops every host of the agent on stopHost and on a spawn-signature eviction', async () => {
    const root = scaffold()
    const { daemon, hosts, factory } = await startDaemon(root)
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    expect((daemon as any).hosts.size).toBe(2)

    await (daemon as any).stopHost('bot-a')
    expect(hosts[0]!.stop).toHaveBeenCalledTimes(1)
    expect(hosts[1]!.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.size).toBe(0)
    expect((daemon as any).hostLaunch.size).toBe(0)

    await (daemon as any).dispatch('bot-a', dm('300', 'three', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('400', 'four', 'T2'), 'int-a')
    expect(factory).toHaveBeenCalledTimes(4)
    expect((daemon as any).hosts.size).toBe(2)
    // The reconciler's hostSpawnSig eviction (description is in the signature) reaches every host too.
    const path = join(root, 'agents', 'bot-a', 'agent.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), description: 'respawn me' }))
    await daemon.reconcile()
    expect(hosts[2]!.stop).toHaveBeenCalledTimes(1)
    expect(hosts[3]!.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.size).toBe(0)
    await daemon.stop()
  })

  it('gives each host its own sandbox policy directory and removes it with the host', async () => {
    const root = scaffold()
    const { daemon } = await startDaemon(root)
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    const agentDir = join(root, 'agents', 'bot-a')
    const first = sessionHostKey('bot-a', KEY('T1'))
    const second = sessionHostKey('bot-a', KEY('T2'))
    expect(hostKeyDirName(first)).not.toBe(hostKeyDirName(second))
    // The injected host factory writes no policy; stand in for what a real launch leaves behind.
    for (const key of [first, second]) {
      mkdirSync(sandboxSettingsDir(agentDir, hostKeyDirName(key)), { recursive: true })
      writeFileSync(join(sandboxSettingsDir(agentDir, hostKeyDirName(key)), 'settings.json'), '{}')
    }
    await (daemon as any).stopHostByKey(first)
    expect(existsSync(sandboxSettingsDir(agentDir, hostKeyDirName(first)))).toBe(false)
    expect(existsSync(join(sandboxSettingsDir(agentDir, hostKeyDirName(second)), 'settings.json'))).toBe(true)
    expect((daemon as any).hosts.has(second)).toBe(true)
    await daemon.stop()
    expect(existsSync(sandboxSettingsDir(agentDir, hostKeyDirName(second)))).toBe(false)
  })

  it('launch preparation writes two concurrent session hosts two policies, each anchored on its own session cwd and HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-session-hosts-launch-'))
    const scopeDir = join(root, 'agent')
    const hostHome = join(root, 'host-home')
    mkdirSync(hostHome)
    const launches = ['s1', 's2'].map((session) => {
      const key = sessionHostKey('bot-a', `slack:C1:${session}:bot-a`)
      const sessionDir = join(scopeDir, 'sessions', hostKeyDirName(key))
      const cwd = join(sessionDir, 'workspace')
      mkdirSync(cwd, { recursive: true })
      const launch = prepareRuntimeLaunch({
        runtimeId: 'claude',
        runtime: { command: 'npx', args: ['claude-agent-acp'], env: [] },
        scopeDir,
        cwd,
        hostKey: key,
        runInSandbox: true,
        daemonRoot: dirname(scopeDir),
        sandboxMechanism: 'bwrap',
        credentialPlatform: 'linux',
        explicitEnv: {},
        hostEnv: { HOME: hostHome, PATH: '/usr/bin' }
      })
      return { key, cwd: realpathSync(cwd), home: join(realpathSync(sessionDir), 'home'), launch }
    })
    const [one, two] = launches as [(typeof launches)[number], (typeof launches)[number]]
    expect(one.launch.sandbox!.settingsPath).not.toBe(two.launch.sandbox!.settingsPath)
    expect(one.launch.env.HOME).not.toBe(two.launch.env.HOME)
    for (const { key, cwd, home, launch } of launches) {
      const sandbox = launch.sandbox!
      expect(sandbox.settingsPath).toBe(
        join(realpathSync(sandboxSettingsDir(scopeDir, hostKeyDirName(key))), 'settings.json')
      )
      expect(existsSync(sandbox.settingsPath)).toBe(true)
      // The outer provider needs the launch cwd as a write root and Git safe directory: derived from cwd.
      expect(sandbox.cwd).toBe(cwd)
      expect(sandbox.writable).toContain(cwd)
      const policy = JSON.parse(readFileSync(sandbox.settingsPath, 'utf8'))
      expect(policy.filesystem.allowWrite).toContain(cwd)
      expect(policy.git.safeDirectories).toContain(cwd)
      // ...and its HOME under the same leaf (§11), an exact write root as the provider requires of HOME.
      expect(launch.env.HOME).toBe(home)
      expect(sandbox.writable).toContain(home)
      expect(policy.filesystem.allowWrite).toContain(home)
    }
    // Neither write clobbered the other: both files still stand once both launches are prepared.
    expect(existsSync(one.launch.sandbox!.settingsPath)).toBe(true)
    expect(existsSync(two.launch.sandbox!.settingsPath)).toBe(true)
  })

  // git-workspace-model §11: the same predicate that gives the session its own host gives it its own clones.
  it('asks the session workspace for its own clone directory only under a confined launch', async () => {
    const confined = await startDaemon(scaffold())
    const confinedPrepare = vi.spyOn((confined.daemon as any).workspaces, 'prepareSessionWorkspace')
    await (confined.daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    expect(confinedPrepare).toHaveBeenCalled()
    expect(confinedPrepare.mock.calls.at(-1)![1]).toMatchObject({ sessionKey: KEY('T1'), confined: true })
    await confined.daemon.stop()

    // Without a boundary the same isolated session goes to the funnel unchanged: no `confined` is added.
    const open = await startDaemon(scaffold({ runInSandbox: false }))
    const openPrepare = vi.spyOn((open.daemon as any).workspaces, 'prepareSessionWorkspace')
    const request = { sessionKey: KEY('T1'), isolation: 'session' as const }
    await (open.daemon as any).runAgentWorkspacePreparation((open.daemon as any).agents.get('bot-a'), request)
    expect(openPrepare).toHaveBeenCalledTimes(1)
    expect(openPrepare.mock.calls[0]![1]).toEqual(request)
    await open.daemon.stop()
  })

  // A canonical rename keeps warm hosts only where the clone followed: the session whose clone kept its old origin loses its host, the others keep theirs.
  it('evicts only the session hosts whose clone would not follow a canonical rename', async () => {
    const { daemon, hosts } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    const first = sessionHostKey('bot-a', KEY('T1'))
    const second = sessionHostKey('bot-a', KEY('T2'))
    const agent = (daemon as any).agents.get('bot-a')
    const converge = vi
      .spyOn((daemon as any).workspaces, 'convergeGithubAppWorkspaceRename')
      .mockResolvedValue({ unconvergedSessions: [hostKeyDirName(first)] })

    expect(await (daemon as any).convergeWorkspaceRename(agent)).toBe(true)

    expect(converge).toHaveBeenCalledTimes(1)
    expect(hosts[0]!.stop).toHaveBeenCalledTimes(1)
    expect(hosts[1]!.stop).not.toHaveBeenCalled()
    expect([...(daemon as any).hosts.keys()]).toEqual([second])
    // A primary that will not follow means the ordinary cold workspace path for the whole agent.
    converge.mockRejectedValue(new Error('config locked'))
    expect(await (daemon as any).convergeWorkspaceRename(agent)).toBe(false)
    expect(hosts[1]!.stop).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('gives a resumed session its own host again after a daemon restart', async () => {
    const root = scaffold()
    const first = await startDaemon(root)
    await (first.daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const persisted = first.hosts[0]!.newSession.mock.results[0]!.value as Promise<string>
    await first.daemon.stop()

    const second = await startDaemon(root)
    await (second.daemon as any).dispatch('bot-a', dm('200', 'again', 'T1'), 'int-a')
    const key = sessionHostKey('bot-a', KEY('T1'))
    expect(second.factory).toHaveBeenCalledTimes(1)
    expect([...(second.daemon as any).hosts.keys()]).toEqual([key])
    expect(second.hosts[0]!.newSession).not.toHaveBeenCalled()
    expect(second.hosts[0]!.loadSession).toHaveBeenCalledTimes(1)
    const [sid, cwd] = second.hosts[0]!.loadSession.mock.calls[0]! as unknown as [string, string]
    expect(sid).toBe(await persisted)
    expect(cwd).toBe((second.daemon as any).hostLaunch.get(key).cwd)
    await second.daemon.stop()
  })

  it('files turns, updates and cancellation under the owning host when two session hosts mint the same ACP id', async () => {
    const root = scaffold()
    const updates: ((sid: string, update: unknown) => void)[] = []
    const releases: (() => void)[] = []
    const hosts: { cancel: ReturnType<typeof vi.fn> }[] = []
    const factory = vi.fn((_agent: unknown, onUpdate: (sid: string, update: unknown) => void) => {
      updates.push(onUpdate)
      let release!: () => void
      const blocked = new Promise<void>((resolve) => (release = resolve))
      releases.push(release)
      const host = {
        start: vi.fn(async () => {}),
        // Runtime-local ids: every child of this agent answers `acp-1`.
        newSession: vi.fn(async () => 'acp-1'),
        hasSession: vi.fn((sid: string) => sid === 'acp-1'),
        prompt: vi.fn(async () => {
          await blocked
          return { stopReason: 'end_turn' }
        }),
        cancel: vi.fn(async () => {}),
        stop: vi.fn(async () => {})
      }
      hosts.push(host)
      return host as never
    })
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: factory as never,
      sandboxMechanism: 'bwrap'
    })
    await daemon.start()
    makeRoutable(daemon)
    stubWorkspacePreparation(daemon)
    const one = (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const two = (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    await vi.waitFor(() => expect((daemon as any).pending.size).toBe(2), WAIT)
    const first = sessionHostKey('bot-a', KEY('T1'))
    const second = sessionHostKey('bot-a', KEY('T2'))
    expect((daemon as any).pending.get(pendingTurnKey(first, 'acp-1')).plan.sessionKey).toBe(KEY('T1'))
    expect((daemon as any).pending.get(pendingTurnKey(second, 'acp-1')).plan.sessionKey).toBe(KEY('T2'))
    // An update from a child lands on that child's session, never on the sibling that shares the id.
    await updates[1]!('acp-1', { sessionUpdate: 'session_info_update', title: 'second' })
    await updates[0]!('acp-1', { sessionUpdate: 'session_info_update', title: 'first' })
    expect((await (daemon as any).store.getSession(KEY('T1')))?.title).toBe('first')
    expect((await (daemon as any).store.getSession(KEY('T2')))?.title).toBe('second')
    // Cancelling the second session reaches its own child.
    await (daemon as any).interruptTurn('bot-a', KEY('T2'), 'stop', undefined, {})
    expect(hosts[1]!.cancel).toHaveBeenCalledWith('acp-1')
    expect(hosts[0]!.cancel).not.toHaveBeenCalled()
    for (const release of releases) release()
    await Promise.all([one, two])
    await daemon.stop()
  })

  it('a stale idle-close decision does not evict the host a reopened session was admitted on', async () => {
    const { daemon, hosts } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const key = sessionHostKey('bot-a', KEY('T1'))
    expect((daemon as any).hosts.get(key)).toBe(hosts[0])
    const store = (daemon as any).store
    // The sweep decides against the first host; before its stop runs, the key is reopened on a replacement.
    const closeIdle = vi.spyOn(store, 'closeIdleSessions').mockImplementation(async () => {
      await (daemon as any).stopHostByKey(key)
      await (daemon as any).dispatch('bot-a', dm('200', 'again', 'T1'), 'int-a')
      return [{ key: KEY('T1'), agentId: 'bot-a', platform: 'slack', channel: 'C1', thread: 'T1', acpSessionId: null }]
    })
    await (daemon as any).sweepIdle()
    await new Promise((resolve) => setTimeout(resolve, 50))
    closeIdle.mockRestore()
    expect(hosts).toHaveLength(2)
    expect(hosts[0]!.stop).toHaveBeenCalledTimes(1)
    expect(hosts[1]!.stop).not.toHaveBeenCalled()
    expect((daemon as any).hosts.get(key)).toBe(hosts[1])
    await daemon.stop()
  })

  it('closeIdleSessions reports only the rows it closed, not a candidate a turn reopened meanwhile', async () => {
    const { daemon } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const store = (daemon as any).store
    expect((await store.getSession(KEY('T1')))?.state).toBe('idle')
    const closed = await store.closeIdleSessions(
      Date.now() + 60_000,
      1,
      async (_agentId: string, _acp: unknown, key: string) => {
        await store.setSessionState(key, 'prompting', Date.now())
        return false
      }
    )
    expect(closed).toEqual([])
    expect((await store.getSession(KEY('T1')))?.state).toBe('prompting')
    await daemon.stop()
  })

  it('reaping the shared utility host leaves a sibling session host its lease and binding', async () => {
    const { daemon, hosts } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).ensureHostAsync(agentHostKey('bot-a'))
    const sessionHost = sessionHostKey('bot-a', KEY('T1'))
    const sid = (await hosts[0]!.newSession.mock.results[0]!.value) as string
    const lease = {
      agentId: 'bot-a',
      tasks: new Map(),
      settled: [],
      sdkState: 'idle',
      bgWakes: 0,
      armedWakes: 0,
      deliveringWakes: 0,
      drainText: '',
      drainDeliveries: 0
    }
    ;(daemon as any).sdkLease.set(sdkLeaseKey(sessionHost, sid), lease)
    ;(daemon as any).sessionDeliveryBindings.set(KEY('T1'), { agentId: 'bot-a', platform: 'slack', isDm: true })

    await (daemon as any).stopHostByKey(agentHostKey('bot-a'))
    expect(hosts[1]!.stop).toHaveBeenCalledTimes(1)
    expect(hosts[0]!.stop).not.toHaveBeenCalled()
    expect((daemon as any).sdkLease.has(sdkLeaseKey(sessionHost, sid))).toBe(true)
    expect((daemon as any).sessionDeliveryBindings.has(KEY('T1'))).toBe(true)

    // The agent-wide teardown is where every session's state goes.
    await (daemon as any).stopHost('bot-a')
    expect(hosts[0]!.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).sdkLease.size).toBe(0)
    expect((daemon as any).sessionDeliveryBindings.has(KEY('T1'))).toBe(false)
    await daemon.stop()
  })

  // The shared host's clock follows where each session runs, not what isolation it records: a worktree session runs there, a confined one never does.
  it('keeps the shared host for a worktree session it serves, and not for a confined session with a host of its own', async () => {
    const root = scaffold()
    const { daemon } = await startDaemon(root)
    const inner = daemon as any
    const ttl = inner.cfg.limits.agentIdleTimeoutMs
    const confined = KEY('T1')
    const worktree = KEY('T2')
    // What a worktree session's preparation left, so it was born on that tier and stays on the agent host.
    const tree = join(root, 'agents', 'bot-a', 'worktrees', inner.workspaces.sessionWorktreeId(worktree))
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, '.git'), 'gitdir: /nowhere\n')
    for (const key of [confined, worktree]) inner.sessionIsolation.set(key, 'session')
    expect(inner.hostKeyFor('bot-a', confined)).toBe(sessionHostKey('bot-a', confined))
    expect(inner.hostKeyFor('bot-a', worktree)).toBe(agentHostKey('bot-a'))
    const row = (key: string) =>
      inner.store.upsertSession({
        key,
        agentId: 'bot-a',
        platform: 'slack',
        channel: 'C1',
        thread: key,
        acpSessionId: null,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now(),
        workspaceIsolation: 'session'
      })
    const host = { stop: vi.fn(async () => {}) }
    /** One idle sweep over a shared host started two windows ago: whether it reaped the host. */
    const reaps = async (): Promise<boolean> => {
      inner.hosts.set(agentHostKey('bot-a'), host)
      inner.hostStartedAt.set(agentHostKey('bot-a'), Date.now() - 2 * ttl)
      host.stop.mockClear()
      await inner.sweepIdle()
      await new Promise((resolve) => setTimeout(resolve, 20))
      return host.stop.mock.calls.length > 0
    }
    await row(confined)
    expect(await reaps()).toBe(true)
    await row(worktree)
    expect(await reaps()).toBe(false)
    await daemon.stop()
  })

  it('an internal pass resolves an ACP id only to its own row: a dream to its execution row, a memory pass to none', async () => {
    const { daemon } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const store = (daemon as any).store
    const sid = (await store.getSession(KEY('T1'))).acpSessionId as string
    // A dream executing beside the chat session mints the same runtime-local id.
    const dreamKey = sessionKey('dream', 'memory', 'd1', 'bot-a')
    await store.upsertSession({
      key: dreamKey,
      agentId: 'bot-a',
      platform: 'dream',
      channel: 'memory',
      thread: 'd1',
      acpSessionId: sid,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const dreamOwner = (daemon as any).dreamOwnerKey('bot-a', 'd1')
    expect((await (daemon as any).sessionForAcp(dreamOwner, sid))?.key).toBe(dreamKey)
    expect((await (daemon as any).sessionForAcp(sessionHostKey('bot-a', KEY('T1')), sid))?.key).toBe(KEY('T1'))
    // A memory pass has no row of its own and must never borrow a sibling's.
    expect(await (daemon as any).sessionForAcp(sessionHostKey('bot-a', 'internal:memory:bot-a'), sid)).toBeUndefined()
    await daemon.stop()
  })

  it('the capture gate is filed under the logical session, so a public sibling sharing an ACP id cannot open a private one', async () => {
    const { daemon } = await startDaemon(scaffold())
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    const store = (daemon as any).store
    // Two session hosts can mint one runtime-local id; force the rows onto it.
    const sid = (await store.getSession(KEY('T1'))).acpSessionId as string
    await store.db.prepare('UPDATE sessions SET acpSessionId = ? WHERE key = ?').run(sid, KEY('T2'))
    expect(await store.isCaptureExcluded('bot-a', KEY('T1'))).toBe(true)
    expect(await store.isCaptureExcluded('bot-a', KEY('T2'))).toBe(true)
    // The CP opens the SECOND session, naming it outwardly: the first stays private.
    const outward = await store.ensureOutwardSessionId(KEY('T2'), 'bot-a')
    const apply = (daemon as any).cpConfigApply()
    expect(
      await apply.applySessionVisibility({ sessionId: outward, agentId: 'bot-a', visibility: 'org', visibilityRev: 1 })
    ).toBe('applied')
    expect(await store.isCaptureExcluded('bot-a', KEY('T2'))).toBe(false)
    expect(await store.isCaptureExcluded('bot-a', KEY('T1'))).toBe(true)
    await daemon.stop()
  })

  it('a turn admitted while the stop probe awaits the store keeps its host', async () => {
    const root = scaffold()
    const hosts: ReturnType<typeof fakeHost>[] = []
    let releaseSecondPrompt!: () => void
    const secondPrompt = new Promise<void>((resolve) => (releaseSecondPrompt = resolve))
    const factory = vi.fn(() => {
      const host = fakeHost(hosts.length + 1)
      let prompts = 0
      host.prompt.mockImplementation(async () => {
        if (++prompts === 2) await secondPrompt
        return 'end_turn'
      })
      hosts.push(host)
      return host as never
    })
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root,
      hostFactory: factory,
      sandboxMechanism: 'bwrap'
    })
    await daemon.start()
    makeRoutable(daemon)
    stubWorkspacePreparation(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    const key = sessionHostKey('bot-a', KEY('T1'))
    const store = (daemon as any).store
    const row = { key: KEY('T1'), agentId: 'bot-a', acpSessionId: (await store.getSession(KEY('T1'))).acpSessionId }
    const fence = { ...(daemon as any).sessionHostFence('bot-a', KEY('T1')), row }
    let turn: Promise<unknown> | undefined
    // A direct message claims the key on the same warm host while the probe's store query is out.
    const probe = vi.spyOn(store, 'sessionHasPendingInboxRows').mockImplementation(async () => {
      if (!turn) {
        turn = (daemon as any).dispatch('bot-a', dm('200', 'again', 'T1'), 'int-a')
        await vi.waitFor(() => expect((daemon as any).inflight.has(KEY('T1'))).toBe(true), WAIT)
      }
      return false
    })
    await (daemon as any).stopSessionHost('bot-a', KEY('T1'), fence)
    probe.mockRestore()
    releaseSecondPrompt()
    await turn
    expect(hosts[0]!.stop).not.toHaveBeenCalled()
    expect((daemon as any).hosts.get(key)).toBe(hosts[0])
    expect(hosts[0]!.prompt).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })
})

/** Merge runtime definitions into the scaffold's config. */
function withRuntimes(root: string, runtimes: Record<string, Record<string, unknown>>): string {
  const path = join(root, 'config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...config, runtimes: { ...config.runtimes, ...runtimes } }))
  return root
}

/** The AgentConnect bridge token a `session/new` handed the runtime. */
function bridgeToken(call: unknown[]): string {
  const servers = call[1] as { name: string; env: { name: string; value: string }[] }[]
  const bridge = servers.find((server) => server.name === 'agentconnect')!
  return bridge.env.find((entry) => entry.name === 'AC_MCP_TOKEN')!.value
}

// OpenCode keeps session mcpServers per working directory by name, so on a shared host every session's tool calls would carry the token of whichever session registered last.
describe('one ACP host per session for a runtime whose session MCP servers are per-process', () => {
  it.each(['opencode', 'kilo'])(
    'resumes legacy %s sessions on separate hosts without moving their VM or HOME',
    async (runtime) => {
      const root = withRuntimes(
        scaffold({ runtime, workspace: { mode: 'from-scratch', path: 'workspace', isolation: 'shared' } }, 'shared'),
        { [runtime]: { command: 'node', args: ['unused'], sessionMcpServers: 'per-session' } }
      )
      const { daemon, hosts } = await startDaemon(root)
      const agent = (daemon as any).agents.get('bot-a')
      mkdirSync(agent.workspace.path, { recursive: true })
      try {
        // Seed the pre-upgrade shared-host topology before restoring the runtime's audited scope.
        await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
        await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
        expect(hosts[0]!.newSession).toHaveBeenCalledTimes(2)
        await (daemon as any).stopHost('bot-a')
        delete (daemon as any).runtimes[runtime].sessionMcpServers
        const manager = useMicrosandbox(daemon, ['bot-a/agent'])
        await (daemon as any).hydrateMicrosandboxSessions()

        const tokens: string[] = []
        for (const [index, thread] of ['T1', 'T2'].entries()) {
          await (daemon as any).dispatch('bot-a', dm(String(300 + index), 'resume', thread), 'int-a')
          const key = sessionHostKey('bot-a', KEY(thread))
          const host = hosts[index + 1]!
          expect((daemon as any).hosts.get(key)).toBe(host)
          expect(host.loadSession).toHaveBeenCalledOnce()
          expect(host.newSession).not.toHaveBeenCalled()
          expect((daemon as any).microsandboxPlacement(agent, agent.workspace.path, key)).toEqual({
            id: 'bot-a/agent',
            homeKey: agentHostKey('bot-a')
          })
          const token = bridgeToken((host.loadSession.mock.calls[0] as unknown[]).slice(1))
          tokens.push(token)
          expect((daemon as any).mcp.sessions.get(token)).toMatchObject({ agentId: 'bot-a', thread })
        }
        expect(new Set(tokens).size).toBe(2)
        expect((daemon as any).hosts.get(agentHostKey('bot-a'))).toBeUndefined()
        await (daemon as any).hydrateMicrosandboxSessions()
        expect((daemon as any).hostKeyFor('bot-a', KEY('T1'))).toBe(sessionHostKey('bot-a', KEY('T1')))

        const expire = async (thread: string) => {
          await (daemon as any).store.db.prepare('UPDATE sessions SET updatedAt = ? WHERE key = ?').run(1, KEY(thread))
          await (daemon as any).sweepExpiredSessions()
          expect(await (daemon as any).store.getSession(KEY(thread))).toBeUndefined()
        }
        await expire('T1')
        expect(hosts[1]!.stop).toHaveBeenCalledOnce()
        expect(hosts[2]!.stop).not.toHaveBeenCalled()
        expect(manager.discard).not.toHaveBeenCalled()
        await expire('T2')
        expect(hosts[2]!.stop).toHaveBeenCalledOnce()
        expect(manager.discard).toHaveBeenCalledExactlyOnceWith('bot-a/agent')
      } finally {
        await daemon.stop()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  // VM mount preparation needs POSIX guest paths, and the helper alias targets a host path.
  it.skipIf(process.platform === 'win32')(
    'carries the legacy HOME through real launch assembly while keeping new sessions on their own HOME',
    async () => {
      const runtime = 'test-acp'
      const root = withRuntimes(
        scaffold({ runtime, workspace: { mode: 'from-scratch', path: 'workspace', isolation: 'shared' } }, 'shared'),
        { [runtime]: { command: 'node', args: ['unused'], sessionMcpServers: 'per-process' } }
      )
      const daemon = new Daemon({ root, sandboxMechanism: 'bwrap', probeRuntimes: async () => [] })
      try {
        await daemon.start()
        const manager = useMicrosandbox(daemon)
        const agent = (daemon as any).agents.get('bot-a')
        const agentHome = join(realpathSync(agent.dir), 'home')
        mkdirSync(agentHome, { recursive: true })
        writeFileSync(join(agentHome, 'session-history'), 'preserved')
        const sharedEnvironment = (daemon as any).microsandboxContext(agent, agent.workspace.path).environment
        for (const thread of ['T1', 'T2', 'new']) {
          const hostKey = sessionHostKey('bot-a', KEY(thread))
          if (thread !== 'new') (daemon as any).legacyMicrosandboxSessions.add(hostKey)
          const cwd = thread === 'new' ? agent.workspace.path : join(agent.workspace.path, thread)
          mkdirSync(cwd, { recursive: true })
          const host = (daemon as any).buildAcpHost(agent, (daemon as any).cfg, {
            hostKey,
            strategy: 'microsandbox',
            cwd
          }).host
          expect(host.opts.hostKey).toBe(hostKey)
          const home =
            thread === 'new'
              ? join(realpathSync(agent.dir), 'runtime-homes', hostKeyDirName(hostKey), 'home')
              : agentHome
          expect(host.opts.env.HOME).toBe(home)
          expect(manager.driverFor).toHaveBeenLastCalledWith(
            expect.objectContaining({
              id: thread === 'new' ? `bot-a/${hostKeyDirName(hostKey)}` : 'bot-a/agent',
              mounts: expect.arrayContaining([{ source: home, target: home, mode: 'writable' }])
            })
          )
          if (thread !== 'new') {
            expect(manager.driverFor).toHaveBeenLastCalledWith(sharedEnvironment)
            expect((daemon as any).microsandboxContext(agent, cwd, hostKey).environment).toEqual(sharedEnvironment)
          }
        }
        expect(readFileSync(join(agentHome, 'session-history'), 'utf8')).toBe('preserved')
      } finally {
        await daemon.stop()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('gives each session its own host in the shared workspace, holding only that session’s bridge token', async () => {
    const opencode = { command: 'node', args: ['unused'] }
    const root = withRuntimes(scaffold({ runtime: 'opencode', runInSandbox: false }, 'shared'), { opencode })
    const { daemon, hosts, factory } = await startDaemon(root)
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')

    expect(factory).toHaveBeenCalledTimes(2)
    expect((daemon as any).hosts.get(agentHostKey('bot-a'))).toBeUndefined()
    for (const [index, thread] of ['T1', 'T2'].entries()) {
      const key = sessionHostKey('bot-a', KEY(thread))
      expect((daemon as any).hosts.get(key)).toBe(hosts[index])
      expect((daemon as any).hostLaunch.get(key).cwd).toBe(join(root, 'agents', 'bot-a', 'workspace'))
      expect(hosts[index]!.newSession).toHaveBeenCalledTimes(1)
      const token = bridgeToken(hosts[index]!.newSession.mock.calls[0] as unknown[])
      expect((daemon as any).mcp.sessions.get(token)).toMatchObject({ agentId: 'bot-a', channel: 'C1', thread })
    }

    // A reaped session resumes its runtime session on a host of its own again.
    await (daemon as any).stopHost('bot-a')
    await (daemon as any).dispatch('bot-a', dm('300', 'resume', 'T1'), 'int-a')
    expect((daemon as any).hosts.get(sessionHostKey('bot-a', KEY('T1')))).toBe(hosts[2])
    expect(hosts[2]!.loadSession).toHaveBeenCalled()
    expect(hosts[2]!.newSession).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('follows what a RuntimeDef declares over the audited scope of its id', async () => {
    const opencode = { command: 'node', args: ['unused'], sessionMcpServers: 'per-session' }
    const root = withRuntimes(scaffold({ runtime: 'opencode', runInSandbox: false }, 'shared'), { opencode })
    const { daemon } = await startDaemon(root)
    expect((daemon as any).hostKeyFor('bot-a', KEY('T1'))).toBe(agentHostKey('bot-a'))
    // Undeclared, the audited scope of the id applies.
    delete (daemon as any).runtimes.opencode.sessionMcpServers
    expect((daemon as any).hostKeyFor('bot-a', KEY('T1'))).toBe(sessionHostKey('bot-a', KEY('T1')))
    // Internal passes keep the agent's host: only a session key names a session-bound one.
    expect((daemon as any).hostKeyFor('bot-a')).toBe(agentHostKey('bot-a'))
    await daemon.stop()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { agentHostKey, hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { sandboxSettingsDir } from '../src/acp/sandbox.js'
import { prepareRuntimeLaunch } from '../src/launch/prepare.js'
import { sessionKey } from '../src/store/local-store.js'
import { pendingTurnKey, sdkLeaseKey } from '../src/daemon/turn-types.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

/** git-workspace-model §11: a confined self-hosted session gets its own ACP host; nothing else does. */

const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`
const KEY = (thread: string) => sessionKey('slack', 'C1', thread, 'bot-a', TRANSPORT_SCOPE)

function scaffold(agent: Record<string, unknown> = {}): string {
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
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
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
  return { daemon, hosts, factory }
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

  it('keeps one host per agent when the launch is not confined', async () => {
    const { daemon, hosts, factory } = await startDaemon(scaffold({ runInSandbox: false }))
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    expect(factory).toHaveBeenCalledTimes(1)
    expect([...(daemon as any).hosts.keys()]).toEqual([agentHostKey('bot-a')])
    expect(hosts[0]!.newSession).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  it('keeps one host per agent when the sandbox is requested but this host has no mechanism', async () => {
    const { daemon, hosts, factory } = await startDaemon(scaffold(), { sandboxMechanism: null })
    await (daemon as any).dispatch('bot-a', dm('100', 'one', 'T1'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'two', 'T2'), 'int-a')
    expect(factory).toHaveBeenCalledTimes(1)
    expect([...(daemon as any).hosts.keys()]).toEqual([agentHostKey('bot-a')])
    expect(hosts[0]!.newSession).toHaveBeenCalledTimes(2)
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

    // A shared host's cold gate prepares no session workspace for a scratch agent, so ask the funnel directly.
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

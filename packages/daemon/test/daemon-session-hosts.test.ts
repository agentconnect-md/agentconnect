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
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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

  it('launch preparation writes two concurrent session hosts two policies, each anchored on its session cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-session-hosts-launch-'))
    const scopeDir = join(root, 'agent')
    const hostHome = join(root, 'host-home')
    mkdirSync(hostHome)
    const launches = ['s1', 's2'].map((session) => {
      const cwd = join(scopeDir, 'sessions', session, 'workspace')
      mkdirSync(cwd, { recursive: true })
      const key = sessionHostKey('bot-a', `slack:C1:${session}:bot-a`)
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
      return { key, cwd: realpathSync(cwd), launch }
    })
    const [one, two] = launches as [(typeof launches)[number], (typeof launches)[number]]
    expect(one.launch.sandbox!.settingsPath).not.toBe(two.launch.sandbox!.settingsPath)
    for (const { key, cwd, launch } of launches) {
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
    }
    // Neither write clobbered the other: both files still stand once both launches are prepared.
    expect(existsSync(one.launch.sandbox!.settingsPath)).toBe(true)
    expect(existsSync(two.launch.sandbox!.settingsPath)).toBe(true)
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
})

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { SlackConnection } from '../src/slack/connection.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

// A SlackConnection backed by an inert fake Bolt app (no network), with a fixed
// bot user id, so reconcileSlackConnections' existing-socket branch can be exercised.
function fakeConn(appToken: string, botToken: string, botUserId: string): SlackConnection {
  const conn = new SlackConnection(
    { group: { appToken, botToken, integrations: [] }, onMessage: () => {}, newTraceId: () => 't' } as any,
    () =>
      ({
        message() {},
        event() {},
        client: { auth: { test: async () => ({ user_id: botUserId }) }, chat: { postMessage: async () => ({}) } },
        start: async () => {},
        stop: async () => {}
      }) as any
  )
  ;(conn as any).botUserId = botUserId
  return conn
}

function root1(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-watch-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  return root
}
function writeAgent(root: string, id: string) {
  const adir = join(root, 'agents', id)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id,
      name: id,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'ws') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
}

describe('Daemon debounce timer cleared on stop()', () => {
  it('does not call reconcile after stop() cancels a pending debounce', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const daemon = new Daemon({
      root,
      slackAppFactory: fakeSlackAppFactory(),
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })
    await daemon.start()

    const reconcileSpy = vi.spyOn(daemon as any, 'reconcile')

    // Arm the debounce timer without waiting for it to fire (simulate FS event < 300ms before stop)
    const debounced: () => void = (daemon as any).watcher.listeners('add')[0] as () => void
    debounced()
    expect((daemon as any).debounceTimer).toBeDefined()

    // stop() must clear the timer before closing the watcher
    await daemon.stop()
    expect((daemon as any).debounceTimer).toBeDefined() // timer id is still stored, but cleared

    // Wait longer than debounce window to confirm reconcile was never called
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(reconcileSpy).not.toHaveBeenCalled()
  })
})

describe('Daemon agent config watcher', () => {
  it('does not traverse a self-referential symlink in runtime temp state', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const temp = join(root, 'agents', 'bot-a', 'home', '.tmp', 'ac-admin-sockets-test')
    mkdirSync(temp, { recursive: true })
    const loop = join(temp, 'private-daemon-loop-do-not-leak')
    symlinkSync(loop, loop)

    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const watcher = (daemon as any).watcher
    const errors: NodeJS.ErrnoException[] = []
    watcher.on('error', (err: NodeJS.ErrnoException) => errors.push(err))
    if (!watcher._readyEmitted) {
      await new Promise<void>((resolve) => watcher.once('ready', resolve))
    }

    expect(errors.some((err) => err.code === 'ELOOP')).toBe(false)
    expect(Object.keys(watcher.getWatched()).some((path) => path.endsWith(join('home', '.tmp')))).toBe(false)
    await daemon.stop()
  })
})

describe('Daemon.reconcile', () => {
  it('starts valid agents and skips a malformed agent config', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const badDir = join(root, 'agents', 'bad')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'agent.json'), '{ "id": "bad"')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const daemon = new Daemon({
      root,
      slackAppFactory: fakeSlackAppFactory(),
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })

    await expect(daemon.start()).resolves.toBeUndefined()

    expect((daemon as any).agents.has('bot-a')).toBe(true)
    expect((daemon as any).agents.has('bad')).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/WARN.*invalid agent\.json.*bad.*skipping agent/))

    errorSpy.mockRestore()
    await daemon.stop()
  })

  it('picks up a newly added agent from disk', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const daemon = new Daemon({
      root,
      slackAppFactory: fakeSlackAppFactory(),
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })
    await daemon.start()
    expect((daemon as any).agents.has('bot-b')).toBe(false)
    writeAgent(root, 'bot-b')
    await daemon.reconcile()
    expect((daemon as any).agents.has('bot-b')).toBe(true)
    await daemon.stop()
  })
})

// A daemon whose hosts are inert stubs; each started host is recorded so tests can
// assert eviction (stop() called + dropped from the hosts map).
function makeStubDaemon(root: string) {
  const hosts: Array<{ id: string; stop: ReturnType<typeof vi.fn> }> = []
  const daemon = new Daemon({
    root,
    hostFactory: (agent) => {
      const h = {
        id: agent.id,
        start: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined)
      }
      hosts.push(h)
      return h as any
    }
  })
  return { daemon, hosts }
}

function writeAgentJson(root: string, id: string, extra: Record<string, unknown>) {
  const adir = join(root, 'agents', id)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id,
      name: id,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'ws') },
      integrations: [],
      output: { mode: 'medium' },
      ...extra
    })
  )
}

describe('Daemon.reconcile per-dimension host eviction', () => {
  it('does NOT evict the host on an integration-only change', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-a', {})
    const { daemon } = makeStubDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const host = (daemon as any).hosts.get('bot-a')
    expect(host).toBeDefined()

    // Add a Slack integration (integration dimension only).
    writeAgentJson(root, 'bot-a', {
      integrations: [
        {
          id: 'int-1',
          platform: 'slack',
          core: { bindRules: [{ match: { kind: 'mention' } }] },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ]
    })
    await daemon.reconcile()

    expect(host.stop).not.toHaveBeenCalled()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    await daemon.stop()
  })

  it('does NOT evict the host on a soft-only change (output.mode)', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-a', {})
    const { daemon } = makeStubDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const host = (daemon as any).hosts.get('bot-a')

    writeAgentJson(root, 'bot-a', { output: { mode: 'high' } })
    await daemon.reconcile()

    expect(host.stop).not.toHaveBeenCalled()
    expect((daemon as any).hosts.has('bot-a')).toBe(true)
    // live config reflects the new mode
    expect((daemon as any).agents.get('bot-a').output.mode).toBe('high')
    await daemon.stop()
  })

  it('DOES evict the host on a host-spawn change (runtime/model)', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-a', {})
    const { daemon } = makeStubDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const host = (daemon as any).hosts.get('bot-a')

    writeAgentJson(root, 'bot-a', { runtimeOverrides: { model: 'opus' } })
    await daemon.reconcile()

    expect(host.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('DOES evict the host on a workspace change', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-a', {})
    const { daemon } = makeStubDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const host = (daemon as any).hosts.get('bot-a')

    const adir = join(root, 'agents', 'bot-a')
    writeAgentJson(root, 'bot-a', { workspace: { mode: 'from-scratch', path: join(adir, 'ws2') } })
    await daemon.reconcile()

    expect(host.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  })

  it('evicts the host only ONCE when both host-spawn and workspace dimensions move', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-a', {})
    const { daemon } = makeStubDaemon(root)
    await daemon.start()
    await (daemon as any).ensureHostAsync('bot-a')
    const host = (daemon as any).hosts.get('bot-a')

    const adir = join(root, 'agents', 'bot-a')
    writeAgentJson(root, 'bot-a', {
      runtimeOverrides: { model: 'opus' },
      workspace: { mode: 'from-scratch', path: join(adir, 'ws2') }
    })
    await daemon.reconcile()

    expect(host.stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).hosts.has('bot-a')).toBe(false)
    await daemon.stop()
  })
})

describe('Daemon watcher resilience: corrupt agent.json', () => {
  it('keeps the last valid config and still reconciles unrelated agents', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    writeAgent(root, 'bot-b')
    const daemon = new Daemon({
      root,
      slackAppFactory: fakeSlackAppFactory(),
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(),
          newSession: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as any
    })
    await daemon.start()

    const originalAgent = (daemon as any).agents.get('bot-a')
    const agentJsonPath = join(root, 'agents', 'bot-a', 'agent.json')
    writeFileSync(agentJsonPath, '{ this is not valid json')
    writeAgentJson(root, 'bot-b', { output: { mode: 'high' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(daemon.reconcile()).resolves.toBeUndefined()

    expect((daemon as any).agents.get('bot-a')).toBe(originalAgent)
    expect((daemon as any).agents.get('bot-b').output.mode).toBe('high')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/WARN.*invalid agent\.json.*bot-a.*keeping last valid config for agent "bot-a"/)
    )

    errorSpy.mockRestore()
    await daemon.stop()
  })
})

describe('Daemon.reconcileSlackConnections', () => {
  it('refreshes channel metadata when an HTTP send-only client is first bound', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const shared = { botToken: 'xoxb-shared', botUserId: 'U_SHARED', stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).connections.slackSharedPool.add(shared)
    ;(daemon as any).agents = new Map([
      [
        'bot-shared',
        {
          id: 'bot-shared',
          integrations: [
            { id: 'int-shared', platform: 'slack', core: { mode: 'shared' }, config: { botToken: 'xoxb-shared' } }
          ]
        }
      ]
    ])
    const refresh = vi.spyOn((daemon as any).connections, 'refreshChannels').mockResolvedValue(undefined)

    await (daemon as any).connections.openHttpSlackConnections([...(daemon as any).agents.values()])

    expect((daemon as any).connByIntegration.get('int-shared')).toBe(shared)
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(shared)

    // A normal reconcile of an unchanged binding should not re-list Slack channels.
    await (daemon as any).connections.openHttpSlackConnections([...(daemon as any).agents.values()])
    expect(refresh).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('rebinds an integration moved onto an already-open appToken (no stale mapping)', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    // Two live sockets: conn-A (appToken A) and conn-B (appToken B, shared/already open).
    const connA = fakeConn('xapp-A', 'xoxb-A', 'U_A')
    const connB = fakeConn('xapp-B', 'xoxb-B', 'U_B')
    ;(daemon as any).connections.slackPool.add(connA)
    ;(daemon as any).connections.slackPool.add(connB)
    ;(daemon as any).connByIntegration.set('int-1', connA)
    ;(daemon as any).connByIntegration.set('int-other', connB)
    ;(daemon as any).botUserIds = { 'int-1': 'U_A', 'int-other': 'U_B' }

    // int-1 now lives on an agent whose integration uses appToken B (re-pointed).
    ;(daemon as any).agents = new Map([
      [
        'bot-x',
        {
          id: 'bot-x',
          integrations: [{ id: 'int-1', platform: 'slack', config: { appToken: 'xapp-B', botToken: 'xoxb-B' } }]
        }
      ],
      [
        'bot-y',
        {
          id: 'bot-y',
          integrations: [{ id: 'int-other', platform: 'slack', config: { appToken: 'xapp-B', botToken: 'xoxb-B' } }]
        }
      ]
    ])

    await (daemon as any).connections.reconcileSlackConnections()

    // int-1 must now resolve to conn-B (not the stale conn-A).
    expect((daemon as any).connByIntegration.get('int-1')).toBe(connB)
    expect((daemon as any).botUserIds['int-1']).toBe('U_B')
    await daemon.stop()
  })

  it('preserves a shared direct socket until the final appToken reference disappears', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const conn = fakeConn('xapp-A', 'xoxb-A', 'U_A')
    const stop = vi.spyOn(conn, 'stop')
    ;(daemon as any).connections.slackPool.add(conn)
    ;(daemon as any).connByIntegration.set('int-detached', conn)
    ;(daemon as any).connByIntegration.set('int-live', conn)
    ;(daemon as any).botUserIds = { 'int-detached': 'U_A', 'int-live': 'U_A' }
    ;(daemon as any).channelSnapshots.set('int-detached', {
      channels: [{ id: 'C-old' }],
      authoritative: true
    })
    ;(daemon as any).agents = new Map([
      [
        'bot-live',
        {
          id: 'bot-live',
          integrations: [{ id: 'int-live', platform: 'slack', config: { appToken: 'xapp-A', botToken: 'xoxb-A' } }]
        }
      ]
    ])

    await (daemon as any).connections.closeUnusedPlatformConnections()
    expect(stop).not.toHaveBeenCalled()
    expect((daemon as any).connections.slackPool.all()).toEqual([conn])
    expect((daemon as any).connByIntegration.has('int-detached')).toBe(false)
    expect((daemon as any).connByIntegration.get('int-live')).toBe(conn)
    expect((daemon as any).botUserIds['int-detached']).toBeUndefined()
    expect((daemon as any).channelSnapshots.has('int-detached')).toBe(false)

    ;(daemon as any).agents = new Map()
    await (daemon as any).connections.closeUnusedPlatformConnections()
    expect(stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).connections.slackPool.all()).toEqual([])
    await daemon.stop()
  })

  it('closes only unreferenced shared-Slack, Telegram, and Discord token clients', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const conn = (botToken: string, appToken?: string) => ({
      botToken,
      appToken,
      stop: vi.fn().mockResolvedValue(undefined)
    })
    const sharedLive = conn('xoxb-live', '')
    const sharedOld = conn('xoxb-old', '')
    const telegramLive = conn('tg-live')
    const telegramOld = conn('tg-old')
    const discordLive = conn('dc-live')
    const discordOld = conn('dc-old')
    for (const c of [sharedLive, sharedOld]) (daemon as any).connections.slackSharedPool.add(c)
    for (const c of [telegramLive, telegramOld]) (daemon as any).connections.telegramPool.add(c)
    for (const c of [discordLive, discordOld]) (daemon as any).connections.discordPool.add(c)
    ;(daemon as any).agents = new Map([
      [
        'bot-live',
        {
          id: 'bot-live',
          integrations: [
            { id: 'slack-live', platform: 'slack', core: { mode: 'shared' }, config: { botToken: 'xoxb-live' } },
            { id: 'tg-live', platform: 'telegram', config: { botToken: 'tg-live' } },
            { id: 'dc-live', platform: 'discord', config: { botToken: 'dc-live' } }
          ]
        }
      ]
    ])

    await (daemon as any).connections.closeUnusedPlatformConnections()
    expect(sharedOld.stop).toHaveBeenCalledTimes(1)
    expect(telegramOld.stop).toHaveBeenCalledTimes(1)
    expect(discordOld.stop).toHaveBeenCalledTimes(1)
    expect(sharedLive.stop).not.toHaveBeenCalled()
    expect(telegramLive.stop).not.toHaveBeenCalled()
    expect(discordLive.stop).not.toHaveBeenCalled()

    ;(daemon as any).agents = new Map()
    await (daemon as any).connections.closeUnusedPlatformConnections()
    expect(sharedLive.stop).toHaveBeenCalledTimes(1)
    expect(telegramLive.stop).toHaveBeenCalledTimes(1)
    expect(discordLive.stop).toHaveBeenCalledTimes(1)
    await daemon.stop()
  })

  it('awaits a captured pre-pending connection lease before closing the final socket', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const connection = fakeConn('xapp-final', 'xoxb-final', 'U_FINAL')
    const stop = vi.spyOn(connection, 'stop')
    ;(daemon as any).connections.slackPool.add(connection)
    ;(daemon as any).agents = new Map()
    const release = (daemon as any).holdReplyConnection(connection) as () => void

    let settled = false
    const close = (daemon as any).connections.closeUnusedPlatformConnections().then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    release()
    await close
    expect(stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).connections.slackPool.all()).toEqual([])
    await daemon.stop()
  })
})

describe('Daemon.refreshObservedChannels (Telegram/Discord/Feishu discovery)', () => {
  it('reports observed Telegram chats as a non-authoritative integration/channels update', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    // cpClient is wired AFTER start() so any backfill emits during start were no-ops.
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const telegramIntegration = { id: 'tg-int', platform: 'telegram', config: { botToken: 'tg' } }
    ;(daemon as any).agents = new Map([
      [
        'bot-tg',
        {
          id: 'bot-tg',
          integrations: [
            telegramIntegration,
            { id: 'slack-int', platform: 'slack', config: { appToken: 'a', botToken: 'x' } }
          ]
        }
      ]
    ])
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockResolvedValue([{ id: '-100123', name: 'Team Chat' }, { id: '-100456' }])

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    // Only the Telegram integration is enumerated — Slack has its own membership snapshot.
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenCalledWith(
      'bot-tg',
      'telegram',
      (daemon as any).transportScopeForIntegration(telegramIntegration)
    )
    // A named chat carries its name; an unresolved one is id-only (console falls back to the id).
    const channels = [{ id: '-100123', name: 'Team Chat' }, { id: '-100456' }]
    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith({ integrationId: 'tg-int', channels, authoritative: false })
    // Cached so it re-asserts on the next CP reconnect.
    expect((daemon as any).channelSnapshots.get('tg-int')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })

  it('reports observed Discord channels the same way (Discord bots cannot list the channels they engage in)', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const discordIntegration = { id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }
    ;(daemon as any).agents = new Map([
      [
        'bot-dc',
        {
          id: 'bot-dc',
          integrations: [discordIntegration]
        }
      ]
    ])
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockReturnValue([{ id: '900123', name: 'general' }, { id: '900456' }])

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    expect(observed).toHaveBeenCalledWith(
      'bot-dc',
      'discord',
      (daemon as any).transportScopeForIntegration(discordIntegration)
    )
    const channels = [{ id: '900123', name: 'general' }, { id: '900456' }]
    expect(emit).toHaveBeenCalledWith({ integrationId: 'dc-int', channels, authoritative: false })
    expect((daemon as any).channelSnapshots.get('dc-int')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })

  it('backfills a Feishu participant and reports the resolved chat name', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    const conn = {
      getChannelInfo: vi.fn(),
      getUserProfile: vi.fn()
    }
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const feishuIntegration = {
      id: 'fs-int',
      platform: 'feishu',
      config: { appId: 'cli_fs', appSecret: 'secret', region: 'lark' }
    }
    const transportScope = (daemon as any).transportScopeForIntegration(feishuIntegration)
    ;(daemon as any).agents = new Map([
      [
        'bot-fs',
        {
          id: 'bot-fs',
          integrations: [feishuIntegration]
        }
      ]
    ])
    ;(daemon as any).fsConnByIntegration.set('fs-int', conn)
    vi.spyOn((daemon as any).store, 'listSessions').mockReturnValue([
      { agentId: 'bot-fs', platform: 'feishu', channel: 'oc_group', triggeredBy: 'ou_sender', transportScope }
    ])
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockReturnValue([{ id: 'oc_group', name: 'Product Chat' }])
    const noteMessage = vi.spyOn((daemon as any).channelNameResolver, 'noteMessage').mockImplementation(() => {})

    await (daemon as any).connections.backfillChannelNames()

    expect(noteMessage).toHaveBeenCalledWith(conn, {
      channel: 'oc_group',
      sender: { id: 'ou_sender', isBot: false }
    })
    expect(observed).toHaveBeenCalledWith('bot-fs', 'feishu', transportScope)
    const channels = [{ id: 'oc_group', name: 'Product Chat' }]
    expect(emit).toHaveBeenCalledWith({ integrationId: 'fs-int', channels, authoritative: false })
    expect((daemon as any).channelSnapshots.get('fs-int')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })

  it("does not attach a replaced Feishu app's session history to the new integration", async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const oldIntegration = {
      id: 'fs-old',
      platform: 'feishu',
      name: 'private-bot',
      config: { appId: 'cli_old', appSecret: 'old-secret', region: 'lark' }
    }
    const newIntegration = {
      id: 'fs-new',
      platform: 'feishu',
      name: 'private-bot',
      config: { appId: 'cli_new', appSecret: 'new-secret', region: 'lark' }
    }
    ;(daemon as any).agents = new Map([['bot-fs', { id: 'bot-fs', integrations: [newIntegration] }]])
    const store = (daemon as any).store
    await store.upsertSession({
      key: 'old-session',
      agentId: 'bot-fs',
      platform: 'feishu',
      channel: 'oc_old',
      thread: 'old-thread',
      transportScope: (daemon as any).transportScopeForIntegration(oldIntegration),
      acpSessionId: 'acp-old',
      state: 'idle',
      lastDeliveredTs: null,
      triggeredBy: 'ou_old',
      updatedAt: 1
    })
    await store.setDisplayName('oc_old', 'Old chat', 1)

    await (daemon as any).observedChannelsSync.refreshObservedChannels()
    expect(emit).not.toHaveBeenCalled()

    await store.upsertSession({
      key: 'new-session',
      agentId: 'bot-fs',
      platform: 'feishu',
      channel: 'oc_new',
      thread: 'new-thread',
      transportScope: (daemon as any).transportScopeForIntegration(newIntegration),
      acpSessionId: 'acp-new',
      state: 'idle',
      lastDeliveredTs: null,
      triggeredBy: 'ou_new',
      updatedAt: 2
    })
    await store.setDisplayName('oc_new', 'New chat', 2)

    await (daemon as any).observedChannelsSync.refreshObservedChannels()
    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith({
      integrationId: 'fs-new',
      channels: [{ id: 'oc_new', name: 'New chat' }],
      authoritative: false
    })
    await daemon.stop()
  })

  it('reports a new Feishu chat after its cold session row is committed', async () => {
    const root = root1()
    writeAgentJson(root, 'bot-fs', {})
    let releaseSession!: () => void
    const sessionGate = new Promise<void>((resolve) => (releaseSession = resolve))
    const host = {
      start: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn(async () => {
        await sessionGate
        return 'acp-fs-1'
      }),
      hasSession: vi.fn(() => true),
      prompt: vi.fn().mockResolvedValue('end_turn'),
      cancel: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    const daemon = new Daemon({ root, hostFactory: () => host as any })
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents.get('bot-fs').integrations = [
      {
        id: 'fs-int',
        platform: 'feishu',
        config: { appId: 'cli_fs', appSecret: 'secret', region: 'lark' }
      }
    ]
    const dispatch = (daemon as any).dispatch(
      'bot-fs',
      {
        msgId: 'feishu:oc_group:om_1',
        traceId: 'trace-fs-1',
        source: 'user',
        platform: 'feishu',
        channel: 'oc_group',
        sender: { id: 'ou_sender', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm: false,
        trigger: 'mention'
      },
      'fs-int'
    )
    await vi.waitFor(() => expect(host.newSession).toHaveBeenCalledOnce(), WAIT)

    // Model the Lark lookup finishing while cold ACP startup is still blocked: there
    // is a resolved name, but no session row for discovery to publish yet.
    await (daemon as any).store.setDisplayName('oc_group', 'Product Chat', Date.now())
    await (daemon as any).observedChannelsSync.refreshObservedChannels()
    expect(emit).not.toHaveBeenCalled()

    releaseSession()
    await dispatch

    expect(emit).toHaveBeenCalledWith({
      integrationId: 'fs-int',
      channels: [{ id: 'oc_group', name: 'Product Chat' }],
      authoritative: false
    })
    await daemon.stop()
  })

  it('folds observed Discord threads onto their enclosing channel (one row per channel)', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      ['bot-dc', { id: 'bot-dc', integrations: [{ id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }] }]
    ])
    // Three turns in #general ⇒ three thread channels, each labelled with the enclosing
    // channel — the console showed "#general" three times before the fold.
    const store = (daemon as any).store
    for (const t of ['900001', '900002', '900003']) {
      await store.setChannelScope(t, { parentId: '900123' }, 1)
    }
    await store.setDisplayName('900123', 'general', 1)
    vi.spyOn(store, 'observedChannels').mockReturnValue([
      { id: '900003', name: 'general' },
      { id: '900002', name: 'general' },
      { id: '900001', name: 'general' }
    ])

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    const channels = [{ id: '900123', name: 'general' }]
    expect(emit).toHaveBeenCalledWith({ integrationId: 'dc-int', channels, authoritative: false })
    expect((daemon as any).channelSnapshots.get('dc-int')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })

  it('reports an observed DM as a DM row, never as a configurable channel', async () => {
    // Session history cannot tell a DM from a group, so a Discord DM used to surface as
    // a channel row labelled "@yulong" — a "channel" nobody can invite the bot to.
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      ['bot-dc', { id: 'bot-dc', integrations: [{ id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }] }]
    ])
    const store = (daemon as any).store
    await store.setChannelScope('900777', { isIm: true }, 1)
    await store.setChannelScope('900123', { isIm: false }, 1)
    vi.spyOn(store, 'observedChannels').mockReturnValue([
      { id: '900777', name: '@yulong' },
      { id: '900123', name: 'general' }
    ])

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    const channels = [
      { id: '900777', name: '@yulong', kind: 'im' },
      { id: '900123', name: 'general', kind: 'channel' }
    ]
    expect(emit).toHaveBeenCalledWith({ integrationId: 'dc-int', channels, authoritative: false })
    await daemon.stop()
  })

  it("reports each Telegram bot's own observed chats when an agent has several", async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const telegramA = { id: 'tg-a', platform: 'telegram', config: { botToken: '100:a' } }
    const telegramB = { id: 'tg-b', platform: 'telegram', config: { botToken: '200:b' } }
    ;(daemon as any).agents = new Map([
      [
        'bot-tg2',
        {
          id: 'bot-tg2',
          integrations: [telegramA, telegramB]
        }
      ]
    ])
    const scopeA = (daemon as any).transportScopeForIntegration(telegramA)
    const scopeB = (daemon as any).transportScopeForIntegration(telegramB)
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockImplementation((_agentId, _platform, scope) =>
        scope === scopeA ? [{ id: '-100', name: 'Team A' }] : [{ id: '-200', name: 'Team B' }]
      )

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    expect(observed).toHaveBeenCalledWith('bot-tg2', 'telegram', scopeA)
    expect(observed).toHaveBeenCalledWith('bot-tg2', 'telegram', scopeB)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith({
      integrationId: 'tg-a',
      channels: [{ id: '-100', name: 'Team A' }],
      authoritative: false
    })
    expect(emit).toHaveBeenCalledWith({
      integrationId: 'tg-b',
      channels: [{ id: '-200', name: 'Team B' }],
      authoritative: false
    })
    await daemon.stop()
  })

  it('retains an explicitly discovered Off chat and fills its asynchronously resolved name', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      [
        'bot-tg',
        {
          id: 'bot-tg',
          integrations: [{ id: 'tg-int', platform: 'telegram', config: { botToken: 'tg' } }]
        }
      ]
    ])
    ;(daemon as any).channelSnapshots.set('tg-int', {
      channels: [{ id: '-100999', kind: 'channel' }],
      authoritative: false
    })
    await (daemon as any).store.setDisplayName('-100999', 'New private group', Date.now())
    vi.spyOn((daemon as any).store, 'observedChannels').mockReturnValue([])

    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    const channels = [{ id: '-100999', kind: 'channel', name: 'New private group' }]
    expect((daemon as any).channelSnapshots.get('tg-int')).toEqual({ channels, authoritative: false })
    expect(emit).toHaveBeenCalledWith({ integrationId: 'tg-int', channels, authoritative: false })
    await daemon.stop()
  })

  it('replays a cached partial Slack report as non-authoritative after a CP reconnect', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    const channels = [{ id: 'C-new', kind: 'channel' }]
    ;(daemon as any).channelSnapshots.set('slack-int', { channels, authoritative: false })

    await (daemon as any).replayChannelSnapshots()

    expect(emit).toHaveBeenCalledWith({
      integrationId: 'slack-int',
      channels,
      authoritative: false
    })
    await daemon.stop()
  })
})

/**
 * Leaving is the only channel control that reaches outside AgentConnect, so these
 * pin the two things that make it safe: the platforms' differing notions of what can
 * be left, and the retraction that a non-enumerating platform needs afterwards
 * (nothing else will ever remove the row).
 */
describe('Daemon.leaveConversation', () => {
  const telegramAgent = (daemon: unknown) => {
    const integration = { id: 'tg-int', platform: 'telegram', config: { botToken: 'tg' } }
    ;(daemon as any).agents = new Map([['bot-tg', { id: 'bot-tg', integrations: [integration] }]])
    return integration
  }

  it('leaves a Telegram chat and RETRACTS the row — nothing else ever would', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).channelSnapshots.set('tg-int', {
      channels: [{ id: '-100123', name: 'Team Chat' }, { id: '-100456' }],
      authoritative: false
    })
    const leaveChannel = vi.fn().mockResolvedValue(undefined)
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), { leaveChannel })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })

    expect(verdict).toEqual({ ok: true })
    expect(leaveChannel).toHaveBeenCalledWith('-100123')
    // The row is named as removed: an omission would mean nothing on this platform.
    expect(emit).toHaveBeenCalledWith({
      integrationId: 'tg-int',
      channels: [{ id: '-100456' }],
      authoritative: false,
      removed: ['-100123']
    })
    await daemon.stop()
  })

  it("reports the platform's refusal instead of throwing, and leaves the row alone", async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), {
        leaveChannel: vi.fn().mockRejectedValue(new Error('CHAT_ADMIN_REQUIRED'))
      })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })

    expect(verdict).toEqual({ ok: false, error: 'CHAT_ADMIN_REQUIRED' })
    expect(emit).not.toHaveBeenCalled() // still a member, so the row must stay
    await daemon.stop()
  })

  // The bug this suppression exists for: sessions outlive the departure, and the
  // observed set is rebuilt FROM them, so without a durable marker the next refresh
  // silently puts the conversation back and undoes the leave.
  it('survives the next observed refresh — session history must not resurrect it', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).channelSnapshots.set('tg-int', {
      channels: [{ id: '-100123', name: 'Team Chat' }],
      authoritative: false
    })
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), { leaveChannel: vi.fn().mockResolvedValue(undefined) })

    await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })
    // The chat is still all over session history — nothing deletes sessions on leave.
    vi.spyOn((daemon as any).store, 'observedChannels').mockReturnValue([{ id: '-100123', name: 'Team Chat' }])
    emit.mockClear()
    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    expect((daemon as any).channelSnapshots.get('tg-int').channels).toEqual([])
    expect(emit.mock.calls.flatMap((c: unknown[]) => (c[0] as { channels: unknown[] }).channels)).toEqual([])
  })

  it('lets a re-invited conversation come back once it actually talks to us again', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    ;(daemon as any).cpClient = { emitIntegrationChannels: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), { leaveChannel: vi.fn().mockResolvedValue(undefined) })
    await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })
    expect((await (daemon as any).store.retractedConversations('tg-int')).has('-100123')).toBe(true)

    // A platform only delivers messages for a conversation the bot is IN, so traffic
    // is proof it was re-invited — otherwise "leave" would be irreversible from here.
    await (daemon as any).observedChannelsSync.clearRetractionOnTraffic(
      { source: 'user', channel: '-100123', sender: { id: 'U1', isBot: false } },
      ['tg-int']
    )

    expect((await (daemon as any).store.retractedConversations('tg-int')).has('-100123')).toBe(false)
  })

  // A Discord observation is a THREAD id; only the collapse turns it into the channel
  // the tombstone names. Filtering the raw ids matches nothing and the thread folds
  // straight back onto the channel that was just left.
  it('a Discord thread observation cannot fold back onto the server channel that was left', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      ['bot-dc', { id: 'bot-dc', integrations: [{ id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }] }]
    ])
    ;(daemon as any).channelSnapshots.set('dc-int', {
      channels: [{ id: 'C1', spaceId: 'G1' }],
      authoritative: false
    })
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(DiscordConnection.prototype), { leaveSpace: vi.fn().mockResolvedValue(undefined) })
    await (daemon as any).connections.leaveConversation({
      integrationId: 'dc-int',
      target: { kind: 'space', spaceId: 'G1' }
    })

    // Session history holds the THREAD, which collapses onto the left channel C1.
    vi.spyOn((daemon as any).store, 'observedChannels').mockReturnValue([{ id: 'T-in-C1' }])
    vi.spyOn((daemon as any).observedChannelsSync, 'collapseObserved').mockReturnValue([{ id: 'C1', spaceId: 'G1' }])
    emit.mockClear()
    await (daemon as any).observedChannelsSync.refreshObservedChannels()

    expect((daemon as any).channelSnapshots.get('dc-int').channels).toEqual([])
  })

  it('replays the tombstones on reconnect, so a retraction lost while the CP was down still lands', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    telegramAgent(daemon)
    // Retract while the CP link is DOWN: the EVT is fire-and-forget and simply lost.
    ;(daemon as any).cpClient = undefined
    ;(daemon as any).channelSnapshots.set('tg-int', { channels: [{ id: '-100123' }], authoritative: false })
    ;(daemon as any).observedChannelsSync.retractChannels('tg-int', ['-100123'])

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    await (daemon as any).replayChannelSnapshots()

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'tg-int', removed: ['-100123'] }))
  })

  // The snapshots are in memory, the tombstones on disk. A restart before the first
  // reconnect leaves a durable retraction with no cached snapshot beside it — keying
  // replay on the map alone strands the CP row exactly when the original
  // fire-and-forget retraction was the thing that got lost.
  it('replays a tombstone that outlived the snapshot it was recorded next to', async () => {
    const root = root1()
    const first = makeStubDaemon(root).daemon
    await first.start()
    ;(first as any).cpClient = undefined // CP unreachable: the retraction EVT is lost
    telegramAgent(first)
    ;(first as any).channelSnapshots.set('tg-int', { channels: [{ id: '-100123' }], authoritative: false })
    ;(first as any).observedChannelsSync.retractChannels('tg-int', ['-100123'])
    await first.stop()

    // A fresh process over the SAME root: the tombstone survived, the snapshot did not.
    const second = makeStubDaemon(root).daemon
    await second.start()
    expect((second as any).channelSnapshots.get('tg-int')).toBeUndefined()
    const emit = vi.fn()
    ;(second as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    await (second as any).replayChannelSnapshots()

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'tg-int', removed: ['-100123'] }))
    await second.stop()
  })

  // Leaving is the ONLY action a Telegram row offers, so it has to finish the job even
  // when the bot is already out — that stale row is the whole reason this exists, and
  // refusing would leave the operator with a row they can see and cannot clear.
  it('clears the row when Telegram says the bot is already out of the chat', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).channelSnapshots.set('tg-int', { channels: [{ id: '-100123' }], authoritative: false })
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), {
        leaveChannel: vi.fn().mockRejectedValue(new Error('Bad Request: chat not found'))
      })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })

    expect(verdict).toEqual({ ok: true })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ removed: ['-100123'] }))
  })

  it('still reports a refusal that does NOT mean the bot is out', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    telegramAgent(daemon)
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(TelegramConnection.prototype), {
        leaveChannel: vi.fn().mockRejectedValue(new Error('Too Many Requests: retry after 30'))
      })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'tg-int',
      target: { kind: 'conversation', channel: '-100123' }
    })

    expect(verdict).toEqual({ ok: false, error: 'Too Many Requests: retry after 30' })
    expect(emit).not.toHaveBeenCalled() // the row must not vanish on a transient failure
  })

  it('refuses a conversation-scoped leave on Discord, where a bot can only leave a server', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    ;(daemon as any).agents = new Map([
      ['bot-dc', { id: 'bot-dc', integrations: [{ id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }] }]
    ])
    const leaveSpace = vi.fn()
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(DiscordConnection.prototype), { leaveSpace })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'dc-int',
      target: { kind: 'conversation', channel: 'C9' }
    })

    expect(verdict.ok).toBe(false)
    expect(leaveSpace).not.toHaveBeenCalled() // never silently escalates to the server
    await daemon.stop()
  })

  it('leaving a Discord server retracts every row of that server, and no others', async () => {
    const { daemon } = makeStubDaemon(root1())
    await daemon.start()
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      ['bot-dc', { id: 'bot-dc', integrations: [{ id: 'dc-int', platform: 'discord', config: { botToken: 'dc' } }] }]
    ])
    ;(daemon as any).channelSnapshots.set('dc-int', {
      channels: [
        { id: 'C1', spaceId: 'G1' },
        { id: 'C2', spaceId: 'G1' },
        { id: 'C3', spaceId: 'G2' }
      ],
      authoritative: false
    })
    ;(daemon as any).connForIntegration = () =>
      Object.assign(Object.create(DiscordConnection.prototype), { leaveSpace: vi.fn().mockResolvedValue(undefined) })

    const verdict = await (daemon as any).connections.leaveConversation({
      integrationId: 'dc-int',
      target: { kind: 'space', spaceId: 'G1' }
    })

    expect(verdict).toEqual({ ok: true })
    expect(emit).toHaveBeenCalledWith({
      integrationId: 'dc-int',
      channels: [{ id: 'C3', spaceId: 'G2' }],
      authoritative: false,
      removed: ['C1', 'C2']
    })
    await daemon.stop()
  })
})

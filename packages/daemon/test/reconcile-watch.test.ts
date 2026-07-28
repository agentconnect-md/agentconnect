import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { SlackConnection } from '../src/slack/connection.js'

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

describe('Daemon.reconcile', () => {
  it('picks up a newly added agent from disk', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const daemon = new Daemon({
      root,
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
          slack: { botToken: 'xoxb', appToken: 'xapp', bindRules: [{ match: { kind: 'mention' } }] }
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
  it('direct reconcile() rejects, but watcher-triggered reconcile does not cause unhandled rejection and logs to console.error', async () => {
    const root = root1()
    writeAgent(root, 'bot-a')
    const daemon = new Daemon({
      root,
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

    // Corrupt agent.json so discovery throws
    const agentJsonPath = join(root, 'agents', 'bot-a', 'agent.json')
    writeFileSync(agentJsonPath, '{ this is not valid json')

    // Direct call to reconcile() must still reject (fix must not swallow errors in reconcile itself)
    await expect(daemon.reconcile()).rejects.toThrow()

    // Spy on console.error before triggering the debounced watcher path
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Fire the debounced watcher handler (same pattern as existing test)
    const debounced = (daemon as any).watcher.listeners('add')[0] as () => void
    debounced()

    // Wait longer than the 300ms debounce window
    await new Promise((resolve) => setTimeout(resolve, 400))

    // The background path must have caught the error and logged it
    expect(errorSpy).toHaveBeenCalledWith('agentconnect: reconcile failed:', expect.any(Error))

    errorSpy.mockRestore()
    await daemon.stop()
  })
})

describe('Daemon.reconcileSlackConnections', () => {
  it('refreshes channel metadata when a shared send-only client is first bound', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const shared = { botToken: 'xoxb-shared', botUserId: 'U_SHARED', stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).sharedSlackConns = new Map([['xoxb-shared', shared]])
    ;(daemon as any).agents = new Map([
      [
        'bot-shared',
        {
          id: 'bot-shared',
          integrations: [{ id: 'int-shared', platform: 'slack', slack: { mode: 'shared', botToken: 'xoxb-shared' } }]
        }
      ]
    ])
    const refresh = vi.spyOn(daemon as any, 'refreshChannels').mockResolvedValue(undefined)

    await (daemon as any).openSharedSlackConnections([...(daemon as any).agents.values()])

    expect((daemon as any).connByIntegration.get('int-shared')).toBe(shared)
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(shared)

    // A normal reconcile of an unchanged binding should not re-list Slack channels.
    await (daemon as any).openSharedSlackConnections([...(daemon as any).agents.values()])
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
    ;(daemon as any).connections = [connA, connB]
    ;(daemon as any).connByIntegration.set('int-1', connA)
    ;(daemon as any).connByIntegration.set('int-other', connB)
    ;(daemon as any).botUserIds = { 'int-1': 'U_A', 'int-other': 'U_B' }

    // int-1 now lives on an agent whose integration uses appToken B (re-pointed).
    ;(daemon as any).agents = new Map([
      [
        'bot-x',
        {
          id: 'bot-x',
          integrations: [{ id: 'int-1', platform: 'slack', slack: { appToken: 'xapp-B', botToken: 'xoxb-B' } }]
        }
      ],
      [
        'bot-y',
        {
          id: 'bot-y',
          integrations: [{ id: 'int-other', platform: 'slack', slack: { appToken: 'xapp-B', botToken: 'xoxb-B' } }]
        }
      ]
    ])

    await (daemon as any).reconcileSlackConnections()

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
    ;(daemon as any).connections = [conn]
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
          integrations: [{ id: 'int-live', platform: 'slack', slack: { appToken: 'xapp-A', botToken: 'xoxb-A' } }]
        }
      ]
    ])

    await (daemon as any).closeUnusedPlatformConnections()
    expect(stop).not.toHaveBeenCalled()
    expect((daemon as any).connections).toEqual([conn])
    expect((daemon as any).connByIntegration.has('int-detached')).toBe(false)
    expect((daemon as any).connByIntegration.get('int-live')).toBe(conn)
    expect((daemon as any).botUserIds['int-detached']).toBeUndefined()
    expect((daemon as any).channelSnapshots.has('int-detached')).toBe(false)

    ;(daemon as any).agents = new Map()
    await (daemon as any).closeUnusedPlatformConnections()
    expect(stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).connections).toEqual([])
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
    ;(daemon as any).sharedSlackConns = new Map([
      ['xoxb-live', sharedLive],
      ['xoxb-old', sharedOld]
    ])
    ;(daemon as any).telegramConns = [telegramLive, telegramOld]
    ;(daemon as any).discordConns = [discordLive, discordOld]
    ;(daemon as any).agents = new Map([
      [
        'bot-live',
        {
          id: 'bot-live',
          integrations: [
            { id: 'slack-live', platform: 'slack', slack: { mode: 'shared', botToken: 'xoxb-live' } },
            { id: 'tg-live', platform: 'telegram', telegram: { botToken: 'tg-live' } },
            { id: 'dc-live', platform: 'discord', discord: { botToken: 'dc-live' } }
          ]
        }
      ]
    ])

    await (daemon as any).closeUnusedPlatformConnections()
    expect(sharedOld.stop).toHaveBeenCalledTimes(1)
    expect(telegramOld.stop).toHaveBeenCalledTimes(1)
    expect(discordOld.stop).toHaveBeenCalledTimes(1)
    expect(sharedLive.stop).not.toHaveBeenCalled()
    expect(telegramLive.stop).not.toHaveBeenCalled()
    expect(discordLive.stop).not.toHaveBeenCalled()

    ;(daemon as any).agents = new Map()
    await (daemon as any).closeUnusedPlatformConnections()
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
    ;(daemon as any).connections = [connection]
    ;(daemon as any).agents = new Map()
    const release = (daemon as any).holdReplyConnection(connection) as () => void

    let settled = false
    const close = (daemon as any).closeUnusedPlatformConnections().then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(stop).not.toHaveBeenCalled()

    release()
    await close
    expect(stop).toHaveBeenCalledTimes(1)
    expect((daemon as any).connections).toEqual([])
    await daemon.stop()
  })
})

describe('Daemon.refreshObservedChannels (Telegram/Discord discovery)', () => {
  it('reports observed Telegram chats as a non-authoritative integration/channels update', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    // cpClient is wired AFTER start() so any backfill emits during start were no-ops.
    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      [
        'bot-tg',
        {
          id: 'bot-tg',
          integrations: [
            { id: 'tg-int', platform: 'telegram', telegram: { botToken: 'tg' } },
            { id: 'slack-int', platform: 'slack', slack: { appToken: 'a', botToken: 'x' } }
          ]
        }
      ]
    ])
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockReturnValue([{ id: '-100123', name: 'Team Chat' }, { id: '-100456' }])

    ;(daemon as any).refreshObservedChannels()

    // Only the Telegram integration is enumerated — Slack has its own membership snapshot.
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenCalledWith('bot-tg', 'telegram')
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
    ;(daemon as any).agents = new Map([
      [
        'bot-dc',
        {
          id: 'bot-dc',
          integrations: [{ id: 'dc-int', platform: 'discord', discord: { botToken: 'dc' } }]
        }
      ]
    ])
    const observed = vi
      .spyOn((daemon as any).store, 'observedChannels')
      .mockReturnValue([{ id: '900123', name: 'general' }, { id: '900456' }])

    ;(daemon as any).refreshObservedChannels()

    expect(observed).toHaveBeenCalledWith('bot-dc', 'discord')
    const channels = [{ id: '900123', name: 'general' }, { id: '900456' }]
    expect(emit).toHaveBeenCalledWith({ integrationId: 'dc-int', channels, authoritative: false })
    expect((daemon as any).channelSnapshots.get('dc-int')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })

  it('skips an agent with multiple Telegram bots (observed set is not per-bot)', async () => {
    const root = root1()
    const { daemon } = makeStubDaemon(root)
    await daemon.start()

    const emit = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels: emit, stop: vi.fn().mockResolvedValue(undefined) }
    ;(daemon as any).agents = new Map([
      [
        'bot-tg2',
        {
          id: 'bot-tg2',
          integrations: [
            { id: 'tg-a', platform: 'telegram', telegram: { botToken: 'tg-a' } },
            { id: 'tg-b', platform: 'telegram', telegram: { botToken: 'tg-b' } }
          ]
        }
      ]
    ])
    const observed = vi.spyOn((daemon as any).store, 'observedChannels')

    ;(daemon as any).refreshObservedChannels()

    // Ambiguous which bot saw which chat ⇒ report nothing rather than mis-attribute.
    expect(observed).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
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
          integrations: [{ id: 'tg-int', platform: 'telegram', telegram: { botToken: 'tg' } }]
        }
      ]
    ])
    ;(daemon as any).channelSnapshots.set('tg-int', {
      channels: [{ id: '-100999', kind: 'channel' }],
      authoritative: false
    })
    ;(daemon as any).store.setDisplayName('-100999', 'New private group', Date.now())
    vi.spyOn((daemon as any).store, 'observedChannels').mockReturnValue([])

    ;(daemon as any).refreshObservedChannels()

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

    ;(daemon as any).replayChannelSnapshots()

    expect(emit).toHaveBeenCalledWith({
      integrationId: 'slack-int',
      channels,
      authoritative: false
    })
    await daemon.stop()
  })
})

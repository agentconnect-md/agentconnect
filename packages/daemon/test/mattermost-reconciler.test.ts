import { describe, expect, it, vi } from 'vitest'
import { VirtualClock } from './fakes/virtual-clock.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import type { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'

describe('ConnectionReconciler — Mattermost pool & bindings', () => {
  it('consolidates shared credentials onto one connection, forwards inbound, and prunes on token rotation', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'general', display_name: 'General' }, [
      server.botUser.id,
      alice.id
    ])

    const bindings = new Map<string, MattermostConnection>()
    const inbound: string[] = []
    const clock = new VirtualClock(1_000)

    let token = server.botToken
    let includeBot = true
    const agents = () =>
      includeBot
        ? [
            {
              id: 'agent-a',
              integrations: [
                {
                  id: 'int-a',
                  platform: 'mattermost',
                  config: { serverUrl: `${server.serverUrl}/`, botToken: token }
                }
              ]
            },
            {
              id: 'agent-b',
              integrations: [
                {
                  id: 'int-b',
                  platform: 'mattermost',
                  config: { serverUrl: server.serverUrl, botToken: token }
                }
              ]
            }
          ]
        : []

    const host: Partial<ConnectionReconcilerHost> = {
      log: () => quietLog,
      clock: () => clock,
      cpClient: () => undefined,
      transportAgents: () => agents() as never,
      evaluationIntegrationIds: () => new Set(),
      draining: () => false,
      channelSnapshots: () => new Map(),
      boundIntegrationIds: () => [...bindings.keys()],
      bindings: () => ({
        slack: new Map(),
        telegram: new Map(),
        discord: new Map(),
        feishu: new Map(),
        linear: new Map(),
        googlechat: new Map(),
        mattermost: bindings
      }),
      bindMattermost: (id, conn) => {
        bindings.set(id, conn)
      },
      unbindIntegration: (id) => {
        bindings.delete(id)
      },
      channelNameResolver: () => undefined,
      onInbound: (msg) => inbound.push(msg.msgId),
      srcIntegrationIds: (conn) => [...bindings.entries()].filter(([, c]) => c === conn).map(([id]) => id),
      waitForConnectionUses: vi.fn(async () => {}),
      mattermostTransport: () => ({
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      })
    }

    const reconciler = new ConnectionReconciler(host as ConnectionReconcilerHost)
    await reconciler.reconcileMattermostConnections()

    expect(reconciler.mattermostPool.all()).toHaveLength(1)
    expect(bindings.get('int-a')).toBe(bindings.get('int-b'))
    expect(bindings.get('int-a')?.botUserId).toBe(server.botUser.id)

    server.lastSocket.emitPosted({
      id: server.nextId('post'),
      channel_id: ch.id,
      user_id: alice.id,
      message: 'hello team'
    })
    await vi.waitFor(() => expect(inbound).toHaveLength(1))

    // Rotating the token must evict old bindings and stop/prune the old pool entry.
    const oldConn = bindings.get('int-a')!
    const stopSpy = vi.spyOn(oldConn, 'stop')
    includeBot = false
    await reconciler.closeUnusedPlatformConnections()
    expect(bindings.size).toBe(0)
    expect(reconciler.mattermostPool.all()).toHaveLength(0)
    expect(stopSpy).toHaveBeenCalledOnce()

    // Re-adding and disposing cleans up completely.
    token = server.botToken
    includeBot = true
    await reconciler.reconcileMattermostConnections()
    expect(reconciler.mattermostPool.all()).toHaveLength(1)
    const errs = await reconciler.dispose()
    expect(errs).toEqual([])
  })

  it('leaves a Mattermost channel via leaveConversation and refreshes snapshots', async () => {
    const server = new FakeMattermostServer()
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'leave-me' }, [server.botUser.id])
    const bindings = new Map<string, MattermostConnection>()
    const refreshChannels = vi.fn(async () => {})
    const retractChannels = vi.fn(async () => {})
    const host: Partial<ConnectionReconcilerHost> = {
      log: () => quietLog,
      clock: () => new VirtualClock(1_000),
      cpClient: () => undefined,
      transportAgents: () =>
        [
          {
            id: 'agent-a',
            integrations: [
              {
                id: 'int-a',
                platform: 'mattermost',
                config: { serverUrl: server.serverUrl, botToken: server.botToken }
              }
            ]
          }
        ] as never,
      evaluationIntegrationIds: () => new Set(),
      draining: () => false,
      channelSnapshots: () => new Map(),
      boundIntegrationIds: () => [...bindings.keys()],
      bindings: () => ({
        slack: new Map(),
        telegram: new Map(),
        discord: new Map(),
        feishu: new Map(),
        linear: new Map(),
        googlechat: new Map(),
        mattermost: bindings
      }),
      integrationConfigById: (id) =>
        id === 'int-a'
          ? ({
              id: 'int-a',
              platform: 'mattermost',
              config: { serverUrl: server.serverUrl, botToken: server.botToken }
            } as never)
          : undefined,
      connForIntegration: (id) => bindings.get(id),
      bindMattermost: (id, conn) => {
        bindings.set(id, conn)
      },
      unbindIntegration: (id) => {
        bindings.delete(id)
      },
      channelNameResolver: () => undefined,
      onInbound: () => {},
      srcIntegrationIds: (conn) => [...bindings.entries()].filter(([, c]) => c === conn).map(([id]) => id),
      refreshChannels,
      retractChannels,
      waitForConnectionUses: vi.fn(async () => {}),
      mattermostTransport: () => ({
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      })
    }

    const reconciler = new ConnectionReconciler(host as ConnectionReconcilerHost)
    await reconciler.reconcileMattermostConnections()
    expect(server.channelMembers.get(ch.id)?.has(server.botUser.id)).toBe(true)

    const res = await reconciler.leaveConversation({
      integrationId: 'int-a',
      target: { kind: 'conversation', channel: ch.id }
    })
    expect(res).toEqual({ ok: true })
    expect(server.channelMembers.get(ch.id)?.has(server.botUser.id)).toBe(false)
    expect(refreshChannels).toHaveBeenCalledTimes(2)
    expect(retractChannels).not.toHaveBeenCalled()
    await reconciler.dispose()
  })

  it('logs sanitized open error without leaking botToken and schedules 30s background retry', async () => {
    const server = new FakeMattermostServer()
    server.refuseOpens = 1
    const bindings = new Map<string, MattermostConnection>()
    const clock = new VirtualClock(1_000)
    const warns: string[] = []
    const captureLog = { ...quietLog, warn: (s: string) => warns.push(s) }
    const host: Partial<ConnectionReconcilerHost> = {
      log: () => captureLog,
      clock: () => clock,
      cpClient: () => undefined,
      transportAgents: () =>
        [
          {
            id: 'agent-a',
            integrations: [
              {
                id: 'int-a',
                platform: 'mattermost',
                config: { serverUrl: server.serverUrl, botToken: server.botToken }
              }
            ]
          }
        ] as never,
      evaluationIntegrationIds: () => new Set(),
      draining: () => false,
      channelSnapshots: () => new Map(),
      boundIntegrationIds: () => [...bindings.keys()],
      bindings: () => ({
        slack: new Map(),
        telegram: new Map(),
        discord: new Map(),
        feishu: new Map(),
        linear: new Map(),
        googlechat: new Map(),
        mattermost: bindings
      }),
      bindMattermost: (id, conn) => {
        bindings.set(id, conn)
      },
      unbindIntegration: (id) => {
        bindings.delete(id)
      },
      channelNameResolver: () => undefined,
      onInbound: () => {},
      srcIntegrationIds: (conn) => [...bindings.entries()].filter(([, c]) => c === conn).map(([id]) => id),
      waitForConnectionUses: vi.fn(async () => {}),
      mattermostTransport: () => ({
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      })
    }

    const reconciler = new ConnectionReconciler(host as ConnectionReconcilerHost)
    await reconciler.reconcileMattermostConnections()
    expect(reconciler.mattermostPool.all()).toHaveLength(0)
    expect(clock.pending).toBe(1)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('mattermost: could not open connection; retrying in 30s:')
    expect(warns[0]).toContain('websocket closed before open')
    expect(warns[0]).not.toContain(server.botToken)

    expect(clock.fireNext(30_000)).toBe(true)
    await vi.waitFor(() => expect(reconciler.mattermostPool.all()).toHaveLength(1))
    expect(bindings.get('int-a')?.botUserId).toBe(server.botUser.id)
    reconciler.cancelRetryTimers()
    expect(clock.pending).toBe(0)
    await reconciler.dispose()
  })
})

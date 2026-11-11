import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { WECOM_KICK_COOLDOWN_BASE_MS, type WeComConnection } from '../src/platforms/wecom/connection.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'

afterEach(() => vi.unstubAllGlobals())

const BOT = 'aibot-example'

function agent(id: string, secret: string): LoadedAgent {
  return {
    id,
    integrations: [{ id: `int-${id}`, platform: 'wecom', core: { bindRules: [] }, config: { botId: BOT, secret } }]
  } as unknown as LoadedAgent
}

function setup(initial: LoadedAgent[]) {
  const server = new FakeWeComServer()
  // The production client dials the global WebSocket; the fake server stands in for WeCom.
  vi.stubGlobal('WebSocket', function FakeWebSocket(url: string) {
    return server.createSocket(url)
  })
  const clock = new FakeClock(1_000_000)
  let agents = initial
  const bound = new Map<string, WeComConnection>()
  const inbound: [string, string[]][] = []
  const host = {
    log: () => quietLog,
    clock: () => clock,
    draining: () => false,
    transportAgents: () => agents,
    evaluationIntegrationIds: () => new Set<string>(),
    channelSnapshots: () => new Map(),
    boundIntegrationIds: () => [...bound.keys()],
    bindings: () => ({
      slack: new Map(),
      telegram: new Map(),
      discord: new Map(),
      feishu: new Map(),
      linear: new Map(),
      googlechat: new Map(),
      wecom: bound
    }),
    bindWeCom: (id: string, conn: WeComConnection) => void bound.set(id, conn),
    unbindIntegration: (id: string) => void bound.delete(id),
    srcIntegrationIds: (conn: unknown) => [...bound].filter(([, c]) => c === conn).map(([id]) => id),
    channelNameResolver: () => undefined,
    onInbound: (msg: NormalizedMessage, ids: string[]) => void inbound.push([msg.msgId, ids]),
    waitForConnectionUses: async () => {},
    cpClient: () => undefined
  } as unknown as ConnectionReconcilerHost
  const reconciler = new ConnectionReconciler(host)
  return { server, clock, reconciler, bound, inbound, setAgents: (next: LoadedAgent[]) => void (agents = next) }
}

describe('WeCom connection reconciliation', () => {
  it('opens one long connection for every integration of one bot and hands its messages on', async () => {
    const { server, reconciler, bound, inbound } = setup([
      agent('a', 'secret-placeholder'),
      agent('b', 'secret-placeholder')
    ])
    try {
      await reconciler.reconcileWeComConnections()
      await reconciler.reconcileWeComConnections()
      expect(server.sockets).toHaveLength(1)
      expect(reconciler.weComPool.all()).toHaveLength(1)
      expect([...bound.keys()]).toEqual(['int-a', 'int-b'])
      server.last.message('req-1', {
        msgid: 'msg-1',
        aibotid: BOT,
        chattype: 'single',
        from: { userid: 'user-alice' },
        msgtype: 'text',
        text: { content: 'hi' }
      })
      expect(inbound).toEqual([[`wecom:${BOT}:msg-1`, ['int-a', 'int-b']]])
    } finally {
      await reconciler.dispose()
    }
  })

  it('leaves a kicked connection down until its cooldown, then redials through the reconciler', async () => {
    const { server, clock, reconciler } = setup([agent('a', 'secret-placeholder')])
    try {
      await reconciler.reconcileWeComConnections()
      server.last.kick()
      // An ordinary reconcile pass inside the cooldown does not dial.
      await reconciler.reconcileWeComConnections()
      clock.advance(WECOM_KICK_COOLDOWN_BASE_MS - 1)
      expect(server.sockets).toHaveLength(1)
      clock.advance(1)
      await vi.waitFor(() => expect(server.sockets).toHaveLength(2))
      await vi.waitFor(() => expect(reconciler.weComPool.all()[0]!.connected).toBe(true))
      expect(server.last.frames('aibot_subscribe')).toHaveLength(1)
    } finally {
      reconciler.cancelRetryTimers()
      await reconciler.dispose()
    }
  })

  it('connects at once when the Secret changes, even while the old connection waits out a kick', async () => {
    const { server, reconciler, bound, setAgents } = setup([agent('a', 'secret-placeholder')])
    try {
      await reconciler.reconcileWeComConnections()
      const old = server.last
      old.kick()
      setAgents([agent('a', 'secret-placeholder-rotated')])
      await reconciler.closeUnusedPlatformConnections()
      expect(bound.has('int-a')).toBe(false)
      expect(reconciler.weComPool.all()).toHaveLength(0)
      await reconciler.reconcileWeComConnections()
      expect(server.sockets).toHaveLength(2)
      expect(server.last.frames('aibot_subscribe')[0]!.body).toMatchObject({ secret: 'secret-placeholder-rotated' })
      expect(bound.get('int-a')?.connected).toBe(true)
    } finally {
      reconciler.cancelRetryTimers()
      await reconciler.dispose()
    }
  })
})

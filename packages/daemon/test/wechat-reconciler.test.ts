import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { memoryWeChatState } from '../src/platforms/wechat/state.js'
import { API, CDN, fakeIlink } from './fakes/ilink-server.js'

afterEach(() => vi.unstubAllGlobals())

describe('WeChat connection reconciliation', () => {
  it('polls configured integrations without a daemon feature flag', async () => {
    const ilink = fakeIlink()
    vi.stubGlobal('fetch', ilink.fetchImpl)
    const state = memoryWeChatState()
    const agent = {
      id: 'agent',
      integrations: [
        {
          id: 'wechat-int',
          platform: 'wechat',
          core: { bindRules: [] },
          config: {
            botId: 'b1@im.bot',
            botToken: 'bot-token-placeholder',
            boundUserId: 'u1@im.wechat',
            apiUrl: API,
            cdnUrl: CDN
          }
        }
      ]
    } as unknown as LoadedAgent
    const reconciler = new ConnectionReconciler({
      log: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
      draining: () => false,
      transportAgents: () => [agent],
      store: () => ({
        getWeChatBotState: (botId: string) => state.load(botId),
        setWeChatPollCursor: (botId: string, cursor: string) => state.saveCursor(botId, cursor),
        setWeChatContextToken: (botId: string, token: string) => state.saveContextToken(botId, token)
      }),
      bindWeChat: () => {},
      srcIntegrationIds: () => ['wechat-int']
    } as unknown as ConnectionReconcilerHost)
    try {
      await reconciler.reconcileWeChatConnections()
      expect(reconciler.weChatPool.all()).toHaveLength(1)
      await vi.waitFor(() => expect(ilink.pollCalls().length).toBeGreaterThan(0))
    } finally {
      await Promise.all(reconciler.weChatPool.all().map((conn) => conn.stop()))
    }
  })
})

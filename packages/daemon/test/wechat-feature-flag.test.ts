// `features.wechat` gates every WeChat connection: off by default, on from config.json or AGENTCONNECT_WECHAT.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { loadConfig, WECHAT_FEATURE_ENV } from '../src/config/load-config.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { memoryWeChatState } from '../src/platforms/wechat/state.js'
import { API, CDN, fakeIlink } from './fakes/ilink-server.js'

const config = {
  botId: 'b1@im.bot',
  botToken: 'bot-token-placeholder',
  boundUserId: 'u1@im.wechat',
  apiUrl: API,
  cdnUrl: CDN
}
const agent = {
  id: 'agent',
  integrations: [{ id: 'wechat-int', platform: 'wechat', core: { bindRules: [] }, config }]
} as unknown as LoadedAgent

function reconcilerWith(enabled: { on: boolean }) {
  const warnings: string[] = []
  const state = memoryWeChatState()
  const store = {
    getWeChatBotState: (botId: string) => state.load(botId),
    setWeChatPollCursor: (botId: string, cursor: string) => state.saveCursor(botId, cursor),
    setWeChatContextToken: (botId: string, token: string) => state.saveContextToken(botId, token)
  }
  const reconciler = new ConnectionReconciler({
    log: () => ({ trace() {}, debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} }),
    draining: () => false,
    weChatEnabled: () => enabled.on,
    transportAgents: (agents?: LoadedAgent[]) => agents ?? [agent],
    store: () => store,
    bindWeChat: () => {},
    srcIntegrationIds: () => ['wechat-int']
  } as unknown as ConnectionReconcilerHost)
  return { reconciler, warnings }
}

function configFile(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wechat-flag-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ version: 1, ...body }))
  return file
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('features.wechat', () => {
  it('opens no connection while off and says so once', async () => {
    const ilink = fakeIlink()
    vi.stubGlobal('fetch', ilink.fetchImpl)
    const { reconciler, warnings } = reconcilerWith({ on: false })
    await reconciler.reconcileWeChatConnections()
    await reconciler.reconcileWeChatConnections()
    expect(reconciler.weChatPool.all()).toHaveLength(0)
    expect(ilink.calls).toHaveLength(0)
    expect(warnings.filter((w) => w.includes('features.wechat is off'))).toHaveLength(1)
  })

  it('polls while on', async () => {
    const ilink = fakeIlink()
    vi.stubGlobal('fetch', ilink.fetchImpl)
    const { reconciler } = reconcilerWith({ on: true })
    await reconciler.reconcileWeChatConnections()
    expect(reconciler.weChatPool.all()).toHaveLength(1)
    await vi.waitFor(() => expect(ilink.pollCalls().length).toBeGreaterThan(0))
    await reconciler.weChatPool.all()[0]!.stop()
  })

  it('defaults off; the environment turns it on only where config.json is silent', () => {
    expect(loadConfig({ configPath: configFile({}) }).features.wechat).toBe(false)
    vi.stubEnv(WECHAT_FEATURE_ENV, 'true')
    expect(loadConfig({ configPath: configFile({}) }).features.wechat).toBe(true)
    expect(loadConfig({ configPath: configFile({ features: { wechat: false } }) }).features.wechat).toBe(false)
    vi.stubEnv(WECHAT_FEATURE_ENV, '')
    expect(loadConfig({ configPath: configFile({ features: { wechat: true } }) }).features.wechat).toBe(true)
  })
})

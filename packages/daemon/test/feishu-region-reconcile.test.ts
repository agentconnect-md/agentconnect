import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { FeishuConnection, type FeishuClientHandle } from '../src/feishu/connection.js'

/** Minimal on-disk config root (CP disabled) — enough to construct a Daemon. */
function configRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-fsregion-'))
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

/** A FeishuConnection whose SDK handle is inert; `close()` is spied so we can assert the
 *  reconcile stopped the stale (old-region) connection. */
function fakeFeishuConn(appId: string, region: 'feishu' | 'lark', botOpenId: string) {
  const closed = vi.fn()
  const handle: FeishuClientHandle = {
    api: {
      createText: async () => ({}),
      createCard: async () => ({}),
      replyText: async () => ({}),
      replyCard: async () => ({}),
      listMessages: async () => ({ items: [], hasMore: false }),
      uploadImage: async () => ({ imageKey: 'img_1' }),
      createImage: async () => ({}),
      replyImage: async () => ({}),
      createCardEntity: async () => ({ cardId: 'card-1' }),
      createCardEntityMessage: async () => ({ messageId: 'message-1' }),
      replyCardEntityMessage: async () => ({ messageId: 'message-2' }),
      updateCardEntityElement: async () => {},
      setCardEntityStreaming: async () => {},
      patchCardMessage: async () => {},
      deleteMessage: async () => {},
      updateText: async () => {},
      downloadResource: async () => {},
      getChat: async (id: string) => ({ id }),
      listChatMembers: async () => [],
      listChats: async () => [],
      getUser: async (id: string) => ({ id }),
      getBotInfo: async () => ({})
    },
    startWs: async () => {},
    close: closed
  }
  const conn = new FeishuConnection(
    {
      group: { appId, appSecret: 's', mode: 'direct', region, botOpenId, integrations: [] },
      onMessage: () => {},
      newTraceId: () => 't'
    },
    () => handle
  )
  return { conn, closed }
}

/** Seed the daemon's `agents` map with one feishu integration on `appId` at `region`. */
function seedAgent(daemon: Daemon, agentId: string, integrationId: string, appId: string, region: 'feishu' | 'lark') {
  ;(daemon as unknown as { agents: Map<string, unknown> }).agents.set(agentId, {
    id: agentId,
    integrations: [
      {
        id: integrationId,
        platform: 'feishu',
        core: { mode: 'direct', bindRules: [] },
        config: { appId, appSecret: 's', region }
      }
    ]
  })
}

describe('feishu reconcile — region change on the same appId', () => {
  it('evicts the stale per-integration mapping + stops the old-domain connection', async () => {
    const daemon = new Daemon({ root: configRoot(), hostFactory: () => ({ start: vi.fn(), stop: vi.fn() }) as never })
    const d = daemon as unknown as {
      connections: {
        feishuPool: { add(c: FeishuConnection): void; all(): FeishuConnection[] }
        closeUnusedPlatformConnections: () => Promise<void>
      }
      fsConnByIntegration: Map<string, FeishuConnection>
      botUserIds: Record<string, string | undefined>
    }

    const intId = 'int-1'
    const { conn: stale, closed } = fakeFeishuConn('cli_x', 'feishu', 'ou_old')
    // Existing state: the app is connected to the FEISHU gateway and routed there.
    d.connections.feishuPool.add(stale)
    d.fsConnByIntegration.set(intId, stale)
    d.botUserIds[intId] = 'ou_old'

    // Desired state: the same appId now wants the LARK gateway.
    seedAgent(daemon, 'agent-1', intId, 'cli_x', 'lark')

    await d.connections.closeUnusedPlatformConnections()

    // The stale old-domain connection is stopped and dropped from the live list, and its
    // routing mapping is evicted — so a failed replacement can never leave the integration
    // pointed at the wrong-region client (it re-binds only on a successful new connect).
    expect(closed).toHaveBeenCalled()
    expect(d.connections.feishuPool.all()).not.toContain(stale)
    expect(d.fsConnByIntegration.has(intId)).toBe(false)
    expect(d.botUserIds[intId]).toBeUndefined()

    await daemon.stop().catch(() => {})
  })
})

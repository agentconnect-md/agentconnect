import { describe, it, expect, vi } from 'vitest'
import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { Agent } from '../src/agents/agent-schema.js'
import {
  consolidateFeishu,
  FeishuConnection,
  type FeishuClientHandle,
  type ConsolidatedFeishuGroup
} from '../src/feishu/connection.js'

/** Build a minimal feishu-only Agent the consolidator can read. */
function feishuAgent(id: string, appId: string, region: FeishuRegion): Agent {
  return {
    id,
    integrations: [
      {
        id: `int-${id}`,
        platform: 'feishu',
        core: { mode: 'direct', bindRules: [] },
        config: { appId, appSecret: 'secret', region }
      }
    ]
  } as unknown as Agent
}

/** A no-op handle that records the region the factory was invoked with. */
function fakeHandle(): FeishuClientHandle {
  const api = {
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
    addReaction: async () => {},
    updateText: async () => {},
    downloadResource: async () => {},
    getChat: async (id: string) => ({ id }),
    listChatMembers: async () => [],
    listChats: async () => [],
    getUser: async (id: string) => ({ id }),
    getBotInfo: async () => ({})
  } satisfies FeishuClientHandle['api']
  return { api, startWs: async () => {}, close: () => {} }
}

describe('feishu region → gateway plumbing', () => {
  it('consolidateFeishu carries each app’s region onto the group', () => {
    const groups = consolidateFeishu([feishuAgent('a', 'cli_cn', 'feishu'), feishuAgent('b', 'cli_intl', 'lark')])
    expect(groups.get('cli_cn')?.region).toBe('feishu')
    expect(groups.get('cli_intl')?.region).toBe('lark')
  })

  it('FeishuConnection forwards the group region to the SDK factory', () => {
    const seen: FeishuRegion[] = []
    const group: ConsolidatedFeishuGroup = {
      appId: 'cli_intl',
      appSecret: 'secret',
      mode: 'direct',
      region: 'lark',
      botOpenId: 'ou_bot',
      integrations: [{ agentId: 'a', integrationId: 'int-a' }]
    }
    // Construction alone drives the factory call under test.
    const conn = new FeishuConnection(
      { group, onMessage: () => {}, newTraceId: () => 't' },
      (_appId, _appSecret, region) => {
        seen.push(region)
        return fakeHandle()
      }
    )
    expect(conn.appId).toBe('cli_intl')
    // Exposed so daemon reconcile can detect a region change on the same appId and
    // reconnect against the new gateway instead of reusing the old-domain client.
    expect(conn.region).toBe('lark')
    expect(seen).toEqual(['lark'])
  })

  it('shared mode initializes provider egress without opening a second inbound connection', async () => {
    const startWs = vi.fn(async () => {})
    const handle = fakeHandle()
    handle.startWs = startWs
    const conn = new FeishuConnection(
      {
        group: {
          appId: 'cli_http',
          appSecret: 'secret',
          mode: 'shared',
          region: 'lark',
          botOpenId: 'ou_bot',
          integrations: [{ agentId: 'a', integrationId: 'int-a' }]
        },
        onMessage: () => {},
        newTraceId: () => 't',
        sendIntervalMs: 0
      },
      () => handle
    )

    await conn.start()

    expect(startWs).not.toHaveBeenCalled()
    expect(conn.mode).toBe('shared')
    await expect(conn.postMessage('oc_chat', 'hello')).resolves.toBeUndefined()
  })
})

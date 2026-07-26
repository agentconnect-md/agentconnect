import { describe, it, expect } from 'vitest'
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
        feishu: { appId, appSecret: 'secret', region, allowedUserIds: [], bindRules: [] }
      }
    ]
  } as unknown as Agent
}

/** A no-op handle that records the region the factory was invoked with. */
function fakeHandle(): FeishuClientHandle {
  const api = {
    createText: async () => ({}),
    replyText: async () => ({}),
    patchText: async () => {},
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
})

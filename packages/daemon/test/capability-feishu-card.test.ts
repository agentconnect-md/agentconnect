// Feishu/Lark's capability card (capability-requests.md §4.4.2): an open_url button and a Decline callback the relay routes back.
import { describe, expect, it, vi } from 'vitest'
import { FeishuConnection } from '../src/feishu/connection.js'
import type { CapabilityCardModel } from '../src/platforms/capability-card.js'
import { withCapabilityClick } from '../src/platforms/capability-click.js'
import {
  buildFeishuCapabilityCard,
  buildFeishuCapabilitySettled,
  feishuCapabilityCards,
  parseFeishuCapabilityDecline
} from '../src/platforms/feishu/capability-card.js'

const CARD = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
const AGENT = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b'
const INT = '5e6f7081-92a3-44b5-86c7-d8e9f0a1b2c3'

const model: CapabilityCardModel = {
  requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
  generation: 2,
  cardId: CARD,
  summary: 'add the MCP server "Linear"',
  reason: 'Filing the bug needs [Linear](https://evil.example.test)',
  link: 'https://console.example.test/example-org/requests/7f3a',
  agentName: 'Ada',
  context: 'Asked for Ana',
  via: { agentId: AGENT, integrationId: INT, sessionKey: 'feishu:oc_chat:om_root' }
}

/** Every node of a card with the given key, wherever it sits. */
function find(node: unknown, key: string): unknown[] {
  const out: unknown[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    const o = n as Record<string, unknown>
    if (key in o) out.push(o[key])
    Object.values(o).forEach(walk)
  }
  walk(node)
  return out
}

describe('Feishu/Lark capability card', () => {
  it('shows the reason as plain text, links the request, and routes Decline by its card, generation and integration', () => {
    const { card } = buildFeishuCapabilityCard(model)
    const text = (find(card, 'text') as { tag: string; content: string }[]).find((t) => t.content.includes('Reason'))!
    expect(text.tag).toBe('plain_text')
    expect(text.content).toContain('Reason: Filing the bug needs [Linear](https://evil.example.test)')
    const behaviors = (find(card, 'behaviors') as Record<string, unknown>[][]).flat()
    expect(behaviors).toContainEqual({ type: 'open_url', default_url: model.link })
    const callback = behaviors.find((b) => b.type === 'callback')!
    expect(callback.value).toMatchObject({ target: { v: 1, agentId: AGENT, integrationId: INT } })
    expect(parseFeishuCapabilityDecline(callback.value)).toEqual({ generation: 2, cardId: CARD })
    expect(parseFeishuCapabilityDecline({ action: 'agentconnect_approval', request: 'r', option: '0' })).toBeNull()
  })

  it('settles with no buttons and the request link, and is never a direct message surface', () => {
    const { card } = buildFeishuCapabilitySettled(model, { status: 'declined', by: 'Ben' })
    expect(find(card, 'behaviors')).toEqual([])
    expect(JSON.stringify(card)).toContain('🚫 Declined by Ben')
    expect(feishuCapabilityCards.directMessages).toBe(false)
  })

  it('updates the card in place, else answers beside it', async () => {
    const conn = {
      updateElicitCard: vi.fn(async () => false),
      postElicitCard: vi.fn(async () => 'om_follow')
    }
    const draft = feishuCapabilityCards.settled(model, { status: 'expired' })
    const handle = { conn, channel: 'oc_chat', thread: 'om_root', ts: 'om_card' }
    await expect(feishuCapabilityCards.rewrite(handle, draft)).resolves.toBe('followed-up')
    conn.updateElicitCard.mockResolvedValueOnce(true)
    await expect(feishuCapabilityCards.rewrite(handle, draft)).resolves.toBe('edited')
  })

  it('takes the p2p chat’s one member as its person, and the clicker as a person only while their click is judged', async () => {
    const conn = {
      getChannelInfo: async () => ({ id: 'oc_p2p', isIm: true }),
      listMemberIds: async () => ['on_ada']
    }
    await expect(feishuCapabilityCards.directMessageWith(conn, 'oc_p2p')).resolves.toBe('on_ada')
    await expect(feishuCapabilityCards.isPerson(conn, 'on_ada')).resolves.toBe(false)
    await withCapabilityClick(conn, 'on_ada', {}, async () => {
      await expect(feishuCapabilityCards.isPerson(conn, 'on_ada')).resolves.toBe(true)
    })
  })
})

describe('a Decline clicked on a Feishu/Lark card', () => {
  it('reaches core with the clicker’s union_id, and core’s private line comes back as the toast', async () => {
    const seen: unknown[] = []
    const conn: FeishuConnection = new FeishuConnection(
      {
        group: { appId: 'cli_example', appSecret: 'secret', mode: 'direct', region: 'feishu', integrations: [] },
        onMessage: () => {},
        onCapabilityDecline: async (a) => {
          seen.push(a)
          await feishuCapabilityCards.tellPrivately(
            { conn, channel: 'oc_chat' },
            a.actor.userId,
            'Only someone who can ask Ada here can decline this request.'
          )
        },
        newTraceId: () => 'trace',
        sendIntervalMs: 0
      },
      (() => ({})) as never
    )
    const answer = await conn.handleCardAction({
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_ada', union_id: 'on_ada', name: 'Ada Example' },
      action: { tag: 'button', value: { action: 'agentconnect_capability', card: CARD, generation: '2' } }
    })
    expect(seen).toEqual([
      {
        generation: 2,
        cardId: CARD,
        actor: { userId: 'on_ada', memberId: 'on_ada', name: 'Ada Example' }
      }
    ])
    expect(answer).toEqual({
      toast: { type: 'warning', content: 'Only someone who can ask Ada here can decline this request.' }
    })
  })
})

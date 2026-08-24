import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { forwardSessionShortcut, slackIngressPlugin } from './ingress-plugin.js'
import type { RelayIngressHost } from '../contract.js'
import type { BotAssignment, RouteTarget } from '../../bot-arbitration.js'

const ROUTE: RouteTarget = {
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '33333333-3333-4333-8333-333333333333',
  integrationId: '66666666-6666-4666-8666-666666666666'
}

const host = (over: Partial<RelayIngressHost> = {}): RelayIngressHost => ({
  forward: async () => {},
  forwardAction: vi.fn(async (msg) => ({ msgId: msg.msgId, accepted: true })),
  reportChannels: () => {},
  reportRevoked: vi.fn(),
  directory: {
    agents: () => [],
    channelOwner: () => undefined,
    targetForAgentId: () => undefined,
    resolveTarget: () => ROUTE,
    targetForAgent: () => ROUTE,
    integrationTarget: () => ROUTE,
    soleTarget: () => ROUTE
  },
  canDeliver: () => true,
  dedupSeen: () => false,
  setChannelAgent: () => {},
  selectThreadAgent: () => {},
  reportBotUserId: () => {},
  clock: { now: () => 1_720_000_000_000 },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ...over
})

const SHORTCUT = {
  triggerId: 'trigger-1',
  channelId: 'C1',
  threadTs: 'T1',
  interactionId: 'trigger-1'
}

describe('slack ingress plugin — review-pinned regressions', () => {
  it('a shortcut whose daemon is OFFLINE returns false (local unavailable modal, trigger not eaten)', () => {
    // The trigger id is one-shot: returning true consumes it. An offline daemon
    // must fall back to the local unavailable path exactly like an unroutable
    // conversation — not silently eat the interaction.
    const h = host({ canDeliver: () => false })
    expect(forwardSessionShortcut(h, 'bot-1', SHORTCUT)).toBe(false)
    expect(h.forwardAction).not.toHaveBeenCalled()
  })

  it('a routable shortcut forwards and returns true', () => {
    const h = host()
    expect(forwardSessionShortcut(h, 'bot-1', SHORTCUT)).toBe(true)
    expect(h.forwardAction).toHaveBeenCalledTimes(1)
  })

  // The whole plugin path for the native Stop: HMAC demux → handle → the daemon that owns the
  // conversation, carrying the tapping user. A signature no assigned bot verifies stops at verify.
  it('forwards a verified agent-session stop, and never an unverified one', async () => {
    const h = host()
    const assignment = {
      botId: 'bot-1',
      platform: 'slack',
      secrets: { botToken: 'xoxb-1', signingSecret: 'sig' },
      members: [],
      agents: [],
      routes: []
    } as unknown as BotAssignment
    const ingest = slackIngressPlugin.buildIngest(assignment, h)!
    const envelope = {
      type: 'event_callback',
      api_app_id: 'A1',
      team_id: 'T9',
      event_id: 'Ev-stop',
      event: { type: 'agent_session_stopped', channel: 'C1', thread_ts: 'T1', user: 'U-ALICE' }
    }
    const raw = Buffer.from(JSON.stringify(envelope))
    const ts = '1720000000'
    const now = 1_720_000_000_000
    const sign = (secret: string) =>
      `v0=${createHmac('sha256', secret)
        .update(`v0:${ts}:${raw.toString('utf8')}`)
        .digest('hex')}`
    const headers = (signature: string) => ({
      'x-slack-signature': signature,
      'x-slack-request-timestamp': ts
    })

    expect(slackIngressPlugin.verify(ingest, raw, envelope, headers(sign('other-bots-secret')), now)).toBeUndefined()
    expect(h.forwardAction).not.toHaveBeenCalled()

    const verified = slackIngressPlugin.verify(ingest, raw, envelope, headers(sign('sig')), now)!
    expect(verified).toMatchObject({ kind: 'event', eventId: 'Ev-stop' })
    await slackIngressPlugin.handle(ingest, verified, h)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.forwardAction).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.forwardAction).mock.calls[0]![0]).toMatchObject({
      source: 'platform_action',
      platformId: 'slack',
      agentId: ROUTE.agentId,
      integrationId: ROUTE.integrationId,
      botId: 'bot-1',
      userId: 'U-ALICE',
      payload: { kind: 'agent-session-stopped', channelId: 'C1', threadTs: 'T1' }
    })
  })

  it('revocation reports carry the OBSERVING assignment revision, not the current one', () => {
    // Assignments start fire-and-forget: an older ingest's auth.test can finish
    // after a newer assignment installed. Fencing with the mutable current
    // revision would let that stale observation revoke the replacement
    // credential — the report must carry the generation this ingest was built
    // from.
    const h = host()
    const assignment = {
      botId: 'bot-1',
      platform: 'slack',
      secrets: { botToken: 'xoxb-1', signingSecret: 'sig' },
      credentialRevision: 1,
      members: [],
      agents: [],
      routes: [],
      gatedAgentIds: [],
      mutedChannels: [],
      gatedOffChannels: [],
      noticedDmConversations: []
    } as unknown as BotAssignment
    const ingest = slackIngressPlugin.buildIngest(assignment, h)!
    // Simulate the platform revoking AFTER a re-assign bumped the live revision:
    // the callback wired at buildIngest must still report revision 1.
    ;(
      ingest as unknown as {
        deps: { onBotRevoked?: (reason: string, eventAtMs?: number) => void }
      }
    ).deps.onBotRevoked?.('app_uninstalled', 1_720_000_000_000)
    expect(h.reportRevoked).toHaveBeenCalledWith('bot-1', 'app_uninstalled', 1_720_000_000_000, 1)
  })
})

import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { forwardSessionShortcut, forwardSessionStop, slackIngressPlugin } from './ingress-plugin.js'
import type { RelayIngressHost } from '../contract.js'
import type { BotAssignment, RouteTarget } from '../../bot-arbitration.js'

const ROUTE: RouteTarget = {
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '33333333-3333-4333-8333-333333333333',
  integrationId: '66666666-6666-4666-8666-666666666666'
}

const host = (over: Partial<RelayIngressHost> = {}): RelayIngressHost => ({
  forward: async () => 'accepted' as const,
  forwardAction: vi.fn(async (msg) => ({ msgId: msg.msgId, accepted: true })),
  reportChannels: () => {},
  reportRevoked: vi.fn(),
  reportCredentialCheck: vi.fn(),
  credentialCheckSupported: () => true,
  directory: {
    agents: () => [],
    channelOwner: () => undefined,
    targetForAgentId: () => undefined,
    resolveTarget: () => ROUTE,
    resolveBoundTarget: async () => ROUTE,
    conversationParticipants: () => [],
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

/** A Slack assignment built at revision 1 — the OBSERVING generation every report must carry. */
const slackAssignment = (): BotAssignment =>
  ({
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
  }) as unknown as BotAssignment

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

  // A shared bot's participants can span daemons while Slack sees one calling agent, and the
  // session-level Stop means "stop all in-progress work" — so it fans out, one frame per daemon.
  it('fans the stop out to every participating daemon, once each', () => {
    const other: RouteTarget = {
      agentId: '55555555-5555-4555-8555-555555555555',
      daemonId: '77777777-7777-4777-8777-777777777777',
      integrationId: '88888888-8888-4888-8888-888888888888'
    }
    const sameDaemonSibling: RouteTarget = { ...ROUTE, agentId: '99999999-9999-4999-8999-999999999999' }
    const h = host({
      directory: {
        agents: () => [],
        channelOwner: () => undefined,
        targetForAgentId: () => undefined,
        resolveTarget: () => ROUTE,
        resolveBoundTarget: async () => ROUTE,
        conversationParticipants: () => [sameDaemonSibling, other],
        targetForAgent: () => ROUTE,
        integrationTarget: () => ROUTE,
        soleTarget: () => ROUTE
      }
    })

    forwardSessionStop(h, 'bot-1', { channelId: 'C1', threadTs: 'T1', interactionId: 'Ev-stop', userId: 'U-ALICE' })

    const calls = vi.mocked(h.forwardAction).mock.calls
    expect(calls).toHaveLength(2)
    // The primary claims its daemon first; the sibling on the same daemon rides that one frame.
    expect(calls.map(([msg]) => msg.agentId)).toEqual([ROUTE.agentId, other.agentId])
    expect(calls.map(([, route]) => route.daemonId)).toEqual([ROUTE.daemonId, other.daemonId])
    // One event id, one dedup identity — every daemon collapses a Slack redelivery the same way.
    expect(new Set(calls.map(([msg]) => msg.msgId)).size).toBe(1)
  })

  it('still stops the remembered participants when the ownership ladder resolves nobody', () => {
    const h = host({
      directory: {
        agents: () => [],
        channelOwner: () => undefined,
        targetForAgentId: () => undefined,
        resolveTarget: () => undefined,
        resolveBoundTarget: async () => undefined,
        conversationParticipants: () => [ROUTE],
        targetForAgent: () => undefined,
        integrationTarget: () => undefined,
        soleTarget: () => undefined
      }
    })

    forwardSessionStop(h, 'bot-1', { channelId: 'C1', threadTs: 'T1', interactionId: 'Ev-stop' })

    expect(h.forwardAction).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.forwardAction).mock.calls[0]![1]).toEqual(ROUTE)
  })

  it('revocation reports carry the OBSERVING assignment revision, not the current one', () => {
    // An older ingest's report can land after a re-assign bumped the live revision; it must fence on its own.
    const h = host()
    const ingest = slackIngressPlugin.buildIngest(slackAssignment(), h)!
    ;(
      ingest as unknown as {
        deps: { onBotRevoked?: (reason: string, proof: { evidence: 'event'; eventAtMs?: number }) => void }
      }
    ).deps.onBotRevoked?.('app_uninstalled', { evidence: 'event', eventAtMs: 1_720_000_000_000 })
    expect(h.reportRevoked).toHaveBeenCalledWith(
      'bot-1',
      { reason: 'app_uninstalled', evidence: 'event', eventAtMs: 1_720_000_000_000 },
      1
    )
  })
})

describe('slack ingress plugin — credential probe tiers', () => {
  const NOW = 1_720_000_000_000
  const platformError = (code: string) => Object.assign(new Error(code), { data: { error: code } })

  /** Build the real ingest and run one probe against a stubbed `auth.test`. */
  const probe = async (h: RelayIngressHost, answer: () => Promise<unknown>): Promise<void> => {
    const ingest = slackIngressPlugin.buildIngest(slackAssignment(), h)!
    ;(ingest as unknown as { web: unknown }).web = { auth: { test: answer } }
    await ingest.probeCredential()
  }

  it('reports a definitive answer as a probe revocation with its code', async () => {
    const h = host()
    await probe(h, async () => Promise.reject(platformError('token_revoked')))
    expect(h.reportRevoked).toHaveBeenCalledWith(
      'bot-1',
      { reason: 'tokens_revoked', evidence: 'probe', code: 'token_revoked' },
      1
    )
    expect(h.reportCredentialCheck).not.toHaveBeenCalled()
  })

  it('reports invalid_auth as a rejected check to a CP that accepts checks', async () => {
    const h = host()
    await probe(h, async () => Promise.reject(platformError('invalid_auth')))
    expect(h.reportCredentialCheck).toHaveBeenCalledWith(
      'bot-1',
      { result: 'rejected', code: 'invalid_auth', observedAtMs: NOW },
      1
    )
    expect(h.reportRevoked).not.toHaveBeenCalled()
  })

  it('keeps revoking on invalid_auth for a CP without credential checks', async () => {
    const h = host({ credentialCheckSupported: () => false })
    await probe(h, async () => Promise.reject(platformError('invalid_auth')))
    expect(h.reportRevoked).toHaveBeenCalledWith(
      'bot-1',
      { reason: 'tokens_revoked', evidence: 'probe', code: 'invalid_auth' },
      1
    )
    expect(h.reportCredentialCheck).not.toHaveBeenCalled()
  })

  it('reports a successful probe as an ok check', async () => {
    const h = host()
    await probe(h, async () => ({ user_id: 'UBOT' }))
    expect(h.reportCredentialCheck).toHaveBeenCalledWith('bot-1', { result: 'ok', observedAtMs: NOW }, 1)
    expect(h.reportRevoked).not.toHaveBeenCalled()
  })

  it('reports nothing for a rate-limited probe', async () => {
    const h = host()
    await probe(h, async () =>
      Promise.reject(Object.assign(new Error('rate limited'), { code: 'slack_webapi_rate_limited_error' }))
    )
    expect(h.reportRevoked).not.toHaveBeenCalled()
    expect(h.reportCredentialCheck).not.toHaveBeenCalled()
  })
})

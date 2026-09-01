import { createHmac } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import type { WireNormalizedMessage } from '@agentconnect.md/protocol'
import { linearIngressPlugin } from './ingress-plugin.js'
import { LINEAR_CONTEXT_BUDGET_BYTES, type LinearAdapterExt } from './http-ingest.js'
import type { RelayIngressHost } from '../contract.js'
import { toBotAssignment } from '../../bot-arbitration.js'
import type { BotAssignment, RouteTarget } from '../../bot-arbitration.js'

const NOW = 1_788_249_909_143
const SIGNING_SECRET = 'lin_wh_00000000000000000000000000000000'
const CLIENT_ID = '00000000000000000000000000000001'
const ORG_ID = '00000000-0000-4000-8000-000000000001'
const SIBLING_ORG_ID = '00000000-0000-4000-8000-000000000002'
const APP_USER_ID = '00000000-0000-4000-8000-0000000000a1'
const ISSUE_ID = '00000000-0000-4000-8000-0000000000i1'
const SESSION_ID = '00000000-0000-4000-8000-0000000000s1'
const ACTIVITY_ID = '00000000-0000-4000-8000-0000000000c1'
const USER_ID = '00000000-0000-4000-8000-0000000000u1'

const ROUTE: RouteTarget = {
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '33333333-3333-4333-8333-333333333333',
  integrationId: '66666666-6666-4666-8666-666666666666'
}

const host = (over: Partial<RelayIngressHost> = {}): RelayIngressHost => ({
  forward: vi.fn(async () => {}),
  forwardAction: vi.fn(async (msg) => ({ msgId: msg.msgId, accepted: true })),
  reportChannels: () => {},
  reportRevoked: vi.fn(),
  directory: {
    agents: () => [],
    channelOwner: () => undefined,
    targetForAgentId: () => undefined,
    resolveTarget: () => ROUTE,
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
  clock: { now: () => NOW },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ...over
})

// The §6.2 bags as the assignment's platform-free identity slots carry them: Linear's
// `clientId` is the provider app id, `organizationId` the tenant, `appUserId` the bot identity.
const assignment = (over: Partial<BotAssignment> = {}): BotAssignment =>
  ({
    botId: '11111111-1111-4111-8111-111111111111',
    platform: 'linear',
    secrets: { signingSecret: SIGNING_SECRET },
    apiAppId: CLIENT_ID,
    teamId: ORG_ID,
    botUserId: APP_USER_ID,
    credentialRevision: 7,
    members: [],
    agents: [],
    routes: [],
    ...over
  }) as unknown as BotAssignment

const issue = {
  id: ISSUE_ID,
  identifier: 'AGE-5',
  title: 'Probe: agent session activity rendering',
  url: 'https://linear.app/example-workspace/issue/AGE-5/probe',
  team: { id: '00000000-0000-4000-8000-0000000000t1', key: 'AGE', name: 'Example' }
}

function createdEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: ORG_ID,
    oauthClientId: CLIENT_ID,
    appUserId: APP_USER_ID,
    agentSession: {
      id: SESSION_ID,
      creatorId: USER_ID,
      commentId: '00000000-0000-4000-8000-0000000000m1',
      sourceCommentId: null,
      status: 'active',
      url: 'https://linear.app/example-workspace/issue/AGE-5/probe#agent-session',
      comment: { id: '00000000-0000-4000-8000-0000000000m1', body: 'example-agent please look at this' },
      issue
    },
    previousComments: null,
    guidance: 'Always open a draft PR.',
    promptContext: '<issue identifier="AGE-5"><title>Probe</title></issue>',
    webhookTimestamp: NOW,
    webhookId: '00000000-0000-4000-8000-0000000000w1',
    ...over
  }
}

function promptedEvent(over: Record<string, unknown> = {}, activityOver: Record<string, unknown> = {}) {
  return {
    ...createdEvent(),
    action: 'prompted',
    agentActivity: {
      id: ACTIVITY_ID,
      signal: null,
      sourceCommentId: '00000000-0000-4000-8000-0000000000m2',
      content: { type: 'prompt', body: 'Follow-up: does this reopen the session?' },
      user: { id: USER_ID, name: 'Example Person' },
      ...activityOver
    },
    ...over
  }
}

// `timestampHeader` absent ⇒ the header mirrors the SIGNED timestamp, as a real delivery does;
// `null` ⇒ no header at all; a number ⇒ the attacker's freely chosen unsigned value.
function delivery(
  body: unknown,
  over: { secret?: string; signature?: string; timestampHeader?: number | string | null } = {}
) {
  const raw = Buffer.from(JSON.stringify(body))
  const signature =
    over.signature ??
    createHmac('sha256', over.secret ?? SIGNING_SECRET)
      .update(raw)
      .digest('hex')
  const signed = (body as { webhookTimestamp?: number } | undefined)?.webhookTimestamp
  const headerValue = over.timestampHeader === undefined ? signed : over.timestampHeader
  return {
    raw,
    body,
    headers: {
      'linear-event': 'AgentSessionEvent',
      'linear-delivery': '00000000-0000-4000-8000-0000000000d1',
      'linear-signature': signature,
      ...(headerValue === null || headerValue === undefined ? {} : { 'linear-timestamp': String(headerValue) })
    } as Record<string, string | string[] | undefined>
  }
}

async function run(h: RelayIngressHost, body: unknown, opts: Parameters<typeof delivery>[1] = {}, now = NOW) {
  const ingest = linearIngressPlugin.buildIngest(assignment(), h)!
  const d = delivery(body, opts)
  const verified = linearIngressPlugin.verify(ingest, d.raw, d.body, d.headers, now)
  if (verified === undefined) return { verified, forwarded: undefined }
  await linearIngressPlugin.handle(ingest, verified, h)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { verified, forwarded: vi.mocked(h.forward).mock.calls[0]?.[1] as WireNormalizedMessage | undefined }
}

describe('linear ingress plugin — signature and replay window', () => {
  it('accepts a delivery signed with the workspace bot signing secret', async () => {
    const h = host()
    const { verified } = await run(h, createdEvent())
    expect(verified).toMatchObject({ kind: 'agent-session' })
  })

  it('rejects a forged signature, a truncated one, and a non-hex one', async () => {
    const h = host()
    expect((await run(h, createdEvent(), { secret: 'another-apps-secret' })).verified).toBeUndefined()
    expect((await run(h, createdEvent(), { signature: '0'.repeat(63) })).verified).toBeUndefined()
    expect((await run(h, createdEvent(), { signature: 'not-hex' })).verified).toBeUndefined()
    expect(h.forward).not.toHaveBeenCalled()
  })

  it('rejects a STALE signed body even when the unsigned header is fresh', async () => {
    // The signature covers the body only, so a captured body + signature replays for as long as
    // the attacker keeps minting fresh `Linear-Timestamp` headers. The signed timestamp is the
    // only freshness authority; a header-only skew check admits the replay.
    const h = host()
    const captured = createdEvent({ webhookTimestamp: NOW - 6 * 60 * 60 * 1000 })
    expect((await run(h, captured, { timestampHeader: NOW })).verified).toBeUndefined()
    expect(h.forward).not.toHaveBeenCalled()
  })

  it('accepts a fresh signed body with NO timestamp header at all', async () => {
    const h = host()
    expect((await run(h, createdEvent(), { timestampHeader: null })).verified).toMatchObject({
      kind: 'agent-session'
    })
  })

  it('rejects a body carrying no signed timestamp — nothing would bound its replay', async () => {
    const h = host()
    const undated = createdEvent()
    delete (undated as Record<string, unknown>).webhookTimestamp
    expect((await run(h, undated, { timestampHeader: NOW })).verified).toBeUndefined()
  })

  it('rejects an unsigned header that CONTRADICTS the signed timestamp', async () => {
    // The header can only ever reject; a mismatch means one of the two was tampered with.
    const h = host()
    expect((await run(h, createdEvent(), { timestampHeader: NOW - 5_000 })).verified).toBeUndefined()
    expect((await run(h, createdEvent(), { timestampHeader: 'not-a-number' })).verified).toBeUndefined()
  })

  it('reads webhookTimestamp as epoch MILLISECONDS, not seconds', async () => {
    const h = host()
    // The same instant expressed in seconds is ~1 788 249 909 ms after the epoch — far outside
    // the window. A seconds reading would accept it and reject every real delivery.
    const seconds = createdEvent({ webhookTimestamp: Math.floor(NOW / 1000) })
    expect((await run(h, seconds)).verified).toBeUndefined()
    expect((await run(h, createdEvent())).verified).toMatchObject({ kind: 'agent-session' })
  })

  it('rejects a signed timestamp more than 60 s from the host clock, in either direction', async () => {
    const h = host()
    expect((await run(h, createdEvent({ webhookTimestamp: NOW - 60_001 }))).verified).toBeUndefined()
    expect((await run(h, createdEvent({ webhookTimestamp: NOW + 60_001 }))).verified).toBeUndefined()
    expect((await run(h, createdEvent({ webhookTimestamp: NOW - 59_000 }))).verified).toMatchObject({
      kind: 'agent-session'
    })
  })

  it('verifies against the RAW bytes, so a reserialized body no longer matches', async () => {
    const h = host()
    const ingest = linearIngressPlugin.buildIngest(assignment(), h)!
    const d = delivery(createdEvent())
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(d.raw.toString('utf8')), null, 2))
    expect(linearIngressPlugin.verify(ingest, reserialized, d.body, d.headers, NOW)).toBeUndefined()
  })
})

describe('linear ingress plugin — demux and tenant isolation', () => {
  it('extracts the tenant-scoped composite from the body identity pair', () => {
    expect(linearIngressPlugin.extractDemuxHints(Buffer.alloc(0), createdEvent(), {})).toEqual({
      appId: CLIENT_ID,
      tenantId: ORG_ID
    })
  })

  it('extracts nothing from a body carrying no identity — never a guessed key', () => {
    expect(linearIngressPlugin.extractDemuxHints(Buffer.alloc(0), { type: 'AgentSessionEvent' }, {})).toEqual({})
  })

  it('a sibling install VERIFIES the signature yet is refused: the payload workspace decides', async () => {
    // Every install of the deployment app shares one signing secret, so the HMAC is valid for a
    // sibling's delivery too. Only the payload's organizationId separates the two workspaces.
    const h = host()
    const sibling = createdEvent({ organizationId: SIBLING_ORG_ID })
    expect((await run(h, sibling)).verified).toBeUndefined()
    expect(h.forward).not.toHaveBeenCalled()
  })

  it('refuses a validly signed delivery from another OAuth app of the same deployment', async () => {
    const h = host()
    expect((await run(h, createdEvent({ oauthClientId: 'a-different-client-id' }))).verified).toBeUndefined()
  })

  it('refuses to build an ingest without the signing secret or either identity half', () => {
    const h = host()
    expect(linearIngressPlugin.buildIngest(assignment({ secrets: {} as never }), h)).toBeUndefined()
    expect(linearIngressPlugin.buildIngest(assignment({ apiAppId: undefined }), h)).toBeUndefined()
    expect(
      linearIngressPlugin.buildIngest(assignment({ teamId: undefined, workspaceId: undefined }), h)
    ).toBeUndefined()
  })

  it('builds from the WIRE frame end to end, so the mapper and the plugin cannot drift', async () => {
    // The plugin reads exactly the slots core indexes (`indexAssign`) and fences on, and the
    // mapper is the only thing between the frame and those slots — so pin the pair together.
    const h = host()
    const mapped = toBotAssignment({
      botId: '11111111-1111-4111-8111-111111111111',
      platform: 'linear',
      secrets: { signingSecret: SIGNING_SECRET },
      ingress: { apiAppId: CLIENT_ID, teamId: ORG_ID, botUserId: APP_USER_ID },
      members: [],
      agents: [],
      routes: [],
      gatedAgentIds: [],
      mutedChannels: [],
      gatedOffChannels: [],
      noticedDmConversations: []
    } as never)
    const ingest = linearIngressPlugin.buildIngest(mapped!, h)!
    expect(ingest.identity).toEqual({ clientId: CLIENT_ID, organizationId: ORG_ID, appUserId: APP_USER_ID })
    const d = delivery(createdEvent())
    const verified = linearIngressPlugin.verify(ingest, d.raw, d.body, d.headers, NOW)!
    await linearIngressPlugin.handle(ingest, verified, h)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(vi.mocked(h.forward).mock.calls[0]?.[1].mentionedBots).toEqual([APP_USER_ID])
  })
})

describe('linear ingress plugin — dedup identity', () => {
  it('derives created from the session id and prompted from the activity id (§4.5)', async () => {
    const created = host()
    expect((await run(created, createdEvent())).forwarded?.msgId).toBe(`linear:${SESSION_ID}:created`)
    const prompted = host()
    expect((await run(prompted, promptedEvent())).forwarded?.msgId).toBe(`linear:${ACTIVITY_ID}`)
  })

  it('drops a redelivery before any forward', async () => {
    const h = host({ dedupSeen: () => true })
    await run(h, createdEvent())
    expect(h.forward).not.toHaveBeenCalled()
    expect(h.forwardAction).not.toHaveBeenCalled()
  })

  it('forwards nothing for an action that mints no content-derived identity', async () => {
    const h = host()
    await run(h, createdEvent({ action: 'unknown-future-action' }))
    expect(h.forward).not.toHaveBeenCalled()
  })
})

describe('linear ingress plugin — normalized message', () => {
  it('maps a created event onto issue/session coordinates with the adapter bag', async () => {
    const h = host()
    const { forwarded } = await run(h, createdEvent())
    expect(forwarded).toMatchObject({
      platform: 'linear',
      channel: ISSUE_ID,
      thread: SESSION_ID,
      threadUrl: issue.url,
      sender: { id: `linear:${USER_ID}`, isBot: false },
      text: 'example-agent please look at this',
      mentionedBots: [APP_USER_ID],
      isDm: false
    })
    const bag = forwarded!.adapterExt!.linear as LinearAdapterExt
    expect(bag).toMatchObject({
      agentSessionId: SESSION_ID,
      issueIdentifier: 'AGE-5',
      issueTitle: issue.title,
      guidance: 'Always open a draft PR.'
    })
    expect(bag.promptContext).toContain('AGE-5')
    expect(bag.truncated).toBeUndefined()
  })

  it('carries the follow-up body VERBATIM for a prompted event', async () => {
    const h = host()
    const { forwarded } = await run(h, promptedEvent())
    expect(forwarded?.text).toBe('Follow-up: does this reopen the session?')
    expect(forwarded?.sender).toMatchObject({ id: `linear:${USER_ID}`, name: 'Example Person' })
  })

  it('also reads the DOCUMENTED prompted shape, where the body sits on the activity itself', async () => {
    // Live deliveries nest the prompt under `content`; the docs describe `agentActivity.body`.
    // Reading only one shape would forward an empty instruction for the other.
    const h = host()
    const documented = promptedEvent({}, { content: null, body: 'Documented-shape follow-up' })
    expect((await run(h, documented)).forwarded?.text).toBe('Documented-shape follow-up')
  })

  it('keys a session with NO issue on the session UUID — never `linear:undefined`', async () => {
    const h = host()
    const noIssue = createdEvent()
    ;(noIssue.agentSession as Record<string, unknown>).issue = null
    const { forwarded } = await run(h, noIssue)
    expect(forwarded?.channel).toBe(SESSION_ID)
    expect(forwarded?.thread).toBe(SESSION_ID)
    expect(forwarded?.threadUrl).toBeUndefined()
    expect(JSON.stringify(forwarded)).not.toContain('undefined')
  })

  it('falls back to the session id for an unattributed sender rather than fabricating one', async () => {
    const h = host()
    const unattributed = createdEvent()
    ;(unattributed.agentSession as Record<string, unknown>).creatorId = null
    expect((await run(h, unattributed)).forwarded?.sender.id).toBe(`linear:${SESSION_ID}`)
  })

  it('never lets the instruction live only inside the fenced context', async () => {
    const h = host()
    const bare = createdEvent()
    ;(bare.agentSession as Record<string, unknown>).comment = null
    // A bare delegation has no comment line; the issue title is the member's instruction.
    expect((await run(h, bare)).forwarded?.text).toBe(issue.title)
  })
})

describe('linear ingress plugin — truncation budget', () => {
  it('cuts promptContext to the 32 KiB budget and flags the bag', async () => {
    const h = host()
    const huge = 'a'.repeat(LINEAR_CONTEXT_BUDGET_BYTES * 2)
    const { forwarded } = await run(h, createdEvent({ promptContext: huge }))
    const bag = forwarded!.adapterExt!.linear as LinearAdapterExt
    expect(Buffer.byteLength(bag.promptContext!, 'utf8')).toBe(LINEAR_CONTEXT_BUDGET_BYTES)
    expect(bag.truncated).toBe(true)
  })

  it('cuts on a code-point boundary, so a multi-byte body never rides at 3x the cap', async () => {
    const h = host()
    // A 3-byte code point does not divide the budget evenly, so a naive byte cut would split one.
    const { forwarded } = await run(h, createdEvent({ promptContext: '€'.repeat(LINEAR_CONTEXT_BUDGET_BYTES) }))
    const bag = forwarded!.adapterExt!.linear as LinearAdapterExt
    expect(Buffer.byteLength(bag.promptContext!, 'utf8')).toBeLessThanOrEqual(LINEAR_CONTEXT_BUDGET_BYTES)
    expect(bag.promptContext).not.toContain('�')
  })

  it('spends ONE budget across promptContext and previousComments, dropping the overflow', async () => {
    const h = host()
    const previousComments = [
      { id: 'c1', body: 'b'.repeat(LINEAR_CONTEXT_BUDGET_BYTES) },
      { id: 'c2', body: 'this one no longer fits' }
    ]
    const { forwarded } = await run(h, createdEvent({ promptContext: 'x'.repeat(1024), previousComments }))
    const bag = forwarded!.adapterExt!.linear as LinearAdapterExt
    const spent =
      Buffer.byteLength(bag.promptContext!, 'utf8') +
      bag.previousComments!.reduce((sum, c) => sum + Buffer.byteLength(c.body ?? '', 'utf8'), 0)
    expect(spent).toBeLessThanOrEqual(LINEAR_CONTEXT_BUDGET_BYTES)
    expect(bag.previousComments).toHaveLength(1)
    expect(bag.truncated).toBe(true)
  })

  it('keeps only the listed comment fields, so a commenter email can never ride the bag', async () => {
    const h = host()
    const previousComments = [{ id: 'c1', body: 'hello', userId: USER_ID, email: 'person@example.test' }]
    const { forwarded } = await run(h, createdEvent({ previousComments }))
    const bag = forwarded!.adapterExt!.linear as LinearAdapterExt
    expect(bag.previousComments).toEqual([{ id: 'c1', body: 'hello', userId: USER_ID }])
  })
})

describe('linear ingress plugin — stop, revocation, and non-session events', () => {
  it('routes a stop signal as a platform_action, not a message', async () => {
    const h = host()
    await run(h, promptedEvent({}, { signal: 'stop' }))
    expect(h.forward).not.toHaveBeenCalled()
    expect(h.forwardAction).toHaveBeenCalledTimes(1)
    const [msg, route] = vi.mocked(h.forwardAction).mock.calls[0]!
    expect(msg).toMatchObject({
      source: 'platform_action',
      platformId: 'linear',
      agentId: ROUTE.agentId,
      integrationId: ROUTE.integrationId,
      msgId: `linear:${ACTIVITY_ID}`,
      userId: USER_ID,
      payload: { kind: 'stop', agentSessionId: SESSION_ID }
    })
    expect(route).toEqual(ROUTE)
  })

  it('drops a stop the directory can no longer place', async () => {
    const h = host({
      directory: { ...host().directory, resolveTarget: () => undefined }
    })
    await run(h, promptedEvent({}, { signal: 'stop' }))
    expect(h.forwardAction).not.toHaveBeenCalled()
  })

  it('rings the revocation doorbell with the OBSERVING assignment revision', async () => {
    const h = host()
    await run(h, { type: 'OAuthApp', action: 'revoked', organizationId: ORG_ID, webhookTimestamp: NOW })
    expect(h.reportRevoked).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'tokens_revoked', NOW, 7)
  })

  it('drops any other verified event category without forwarding or reporting', async () => {
    const h = host()
    const { verified } = await run(h, {
      type: 'Issue',
      action: 'update',
      organizationId: ORG_ID,
      webhookTimestamp: NOW
    })
    expect(verified).toEqual({ kind: 'ignored' })
    expect(h.forward).not.toHaveBeenCalled()
    expect(h.reportRevoked).not.toHaveBeenCalled()
  })

  it('drops a malformed AgentSessionEvent as ignored rather than answering 401', async () => {
    const h = host()
    const { verified } = await run(h, {
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: ORG_ID,
      oauthClientId: CLIENT_ID,
      webhookTimestamp: NOW
    })
    expect(verified).toEqual({ kind: 'ignored' })
  })
})

describe('linear ingress plugin — per-bot ingress bucket', () => {
  it('throttles a burst without marking the dropped deliveries seen', async () => {
    const seen = new Set<string>()
    const h = host({
      dedupSeen: (identity) => {
        if (identity === undefined) return false
        if (seen.has(identity)) return true
        seen.add(identity)
        return false
      }
    })
    const ingest = linearIngressPlugin.buildIngest(assignment(), h)!
    for (let i = 0; i < 20; i++) {
      const body = createdEvent()
      ;(body.agentSession as Record<string, unknown>).id = `${SESSION_ID}-${i}`
      const d = delivery(body)
      const verified = linearIngressPlugin.verify(ingest, d.raw, d.body, d.headers, NOW)!
      await linearIngressPlugin.handle(ingest, verified, h)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Default bucket: capacity 10, and the throttled half never entered the dedup table, so
    // Linear's retry ladder can still deliver them.
    expect(vi.mocked(h.forward).mock.calls).toHaveLength(10)
    expect(seen.size).toBe(10)
  })
})

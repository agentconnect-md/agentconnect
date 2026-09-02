import { describe, it, expect } from 'vitest'
import {
  HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
  HOOK_DELIVERY_REASON_DAEMON_DRAINING,
  HOOK_DELIVERY_REASON_DAEMON_NOT_HOLDER,
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  RETRYABLE_HOOK_DELIVERY_REASONS,
  isRetryableHookDeliveryReason,
  RcVerify,
  RcVerifyResult,
  RcDaemonRevoke,
  RcHookAssign,
  RcHookRerun,
  RcHookRerunResult,
  RcRunReport,
  RcGithubInstallation,
  RcGithubRerequest,
  RcGithubRerequestResult,
  SharedSlackStatusTarget,
  decodeSlackStatusOverflowValue,
  encodeSlackStatusOverflowValue,
  decodeSharedSlackStatusTarget,
  encodeSharedSlackStatusTarget,
  RELAY_CP_FRAME_TYPES,
  buildRelayCpFrame,
  decodeRelayCpFrame,
  isRelayCpFrameType,
  decodeEnvelope,
  buildEnvelope,
  encode,
  MAX_FRAME_BYTES
} from '../index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const RELAY_ID = '55555555-5555-4555-8555-555555555555'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444'
const HOOK_ID = '88888888-8888-4888-8888-888888888888'
const AUTHORITY_ID = '99999999-9999-4999-8999-999999999999'
const TS = '2026-07-07T00:00:00.000Z'

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload, ...extra })
}

describe('relay↔CP wire — skeleton frame codec (shared-bot-relay.md §7.1)', () => {
  it('round-trips rc/register → rc/registered', () => {
    // daemonUrl is the per-instance-routable dial address (NOT the pool ingress)
    const req = buildRelayCpFrame('rc/register', { name: 'relay-0', daemonUrl: 'wss://relay-0.example' })
    const decodedReq = decodeRelayCpFrame(JSON.stringify(req))
    expect(decodedReq.ok).toBe(true)
    if (!decodedReq.ok) throw new Error('expected ok')
    expect(decodedReq.frame.type).toBe('rc/register')
    if (decodedReq.frame.type !== 'rc/register') throw new Error('narrow')
    expect(decodedReq.frame.payload.daemonUrl).toBe('wss://relay-0.example')

    const rep = buildRelayCpFrame('rc/registered', { relayId: RELAY_ID }, { corr: req.id })
    const decodedRep = decodeRelayCpFrame(JSON.stringify(rep))
    expect(decodedRep.ok).toBe(true)
    if (!decodedRep.ok) throw new Error('expected ok')
    expect(decodedRep.frame.corr).toBe(req.id)
    if (decodedRep.frame.type !== 'rc/registered') throw new Error('narrow')
    expect(decodedRep.frame.payload.relayId).toBe(RELAY_ID)
  })

  it('decodes rc/auth for both methods and rejects an unknown method / empty credential', () => {
    for (const method of ['token', 'apikey'] as const) {
      const r = decodeRelayCpFrame(envelope('rc/auth', { method, credential: 's'.repeat(43) }))
      expect(r.ok).toBe(true)
    }
    expect(decodeRelayCpFrame(envelope('rc/auth', { method: 'mtls', credential: 'x' })).ok).toBe(false)
    expect(decodeRelayCpFrame(envelope('rc/auth', { method: 'token', credential: '' })).ok).toBe(false)
  })

  it('carries an optional secret-bearing deployment snapshot on rc/auth/ok', () => {
    const frame = envelope('rc/auth/ok', {
      heartbeatSec: 15,
      serverTime: '2026-08-05T00:00:00.000Z',
      deploymentConfig: { revision: 3, githubWebhookSecret: 'ghw_secret' }
    })
    const decoded = decodeRelayCpFrame(frame)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rc/auth/ok') throw new Error('expected rc/auth/ok')
    expect(decoded.frame.payload.deploymentConfig).toEqual({ revision: 3, githubWebhookSecret: 'ghw_secret' })

    expect(
      decodeRelayCpFrame(
        envelope('rc/auth/ok', {
          heartbeatSec: 15,
          serverTime: '2026-08-05T00:00:00.000Z',
          deploymentConfig: { revision: 3, githubWebhookSecret: '' }
        })
      ).ok
    ).toBe(false)
  })

  it('decodes rc/heartbeat (empty payload)', () => {
    const r = decodeRelayCpFrame(envelope('rc/heartbeat', {}))
    expect(r.ok).toBe(true)
  })

  it('rc/verify enforces the kind enum', () => {
    expect(RcVerify.safeParse({ kind: 'daemon-key', credential: 'k' }).success).toBe(true)
    expect(RcVerify.safeParse({ kind: 'webchat-token', credential: 't' }).success).toBe(true)
    expect(RcVerify.safeParse({ kind: 'webchat-token', credential: 't', conversationBinding: 'v1' }).success).toBe(true)
    expect(RcVerify.safeParse({ kind: 'webchat-token', credential: 't', conversationBinding: 'v0' }).success).toBe(
      false
    )
    expect(RcVerify.safeParse({ kind: 'slack-token', credential: 'x' }).success).toBe(false)
    expect(RcVerify.safeParse({ kind: 'daemon-key', credential: '' }).success).toBe(false)
  })

  it('rc/verify/ok carries per-kind identity fields and a bare rejection', () => {
    // daemon-key success
    expect(RcVerifyResult.safeParse({ ok: true, daemonId: DAEMON_ID, orgId: 'org_x' }).success).toBe(true)
    // webchat-token success (routing target resolved at verify time)
    const webchat = RcVerifyResult.safeParse({
      ok: true,
      userId: 'usr_1',
      user: 'user@example.com',
      userPicture: 'https://cdn.example.test/avatars/usr_1.png',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      orgId: 'org_x',
      conversationId: '33333333-3333-4333-8333-333333333333'
    })
    expect(webchat.success).toBe(true)
    // The avatar is a URL a platform will fetch, never free text.
    expect(RcVerifyResult.safeParse({ ok: true, userPicture: 'not a url' }).success).toBe(false)
    expect(
      RcVerifyResult.safeParse({
        ok: true,
        agentId: AGENT_ID,
        daemonId: DAEMON_ID,
        conversationId: 'not-a-uuid'
      }).success
    ).toBe(false)
    // rejection carries no identity (no existence oracle)
    expect(RcVerifyResult.safeParse({ ok: false, reason: 'expired' }).success).toBe(true)
    expect(RcVerifyResult.safeParse({ ok: false }).success).toBe(true)
  })

  it('round-trips webchat verification results with and without remote-MCP entitlement', () => {
    const legacyPayload = {
      ok: true,
      userId: 'usr_1',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      orgId: 'org_x',
      conversationId: AGENT_ID
    }
    const legacy = decodeRelayCpFrame(envelope('rc/verify/ok', legacyPayload))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok || legacy.frame.type !== 'rc/verify/ok') throw new Error('expected legacy verification result')
    expect(legacy.frame.payload.remoteMcp).toBeUndefined()

    const remoteMcp = { authorityId: AUTHORITY_ID, authorityGeneration: 2, expiresAt: TS }
    const current = buildRelayCpFrame('rc/verify/ok', { ...legacyPayload, remoteMcp })
    const decoded = decodeRelayCpFrame(JSON.stringify(current))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rc/verify/ok') throw new Error('expected remote-MCP verification result')
    expect(decoded.frame.payload.remoteMcp).toEqual(remoteMcp)
  })

  it('rejects malformed remote-MCP entitlements', () => {
    const base = {
      ok: true,
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      conversationId: AGENT_ID
    }
    expect(
      RcVerifyResult.safeParse({
        ...base,
        remoteMcp: { authorityId: 'bad', authorityGeneration: 1, expiresAt: TS }
      }).success
    ).toBe(false)
    expect(
      RcVerifyResult.safeParse({
        ...base,
        remoteMcp: { authorityId: AUTHORITY_ID, authorityGeneration: 0, expiresAt: TS }
      }).success
    ).toBe(false)
  })

  it('round-trips correlated rc/github-comment-authz → rc/github-comment-authz/ok', () => {
    const payload = {
      hookId: HOOK_ID,
      installationId: '12345',
      repoId: '67890',
      repoFullName: 'acme/infra',
      senderLogin: 'octocat',
      subjectAuthorLogin: 'issue-author',
      configRevision: '7',
      dispatchRevision: '9',
      siblingFences: [
        {
          hookId: '99999999-9999-4999-8999-999999999999',
          configRevision: '11',
          dispatchRevision: '13'
        }
      ]
    }
    const req = buildRelayCpFrame('rc/github-comment-authz', payload)
    const decodedReq = decodeRelayCpFrame(JSON.stringify(req))
    expect(decodedReq.ok).toBe(true)
    if (!decodedReq.ok || decodedReq.frame.type !== 'rc/github-comment-authz') throw new Error('expected authz req')
    expect(decodedReq.frame.payload).toEqual(payload)

    const rep = buildRelayCpFrame('rc/github-comment-authz/ok', { allowed: true }, { corr: req.id })
    const decodedRep = decodeRelayCpFrame(JSON.stringify(rep))
    expect(decodedRep.ok).toBe(true)
    if (!decodedRep.ok || decodedRep.frame.type !== 'rc/github-comment-authz/ok') {
      throw new Error('expected authz rep')
    }
    expect(decodedRep.frame.corr).toBe(req.id)
    expect(decodedRep.frame.payload).toEqual({ allowed: true })
  })

  it('rc/github-comment-authz rejects malformed repository identity metadata', () => {
    const decoded = decodeRelayCpFrame(
      envelope('rc/github-comment-authz', {
        hookId: HOOK_ID,
        installationId: '12345',
        repoId: 'not-a-number',
        repoFullName: 'acme/infra',
        senderLogin: 'octocat',
        configRevision: '7',
        dispatchRevision: '9'
      })
    )
    expect(decoded.ok).toBe(false)
  })

  it('round-trips correlated rc/codehost-membership-authz → its one-bit reply', () => {
    const payload = {
      hookId: HOOK_ID,
      provider: 'gitlab',
      repoExternalId: '4455667',
      actorExternalId: '778899',
      subjectAuthorExternalId: '221133',
      configRevision: '7',
      dispatchRevision: '9',
      siblingFences: [{ hookId: '99999999-9999-4999-8999-999999999999', configRevision: '11', dispatchRevision: '13' }]
    }
    const req = buildRelayCpFrame('rc/codehost-membership-authz', payload)
    const decodedReq = decodeRelayCpFrame(JSON.stringify(req))
    expect(decodedReq.ok).toBe(true)
    if (!decodedReq.ok || decodedReq.frame.type !== 'rc/codehost-membership-authz') {
      throw new Error('expected membership authz req')
    }
    expect(decodedReq.frame.payload).toEqual(payload)

    const rep = buildRelayCpFrame('rc/codehost-membership-authz/ok', { allowed: false }, { corr: req.id })
    const decodedRep = decodeRelayCpFrame(JSON.stringify(rep))
    expect(decodedRep.ok).toBe(true)
    if (!decodedRep.ok || decodedRep.frame.type !== 'rc/codehost-membership-authz/ok') {
      throw new Error('expected membership authz rep')
    }
    expect(decodedRep.frame.corr).toBe(req.id)
    expect(decodedRep.frame.payload).toEqual({ allowed: false })
  })

  it('rc/codehost-membership-authz keys on numeric identity, never a display path', () => {
    const base = {
      hookId: HOOK_ID,
      provider: 'gitlab',
      repoExternalId: '4455667',
      actorExternalId: '778899',
      configRevision: '7',
      dispatchRevision: '9'
    }
    expect(decodeRelayCpFrame(envelope('rc/codehost-membership-authz', base)).ok).toBe(true)
    expect(
      decodeRelayCpFrame(
        envelope('rc/codehost-membership-authz', { ...base, repoExternalId: 'example-group/example-project' })
      ).ok
    ).toBe(false)
    expect(
      decodeRelayCpFrame(envelope('rc/codehost-membership-authz', { ...base, actorExternalId: 'octocat' })).ok
    ).toBe(false)
  })

  it('round-trips correlated rc/github-rerequest metadata and its fenced dispatch result', () => {
    const request = {
      checkRunId: '86617583005',
      repoId: '987654321',
      headSha: 'a'.repeat(40),
      deliveryKey: 'delivery-rerun-1',
      includeBaseSha: true as const
    }
    expect(RcGithubRerequest.safeParse(request).success).toBe(true)
    const req = buildRelayCpFrame('rc/github-rerequest', request)
    const decodedReq = decodeRelayCpFrame(JSON.stringify(req))
    expect(decodedReq.ok).toBe(true)
    if (!decodedReq.ok || decodedReq.frame.type !== 'rc/github-rerequest') throw new Error('expected rerequest req')
    expect(decodedReq.frame.payload).toEqual(request)

    const result = {
      allowed: true as const,
      hookId: HOOK_ID,
      pullNumber: 585,
      baseSha: 'b'.repeat(40),
      configRevision: '7',
      dispatchRevision: '9'
    }
    expect(RcGithubRerequestResult.safeParse(result).success).toBe(true)
    expect(RcGithubRerequestResult.safeParse({ ...result, baseSha: undefined }).success).toBe(true)
    const rep = buildRelayCpFrame('rc/github-rerequest/ok', result, { corr: req.id })
    const decodedRep = decodeRelayCpFrame(JSON.stringify(rep))
    expect(decodedRep.ok).toBe(true)
    if (!decodedRep.ok || decodedRep.frame.type !== 'rc/github-rerequest/ok') throw new Error('expected rerequest rep')
    expect(decodedRep.frame.corr).toBe(req.id)
    expect(decodedRep.frame.payload).toEqual(result)
    expect(RcGithubRerequestResult.safeParse({ allowed: false }).success).toBe(true)
  })

  it('round-trips an App-owned Check Suite rerequest and its resolved targets', () => {
    const request = {
      scope: 'suite' as const,
      appId: '4157507',
      installationId: '12345',
      repoId: '987654321',
      headSha: 'a'.repeat(40),
      deliveryKey: 'delivery-suite-rerun-1'
    }
    const req = buildRelayCpFrame('rc/github-rerequest', request)
    const decodedReq = decodeRelayCpFrame(JSON.stringify(req))
    expect(decodedReq.ok).toBe(true)
    if (!decodedReq.ok || decodedReq.frame.type !== 'rc/github-rerequest') throw new Error('expected rerequest req')
    expect(decodedReq.frame.payload).toEqual(request)

    const result = {
      allowed: true as const,
      targets: [
        {
          hookId: HOOK_ID,
          pullNumber: 585,
          baseSha: 'b'.repeat(40),
          configRevision: '7',
          dispatchRevision: '9'
        }
      ]
    }
    const rep = buildRelayCpFrame('rc/github-rerequest/ok', result, { corr: req.id })
    const decodedRep = decodeRelayCpFrame(JSON.stringify(rep))
    expect(decodedRep.ok).toBe(true)
    if (!decodedRep.ok || decodedRep.frame.type !== 'rc/github-rerequest/ok') throw new Error('expected rerequest rep')
    expect(decodedRep.frame.payload).toEqual(result)
  })

  it('round-trips a workflow approval lookup for waiting external-PR reviews', () => {
    const request = {
      scope: 'workflow' as const,
      installationId: '12345',
      repoId: '987654321',
      headSha: 'a'.repeat(40),
      pullNumber: 585,
      deliveryKey: 'delivery-workflow-start-1'
    }
    const req = buildRelayCpFrame('rc/github-rerequest', request)
    const decoded = decodeRelayCpFrame(JSON.stringify(req))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rc/github-rerequest') throw new Error('expected rerequest req')
    expect(decoded.frame.payload).toEqual(request)
  })

  it('rejects malformed rc/github-rerequest identities and incomplete allow results', () => {
    expect(RcGithubRerequest.safeParse({ checkRunId: '0', repoId: '1', headSha: 'a', deliveryKey: 'd' }).success).toBe(
      false
    )
    expect(
      RcGithubRerequest.safeParse({
        scope: 'suite',
        appId: '0',
        installationId: '1',
        repoId: '1',
        headSha: 'a',
        deliveryKey: 'd'
      }).success
    ).toBe(false)
    expect(
      RcGithubRerequestResult.safeParse({
        allowed: true,
        hookId: HOOK_ID,
        pullNumber: 585,
        baseSha: 'b'.repeat(40)
      }).success
    ).toBe(false)
    expect(RcGithubRerequestResult.safeParse({ allowed: true, targets: [] }).success).toBe(false)
  })

  it('rc/daemon-revoke requires a UUID daemonId', () => {
    expect(RcDaemonRevoke.safeParse({ daemonId: DAEMON_ID }).success).toBe(true)
    expect(RcDaemonRevoke.safeParse({ daemonId: 'not-a-uuid' }).success).toBe(false)
    const r = decodeRelayCpFrame(envelope('rc/daemon-revoke', { daemonId: DAEMON_ID }))
    expect(r.ok).toBe(true)
  })

  it('round-trips a versioned shared Slack status target and rejects tampering', () => {
    const encoded = encodeSharedSlackStatusTarget({
      agentId: AGENT_ID,
      integrationId: RELAY_ID,
      sessionKey: 'slack:C1:1710000000.000100:agent'
    })
    expect(decodeSharedSlackStatusTarget(encoded)).toEqual({
      v: 1,
      agentId: AGENT_ID,
      integrationId: RELAY_ID,
      sessionKey: 'slack:C1:1710000000.000100:agent'
    })
    expect(decodeSharedSlackStatusTarget('not-json')).toBeNull()
    expect(
      decodeSharedSlackStatusTarget(
        JSON.stringify({ v: 2, agentId: AGENT_ID, integrationId: RELAY_ID, sessionKey: 'k' })
      )
    ).toBeNull()
    expect(
      SharedSlackStatusTarget.safeParse({
        v: 1,
        agentId: AGENT_ID,
        integrationId: RELAY_ID,
        sessionKey: 'k',
        daemonId: DAEMON_ID
      }).success
    ).toBe(false)
  })

  it('round-trips a compact Slack status overflow choice', () => {
    const encoded = encodeSlackStatusOverflowValue('switch-agent')
    expect(encoded.length).toBeLessThanOrEqual(150)
    expect(decodeSlackStatusOverflowValue(encoded)).toEqual({ action: 'switch-agent' })
    expect(decodeSlackStatusOverflowValue(JSON.stringify({ v: 1, action: 'manage', target: 'legacy-target' }))).toEqual(
      { action: 'manage', target: 'legacy-target' }
    )
    expect(decodeSlackStatusOverflowValue('unknown')).toBeNull()
  })

  it('round-trips rc/bot-assign with attributed routes (§7.1 / §10)', () => {
    const assign = {
      botId: DAEMON_ID,
      platform: 'slack' as const,
      botUserId: 'UBOT',
      secrets: { botToken: 'xoxb-x', signingSecret: 'sign-x' },
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      routes: [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: RELAY_ID,
          scope: { channel: 'C1' },
          match: { kind: 'auto' as const }
        },
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: RELAY_ID,
          match: { kind: 'keyword' as const, value: 'alice' }
        }
      ],
      defaultAgentId: AGENT_ID,
      defaultDaemonId: DAEMON_ID
    }
    const r = decodeRelayCpFrame(envelope('rc/bot-assign', assign))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rc/bot-assign') throw new Error('narrow')
    expect(r.frame.payload.routes).toHaveLength(2)
    if (!('signingSecret' in r.frame.payload.secrets)) throw new Error('expected Slack secrets')
    expect(r.frame.payload.secrets.signingSecret).toBe('sign-x')
  })

  it('round-trips a Feishu HTTP assignment without provider API credentials', () => {
    const r = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: DAEMON_ID,
        platform: 'feishu',
        apiAppId: 'cli_example',
        botUserId: 'ou_bot',
        secrets: { verificationToken: 'verify-x', encryptKey: 'encrypt-x' },
        members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
        agents: [{ agentId: AGENT_ID, name: 'alice', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID }],
        routes: []
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || r.frame.type !== 'rc/bot-assign') throw new Error('expected Feishu assignment')
    expect(r.frame.payload.secrets).toEqual({ verificationToken: 'verify-x', encryptKey: 'encrypt-x' })
    expect(r.frame.payload.agents[0]?.integrationId).toBe(INTEGRATION_ID)
    expect('botToken' in r.frame.payload.secrets).toBe(false)
  })

  it('rc/bot-assign: an incomplete typed secret bag decodes but is refused by the ASSIGNMENT reader (§6.7)', () => {
    // Pre-§6.7 the schema itself rejected a bot-token-only bag. The open reader
    // deliberately relinquishes per-shape schema validation (an unknown platform's
    // opaque bag must decode), so shape enforcement moved to the relay's assignment
    // mapper — `toBotAssignment` refuses a bag missing the signing secret before any
    // credential is touched, and the S3 platform module takes validation over.
    const r = decodeRelayCpFrame(
      envelope('rc/bot-assign', {
        botId: DAEMON_ID,
        platform: 'slack',
        secrets: { botToken: 'xoxb-x' },
        members: [],
        routes: []
      })
    )
    expect(r.ok).toBe(true)
  })

  it('decodes rc/bot-unassign, rc/routes and rc/assign', () => {
    expect(decodeRelayCpFrame(envelope('rc/bot-unassign', { botId: DAEMON_ID })).ok).toBe(true)
    expect(decodeRelayCpFrame(envelope('rc/routes', { botId: DAEMON_ID, members: [], routes: [] })).ok).toBe(true)
    expect(
      decodeRelayCpFrame(
        envelope('rc/assign', { botId: DAEMON_ID, sessionKey: 'C1/ts', agentId: AGENT_ID, daemonId: DAEMON_ID })
      ).ok
    ).toBe(true)
    // sessionKey must be non-empty
    expect(
      decodeRelayCpFrame(
        envelope('rc/assign', { botId: DAEMON_ID, sessionKey: '', agentId: AGENT_ID, daemonId: DAEMON_ID })
      ).ok
    ).toBe(false)
  })

  it('round-trips an HTTP Slack bot channel-membership snapshot', () => {
    const decoded = decodeRelayCpFrame(
      envelope('rc/bot-channels', {
        botId: DAEMON_ID,
        channels: [{ id: 'C1', name: 'deploys' }, { id: 'C2', name: 'ops', isPrivate: true }, { id: 'C3' }]
      })
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (decoded.frame.type !== 'rc/bot-channels') throw new Error('narrow')
    expect(decoded.frame.payload.channels).toEqual([
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'ops', isPrivate: true },
      { id: 'C3' }
    ])
  })

  it('round-trips rc/mcp-assign (upstream binding + grant hashes) and rc/mcp-unassign (whole + single-key)', () => {
    const assign = decodeRelayCpFrame(
      envelope('rc/mcp-assign', {
        providerId: RELAY_ID,
        upstreamUrl: 'https://mcp.notion.com/v1',
        headers: [{ name: 'Authorization', value: 'Bearer upstream-secret' }],
        grantKeyHashes: ['sha256-of-grant']
      })
    )
    expect(assign.ok).toBe(true)
    if (!assign.ok) throw new Error('expected ok')
    if (assign.frame.type !== 'rc/mcp-assign') throw new Error('narrow')
    expect(assign.frame.payload.upstreamUrl).toBe('https://mcp.notion.com/v1')
    expect(assign.frame.payload.grantKeyHashes).toEqual(['sha256-of-grant'])
    // headers default to [], but grantKeyHashes is the bearer-key allowlist — an empty/absent
    // set is REJECTED (never "unrestricted"); a keyless or empty-string-hash binding won't decode.
    expect(decodeRelayCpFrame(envelope('rc/mcp-assign', { providerId: RELAY_ID, upstreamUrl: 'https://x' })).ok).toBe(
      false
    )
    expect(
      decodeRelayCpFrame(
        envelope('rc/mcp-assign', { providerId: RELAY_ID, upstreamUrl: 'https://x', grantKeyHashes: [] })
      ).ok
    ).toBe(false)
    expect(
      decodeRelayCpFrame(
        envelope('rc/mcp-assign', { providerId: RELAY_ID, upstreamUrl: 'https://x', grantKeyHashes: [''] })
      ).ok
    ).toBe(false)
    // unassign: whole provider, and a single rotated key
    expect(decodeRelayCpFrame(envelope('rc/mcp-unassign', { providerId: RELAY_ID })).ok).toBe(true)
    expect(
      decodeRelayCpFrame(envelope('rc/mcp-unassign', { providerId: RELAY_ID, grantKeyHash: 'sha256-old' })).ok
    ).toBe(true)
  })

  it('round-trips revision-fenced external-memory relay bindings', () => {
    const grantHash = 'a'.repeat(64)
    const assign = decodeRelayCpFrame(
      envelope('rc/memoryconnection-assign', {
        connectionId: RELAY_ID,
        revision: 7,
        upstreamUrl: 'https://memory.example/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer upstream-secret' }],
        grantKeyHashes: [grantHash]
      })
    )
    expect(assign.ok).toBe(true)
    if (!assign.ok || assign.frame.type !== 'rc/memoryconnection-assign') throw new Error('narrow')
    expect(assign.frame.payload.revision).toBe(7)
    expect(
      decodeRelayCpFrame(
        envelope('rc/memoryconnection-unassign', {
          connectionId: RELAY_ID,
          revision: 8
        })
      ).ok
    ).toBe(true)
    expect(
      decodeRelayCpFrame(
        envelope('rc/memoryconnection-assign', {
          connectionId: RELAY_ID,
          revision: 1,
          upstreamUrl: 'https://memory.example/mcp',
          grantKeyHashes: ['x']
        })
      ).ok
    ).toBe(false)
  })

  it('round-trips the thread-affinity and participant frames', () => {
    // compatibility-owner report leg
    expect(
      decodeRelayCpFrame(
        envelope('rc/thread-assign', {
          botId: DAEMON_ID,
          sessionKey: 'C1/ts',
          agentId: AGENT_ID,
          daemonId: DAEMON_ID
        })
      ).ok
    ).toBe(true)
    // participant report and pool-broadcast legs stay distinct from owner affinity
    expect(
      decodeRelayCpFrame(
        envelope('rc/thread-participant', {
          botId: DAEMON_ID,
          sessionKey: 'C1/ts',
          agentId: AGENT_ID,
          daemonId: DAEMON_ID
        })
      ).ok
    ).toBe(true)
    expect(
      decodeRelayCpFrame(
        envelope('rc/participant-assign', {
          botId: DAEMON_ID,
          sessionKey: 'C1/ts',
          agentId: AGENT_ID,
          daemonId: DAEMON_ID
        })
      ).ok
    ).toBe(true)
    // sessionKey must be non-empty
    expect(
      decodeRelayCpFrame(
        envelope('rc/thread-assign', { botId: DAEMON_ID, sessionKey: '', agentId: AGENT_ID, daemonId: DAEMON_ID })
      ).ok
    ).toBe(false)
    // backstop request leg
    expect(decodeRelayCpFrame(envelope('rc/thread-lookup', { botId: DAEMON_ID, sessionKey: 'C1/ts' })).ok).toBe(true)
    // reply leg — a hit
    const hit = decodeRelayCpFrame(
      envelope('rc/thread-lookup/ok', {
        botId: DAEMON_ID,
        sessionKey: 'C1/ts',
        target: { agentId: AGENT_ID, daemonId: DAEMON_ID },
        participants: [{ agentId: AGENT_ID, daemonId: DAEMON_ID }]
      })
    )
    expect(hit.ok).toBe(true)
    if (!hit.ok) throw new Error('expected ok')
    if (hit.frame.type !== 'rc/thread-lookup/ok') throw new Error('narrow')
    expect(hit.frame.payload.target?.agentId).toBe(AGENT_ID)
    expect(hit.frame.payload.participants).toEqual([{ agentId: AGENT_ID, daemonId: DAEMON_ID }])
    // reply leg — a miss (no binding)
    expect(
      decodeRelayCpFrame(envelope('rc/thread-lookup/ok', { botId: DAEMON_ID, sessionKey: 'C1/ts', target: null })).ok
    ).toBe(true)
  })

  it('rc/hook-assign round-trips a webhook rule and a github rule (B-github)', () => {
    const HOOK_ID = '88888888-8888-4888-8888-888888888888'
    const base = {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      sessionMode: 'perDelivery' as const
    }
    const webhook = { ...base, kind: 'webhook' as const, webhook: { urlToken: 't'.repeat(32), hmacSecret: 's3cret' } }
    const r = decodeRelayCpFrame(envelope('rc/hook-assign', webhook))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rc/hook-assign') throw new Error('narrow')
    expect(r.frame.payload.webhook?.urlToken).toBe('t'.repeat(32))

    const github = {
      ...base,
      kind: 'github' as const,
      sessionMode: 'perThread' as const,
      configRevision: '3',
      dispatchRevision: '5',
      dispatchDaemonId: DAEMON_ID,
      reviewPolicy: 'full' as const,
      reportingMode: 'check' as const,
      gateMode: 'informational' as const,
      target: { platform: 'slack', channel: 'C123' },
      github: {
        repoId: '123456789',
        repoFullName: 'acme/infra',
        sessionKeyPrefix: 'github:123456789',
        events: ['issues:opened', 'issue_comment:created'],
        labelFilter: [],
        commentFamilies: ['issues' as const],
        mentionOnly: true,
        appSlug: 'example-review-app', // P3 broadcast mention handle
        agentName: 'review-agent', // P3 targeted mention handle
        installationIds: ['1234567']
      }
    }
    const g = decodeRelayCpFrame(envelope('rc/hook-assign', github))
    expect(g.ok).toBe(true)
    if (g.ok && g.frame.type === 'rc/hook-assign') {
      expect(g.frame.payload.github?.appSlug).toBe('example-review-app')
      expect(g.frame.payload.github?.agentName).toBe('review-agent')
      expect(g.frame.payload.github?.sessionKeyPrefix).toBe('github:123456789')
      expect(g.frame.payload.github?.commentFamilies).toEqual(['issues'])
      expect(g.frame.payload.dispatchRevision).toBe('5')
    }
    // Mention handles and commentFamilies are optional — older CP rules still
    // decode; an explicitly empty scope retains the legacy repo-wide meaning.
    const legacyGithub = {
      ...github,
      github: {
        ...github.github,
        appSlug: undefined,
        agentName: undefined,
        sessionKeyPrefix: undefined,
        commentFamilies: undefined
      }
    }
    expect(RcHookAssign.safeParse(legacyGithub).success).toBe(true)
    // The whole R1/R2a tuple is rolling-compatible. Consumers fail closed when
    // it is absent; the relay never invents a revision for this legacy rule.
    expect(
      RcHookAssign.safeParse({
        ...legacyGithub,
        configRevision: undefined,
        dispatchRevision: undefined,
        dispatchDaemonId: undefined,
        reviewPolicy: undefined,
        reportingMode: undefined,
        gateMode: undefined
      }).success
    ).toBe(true)
    expect(RcHookAssign.safeParse({ ...github, github: { ...github.github, commentFamilies: [] } }).success).toBe(true)
    expect(
      RcHookAssign.safeParse({ ...github, github: { ...github.github, commentFamilies: ['discussions'] } }).success
    ).toBe(false)

    // rule shape is enforced: sessionMode enum, uuid ids
    expect(RcHookAssign.safeParse({ ...base, kind: 'webhook', sessionMode: 'sticky' }).success).toBe(false)
    expect(RcHookAssign.safeParse({ ...webhook, daemonId: 'nope' }).success).toBe(false)
    expect(RcHookAssign.safeParse({ ...github, dispatchDaemonId: RELAY_ID }).success).toBe(false)

    const rm = decodeRelayCpFrame(envelope('rc/hook-remove', { hookId: HOOK_ID }))
    expect(rm.ok).toBe(true)
  })

  it('a gitlab rule decodes with or without the removed label filter (§17.3)', () => {
    const gitlab = {
      hookId: '88888888-8888-4888-8888-888888888888',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      kind: 'gitlab' as const,
      sessionMode: 'perThread' as const,
      gitlab: {
        projectId: '4210',
        projectPath: 'example-group/example-project',
        sessionKeyPrefix: 'gitlab:4210',
        events: ['merge_request:*'],
        commentFamilies: ['merge_request' as const],
        mentionOnly: false,
        serviceAccountUserId: '99',
        serviceAccountUsername: 'agentconnect-p4210',
        signingToken: 'whsec_example'
      }
    }
    // Absence is the shape a later release sends once no older relay is deployed.
    expect(RcHookAssign.safeParse(gitlab).success).toBe(true)
    // Presence is what a Control Plane predating the removal still sends; it decodes
    // and the relay's matcher ignores the value.
    const withFilter = { ...gitlab, gitlab: { ...gitlab.gitlab, labelFilter: ['bug'] } }
    const decoded = RcHookAssign.safeParse(withFilter)
    expect(decoded.success).toBe(true)
    if (decoded.success) expect(decoded.data.gitlab?.labelFilter).toEqual(['bug'])
  })

  it('the §12.1 veto set is an additive optional member on a gitlab rule (§17.3)', () => {
    const gitlab = {
      hookId: '88888888-8888-4888-8888-888888888888',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      kind: 'gitlab' as const,
      sessionMode: 'perThread' as const,
      gitlab: {
        projectId: '4210',
        projectPath: 'example-group/example-project',
        sessionKeyPrefix: 'gitlab:4210',
        events: ['merge_request:*'],
        mentionOnly: false,
        serviceAccountUserId: '99',
        serviceAccountUsername: 'agentconnect-p4210',
        signingToken: 'whsec_example'
      }
    }
    // Absent: the shape a Control Plane predating the field sends; the relay vetoes one ID.
    const without = RcHookAssign.safeParse(gitlab)
    expect(without.success).toBe(true)
    if (without.success) expect(without.data.gitlab?.boundServiceAccountUserIds).toBeUndefined()
    // Present: every managed account bound to the project, including the named one.
    const withSet = RcHookAssign.safeParse({
      ...gitlab,
      gitlab: { ...gitlab.gitlab, boundServiceAccountUserIds: ['99', '100'] }
    })
    expect(withSet.success).toBe(true)
    if (withSet.success) expect(withSet.data.gitlab?.boundServiceAccountUserIds).toEqual(['99', '100'])
    // Every member is a positive numeric provider ID, exactly like the named account.
    const bad = { ...gitlab, gitlab: { ...gitlab.gitlab, boundServiceAccountUserIds: ['0'] } }
    expect(RcHookAssign.safeParse(bad).success).toBe(false)
  })

  it('rc/hook-rerun carries the Console rerun fence and its live subject (§16.1)', () => {
    const HOOK_ID = '99999999-9999-4999-8999-999999999999'
    const base = {
      hookId: HOOK_ID,
      agentId: AGENT_ID,
      deliveryKey: 'rerun_1',
      configRevision: '3',
      dispatchRevision: '5',
      event: 'merge_request:rerun',
      gitlab: {
        projectId: '4455667',
        projectPath: 'example-group/example-project',
        target: { kind: 'merge_request', iid: 42, headSha: 'a'.repeat(40) }
      }
    }
    const ok = decodeRelayCpFrame(envelope('rc/hook-rerun', base))
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.frame.type === 'rc/hook-rerun') {
      expect(ok.frame.payload.gitlab.target).toMatchObject({ kind: 'merge_request', iid: 42 })
      expect(ok.frame.payload.deliveryKey).toBe('rerun_1')
    }
    expect(
      RcHookRerun.safeParse({ ...base, gitlab: { ...base.gitlab, target: { kind: 'issue', iid: 7 } } }).success
    ).toBe(true)
    // The fence is REQUIRED here: unlike a rolling delivery frame, a rerun the
    // relay cannot fence against its compiled rule must not decode at all.
    expect(RcHookRerun.safeParse({ ...base, configRevision: undefined }).success).toBe(false)
    expect(RcHookRerun.safeParse({ ...base, dispatchRevision: undefined }).success).toBe(false)
    expect(RcHookRerun.safeParse({ ...base, deliveryKey: '' }).success).toBe(false)
    expect(RcHookRerun.safeParse({ ...base, hookId: 'nope' }).success).toBe(false)
    // A push ref has no rerun subject; the target still decodes as GitLab metadata.
    expect(
      RcHookRerun.safeParse({ ...base, gitlab: { ...base.gitlab, target: { kind: 'merge_request', iid: 0 } } }).success
    ).toBe(false)

    // The REP is the admission: reaching a socket is not acceptance.
    const admitted = decodeRelayCpFrame(
      envelope('rc/hook-rerun/ok', { admitted: true, deliveryKey: 'rerun_1' }, { corr: ok.ok ? ok.frame.id : 'x' })
    )
    expect(admitted.ok).toBe(true)
    if (admitted.ok && admitted.frame.type === 'rc/hook-rerun/ok') {
      expect(admitted.frame.payload).toEqual({ admitted: true, deliveryKey: 'rerun_1' })
    }
    for (const code of ['replay_pending', 'rule_mismatch', 'limiter_exhausted']) {
      expect(RcHookRerunResult.safeParse({ admitted: false, code }).success).toBe(true)
    }
    // A refusal names a category, an admission names the delivery — never both,
    // and never a code the Control Plane has no mapping for.
    expect(RcHookRerunResult.safeParse({ admitted: false, code: 'daemon_offline' }).success).toBe(false)
    expect(RcHookRerunResult.safeParse({ admitted: false }).success).toBe(false)
    expect(RcHookRerunResult.safeParse({ admitted: true }).success).toBe(false)
    expect(RcHookRerunResult.safeParse({ admitted: true, deliveryKey: '' }).success).toBe(false)
  })

  it('rc/run-report carries the delivery-stage verdict (accepted opens, failed records)', () => {
    const HOOK_ID = '88888888-8888-4888-8888-888888888888'
    const base = { hookId: HOOK_ID, deliveryKey: 'dk-1', firedAt: TS, agentId: AGENT_ID }
    expect(RcRunReport.safeParse({ ...base, status: 'accepted', daemonId: DAEMON_ID }).success).toBe(true)
    expect(HOOK_DELIVERY_REASON_DAEMON_OFFLINE).toBe('daemon_offline')
    expect(
      RcRunReport.safeParse({ ...base, status: 'failed', reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE }).success
    ).toBe(true)
    expect(
      RcRunReport.safeParse({
        ...base,
        status: 'failed',
        reason: HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED
      }).success
    ).toBe(true)
    expect(RcRunReport.safeParse({ ...base, status: 'running' }).success).toBe(false) // relay never reports running
    expect(RcRunReport.safeParse({ ...base, deliveryKey: '', status: 'accepted' }).success).toBe(false)
    expect(
      RcRunReport.safeParse({
        ...base,
        daemonId: DAEMON_ID,
        configRevision: '3',
        dispatchRevision: '5',
        dispatchDaemonId: DAEMON_ID,
        reviewPolicy: 'full',
        reportingMode: 'check',
        gateMode: 'informational',
        event: 'pull_request:synchronize',
        github: {
          repoId: '123456789',
          repoFullName: 'acme/infra',
          sourceInstallationId: '1234567',
          subjectKind: 'pull_request',
          pullNumber: 42,
          headSha: 'a'.repeat(40),
          reportSha: 'a'.repeat(40)
        },
        status: 'accepted'
      }).success
    ).toBe(true)
    expect(
      RcRunReport.safeParse({
        ...base,
        daemonId: DAEMON_ID,
        dispatchDaemonId: RELAY_ID,
        status: 'accepted'
      }).success
    ).toBe(false)
    const r = decodeRelayCpFrame(envelope('rc/run-report', { ...base, status: 'accepted' }))
    expect(r.ok).toBe(true)
  })

  it('keeps automatic hook redelivery closed to proven pre-dispatch failures', () => {
    expect(RETRYABLE_HOOK_DELIVERY_REASONS).toEqual([
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
      HOOK_DELIVERY_REASON_DAEMON_DRAINING,
      HOOK_DELIVERY_REASON_DAEMON_NOT_HOLDER
    ])
    for (const reason of RETRYABLE_HOOK_DELIVERY_REASONS) {
      expect(isRetryableHookDeliveryReason(reason), reason).toBe(true)
    }
    for (const reason of [
      undefined,
      null,
      '',
      HOOK_DELIVERY_REASON_DISPATCH_TIMEOUT,
      HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
      'busy',
      'rejected:busy',
      'draining',
      'not_holder',
      'rejected:paused',
      'rejected:anchor_side_effect',
      'rejected:not-holder',
      'rejected:no_agent',
      'rejected:unknown',
      'rejected:busy:later',
      'turn_failed'
    ]) {
      expect(isRetryableHookDeliveryReason(reason), String(reason)).toBe(false)
    }
  })

  it('rc/github-installation is a minimal poke (id + action, both non-empty)', () => {
    // BigInt-as-string id; action is free-form (observational — CP re-pulls the facts)
    const r = decodeRelayCpFrame(envelope('rc/github-installation', { installationId: '1234567', action: 'created' }))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rc/github-installation') throw new Error('narrow')
    expect(r.frame.payload.installationId).toBe('1234567')
    expect(RcGithubInstallation.safeParse({ installationId: '', action: 'created' }).success).toBe(false)
    expect(RcGithubInstallation.safeParse({ installationId: '1', action: '' }).success).toBe(false)
  })

  it('answers an error REP on this wire (typed, correlated)', () => {
    const r = decodeRelayCpFrame(
      envelope('error', { code: 'AUTH_FAILED', message: 'bad relay credential', retryable: false }, { corr: ID })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frame.type).toBe('error')
  })

  it('enforces the shared 256 KiB frame cap', () => {
    const r = decodeRelayCpFrame(envelope('rc/register', { name: 'x'.repeat(MAX_FRAME_BYTES + 1), daemonUrl: 'w' }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.msg).toBe('FRAME_TOO_LARGE')
  })
})

describe('relay↔CP wire — union separation (§8 standalone frame union)', () => {
  it('rejects daemon↔CP frames as UNKNOWN_FRAME', () => {
    const daemonFrame = buildEnvelope('auth', { apiKey: 'k', agentVersion: '1.0.0' })
    const r = decodeRelayCpFrame(encode(daemonFrame))
    expect(r).toEqual({ ok: false, id: daemonFrame.id, msg: 'UNKNOWN_FRAME' })
  })

  it('rejects relay↔daemon frames as UNKNOWN_FRAME', () => {
    const r = decodeRelayCpFrame(envelope('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID }))
    expect(r).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
  })

  it('the daemon↔CP wire rejects rc/* frames as UNKNOWN_FRAME', () => {
    const r = decodeEnvelope(envelope('rc/heartbeat', {}))
    expect(r).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
  })

  it('isRelayCpFrameType guards exactly the rc union', () => {
    for (const t of RELAY_CP_FRAME_TYPES) expect(isRelayCpFrameType(t)).toBe(true)
    expect(isRelayCpFrameType('auth')).toBe(false)
    expect(isRelayCpFrameType('rd/msg')).toBe(false)
  })
})

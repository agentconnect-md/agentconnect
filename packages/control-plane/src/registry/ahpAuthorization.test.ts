import { describe, expect, it } from 'vitest'
import {
  API_AHP_V1_FEATURE,
  TASK_PAGE_MESSAGES_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE
} from '@agentconnect.md/protocol'
import { AhpAuthorization, type AhpAuthorizationDeps } from './ahpAuthorization.js'
import { AhpCatalogCursor } from './ahpCatalogCursor.js'
import { AhpSessionService } from './ahpSessions.js'
import type { AhpSessionBindingRepo } from '../persistence/ports.js'
import { AhpGrantService } from './ahpGrant.js'
import { createWebchatTokenVerifier } from './webchatVerification.js'
import { WebchatTokenService } from './webchatToken.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const PEPPER = 'test-ahp-grant-pepper-at-least-32-characters'
const RESOURCE = `https://relay.example.test/ahp/agents/${AGENT}`

function fixture() {
  const state = {
    now: Date.now(),
    role: 'member' as string | null,
    permission: 'full',
    chatActions: 'talk' as 'talk' | 'approve',
    revoked: false,
    api: true,
    feature: true,
    owner: 'user',
    expiresAt: null as Date | null,
    principalType: 'user' as 'user' | 'oauth',
    scopes: [] as string[],
    grant: { resource: RESOURCE as string | null, revoked: false, userId: 'user' }
  }
  const grants = new AhpGrantService(PEPPER, () => state.now)
  const tokens = new WebchatTokenService(PEPPER)
  const deps = {
    grants,
    tokens,
    now: () => state.now,
    config: {
      AHP_MODE: 'on',
      AHP_PUBLIC_ACCESS: false,
      AHP_TEST_KEY_IDS: ['key'],
      AHP_TEST_USER_IDS: ['user'],
      PUBLIC_RELAY_URL: 'https://relay.example.test'
    },
    keys: {
      authenticateUser: async () => ({
        orgId: 'org',
        userId: 'user',
        apiKeyId: 'key',
        scopes: state.scopes,
        permission: state.permission
      })
    },
    keyRows: {
      findById: async (id: string) =>
        id === 'key'
          ? {
              id: 'key',
              userId: 'user',
              orgId: 'org',
              principalType: state.principalType,
              permission: state.permission,
              scopes: state.scopes,
              oauthGrantId: state.principalType === 'oauth' ? 'grant' : null,
              revokedAt: state.revoked ? new Date(0) : null,
              expiresAt: state.expiresAt
            }
          : null
    },
    oauthGrants: {
      getGrant: async (id: string) =>
        id === 'grant'
          ? {
              id,
              userId: state.grant.userId,
              orgId: 'org',
              scopes: ['ahp'],
              resource: state.grant.resource,
              revokedAt: state.grant.revoked ? new Date(0) : null
            }
          : null
    },
    agents: {
      getUnscoped: async () => ({
        id: AGENT,
        orgId: 'org',
        visibility: 'org',
        chatActions: state.chatActions,
        sharedWith: [],
        placementKind: 'daemon',
        daemonId: 'daemon',
        setId: null
      })
    },
    orgs: { roleOf: async () => state.role },
    apiEntries: { listForAgent: async () => (state.api ? [{ protocol: 'ahp' }] : []) },
    daemons: { get: () => ({ state: 'READY', capabilities: { features: state.feature ? [API_AHP_V1_FEATURE] : [] } }) },
    placement: { dispatchDaemon: async () => 'daemon' },
    users: { getProfile: async () => null },
    reachesContent: async () => true,
    sessions: { getUnscoped: async () => null },
    sessionAccess: async () => ({ identitySet: new Set(['user:user', 'slack:T:U']) }),
    conversations: {
      target: async () => ({ targetSessionId: null, ownerUserId: state.owner }),
      resumeBinding: async () => ({ primaryAgentId: AGENT, ownerUserId: state.owner, currentSessionIds: [null] }),
      participants: async () => [{ agentId: AGENT, role: 'primary', currentSessionId: null }]
    }
  } as unknown as AhpAuthorizationDeps
  return { state, deps, grants, tokens, auth: new AhpAuthorization(deps) }
}

async function grant(f: ReturnType<typeof fixture>) {
  const result = await f.auth.verifyKey({ credential: 'test-key', agentId: AGENT })
  if (!result.ok || !result.ahpGrant) throw new Error('expected grant')
  return result.ahpGrant
}

describe('AHP client authority', () => {
  it('admits a selected full key, caps TTL at its key expiry, and domain-separates signed grants', async () => {
    const f = fixture()
    f.state.expiresAt = new Date(f.state.now + 20_000)
    const signed = await grant(f)
    expect(signed.expiresAtMs).toBeLessThanOrEqual(f.state.expiresAt.getTime())
    expect(await f.grants.verify(signed.token)).toMatchObject({ userId: 'user', apiKeyId: 'key' })
    expect(await f.tokens.verify(signed.token)).toBeNull()
    expect(await f.auth.authorizeGrant(signed.token, { orgId: 'foreign', agentId: AGENT })).toBeNull()
    f.state.now = signed.expiresAtMs
    expect(await f.grants.verify(signed.token)).toBeNull()
  })

  it.each(['read', 'agent:chat'])('refuses %s credentials on the full AHP endpoint', async (permission) => {
    const f = fixture()
    f.state.permission = permission
    expect(await f.auth.verifyKey({ credential: 'key', agentId: AGENT })).toMatchObject({ ok: false })
  })

  it.each(['mode', 'audience', 'membership', 'entry', 'daemon'])(
    'fails closed when %s is unavailable',
    async (gate) => {
      const f = fixture()
      if (gate === 'mode') f.deps.config.AHP_MODE = 'shadow'
      if (gate === 'audience') f.deps.config.AHP_TEST_KEY_IDS = []
      if (gate === 'membership') f.state.role = null
      if (gate === 'entry') f.state.api = false
      if (gate === 'daemon') f.state.feature = false
      expect(await f.auth.verifyKey({ credential: 'key', agentId: AGENT })).toMatchObject({ ok: false })
    }
  )

  it('rechecks revocation and entry removal before registry operations, even inside a grant lifetime', async () => {
    const f = fixture()
    const signed = await grant(f)
    f.state.revoked = true
    expect(await f.auth.authorizeGrant(signed.token, { orgId: 'org', agentId: AGENT })).toBeNull()
    f.state.revoked = false
    f.state.api = false
    expect(await f.auth.authorizeGrant(signed.token, { orgId: 'org', agentId: AGENT })).toBeNull()
  })

  it('admits an ahp OAuth token for the endpoint its grant names and rechecks the grant on renewal', async () => {
    const f = fixture()
    f.state.principalType = 'oauth'
    f.state.scopes = ['ahp']
    f.deps.config.AHP_TEST_KEY_IDS = []
    const verify = (resource?: string) => f.auth.verifyKey({ credential: 'token', agentId: AGENT, resource })
    const admitted = await verify(RESOURCE)
    if (!admitted.ok || !admitted.ahpGrant) throw new Error('expected grant')
    expect(await f.auth.authorizeGrant(admitted.ahpGrant.token, { orgId: 'org', agentId: AGENT })).toMatchObject({
      apiKeyId: 'key'
    })
    expect(await verify()).toMatchObject({ ok: false })
    expect(await verify(RESOURCE.replace('relay.', 'other.'))).toMatchObject({ ok: false })
    f.state.grant.revoked = true
    expect(await f.auth.authorizeGrant(admitted.ahpGrant.token, { orgId: 'org', agentId: AGENT })).toBeNull()
  })

  it.each([
    ['an MCP scope', (f: ReturnType<typeof fixture>) => void (f.state.scopes = ['mcp:write'])],
    [
      'another agent endpoint',
      (f: ReturnType<typeof fixture>) => void (f.state.grant.resource = RESOURCE.replace(AGENT, CONVERSATION))
    ],
    [
      'another relay',
      (f: ReturnType<typeof fixture>) => void (f.deps.config.PUBLIC_RELAY_URL = 'https://elsewhere.example.test')
    ],
    [
      'a user outside the test audience',
      (f: ReturnType<typeof fixture>) => void (f.deps.config.AHP_TEST_USER_IDS = [])
    ],
    ["another user's grant", (f: ReturnType<typeof fixture>) => void (f.state.grant.userId = 'other')]
  ])('refuses an OAuth token with %s', async (_name, change) => {
    const f = fixture()
    f.state.principalType = 'oauth'
    f.state.scopes = ['ahp']
    change(f)
    const resource = f.state.grant.resource ?? RESOURCE
    expect(await f.auth.verifyKey({ credential: 'token', agentId: AGENT, resource })).toMatchObject({ ok: false })
  })

  it.each([undefined, 'legacy'] as const)('rejects browser protocol pin %s at AHP ingress', async (protocol) => {
    const f = fixture()
    const browser = await f.tokens.mint({
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION,
      protocol
    })
    expect(await f.auth.verifyBrowser({ credential: browser.token })).toMatchObject({ ok: false })
  })
  it('rejects AHP-pinned tokens on legacy ingress and preserves the pin in the signed grant', async () => {
    const f = fixture()
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    expect(await createWebchatTokenVerifier(f.deps)(browser.token)).toMatchObject({ ok: false })
    const verified = await f.auth.verifyBrowser({ credential: browser.token })
    if (!verified.ok || !verified.ahpGrant) throw new Error('expected AHP grant')
    expect(await f.grants.verify(verified.ahpGrant.token)).toMatchObject({ protocol: 'ahp' })
  })

  it('binds browser authority to its existing conversation and keeps pre-turn slots owner-only', async () => {
    const f = fixture()
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    const result = await f.auth.verifyBrowser({ credential: browser.token, agentId: AGENT })
    if (!result.ok || !result.ahpGrant) throw new Error('expected browser grant')
    expect(await f.grants.verify(result.ahpGrant.token)).toMatchObject({ conversationId: CONVERSATION })
    expect(result.ahpGrant.expiresAtMs).toBeLessThanOrEqual(browser.expiresAt.getTime())
    f.state.owner = 'another-member'
    expect(await f.auth.authorizeGrant(result.ahpGrant.token, { orgId: 'org', agentId: AGENT })).toBeNull()
    expect(await f.auth.verifyBrowser({ credential: browser.token, agentId: CONVERSATION })).toMatchObject({
      ok: false
    })
  })
  it('admits browser participants without an AHP API entry while keys still need one', async () => {
    const f = fixture()
    const peer = '33333333-3333-4333-8333-333333333333'
    const originalAgent = f.deps.agents.getUnscoped
    f.deps.agents.getUnscoped = async (id) => ({ ...(await originalAgent(id))!, id })
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary' },
      { agentId: peer as never, role: 'member' }
    ]
    f.state.api = false
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    for (const agentId of [AGENT, peer])
      expect(await f.auth.verifyBrowser({ credential: browser.token, agentId })).toMatchObject({
        ok: true,
        agentId,
        apiProtocols: ['ahp']
      })
    const result = await f.auth.verifyBrowser({ credential: browser.token, agentId: peer })
    if (!result.ok || !result.ahpGrant) throw new Error('expected browser grant')
    expect(await f.auth.authorizeGrant(result.ahpGrant.token, { orgId: 'org', agentId: peer })).not.toBeNull()
    expect(await f.auth.verifyKey({ credential: 'test-key', agentId: AGENT })).toMatchObject({ ok: false })
  })
  it('keeps a session continuation target in the signed grant and rechecks purge before registry access', async () => {
    const f = fixture()
    const session = {
      orgId: 'org',
      agentId: AGENT,
      platform: 'slack',
      daemonId: 'daemon',
      contentSetId: null,
      contentStoreId: null,
      visibility: 'org',
      ownerIdentity: null,
      contentPurgedAt: null as Date | null
    }
    f.deps.sessions = { getUnscoped: async () => session }
    f.deps.memberSets = { sharedStoreMemberIdsOf: async () => [] }
    f.deps.conversations.target = async () => ({ targetSessionId: 'existing-outward', ownerUserId: 'user' })
    f.deps.conversations.resumeBinding = async () => ({
      primaryAgentId: AGENT as never,
      ownerUserId: 'user',
      currentSessionIds: ['existing-outward' as never]
    })
    f.deps.daemons.get = () => ({
      state: 'READY',
      capabilities: {
        platforms: [],
        runtimes: [],
        acp: true,
        features: [API_AHP_V1_FEATURE, WEBCHAT_SESSION_CONTINUATION_FEATURE]
      }
    })
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    const result = await f.auth.verifyBrowser({ credential: browser.token, agentId: AGENT })
    if (!result.ok || !result.ahpGrant) throw new Error('expected continuation grant')
    expect(await f.grants.verify(result.ahpGrant.token)).toMatchObject({ targetSessionId: 'existing-outward' })
    expect(await f.auth.authorizeGrant(result.ahpGrant.token, { orgId: 'org', agentId: AGENT })).not.toBeNull()
    session.contentPurgedAt = new Date()
    expect(await f.auth.authorizeGrant(result.ahpGrant.token, { orgId: 'org', agentId: AGENT })).toBeNull()
  })
  it('rechecks an ordinary conversation visibility when another member refreshes their grant', async () => {
    const f = fixture()
    f.state.owner = 'creator'
    const session = {
      orgId: 'org',
      agentId: AGENT,
      platform: 'webchat',
      daemonId: 'daemon',
      contentSetId: null,
      contentStoreId: null,
      visibility: 'org',
      ownerIdentity: 'user:creator',
      contentPurgedAt: null
    }
    f.deps.sessions = { getUnscoped: async () => session }
    f.deps.conversations.resumeBinding = async () => ({
      primaryAgentId: AGENT as never,
      ownerUserId: 'creator',
      currentSessionIds: ['session' as never]
    })
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    const first = await f.auth.verifyBrowser({ credential: browser.token })
    if (!first.ok || !first.ahpGrant) throw new Error('expected org-visible grant')
    session.visibility = 'private'
    expect(await f.auth.verifyBrowser({ credential: browser.token })).toMatchObject({ ok: false })
    expect(await f.auth.authorizeGrant(first.ahpGrant.token, { orgId: 'org', agentId: AGENT })).toBeNull()
  })
  it.each(['private-owner', 'viewer', 'purged', 'missing', 'store-moved', 'external-revoked'])(
    'rechecks API alias authority after %s changes, including list and resolve',
    async (change) => {
      const f = fixture()
      const session = {
        orgId: 'org',
        agentId: AGENT,
        platform: 'slack',
        daemonId: 'daemon',
        contentSetId: null,
        contentStoreId: null,
        visibility: 'org',
        externalProvider: null as string | null,
        ownerIdentity: 'slack:T:U',
        contentPurgedAt: null as Date | null
      }
      f.deps.sessions.getUnscoped = async () => session
      f.deps.conversations.target = async () => ({ targetSessionId: 'outward', ownerUserId: 'user' })
      f.deps.daemons.get = () => ({
        state: 'READY',
        capabilities: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [API_AHP_V1_FEATURE, WEBCHAT_SESSION_CONTINUATION_FEATURE]
        }
      })
      const binding = {
        orgId: 'org',
        agentId: AGENT,
        userId: 'user',
        conversationId: CONVERSATION,
        reservationId: 'reservation',
        operationId: 'operation',
        sessionUri: 'ahp-session:/outward',
        sessionId: 'outward'
      }
      const service = new AhpSessionService({
        authorization: f.auth,
        cursors: new AhpCatalogCursor(PEPPER),
        bindings: {
          get: async () => binding,
          forSession: async () => binding,
          listCandidates: async () => ['outward']
        } as unknown as AhpSessionBindingRepo
      })
      const signed = await grant(f)
      const req = { orgId: 'org', agentId: AGENT, grant: signed.token, sessionUri: binding.sessionUri }
      const claims = (await f.grants.verify(signed.token))!
      expect(await f.auth.authorizeExisting(claims, 'outward')).toBe(true)
      expect(await service.resolve(req)).toMatchObject({ ok: true })
      expect(await service.list({ ...req, limit: 10 })).toMatchObject({
        sessions: [{ sessionUri: binding.sessionUri }]
      })
      if (change === 'private-owner') {
        session.visibility = 'private'
        session.ownerIdentity = 'slack:T:OTHER'
      }
      if (change === 'viewer') f.state.role = 'viewer'
      if (change === 'purged') session.contentPurgedAt = new Date()
      if (change === 'missing') f.deps.sessions.getUnscoped = async () => null
      if (change === 'store-moved') f.deps.reachesContent = async () => false
      if (change === 'external-revoked') {
        session.visibility = 'external'
        session.externalProvider = 'slack'
      }
      expect(await f.auth.authorizeExisting(claims, 'outward')).toBe(false)
      expect(await service.resolve(req)).toEqual({ ok: false, reason: 'not_found' })
      expect(await service.list({ ...req, limit: 10 })).toEqual({ ok: true, sessions: [] })
    }
  )

  // auto-session-mode.md §10: a webchat conversation's task is continued by its target, judged by its owning session.
  it("continues a webchat conversation's task by its target once the daemon advertises task pages", async () => {
    const f = fixture()
    const parent = {
      id: 'parent',
      orgId: 'org',
      agentId: AGENT,
      platform: 'webchat',
      channel: CONVERSATION,
      thread: `webchat:${CONVERSATION}`,
      daemonId: 'daemon',
      contentSetId: null,
      contentStoreId: null,
      visibility: 'private',
      ownerIdentity: 'user:user',
      contentPurgedAt: null
    }
    const task = { ...parent, id: 'task', thread: 'subsession:42', parentSessionId: 'parent', visibility: 'org' }
    f.deps.sessions.getUnscoped = async (id: string) => (id === 'parent' ? parent : id === 'task' ? task : null)
    const features = [API_AHP_V1_FEATURE, WEBCHAT_SESSION_CONTINUATION_FEATURE]
    f.deps.daemons.get = () => ({
      state: 'READY',
      capabilities: { platforms: [], runtimes: [], acp: true, features }
    })
    const claims = (await f.grants.verify((await grant(f)).token))!
    expect(await f.auth.authorizeExisting(claims, 'task')).toBe(false)
    features.push(TASK_PAGE_MESSAGES_FEATURE)
    expect(await f.auth.authorizeExisting(claims, 'task')).toBe(true)
    // The task reads org-visible, but its owning session is someone else's private one.
    parent.ownerIdentity = 'user:other'
    expect(await f.auth.authorizeExisting(claims, 'task')).toBe(false)
  })

  it('derives owner authority only for the native empty conversation, never from the API key alone', async () => {
    const f = fixture()
    f.state.role = 'viewer'
    const result = await f.auth.verifyKey({ credential: 'key', agentId: AGENT })
    expect(result).toMatchObject({ ok: true, callerRole: 'participant' })
    const claims = { orgId: 'org', agentId: AGENT, userId: 'user', user: 'User', apiKeyId: 'key' }
    const binding = {
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      conversationId: CONVERSATION,
      reservationId: 'reservation',
      operationId: 'operation',
      sessionUri: 'ahp-session:/empty',
      sessionId: 'outward'
    }
    expect(await f.auth.authorizeBinding(claims, binding)).toEqual({ callerRole: 'owner', callerApproves: false })
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary', currentSessionId: null },
      { agentId: CONVERSATION as never, role: 'member', currentSessionId: 'peer-already-started' }
    ]
    expect(await f.auth.authorizeBinding(claims, binding)).toEqual({ callerRole: 'owner', callerApproves: false })
    f.deps.sessions.getUnscoped = async () => ({
      orgId: 'org',
      agentId: AGENT,
      platform: 'webchat',
      channel: CONVERSATION,
      daemonId: 'daemon',
      contentSetId: null,
      contentStoreId: null,
      visibility: 'private',
      ownerIdentity: 'user:user',
      contentPurgedAt: null
    })
    // Metadata and current roster pointers commit together; a detached historic row cannot fill an empty slot.
    expect(await f.auth.authorizeBinding(claims, binding)).toBeNull()
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary', currentSessionId: 'outward' }
    ]
    expect(await f.auth.authorizeExisting(claims, 'outward')).toBe(true)
    expect(await f.auth.authorizeBinding(claims, binding)).toEqual({ callerRole: 'owner', callerApproves: false })
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary', currentSessionId: 'replacement' }
    ]
    expect(await f.auth.authorizeExisting(claims, 'outward')).toBe(false)
    expect(await f.auth.authorizeBinding(claims, binding)).toBeNull()
    f.deps.conversations.target = async () => ({ targetSessionId: 'outward', ownerUserId: 'user' })
    expect(await f.auth.authorizeBinding(claims, binding)).toBeNull()
  })
  it.each(['role-downgrade', 'approval-policy-revoked'])(
    'recomputes approval authority through the CP service after %s without renewing the grant',
    async (change) => {
      const f = fixture()
      f.state.role = change === 'role-downgrade' ? 'member' : 'viewer'
      f.state.chatActions = change === 'role-downgrade' ? 'talk' : 'approve'
      const initial = await f.auth.verifyKey({ credential: 'key', agentId: AGENT })
      if (!initial.ok || !initial.ahpGrant) throw new Error('expected grant')
      expect(initial.callerApproves).toBe(true)
      const binding = {
        orgId: 'org',
        agentId: AGENT,
        userId: 'user',
        conversationId: CONVERSATION,
        reservationId: 'reservation',
        operationId: 'operation',
        sessionUri: 'ahp-session:/native',
        sessionId: 'outward'
      }
      const service = new AhpSessionService({
        authorization: f.auth,
        cursors: new AhpCatalogCursor(PEPPER),
        bindings: {
          get: async () => binding,
          forSession: async () => binding,
          listCandidates: async () => ['outward']
        } as unknown as AhpSessionBindingRepo
      })
      const req = { orgId: 'org', agentId: AGENT, grant: initial.ahpGrant.token, sessionUri: binding.sessionUri }
      expect(await service.resolve(req)).toMatchObject({ ok: true, callerApproves: true })
      f.state.role = 'viewer'
      f.state.chatActions = 'talk'
      expect(await service.resolve(req)).toMatchObject({ ok: true, callerRole: 'owner', callerApproves: false })
      expect(await service.list({ ...req, limit: 10 })).toMatchObject({
        ok: true,
        sessions: [{ callerRole: 'owner', callerApproves: false }]
      })
    }
  )
})

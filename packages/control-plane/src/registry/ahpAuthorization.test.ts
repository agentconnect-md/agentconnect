import { describe, expect, it } from 'vitest'
import { API_AHP_V1_FEATURE, WEBCHAT_SESSION_CONTINUATION_FEATURE } from '@agentconnect.md/protocol'
import { AhpAuthorization, type AhpAuthorizationDeps } from './ahpAuthorization.js'
import { AhpSessionService } from './ahpSessions.js'
import type { AhpSessionBindingRepo } from '../persistence/ports.js'
import { AhpGrantService } from './ahpGrant.js'
import { createWebchatTokenVerifier } from './webchatVerification.js'
import { WebchatTokenService } from './webchatToken.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const PEPPER = 'test-ahp-grant-pepper-at-least-32-characters'

function fixture() {
  const state = {
    now: Date.now(),
    role: 'member' as string | null,
    permission: 'full',
    revoked: false,
    api: true,
    feature: true,
    owner: 'user',
    expiresAt: null as Date | null
  }
  const grants = new AhpGrantService(PEPPER, () => state.now)
  const tokens = new WebchatTokenService(PEPPER)
  const deps = {
    grants,
    tokens,
    now: () => state.now,
    config: { AHP_MODE: 'on', AHP_PUBLIC_ACCESS: false, AHP_TEST_KEY_IDS: ['key'] },
    keys: {
      authenticateUser: async () => ({
        orgId: 'org',
        userId: 'user',
        apiKeyId: 'key',
        scopes: [],
        permission: state.permission
      })
    },
    keyRows: {
      listForUser: async () => [
        {
          id: 'key',
          userId: 'user',
          orgId: 'org',
          principalType: 'user',
          permission: state.permission,
          scopes: [],
          revokedAt: state.revoked ? new Date(0) : null,
          expiresAt: state.expiresAt
        }
      ]
    },
    agents: {
      getUnscoped: async () => ({
        id: AGENT,
        orgId: 'org',
        visibility: 'org',
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
  it('scopes a multi-agent browser attachment to the selected participant API entry', async () => {
    const f = fixture()
    const peer = '33333333-3333-4333-8333-333333333333'
    const originalAgent = f.deps.agents.getUnscoped
    f.deps.agents.getUnscoped = async (id) => ({ ...(await originalAgent(id))!, id })
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary' },
      { agentId: peer as never, role: 'member' }
    ]
    f.deps.apiEntries.listForAgent = async (id) => (id === peer ? [{ protocol: 'ahp' }] : [])
    const browser = await f.tokens.mint({
      protocol: 'ahp',
      orgId: 'org',
      agentId: AGENT,
      userId: 'user',
      user: 'User',
      conversationId: CONVERSATION
    })
    expect(await f.auth.verifyBrowser({ credential: browser.token, agentId: peer })).toMatchObject({
      ok: true,
      agentId: peer,
      apiProtocols: ['ahp']
    })
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
        bindings: {
          get: async () => binding,
          listOwned: async () => [binding]
        } as unknown as AhpSessionBindingRepo
      })
      const signed = await grant(f)
      const req = { orgId: 'org', agentId: AGENT, grant: signed.token, sessionUri: binding.sessionUri }
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
      expect(await service.resolve(req)).toEqual({ ok: false, reason: 'not_found' })
      expect(await service.list({ ...req, limit: 10 })).toEqual({ ok: true, sessions: [] })
    }
  )

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
    expect(await f.auth.authorizeBinding(claims, binding)).toBe('owner')
    f.deps.conversations.participants = async () => [
      { agentId: AGENT as never, role: 'primary', currentSessionId: null },
      { agentId: CONVERSATION as never, role: 'member', currentSessionId: 'peer-already-started' }
    ]
    expect(await f.auth.authorizeBinding(claims, binding)).toBe('owner')
    f.deps.conversations.target = async () => ({ targetSessionId: 'outward', ownerUserId: 'user' })
    expect(await f.auth.authorizeBinding(claims, binding)).toBeNull()
  })
})

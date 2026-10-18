import { describe, expect, it } from 'vitest'
import { API_AHP_V1_FEATURE } from '@agentconnect.md/protocol'
import { AhpAuthorization, type AhpAuthorizationDeps } from './ahpAuthorization.js'
import { AhpGrantService } from './ahpGrant.js'
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

  it('binds browser authority to its existing conversation and keeps pre-turn slots owner-only', async () => {
    const f = fixture()
    const browser = await f.tokens.mint({
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
})

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_AHP_V1_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  WEBCHAT_MULTI_AGENT_FEATURE
} from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../../domain/ids.js'
import type { HttpDeps } from '../deps.js'
import { installZod } from '../plugins/zod.js'
import { webchatTokenRoutes } from './webchat-token.js'
import { WebchatTokenService } from '../../registry/webchatToken.js'

const ORG = OrgId('org')
const AGENT = AgentId('11111111-1111-4111-8111-111111111111')
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const DAEMON = '33333333-3333-4333-8333-333333333333'
const SESSION = 'existing-session'
const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function fixture() {
  const app = Fastify()
  apps.push(app)
  installZod(app)
  app.decorate('humanAuth', async () => {})
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user' }
    req.orgCtx = { orgId: ORG, role: 'owner', userId: 'user' } as never
  })
  const config = {
    PUBLIC_RELAY_URL: 'https://relay.test',
    AHP_MODE: 'on' as 'on' | 'off',
    WEBCHAT_PROTOCOL: 'ahp' as 'legacy' | 'ahp'
  }
  const agent = { id: AGENT, orgId: ORG, visibility: 'org', sharedWith: [], daemonId: DAEMON, placementKind: 'daemon' }
  const create = vi.fn(async () => {})
  const features = [API_AHP_V1_FEATURE, WEBCHAT_SESSION_CONTINUATION_FEATURE, WEBCHAT_MULTI_AGENT_FEATURE]
  const tokens = new WebchatTokenService('test-pepper-at-least-32-characters-long')
  const mint = vi.fn(tokens.mint.bind(tokens))
  const deps = {
    config,
    clock: { now: Date.now },
    repos: {
      agent: { get: async (_org: string, id: string) => (id === AGENT ? agent : null) },
      agentApiEntry: { listForAgent: async () => [{ protocol: 'ahp' }] },
      user: { getProfile: async () => null },
      session: {
        get: async () => ({
          id: SESSION,
          orgId: ORG,
          agentId: AGENT,
          platform: 'slack',
          daemonId: DAEMON,
          thread: 'thread',
          visibility: 'org',
          ownerIdentity: null,
          externalScopeId: null,
          contentPurgedAt: null
        }),
        getExternalScopes: async () => []
      },
      relay: { listAlive: async () => [{ features: [WEBCHAT_SESSION_CONTINUATION_FEATURE] }] },
      memberSet: { sharedStoreMemberIdsOf: async () => [] },
      webchatConversation: {
        create,
        resumeBinding: async () => ({ primaryAgentId: AGENT, ownerUserId: 'user', currentSessionIds: [null] }),
        participants: async () => [{ agentId: AGENT }],
        upsertSessionTargeted: async () => ({ conversationId: CONVERSATION })
      },
      ahpSessionBinding: { forConversation: async () => null }
    },
    placementResolver: { dispatchDaemon: async () => DAEMON },
    daemonConns: {
      get: () => ({
        state: 'READY',
        capabilities: { features }
      })
    },
    webchatTokens: { mint }
  } as unknown as HttpDeps
  await app.register(webchatTokenRoutes(deps), { prefix: '/orgs/:orgId' })
  return { app, config, create, mint, tokens, features }
}

describe('Webchat token routes pin an authorized protocol', () => {
  it.each([
    [`/agents/${AGENT}/webchat/token`, {}],
    [`/sessions/${SESSION}/webchat/token`, undefined],
    ['/webchat/conversations/token', { conversationId: CONVERSATION }],
    ['/webchat/conversations/token', { agentIds: [AGENT] }]
  ] as const)('returns AHP bootstrap from the existing mint path %s', async (path, payload) => {
    const f = await fixture()
    const response = await f.app.inject({ method: 'POST', url: `/orgs/${ORG}${path}`, ...(payload ? { payload } : {}) })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      token: expect.any(String),
      protocol: 'ahp',
      ahp: {
        url: `wss://relay.test/ahp/agents/${AGENT}`,
        peers: [{ agentId: AGENT, url: `wss://relay.test/ahp/agents/${AGENT}` }]
      }
    })
    expect(f.mint).toHaveBeenCalledTimes(1)
    expect(await f.tokens.verify(response.json().token)).toMatchObject({ protocol: 'ahp' })
  })

  it('honors a pinned legacy reconnect independently of the default, and refuses AHP while off', async () => {
    const f = await fixture()
    f.config.AHP_MODE = 'off'
    const legacy = await f.app.inject({
      method: 'POST',
      url: `/orgs/${ORG}/agents/${AGENT}/webchat/token`,
      payload: { protocol: 'legacy', conversationId: CONVERSATION }
    })
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(legacy.json()).toMatchObject({ protocol: 'legacy' })
    expect(legacy.json()).not.toHaveProperty('ahp')
    expect(await f.tokens.verify(legacy.json().token)).toMatchObject({ protocol: 'legacy' })
    const denied = await f.app.inject({
      method: 'POST',
      url: `/orgs/${ORG}/agents/${AGENT}/webchat/token`,
      payload: { protocol: 'ahp' }
    })
    expect(denied.statusCode).toBe(503)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.mint).toHaveBeenCalledTimes(1)
  })

  it('mints legacy for the deployment preference when a participant cannot serve AHP', async () => {
    const f = await fixture()
    f.features.splice(f.features.indexOf(API_AHP_V1_FEATURE), 1)
    const url = `/orgs/${ORG}/agents/${AGENT}/webchat/token`
    const chosen = await f.app.inject({ method: 'POST', url, payload: {} })
    expect(chosen.statusCode, chosen.body).toBe(200)
    expect(chosen.json()).toMatchObject({ protocol: 'legacy' })
    expect(chosen.json()).not.toHaveProperty('ahp')
    expect(await f.tokens.verify(chosen.json().token)).toMatchObject({ protocol: 'legacy' })
    const explicit = await f.app.inject({ method: 'POST', url, payload: { protocol: 'ahp' } })
    expect(explicit.statusCode).toBe(503)
  })

  it('preserves the existing authorization refusal before exposing attachment metadata', async () => {
    const f = await fixture()
    const response = await f.app.inject({
      method: 'POST',
      url: `/orgs/${ORG}/agents/${DAEMON}/webchat/token`,
      payload: { protocol: 'ahp' }
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).not.toHaveProperty('ahp')
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('signs an explicit AHP attachment pin while the deployment default stays legacy', async () => {
    const f = await fixture()
    f.config.WEBCHAT_PROTOCOL = 'legacy'
    const response = await f.app.inject({
      method: 'POST',
      url: `/orgs/${ORG}/agents/${AGENT}/webchat/token`,
      payload: { protocol: 'ahp' }
    })
    expect(response.statusCode).toBe(200)
    expect(await f.tokens.verify(response.json().token)).toMatchObject({ protocol: 'ahp' })
  })
})

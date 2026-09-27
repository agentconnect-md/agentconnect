/** Claiming a Google Workspace customer on the multi-tenant deployment app (google-chat-integration.md §10.5), against fakes. */
import { generateKeyPairSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import { installZod } from '../../http/plugins/zod.js'
import type { BotIdentityChange, BotIdentitySnapshot, BotRecord } from '../../persistence/ports.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import { GOOGLE_CHAT_API_ROOT, GOOGLE_TOKEN_ENDPOINT } from './credential.js'
import { decodeGoogleChatClaimState, googleChatClaimRoutes, isGoogleChatRedirect } from './claim.js'
import { GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE } from './tenant.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const OTHER_ORG = OrgId('22222222-2222-4222-8222-222222222222')
const PRESET = AgentId('77777777-7777-4777-8777-777777777777')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const OTHER_BOT = BotId('99999999-9999-4999-8999-999999999999')
const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '123456789012'
const GOOGLE_USER = '100000000000000000009'
const SPACE = 'spaces/AAAAexample'
const DM = 'spaces/DDDDexample'
const REDIRECT = 'https://chat.google.com/api/config_complete_redirect?token=synthetic'
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const KEY = {
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key: PRIVATE_KEY,
  client_email: `chat-app@${PROJECT_ID}.iam.gserviceaccount.com`
}
const MULTI_TENANT_APP: GoogleChatPlatformAppConfig = {
  projectId: PROJECT_ID,
  projectNumber: PROJECT_NUMBER,
  serviceAccountKey: JSON.stringify(KEY, null, 2),
  multiTenant: true
}

interface StateFields {
  v: number
  app: string
  space: string
  user: string
  kind: 'dm' | 'space'
  tenant: string
  redirect?: string
  iat: number
}

function state(over: Partial<StateFields> = {}): string {
  const fields: StateFields = {
    v: 1,
    app: PROJECT_NUMBER,
    space: SPACE,
    user: `users/${GOOGLE_USER}`,
    kind: 'space',
    tenant: 'customers/C0000000000',
    redirect: REDIRECT,
    iat: 1_790_000_000,
    ...over
  }
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

function customerRow(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BOT,
    orgId: ORG,
    name: `Google Chat · ${PROJECT_ID}`,
    externalAppId: PROJECT_NUMBER,
    externalTenantId: 'domains/0000000000',
    platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' },
    agentIds: [PRESET],
    ...over
  } as BotRecord
}

type GoogleAnswers = Record<string, Response | 'offline'>

/** Google's answers to a Space claim: the caller's INTERNAL membership in `domainId`, and the Space's customer. */
function spaceAnswers(domainId = '0000000000', customer = 'customers/C0000000000'): GoogleAnswers {
  return {
    [`${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/${GOOGLE_USER}`]: Response.json({
      name: `${SPACE}/members/${GOOGLE_USER}`,
      affiliation: 'INTERNAL',
      member: { name: `users/${GOOGLE_USER}`, type: 'HUMAN', domainId }
    }),
    [`${GOOGLE_CHAT_API_ROOT}/${SPACE}`]: Response.json({ name: SPACE, customer })
  }
}

/** Google's answer to a DM claim: the caller alone, in `domainId`. */
function dmAnswers(domainId = '0000000000'): GoogleAnswers {
  return {
    [`${GOOGLE_CHAT_API_ROOT}/${DM}/members?pageSize=100`]: Response.json({
      memberships: [{ member: { name: `users/${GOOGLE_USER}`, type: 'HUMAN', domainId } }]
    })
  }
}

const dmState = (over: Partial<StateFields> = {}) =>
  state({ kind: 'dm', space: DM, tenant: 'domains/0000000000', ...over })

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness(
  opts: {
    app?: GoogleChatPlatformAppConfig | null
    recorded?: string | null
    identity?: string | null | 'error'
    rows?: BotRecord[]
    google?: GoogleAnswers
    role?: 'owner' | 'collaborator' | 'viewer'
    relay?: boolean
    preset?: boolean
    createThrows?: Error
  } = {}
) {
  const googleCalls: string[] = []
  const answers: GoogleAnswers = opts.google ?? spaceAnswers()
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    googleCalls.push(url)
    if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'synthetic-access-token' })
    const answer = answers[url]
    if (answer === 'offline') throw new TypeError('fetch failed')
    if (answer) return answer.clone()
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const googleAccountIdFor = vi.fn(async () => {
    if (opts.identity === 'error') throw new Error('identity provider down')
    return opts.identity === undefined ? GOOGLE_USER : opts.identity
  })
  const setGoogleAccountId = vi.fn(async () => {})
  const create = vi.fn(async (input: Record<string, unknown>) => {
    if (opts.createThrows) throw opts.createThrows
    return { ...input, agentIds: [] } as unknown as BotRecord
  })
  const put = vi.fn(async () => {})
  const integrationCreate = vi.fn(async (input: Record<string, unknown>) => ({ ...input, status: 'active' }))
  const syncBot = vi.fn(async (_botId: BotId) => {})
  const rowOf = (id: BotId) => (opts.rows ?? []).find((row) => row.id === id)
  const merged: { id: BotId; change: BotIdentityChange }[] = []
  // Applies the route's merge to the row, as the repository does under the row lock.
  const mergeBotIdentity = vi.fn(
    async (_orgId: OrgId, id: BotId, merge: (current: BotIdentitySnapshot) => BotIdentityChange) => {
      const row = rowOf(id)
      const change = merge({
        platformConfig: row?.platformConfig ?? {},
        externalTenantId: row?.externalTenantId ?? null
      })
      const rekey = change.externalTenantId !== undefined && change.externalTenantId !== row?.externalTenantId
      if (Object.keys(change.platformConfig ?? {}).length === 0 && !rekey) return false
      merged.push({ id, change })
      return true
    }
  )
  // The teardown a consolidation spends on the retired row: one install per row, on the preset agent.
  const installsOf = (botId: BotId) =>
    rowOf(botId)?.agentIds.length ? [{ id: `install-${botId}`, orgId: ORG, agentId: PRESET, botId }] : []
  const removedInstalls: string[] = []
  const deletedBots: BotId[] = []
  const credentialInstall = vi.fn(async () => 2)
  const addBotMembership = vi.fn(async (input: Record<string, unknown>) => ({ outcome: 'added', integration: input }))
  const deps = {
    config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    clock: { now: () => Date.parse('2026-09-28T00:00:00Z') },
    httpBot: { hasConnectedRelay: () => opts.relay !== false, syncBot, prepareIntegrationRemoval: async () => {} },
    agentMutations: { tryBeginMutation: () => () => {} },
    agentDelivery: { integrationRemove: async () => {} },
    platforms: { get: () => undefined },
    placementResolver: { servingDaemon: async () => null },
    repos: {
      presetAgent: { get: async () => (opts.preset === false ? null : { agentId: PRESET }) },
      agent: {
        get: async (_org: OrgId, id: AgentId) => ({ id, orgId: ORG, name: 'agentconnect', visibility: 'org' })
      },
      user: {
        getGoogleAccountId: async () => (opts.recorded === undefined ? null : opts.recorded),
        setGoogleAccountId,
        getOidcSubject: async () => 'logto-subject'
      },
      bot: {
        listForPlatform: async () => opts.rows ?? [],
        get: async (_org: OrgId, id: BotId) => rowOf(id) ?? null,
        mergeBotIdentity,
        create,
        markFreed: async () => {},
        delete: async (_org: OrgId, id: BotId) => {
          deletedBots.push(id)
        }
      },
      botSecret: { put },
      botCredential: { install: credentialInstall },
      integration: {
        create: integrationCreate,
        addBotMembership,
        listForBot: async (botId: BotId) =>
          installsOf(botId).filter((install) => !removedInstalls.includes(install.id)),
        delete: async (_org: OrgId, id: string) => {
          removedInstalls.push(id)
        }
      }
    }
  } as unknown as HttpDeps
  const app = Fastify()
  installZod(app)
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user-1' }
    req.orgCtx = { orgId: ORG, role: opts.role ?? 'collaborator', userId: 'user-1' } as never
  })
  const platform = opts.app === null ? undefined : (opts.app ?? MULTI_TENANT_APP)
  await app.register(
    googleChatClaimRoutes(deps, {
      ...(platform ? { app: platform } : {}),
      fetch: fetchImpl,
      identity: { googleAccountIdFor }
    })
  )
  running = app
  const claim = (raw: string = state()) =>
    app.inject({ method: 'POST', url: '/integrations/googlechat/claim', payload: { state: raw } })
  return {
    claim,
    googleCalls,
    googleAccountIdFor,
    setGoogleAccountId,
    create,
    put,
    integrationCreate,
    syncBot,
    merged,
    removedInstalls,
    deletedBots,
    credentialInstall,
    addBotMembership
  }
}

describe('the claim state', () => {
  it('decodes the relay’s base64url JSON and refuses anything else', () => {
    expect(decodeGoogleChatClaimState(state())).toMatchObject({
      app: PROJECT_NUMBER,
      kind: 'space',
      redirect: REDIRECT
    })
    expect(decodeGoogleChatClaimState('not base64url!')).toBeUndefined()
    expect(decodeGoogleChatClaimState(Buffer.from('{').toString('base64url'))).toBeUndefined()
    expect(decodeGoogleChatClaimState(state({ v: 2 }))).toBeUndefined()
    expect(decodeGoogleChatClaimState(state({ user: 'users/../../spaces' }))).toBeUndefined()
    expect(decodeGoogleChatClaimState(state({ space: 'spaces/AAA/members' }))).toBeUndefined()
  })

  it('accepts only a completion URL on Chat’s own origin', () => {
    expect(isGoogleChatRedirect(REDIRECT)).toBe(true)
    expect(isGoogleChatRedirect('http://chat.google.com/x')).toBe(false)
    expect(isGoogleChatRedirect('https://chat.google.com.example.test/x')).toBe(false)
    expect(isGoogleChatRedirect('https://user:pass@chat.google.com/x')).toBe(false)
    expect(isGoogleChatRedirect('https://console.example.test/')).toBe(false)
    expect(decodeGoogleChatClaimState(state({ redirect: 'https://console.example.test/' }))).toBeUndefined()
  })

  it('accepts a state without a completion URL, as the welcome card’s click mints', () => {
    const decoded = decodeGoogleChatClaimState(state({ redirect: undefined }))
    expect(decoded).toMatchObject({ app: PROJECT_NUMBER, kind: 'space' })
    expect(decoded).not.toHaveProperty('redirect')
  })
})

describe('POST /integrations/googlechat/claim: a new customer', () => {
  it('binds a Space claim to the Space’s customer and the INTERNAL member’s domain, on the preset agent', async () => {
    const h = await harness()

    const res = await h.claim()
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ redirect: REDIRECT })
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        platform: 'googlechat',
        transport: 'http',
        prebuilt: true,
        externalAppId: PROJECT_NUMBER,
        platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
      })
    )
    // A copy of the deployment key in canonical JSON, exactly as the deployment-app install stores it.
    expect(h.put).toHaveBeenCalledWith(ORG, expect.anything(), {
      botToken: JSON.stringify(KEY),
      appToken: null,
      signingSecret: null
    })
    expect(h.integrationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: PRESET, platform: 'googlechat' })
    )
    expect(h.syncBot).toHaveBeenCalledOnce()
    expect(res.body).not.toContain('PRIVATE KEY')
  })

  it('binds a DM claim to the claimant’s own domain', async () => {
    const h = await harness({ google: dmAnswers() })

    const res = await h.claim(dmState())
    expect(res.statusCode).toBe(201)
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' } })
    )
  })

  it('answers success without a completion URL when the state carried none', async () => {
    const h = await harness()

    const res = await h.claim(state({ redirect: undefined }))
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({})
    expect(h.create).toHaveBeenCalledOnce()
  })

  it('gives a Space claim its customer’s own row even when the organization holds another customer', async () => {
    const other = customerRow({
      externalTenantId: 'customers/C0000000001',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001', domainIds: '0000000009' }
    })
    const h = await harness({ rows: [other], google: spaceAnswers('0000000000') })

    expect((await h.claim()).statusCode).toBe(201)
    expect(h.merged).toEqual([])
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
      })
    )
  })

  it('keeps a DM from an unrelated customer’s domain on a row of its own, never on this organization’s customer row', async () => {
    const customerA = customerRow({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
    })
    const h = await harness({ rows: [customerA], google: dmAnswers('0000000005') })

    expect((await h.claim(dmState({ tenant: 'domains/0000000005' }))).statusCode).toBe(201)
    expect(h.merged).toEqual([])
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ platformConfig: { projectId: PROJECT_ID, domainIds: '0000000005' } })
    )
  })

  it('answers the refusal without naming the other organization when the composite unique fires', async () => {
    const h = await harness({ createThrows: new BotExternalIdentityTaken('googlechat') })

    const res = await h.claim()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GOOGLE_CHAT_CLAIM_TAKEN', message: GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE })
  })
})

describe('POST /integrations/googlechat/claim: a customer that already has a row', () => {
  it('refuses a customer another organization holds, naming no organization', async () => {
    const h = await harness({ rows: [customerRow({ orgId: OTHER_ORG })] })

    const res = await h.claim()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GOOGLE_CHAT_CLAIM_TAKEN', message: GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE })
    expect(res.body).not.toContain(OTHER_ORG)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('upgrades this organization’s domain row to the customer a Space proves, re-keying it', async () => {
    const h = await harness({ rows: [customerRow()] })

    const res = await h.claim()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ redirect: REDIRECT })
    expect(h.merged).toEqual([
      {
        id: BOT,
        change: { platformConfig: { customerId: 'C0000000000' }, externalTenantId: 'customers/C0000000000' }
      }
    ])
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('upgrades an unrelated customer’s DM row when that customer’s own Space proves the pair', async () => {
    const customerA = customerRow({
      id: OTHER_BOT,
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
    })
    const domainRowB = customerRow({
      externalTenantId: 'domains/0000000005',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000005' }
    })
    const h = await harness({
      rows: [customerA, domainRowB],
      google: spaceAnswers('0000000005', 'customers/C0000000005')
    })

    expect((await h.claim()).statusCode).toBe(200)
    expect(h.merged).toEqual([
      {
        id: BOT,
        change: { platformConfig: { customerId: 'C0000000005' }, externalTenantId: 'customers/C0000000005' }
      }
    ])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('answers 200 without a completion URL for this organization’s own customer when the state carried none', async () => {
    const h = await harness({ rows: [customerRow()] })

    const res = await h.claim(state({ redirect: undefined }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
  })

  it('attaches a second domain from a Space claim to its customer’s row, writing no new row', async () => {
    const row = customerRow({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
    })
    const h = await harness({ rows: [row], google: spaceAnswers('0000000001') })

    const res = await h.claim()
    expect(res.statusCode).toBe(200)
    expect(h.merged).toEqual([{ id: BOT, change: { platformConfig: { domainIds: '0000000000,0000000001' } } }])
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('consolidates this organization’s domain row into the customer row a Space proves, retiring it', async () => {
    const domainRow = customerRow({
      id: OTHER_BOT,
      externalTenantId: 'domains/0000000000',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' }
    })
    const customer = customerRow({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000001' }
    })
    const h = await harness({ rows: [domainRow, customer], google: spaceAnswers('0000000000') })

    const res = await h.claim()
    expect(res.statusCode).toBe(200)
    expect(h.merged).toEqual([{ id: BOT, change: { platformConfig: { domainIds: '0000000001,0000000000' } } }])
    expect(h.removedInstalls).toEqual([`install-${OTHER_BOT}`])
    expect(h.deletedBots).toEqual([OTHER_BOT])
    // The surviving row is re-sent first, then the retired row is released.
    expect(h.syncBot.mock.calls.map(([id]) => id)).toEqual([BOT, OTHER_BOT])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('refuses with a conflict a Space proof whose domain is bound to a different customer, writing nothing', async () => {
    const row = customerRow({
      externalTenantId: 'customers/C0000000007',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000007', domainIds: '0000000000' }
    })
    const h = await harness({ rows: [row], google: spaceAnswers('0000000000', 'customers/C0000000000') })

    const res = await h.claim()
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_CONFLICT')
    expect(h.merged).toEqual([])
    expect(h.deletedBots).toEqual([])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('answers 200 with nothing to attach when one row already holds both the domain and the customer', async () => {
    const row = customerRow({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000,0000000001' }
    })
    const h = await harness({ rows: [row], google: dmAnswers('0000000001') })

    expect((await h.claim(dmState({ tenant: 'domains/0000000001' }))).statusCode).toBe(200)
    expect(h.merged).toEqual([])
    expect(h.syncBot).not.toHaveBeenCalled()
  })

  it('refuses a DM domain another organization’s customer row already lists, whatever that row’s key', async () => {
    const row = customerRow({
      orgId: OTHER_ORG,
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000,0000000001' }
    })
    const h = await harness({ rows: [row], google: dmAnswers('0000000001') })

    const res = await h.claim(dmState({ tenant: 'domains/0000000001' }))
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_TAKEN')
    expect(h.merged).toEqual([])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('refuses a Space claim whose domain another organization holds, even for an unheld customer', async () => {
    const h = await harness({
      rows: [customerRow({ orgId: OTHER_ORG })],
      google: spaceAnswers('0000000000', 'customers/C0000000005')
    })

    const res = await h.claim()
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_TAKEN')
  })

  it('is a no-op when the row already knows every proven id', async () => {
    const h = await harness({
      rows: [
        customerRow({
          externalTenantId: 'customers/C0000000000',
          platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
        })
      ]
    })

    expect((await h.claim()).statusCode).toBe(200)
    expect(h.merged).toEqual([])
    expect(h.syncBot).not.toHaveBeenCalled()
  })

  it('puts a freed customer row back on the preset agent with the current deployment key', async () => {
    const h = await harness({ rows: [customerRow({ agentIds: [] })] })

    expect((await h.claim()).statusCode).toBe(200)
    expect(h.credentialInstall).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: JSON.stringify(KEY), appToken: null, signingSecret: null },
      expect.any(Date)
    )
    expect(h.addBotMembership).toHaveBeenCalledWith(expect.objectContaining({ agentId: PRESET, botId: BOT }))
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
  })

  it('ignores rows of other apps and the anchor', async () => {
    const h = await harness({
      rows: [
        customerRow({ orgId: OTHER_ORG, externalAppId: '210987654321' }),
        customerRow({ orgId: OTHER_ORG, externalTenantId: '-', platformConfig: { projectId: PROJECT_ID } })
      ]
    })

    expect((await h.claim()).statusCode).toBe(201)
  })
})

describe('POST /integrations/googlechat/claim: identity', () => {
  it('uses a recorded Google account id without reading the identity provider', async () => {
    const h = await harness({ recorded: GOOGLE_USER })

    expect((await h.claim()).statusCode).toBe(201)
    expect(h.googleAccountIdFor).not.toHaveBeenCalled()
  })

  it('reads the identity provider on the first claim and records the id', async () => {
    const h = await harness({ recorded: null })

    expect((await h.claim()).statusCode).toBe(201)
    expect(h.googleAccountIdFor).toHaveBeenCalledWith('logto-subject', true)
    expect(h.setGoogleAccountId).toHaveBeenCalledWith('user-1', GOOGLE_USER)
  })

  it('asks a caller without a Google identity to sign in with Google, before any Google read', async () => {
    const h = await harness({ identity: null })

    const res = await h.claim()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_IDENTITY')
    expect(res.json().message).toMatch(/Sign in with Google/)
    expect(h.googleCalls).toEqual([])
  })

  it('refuses a caller whose Google account is not the Chat user who asked', async () => {
    const h = await harness({ recorded: '100000000000000000001', identity: '100000000000000000001' })

    const res = await h.claim()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_IDENTITY')
    expect(h.googleCalls).toEqual([])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('answers 503 when the identity provider cannot be read', async () => {
    const h = await harness({ identity: 'error' })

    const res = await h.claim()
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_IDENTITY_UNAVAILABLE')
  })
})

describe('POST /integrations/googlechat/claim: refusals', () => {
  it('refuses a malformed state and a redirect off Chat’s origin', async () => {
    const h = await harness()

    const garbage = await h.claim('not-a-state')
    expect(garbage.statusCode).toBe(400)
    expect(garbage.json().code).toBe('GOOGLE_CHAT_CLAIM_STATE_INVALID')
    const offsite = await h.claim(state({ redirect: 'https://console.example.test/after' }))
    expect(offsite.statusCode).toBe(400)
    expect(offsite.json().code).toBe('GOOGLE_CHAT_CLAIM_STATE_INVALID')
  })

  it('answers 404 for another app, a single-tenant app, and no deployment app', async () => {
    const other = await harness()
    const res = await other.claim(state({ app: '210987654321' }))
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_APP_UNKNOWN')
    await running?.close()

    const single = await harness({ app: { ...MULTI_TENANT_APP, multiTenant: false } })
    expect((await single.claim()).statusCode).toBe(404)
    await running?.close()

    const none = await harness({ app: null })
    expect((await none.claim()).statusCode).toBe(404)
  })

  it('leaves viewers read-only', async () => {
    const h = await harness({ role: 'viewer' })

    expect((await h.claim()).statusCode).toBe(403)
    expect(h.googleAccountIdFor).not.toHaveBeenCalled()
  })

  it.each(['EXTERNAL', 'MANAGED_EXTERNAL'])('refuses a %s Space member', async (affiliation) => {
    const h = await harness({
      google: {
        [`${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/${GOOGLE_USER}`]: Response.json({
          affiliation,
          member: { name: `users/${GOOGLE_USER}`, type: 'HUMAN', domainId: '0000000001' }
        })
      }
    })

    const res = await h.claim()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_EXTERNAL')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('refuses a Space the caller is not a member of', async () => {
    const h = await harness({
      google: {
        [`${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/${GOOGLE_USER}`]: Response.json(
          { error: { code: 404, message: 'Membership not found.' } },
          { status: 404 }
        )
      }
    })

    const res = await h.claim()
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_CONVERSATION')
  })

  it('refuses a DM that is not the caller alone with the app', async () => {
    const h = await harness({
      google: {
        [`${GOOGLE_CHAT_API_ROOT}/${DM}/members?pageSize=100`]: Response.json({
          memberships: [
            { member: { name: `users/${GOOGLE_USER}`, type: 'HUMAN', domainId: '0000000000' } },
            { member: { name: 'users/100000000000000000001', type: 'HUMAN', domainId: '0000000000' } }
          ]
        })
      }
    })

    const res = await h.claim(state({ kind: 'dm', space: DM }))
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_CONVERSATION')
  })

  it('refuses a personal account with no Workspace domain', async () => {
    const h = await harness({
      google: {
        [`${GOOGLE_CHAT_API_ROOT}/${DM}/members?pageSize=100`]: Response.json({
          memberships: [{ member: { name: `users/${GOOGLE_USER}`, type: 'HUMAN' } }]
        })
      }
    })

    const res = await h.claim(state({ kind: 'dm', space: DM }))
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_WORKSPACE_REQUIRED')
  })

  it('answers an unreachable Google as 503, never as a refusal of the caller', async () => {
    const h = await harness({ google: { [`${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/${GOOGLE_USER}`]: 'offline' } })

    const res = await h.claim()
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('GOOGLE_CHAT_UNREACHABLE')
  })

  it('needs a relay and the preset agent to create the row', async () => {
    const noRelay = await harness({ relay: false })
    const res = await noRelay.claim()
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('GOOGLE_CHAT_CLAIM_UNAVAILABLE')
    await running?.close()

    const noPreset = await harness({ preset: false })
    const refused = await noPreset.claim()
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('GOOGLE_CHAT_CLAIM_NO_AGENT')
    expect(noPreset.create).not.toHaveBeenCalled()
  })
})

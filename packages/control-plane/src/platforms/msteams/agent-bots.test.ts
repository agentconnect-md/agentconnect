// Microsoft's side of an agent bot (teams-integration.md §8.6), against scripted Entra, Graph and Azure answers.
import { describe, expect, it } from 'vitest'
import {
  MSTEAMS_AGENT_BOT_DISABLED_CODE,
  MsTeamsAgentBotClient,
  MsTeamsAgentBotError,
  MsTeamsBlueprintIncomplete,
  createMsTeamsBlueprint,
  msTeamsAgentBotKey,
  msTeamsAgentBotResourceName,
  msTeamsAgentBotTag
} from './agent-bots.js'

const APP = {
  appId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-0000000000b1',
  clientSecret: 'example-app-secret'
}
const AGENT_BOTS = {
  blueprintId: '00000000-0000-4000-8000-0000000000c1',
  clientSecret: 'example-blueprint-secret',
  subscriptionId: '00000000-0000-4000-8000-0000000000d1',
  resourceGroup: 'example-bots'
}
const TENANT = '00000000-0000-4000-8000-0000000000e1'
const IDENTITY = '00000000-0000-4000-8000-0000000000f1'
const AGENT = '00000000-0000-4000-8000-000000000011'
const KEY = msTeamsAgentBotKey(AGENT, TENANT)

interface Call {
  method: string
  url: string
  form?: Record<string, string>
  body?: Record<string, unknown>
  authorization?: string
}
type Answer = { status: number; body?: unknown }

/** Microsoft, scripted: `answer` sees each call in order and decides; token requests get a token named after their client unless it refuses. */
function microsoft(answer: (call: Call, seen: Call[]) => Answer | undefined) {
  const calls: Call[] = []
  const waits: number[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const isToken = url.startsWith('https://login.microsoftonline.com/')
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      ...(isToken ? { form: Object.fromEntries(new URLSearchParams(String(init?.body))) } : {}),
      ...(!isToken && typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      ...(headers.authorization ? { authorization: headers.authorization } : {})
    }
    const decided = answer(call, calls)
    calls.push(call)
    if (decided) return Response.json(decided.body ?? {}, { status: decided.status })
    if (isToken) return Response.json({ access_token: `token-of-${call.form!.client_id}`, expires_in: 3600 })
    return Response.json({}, { status: 200 })
  }) as typeof fetch
  const client = new MsTeamsAgentBotClient({
    app: APP,
    agentBots: AGENT_BOTS,
    fetch: fetchImpl,
    wait: async (ms) => void waits.push(ms)
  })
  return { client, calls, waits }
}

const tokenUrl = (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
const entraRefusal = (code: number): Answer => ({ status: 400, body: { error: 'invalid_client', error_codes: [code] } })

describe('an agent bot’s names', () => {
  it('derive one key per agent and tenant, whatever the tenant’s case', () => {
    expect(KEY).toMatch(/^[0-9a-f]{32}$/)
    expect(msTeamsAgentBotKey(AGENT, TENANT.toUpperCase())).toBe(KEY)
    expect(msTeamsAgentBotKey(AGENT, APP.tenantId)).not.toBe(KEY)
    expect(msTeamsAgentBotResourceName(KEY)).toBe(`acbot-${KEY}`)
    // Azure refuses a bot name longer than 42 characters.
    expect(msTeamsAgentBotResourceName(KEY).length).toBeLessThanOrEqual(42)
    expect(msTeamsAgentBotTag(KEY)).toBe(`agentconnect-agent-bot:${KEY}`)
  })
})

describe('MsTeamsAgentBotClient', () => {
  it('obtains an identity’s Bot Connector token from its own tenant in two steps', async () => {
    const ms = microsoft(() => undefined)
    expect(await ms.client.botToken(TENANT, IDENTITY)).toBe(`token-of-${IDENTITY}`)
    expect(ms.calls.map((c) => c.url)).toEqual([tokenUrl(TENANT), tokenUrl(TENANT)])
    expect(ms.calls[0]!.form).toEqual({
      grant_type: 'client_credentials',
      client_id: AGENT_BOTS.blueprintId,
      client_secret: AGENT_BOTS.clientSecret,
      scope: 'api://AzureADTokenExchange/.default',
      fmi_path: IDENTITY
    })
    expect(ms.calls[1]!.form).toEqual({
      grant_type: 'client_credentials',
      client_id: IDENTITY,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: `token-of-${AGENT_BOTS.blueprintId}`,
      scope: 'https://api.botframework.com/.default'
    })
  })

  it('creates the blueprint’s principal with the administrator’s token only where the tenant has none', async () => {
    const present = microsoft(() => undefined)
    await present.client.ensurePrincipal(TENANT, 'admin-token')
    expect(present.calls).toHaveLength(1)

    const absent = microsoft((call) => (call.form ? entraRefusal(7000229) : { status: 201, body: { id: 'p1' } }))
    await absent.client.ensurePrincipal(TENANT, 'admin-token')
    expect(absent.calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal',
      body: { appId: AGENT_BOTS.blueprintId },
      authorization: 'Bearer admin-token'
    })

    const refused = microsoft((call) =>
      call.form ? entraRefusal(7000229) : { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }
    )
    await expect(refused.client.ensurePrincipal(TENANT, 'admin-token')).rejects.toMatchObject({
      step: 'principal',
      status: 403,
      providerCode: 'Authorization_RequestDenied'
    })
  })

  it('reuses the identity a key’s tag names, and creates one with the tag and a sponsor otherwise', async () => {
    const held = microsoft((call) =>
      call.method === 'GET' ? { status: 200, body: { value: [{ id: IDENTITY.toUpperCase() }] } } : undefined
    )
    const input = { tenantId: TENANT, key: KEY, displayName: 'Example Agent', sponsorUserId: 'user-1' }
    expect(await held.client.ensureIdentity(input)).toBe(IDENTITY)
    expect(held.calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(decodeURIComponent(held.calls[1]!.url)).toContain(`tags/any(t:t eq 'agentconnect-agent-bot:${KEY}')`)

    // A new principal: Graph does not know the caller for a while, then creates.
    const fresh = microsoft((call, seen) => {
      if (call.method === 'GET') return { status: 200, body: { value: [] } }
      if (call.form) return undefined
      const tries = seen.filter((c) => c.url.endsWith('microsoft.graph.agentIdentity')).length
      return tries < 2
        ? { status: 401, body: { error: { code: 'Authorization_IdentityNotFound' } } }
        : { status: 201, body: { id: IDENTITY } }
    })
    expect(await fresh.client.ensureIdentity(input)).toBe(IDENTITY)
    expect(fresh.waits).toHaveLength(2)
    expect(fresh.calls.at(-1)!.body).toEqual({
      displayName: 'Example Agent',
      agentIdentityBlueprintId: AGENT_BOTS.blueprintId,
      tags: [`agentconnect-agent-bot:${KEY}`],
      'sponsors@odata.bind': ['https://graph.microsoft.com/v1.0/users/user-1']
    })

    const blocked = microsoft((call) => {
      if (call.method === 'GET') return { status: 200, body: { value: [] } }
      return call.form ? undefined : { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }
    })
    await expect(blocked.client.ensureIdentity(input)).rejects.toMatchObject({ step: 'identity', status: 403 })
    expect(blocked.waits).toEqual([])
  })

  it('registers the bot and its Teams channel under the key’s name with the app’s Azure token', async () => {
    const ms = microsoft(() => undefined)
    await ms.client.ensureRegistration({
      key: KEY,
      tenantId: TENANT,
      identity: IDENTITY,
      displayName: 'Example Agent',
      relayPublicUrl: 'https://relay.example.test'
    })
    const base =
      `https://management.azure.com/subscriptions/${AGENT_BOTS.subscriptionId}/resourceGroups/example-bots` +
      `/providers/Microsoft.BotService/botServices/acbot-${KEY}`
    expect(ms.calls[0]).toMatchObject({
      url: tokenUrl(APP.tenantId),
      form: { client_id: APP.appId, scope: 'https://management.azure.com/.default' }
    })
    expect(ms.calls[1]).toMatchObject({
      method: 'PUT',
      url: `${base}?api-version=2022-09-15`,
      body: {
        location: 'global',
        kind: 'azurebot',
        sku: { name: 'F0' },
        properties: {
          displayName: 'Example Agent',
          endpoint: 'https://relay.example.test/msteams/messages',
          msaAppId: IDENTITY,
          msaAppType: 'SingleTenant',
          msaAppTenantId: TENANT
        }
      }
    })
    expect(ms.calls[2]).toMatchObject({ method: 'PUT', url: `${base}/channels/MsTeamsChannel?api-version=2022-09-15` })

    const denied = microsoft((call) =>
      call.form ? undefined : { status: 403, body: { error: { code: 'AuthorizationFailed' } } }
    )
    await expect(
      denied.client.ensureRegistration({
        key: KEY,
        tenantId: TENANT,
        identity: IDENTITY,
        displayName: 'x',
        relayPublicUrl: 'https://relay.example.test'
      })
    ).rejects.toMatchObject({ step: 'registration', status: 403, providerCode: 'AuthorizationFailed' })
  })

  it('proves a new identity once it settles, and stops at once for a disabled one', async () => {
    const settling = microsoft((call, seen) =>
      call.form?.client_id === IDENTITY && seen.filter((c) => c.form?.client_id === IDENTITY).length < 2
        ? entraRefusal(700016)
        : undefined
    )
    await settling.client.prove(TENANT, IDENTITY)
    expect(settling.waits).toHaveLength(2)

    const disabled = microsoft(() => entraRefusal(Number(MSTEAMS_AGENT_BOT_DISABLED_CODE)))
    const error = await disabled.client.prove(TENANT, IDENTITY).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(MsTeamsAgentBotError)
    expect(error).toMatchObject({ step: 'token', providerCode: MSTEAMS_AGENT_BOT_DISABLED_CODE, transient: false })
    expect(disabled.waits).toEqual([])
  })

  it('deletes the registration and the identity, counting what is already gone as deleted', async () => {
    const ms = microsoft((call) => (call.method === 'DELETE' ? { status: 404 } : undefined))
    await ms.client.deleteRegistration(KEY)
    await ms.client.deleteIdentity(TENANT, IDENTITY)
    expect(ms.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      expect.stringContaining(`/botServices/acbot-${KEY}?api-version=`),
      `https://graph.microsoft.com/v1.0/servicePrincipals/${IDENTITY}`
    ])
    const stuck = microsoft((call) =>
      call.method === 'DELETE' ? { status: 409, body: { error: { code: 'Conflict' } } } : undefined
    )
    await expect(stuck.client.deleteRegistration(KEY)).rejects.toMatchObject({ status: 409 })
  })

  it('lists its own registrations and one blueprint’s identities for the reaper', async () => {
    const other = 'https://elsewhere.example.test/next'
    const ms = microsoft((call) => {
      if (call.url.includes('/botServices?')) {
        return {
          status: 200,
          body: {
            value: [
              { name: `acbot-${KEY}`, properties: { msaAppId: IDENTITY.toUpperCase(), msaAppTenantId: TENANT } },
              { name: 'someone-elses-bot', properties: { msaAppId: 'x' } }
            ],
            nextLink: other
          }
        }
      }
      if (call.url.includes('microsoft.graph.agentIdentity?')) {
        return {
          status: 200,
          body: {
            value: [
              { id: IDENTITY, tags: [`agentconnect-agent-bot:${KEY}`] },
              { id: 'untagged', tags: [] }
            ]
          }
        }
      }
      return undefined
    })
    expect(await ms.client.listRegistrations()).toEqual([{ key: KEY, identity: IDENTITY, tenantId: TENANT }])
    expect(ms.calls.some((c) => c.url === other)).toBe(false)
    expect(await ms.client.listIdentities(TENANT)).toEqual([
      { identity: IDENTITY, key: KEY },
      { identity: 'untagged', key: null }
    ])
    expect(decodeURIComponent(ms.calls.at(-1)!.url)).toContain(
      `agentIdentityBlueprintId eq '${AGENT_BOTS.blueprintId}'`
    )
  })

  it('checks the blueprint, its audience, the resource group and the provider before Setup saves', async () => {
    const audience = (value: string): Answer => ({ status: 200, body: { signInAudience: value } })
    const registered: Answer = { status: 200, body: { registrationState: 'Registered' } }
    const script = (over: { secret?: Answer; app?: Answer; group?: Answer; provider?: Answer; arm?: Answer }) =>
      microsoft((call) => {
        if (call.form?.client_id === AGENT_BOTS.blueprintId) return over.secret
        if (call.form?.client_id === APP.appId) return over.arm
        if (call.url.includes('/applications(')) return over.app ?? audience('AzureADMultipleOrgs')
        if (call.url.includes('/resourcegroups/')) return over.group ?? { status: 200 }
        if (call.url.includes('/providers/Microsoft.BotService?')) return over.provider ?? registered
        return undefined
      }).client.check()
    expect(await script({})).toEqual({ ok: true })
    expect(await script({ secret: entraRefusal(7000215) })).toEqual({ ok: false, reason: 'blueprint_credentials' })
    expect(await script({ secret: { status: 503 } })).toEqual({ ok: false, reason: 'unavailable' })
    expect(await script({ app: audience('AzureADMyOrg') })).toEqual({ ok: false, reason: 'blueprint_single_tenant' })
    expect(await script({ arm: entraRefusal(7000215) })).toEqual({ ok: false, reason: 'azure_credentials' })
    // Azure answers a missing group and one the app has no role on with the same 403.
    expect(await script({ group: { status: 403 } })).toEqual({ ok: false, reason: 'resource_group' })
    expect(await script({ provider: { status: 200, body: { registrationState: 'NotRegistered' } } })).toEqual({
      ok: false,
      reason: 'provider_unregistered'
    })
    expect(await script({ provider: { status: 500 } })).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('creating the blueprint from Setup', () => {
  const NEW = '00000000-0000-4000-8000-0000000000C9'
  const script = (answer: (call: Call, seen: Call[]) => Answer | undefined) => {
    const ms = microsoft(answer)
    const fetchImpl = ((input: unknown, init?: RequestInit) =>
      (ms.client as unknown as { fetchImpl: typeof fetch }).fetchImpl(input as string, init)) as typeof fetch
    const waits: number[] = []
    const create = () =>
      createMsTeamsBlueprint(
        APP,
        { displayName: 'Example Agents', operator: 'operator@example.test' },
        fetchImpl,
        async (ms) => void waits.push(ms)
      )
    return { ...ms, waits, create }
  }

  it('makes it open to other organizations with the operator as owner and sponsor, then its principal and a secret', async () => {
    const ms = script((call, seen) => {
      if (call.form) return undefined
      if (call.url.endsWith('/applications')) return { status: 201, body: { appId: NEW } }
      // Graph does not see the new application on the first try.
      if (call.url.endsWith('agentIdentityBlueprintPrincipal'))
        return seen.some((c) => c.url === call.url) ? { status: 201, body: { id: 'p1' } } : { status: 400 }
      return { status: 200, body: { secretText: 'example-new-secret' } }
    })
    expect(await ms.create()).toEqual({ blueprintId: NEW.toLowerCase(), clientSecret: 'example-new-secret' })
    expect(ms.waits).toHaveLength(1)
    expect(ms.calls[0]!.form).toMatchObject({ client_id: APP.appId, scope: 'https://graph.microsoft.com/.default' })
    expect(ms.calls[1]!.body).toEqual({
      '@odata.type': 'Microsoft.Graph.AgentIdentityBlueprint',
      displayName: 'Example Agents',
      signInAudience: 'AzureADMultipleOrgs',
      'sponsors@odata.bind': ['https://graph.microsoft.com/v1.0/users/operator%40example.test'],
      'owners@odata.bind': ['https://graph.microsoft.com/v1.0/users/operator%40example.test']
    })
    expect(ms.calls.at(-1)!.url).toBe(
      `https://graph.microsoft.com/v1.0/applications(appId='${NEW.toLowerCase()}')/addPassword`
    )
  })

  it('names the refusal when the app lacks the permission, and the half-made blueprint when a later step fails', async () => {
    const denied = script((call) =>
      call.form ? undefined : { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }
    )
    const refusal = await denied.create().catch((err: unknown) => err)
    expect(refusal).toMatchObject({ step: 'blueprint', status: 403, providerCode: 'Authorization_RequestDenied' })
    expect(refusal).not.toBeInstanceOf(MsTeamsBlueprintIncomplete)

    const half = script((call) => {
      if (call.form) return undefined
      if (call.url.endsWith('/applications')) return { status: 201, body: { appId: NEW } }
      return { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }
    })
    const incomplete = await half.create().catch((err: unknown) => err)
    expect(incomplete).toBeInstanceOf(MsTeamsBlueprintIncomplete)
    expect(incomplete).toMatchObject({ blueprintId: NEW.toLowerCase(), status: 403 })
  })

  it('gives a just-made blueprint’s secret time before it reads as wrong', async () => {
    const ms = microsoft((call, seen) => {
      if (call.form?.client_id === AGENT_BOTS.blueprintId)
        return seen.filter((c) => c.form?.client_id === AGENT_BOTS.blueprintId).length < 2
          ? entraRefusal(7000215)
          : undefined
      if (call.url.includes('/applications(')) return { status: 200, body: { signInAudience: 'AzureADMultipleOrgs' } }
      if (call.url.includes('/providers/Microsoft.BotService?'))
        return { status: 200, body: { registrationState: 'Registered' } }
      return undefined
    })
    expect(await ms.client.check({ settle: true })).toEqual({ ok: true })
    expect(ms.waits).toHaveLength(2)
  })
})

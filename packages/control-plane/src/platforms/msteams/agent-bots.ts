// Microsoft's side of an agent bot (teams-integration.md §8.6): the blueprint's principal, the agent identity, its bot registration and its tokens.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { msTeamsMessagesUrl } from '@agentconnect.md/protocol'
import type { MsTeamsAgentBots, MsTeamsPlatformApp } from './deployment-app.js'
import { MSTEAMS_TOKEN_SCOPE, msTeamsTokenUrl } from './provider.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
const ARM = 'https://management.azure.com'
const ARM_SCOPE = 'https://management.azure.com/.default'
const TOKEN_EXCHANGE_SCOPE = 'api://AzureADTokenExchange/.default'
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const BOT_API_VERSION = '2022-09-15'
const RESOURCES_API_VERSION = '2021-04-01'
const TIMEOUT_MS = 15_000
/** A new principal or identity is not usable at once; retries wait this long between tries, up to the tries below. */
const SETTLE_MS = 5_000
const SETTLE_TRIES = 12

/** Which of Microsoft's steps refused, with its status and code; the provider's own description never reaches a person as is. */
export class MsTeamsAgentBotError extends Error {
  constructor(
    readonly step: 'token' | 'principal' | 'identity' | 'registration' | 'blueprint' | 'azure',
    readonly status: number | undefined,
    /** Entra's `AADSTS…` number, Graph's or Azure's error code; undefined when Microsoft did not answer. */
    readonly providerCode: string | undefined
  ) {
    super(`Microsoft ${step} request ${status === undefined ? 'got no answer' : `answered ${status}`}`)
    this.name = 'MsTeamsAgentBotError'
  }

  /** Nothing was decided: Microsoft was unreachable, throttling or failing. */
  get transient(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500
  }
}

/** Entra's codes for an identity or blueprint principal an administrator disabled, and for one that is gone (§8.6.2). */
export const MSTEAMS_AGENT_BOT_DISABLED_CODE = '7000112'
export const MSTEAMS_AGENT_BOT_DELETED_CODE = '700016'

type Json = Record<string, unknown>
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined

export interface MsTeamsAgentBotDeps {
  app: MsTeamsPlatformApp
  agentBots: MsTeamsAgentBots
  fetch?: typeof fetch
  /** Waits between tries while a new object settles; injected so tests do not sleep. */
  wait?: (ms: number) => Promise<void>
}

/** The key an agent bot's objects are named by, so a retry and the reaper find them: one per agent and tenant. */
export function msTeamsAgentBotKey(agentId: string, tenantId: string): string {
  return createHash('sha256')
    .update(`msteams-agent-bot-v1\0${agentId}\0${tenantId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)
}

/** The Azure Bot resource of a key; resource names are global, so the key is all of it. */
export const msTeamsAgentBotResourceName = (key: string) => `agentconnect-${key}`
const TAG_PREFIX = 'agentconnect-agent-bot:'
/** The tag an agent identity is created with and found again by. */
export const msTeamsAgentBotTag = (key: string) => `${TAG_PREFIX}${key}`

const Identity = z.object({ id: z.string().min(1), tags: z.array(z.string()).nullish() })
const Identities = z.object({ value: z.array(Identity), '@odata.nextLink': z.string().nullish() })
const BotResource = z.object({
  name: z.string().min(1),
  properties: z.object({ msaAppId: z.string().nullish(), msaAppTenantId: z.string().nullish() }).nullish()
})
const BotResources = z.object({ value: z.array(BotResource), nextLink: z.string().nullish() })

export class MsTeamsAgentBotClient {
  private readonly fetchImpl: typeof fetch
  private readonly wait: (ms: number) => Promise<void>

  constructor(private readonly deps: MsTeamsAgentBotDeps) {
    this.fetchImpl = deps.fetch ?? fetch
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  // One client-credentials request; the refusal carries Entra's first error number.
  private async token(tenantId: string, params: Record<string, string>): Promise<string> {
    let response: Response
    let body: Json | undefined
    try {
      response = await this.fetchImpl(msTeamsTokenUrl(tenantId), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', ...params }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      body = obj(await response.json().catch(() => undefined))
    } catch {
      throw new MsTeamsAgentBotError('token', undefined, undefined)
    }
    const value = typeof body?.access_token === 'string' ? body.access_token : ''
    if (response.ok && value) return value
    const codes = Array.isArray(body?.error_codes) ? body.error_codes : []
    throw new MsTeamsAgentBotError('token', response.status, codes.length > 0 ? String(codes[0]) : undefined)
  }

  /** The blueprint's own token in a tenant where its principal exists. */
  async blueprintToken(tenantId: string, scope = GRAPH_SCOPE, extra: Record<string, string> = {}): Promise<string> {
    const { blueprintId, clientSecret } = this.deps.agentBots
    return await this.token(tenantId, { client_id: blueprintId, client_secret: clientSecret, scope, ...extra })
  }

  /** A Bot Connector token for one agent identity, issued by its own tenant: the blueprint vouches, then the identity presents that as its assertion. */
  async botToken(tenantId: string, identity: string): Promise<string> {
    const assertion = await this.blueprintToken(tenantId, TOKEN_EXCHANGE_SCOPE, { fmi_path: identity })
    return await this.token(tenantId, {
      client_id: identity,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
      scope: MSTEAMS_TOKEN_SCOPE
    })
  }

  private async armToken(): Promise<string> {
    const { appId, tenantId, clientSecret } = this.deps.app
    return await this.token(tenantId, { client_id: appId, client_secret: clientSecret, scope: ARM_SCOPE })
  }

  private async call(
    step: MsTeamsAgentBotError['step'],
    method: string,
    url: string,
    token: string,
    body?: Json
  ): Promise<{ status: number; body: Json | undefined; code: string | undefined }> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'OData-Version': '4.0',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new MsTeamsAgentBotError(step, undefined, undefined)
    }
    const parsed = obj(await response.json().catch(() => undefined))
    const code = obj(parsed?.error)?.code
    return { status: response.status, body: parsed, code: typeof code === 'string' ? code : undefined }
  }

  /** The blueprint's principal in a customer tenant, created with the administrator's delegated token if the tenant has none (§8.6.5 step 2). */
  async ensurePrincipal(tenantId: string, adminToken: string): Promise<void> {
    // Graph answers an existing principal with a plain 400, so the blueprint's own token is what says the tenant has one.
    if (await this.hasPrincipal(tenantId)) return
    const url = `${GRAPH}/servicePrincipals/microsoft.graph.agentIdentityBlueprintPrincipal`
    const created = await this.call('principal', 'POST', url, adminToken, { appId: this.deps.agentBots.blueprintId })
    if (created.status !== 201) throw new MsTeamsAgentBotError('principal', created.status, created.code)
  }

  /** Whether the blueprint already has a working principal in the tenant. */
  async hasPrincipal(tenantId: string): Promise<boolean> {
    try {
      await this.blueprintToken(tenantId)
      return true
    } catch (err) {
      if (err instanceof MsTeamsAgentBotError && !err.transient) return false
      throw err
    }
  }

  // The blueprint's Graph token for a tenant whose principal may be seconds old.
  private async settledBlueprintToken(tenantId: string): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.blueprintToken(tenantId)
      } catch (err) {
        if (!(err instanceof MsTeamsAgentBotError) || err.transient || attempt >= SETTLE_TRIES) throw err
        await this.wait(SETTLE_MS)
      }
    }
  }

  /** The agent identity of a key in a tenant, by its tag; undefined when the tenant holds none. */
  async findIdentity(tenantId: string, key: string, token?: string): Promise<string | undefined> {
    const graphToken = token ?? (await this.settledBlueprintToken(tenantId))
    const filter = encodeURIComponent(`tags/any(t:t eq '${msTeamsAgentBotTag(key)}')`)
    const found = await this.call(
      'identity',
      'GET',
      `${GRAPH}/servicePrincipals?$filter=${filter}&$select=id,tags`,
      graphToken
    )
    if (found.status !== 200) throw new MsTeamsAgentBotError('identity', found.status, found.code)
    return Identities.parse(found.body).value[0]?.id.toLowerCase()
  }

  /** The agent identity of a key, created by the blueprint with a sponsor unless the tenant already holds it (§8.6.5 step 3). */
  async ensureIdentity(input: {
    tenantId: string
    key: string
    displayName: string
    sponsorUserId: string
  }): Promise<string> {
    const token = await this.settledBlueprintToken(input.tenantId)
    const existing = await this.findIdentity(input.tenantId, input.key, token)
    if (existing) return existing
    const body = {
      displayName: input.displayName,
      agentIdentityBlueprintId: this.deps.agentBots.blueprintId,
      tags: [msTeamsAgentBotTag(input.key)],
      'sponsors@odata.bind': [`${GRAPH}/users/${encodeURIComponent(input.sponsorUserId)}`]
    }
    for (let attempt = 1; ; attempt += 1) {
      const created = await this.call(
        'identity',
        'POST',
        `${GRAPH}/servicePrincipals/microsoft.graph.agentIdentity`,
        token,
        body
      )
      const id = created.status === 201 ? Identity.safeParse(created.body) : undefined
      if (id?.success) return id.data.id.toLowerCase()
      // Right after a new principal Graph does not know the caller yet (measured for about thirty seconds).
      const settling = created.status === 401 || created.status >= 500 || created.status === 429
      if (!settling || attempt >= SETTLE_TRIES) throw new MsTeamsAgentBotError('identity', created.status, created.code)
      await this.wait(SETTLE_MS)
    }
  }

  private botUrl(key: string, suffix = ''): string {
    const { subscriptionId, resourceGroup } = this.deps.agentBots
    const group = `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}`
    return `${group}/providers/Microsoft.BotService/botServices/${msTeamsAgentBotResourceName(key)}${suffix}?api-version=${BOT_API_VERSION}`
  }

  /** The Azure Bot resource and its Teams channel for an identity; a PUT of the same name replaces, so a retry is safe (§8.6.5 step 4). */
  async ensureRegistration(input: {
    key: string
    tenantId: string
    identity: string
    displayName: string
    relayPublicUrl: string
  }): Promise<void> {
    const token = await this.armToken()
    const bot = await this.call('registration', 'PUT', this.botUrl(input.key), token, {
      location: 'global',
      kind: 'azurebot',
      sku: { name: 'F0' },
      properties: {
        displayName: input.displayName,
        endpoint: msTeamsMessagesUrl(input.relayPublicUrl),
        msaAppId: input.identity,
        msaAppType: 'SingleTenant',
        msaAppTenantId: input.tenantId
      }
    })
    if (bot.status !== 200 && bot.status !== 201) throw new MsTeamsAgentBotError('registration', bot.status, bot.code)
    const channel = await this.call('registration', 'PUT', this.botUrl(input.key, '/channels/MsTeamsChannel'), token, {
      location: 'global',
      properties: { channelName: 'MsTeamsChannel', properties: { isEnabled: true, acceptedTerms: true } }
    })
    if (channel.status !== 200 && channel.status !== 201)
      throw new MsTeamsAgentBotError('registration', channel.status, channel.code)
  }

  /** Proves the principal, the identity and the blueprint's secret together, waiting while the new identity settles (§8.6.5 step 5). */
  async prove(tenantId: string, identity: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.botToken(tenantId, identity)
        return
      } catch (err) {
        if (!(err instanceof MsTeamsAgentBotError) || attempt >= SETTLE_TRIES) throw err
        // An identity an administrator disabled does not settle; anything else may be a seconds-old object.
        if (err.providerCode === MSTEAMS_AGENT_BOT_DISABLED_CODE) throw err
        await this.wait(SETTLE_MS)
      }
    }
  }

  /** Renames the registration and the identity at once (§8.6.5, renaming). */
  async rename(input: { key: string; tenantId: string; identity: string; displayName: string }): Promise<void> {
    const arm = await this.armToken()
    const bot = await this.call('registration', 'PATCH', this.botUrl(input.key), arm, {
      properties: { displayName: input.displayName }
    })
    if (bot.status !== 200) throw new MsTeamsAgentBotError('registration', bot.status, bot.code)
    const graph = await this.blueprintToken(input.tenantId)
    const renamed = await this.call('identity', 'PATCH', `${GRAPH}/servicePrincipals/${input.identity}`, graph, {
      displayName: input.displayName
    })
    if (renamed.status !== 204 && renamed.status !== 200)
      throw new MsTeamsAgentBotError('identity', renamed.status, renamed.code)
  }

  /** Deletes the registration, after which the bot neither receives nor sends; gone already counts as deleted. */
  async deleteRegistration(key: string): Promise<void> {
    const gone = await this.call('registration', 'DELETE', this.botUrl(key), await this.armToken())
    if (gone.status !== 200 && gone.status !== 204 && gone.status !== 404)
      throw new MsTeamsAgentBotError('registration', gone.status, gone.code)
  }

  /** Has the blueprint delete one of its identities; gone already counts as deleted. A tenant whose principal is gone has nothing left to delete with. */
  async deleteIdentity(tenantId: string, identity: string): Promise<void> {
    const token = await this.blueprintToken(tenantId)
    const gone = await this.call('identity', 'DELETE', `${GRAPH}/servicePrincipals/${identity}`, token)
    if (gone.status !== 204 && gone.status !== 404) throw new MsTeamsAgentBotError('identity', gone.status, gone.code)
  }

  /** Every registration in the resource group that this module named, with the identity and tenant it points at (the reaper's first list). */
  async listRegistrations(): Promise<{ key: string; identity: string | null; tenantId: string | null }[]> {
    const { subscriptionId, resourceGroup } = this.deps.agentBots
    const token = await this.armToken()
    const out: { key: string; identity: string | null; tenantId: string | null }[] = []
    let url: string | undefined =
      `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}` +
      `/providers/Microsoft.BotService/botServices?api-version=${BOT_API_VERSION}`
    while (url) {
      const page = await this.call('registration', 'GET', url, token)
      if (page.status !== 200) throw new MsTeamsAgentBotError('registration', page.status, page.code)
      const parsed = BotResources.parse(page.body)
      for (const bot of parsed.value) {
        const key = /^agentconnect-([0-9a-f]{32})$/.exec(bot.name)?.[1]
        if (key)
          out.push({
            key,
            identity: bot.properties?.msaAppId?.toLowerCase() ?? null,
            tenantId: bot.properties?.msaAppTenantId?.toLowerCase() ?? null
          })
      }
      // Only Azure's own next page is followed.
      url = parsed.nextLink?.startsWith(`${ARM}/`) ? parsed.nextLink : undefined
    }
    return out
  }

  /** Every identity this blueprint made in a tenant, with the key its tag names (the reaper's second list); another blueprint's are never returned. */
  async listIdentities(tenantId: string): Promise<{ identity: string; key: string | null }[]> {
    const token = await this.blueprintToken(tenantId)
    const filter = encodeURIComponent(`agentIdentityBlueprintId eq '${this.deps.agentBots.blueprintId}'`)
    const out: { identity: string; key: string | null }[] = []
    let url: string | undefined =
      `${GRAPH}/servicePrincipals/microsoft.graph.agentIdentity?$filter=${filter}&$select=id,tags`
    while (url) {
      const page = await this.call('identity', 'GET', url, token)
      if (page.status !== 200) throw new MsTeamsAgentBotError('identity', page.status, page.code)
      const parsed = Identities.parse(page.body)
      for (const identity of parsed.value) {
        const tag = identity.tags?.find((value) => value.startsWith(TAG_PREFIX))
        out.push({ identity: identity.id.toLowerCase(), key: tag ? tag.slice(TAG_PREFIX.length) : null })
      }
      const next = parsed['@odata.nextLink']
      url = next?.startsWith(`${GRAPH}/`) ? next : undefined
    }
    return out
  }

  /** What Setup checks before it saves agent bots (§8.6.3): the blueprint's secret, that other organizations may use it, the resource group, and the provider's registration. */
  async check(): Promise<MsTeamsAgentBotsCheck> {
    const { blueprintId, subscriptionId, resourceGroup } = this.deps.agentBots
    let graph: string
    try {
      graph = await this.blueprintToken(this.deps.app.tenantId)
    } catch (err) {
      if (err instanceof MsTeamsAgentBotError && !err.transient) return { ok: false, reason: 'blueprint_credentials' }
      return { ok: false, reason: 'unavailable' }
    }
    try {
      // The blueprint reads its own application with no permission granted to it.
      const app = await this.call(
        'blueprint',
        'GET',
        `${GRAPH}/applications(appId='${blueprintId}')?$select=signInAudience`,
        graph
      )
      if (app.status !== 200) return { ok: false, reason: app.status >= 500 ? 'unavailable' : 'blueprint_credentials' }
      if (app.body?.signInAudience !== 'AzureADMultipleOrgs') return { ok: false, reason: 'blueprint_single_tenant' }
      const arm = await this.armToken()
      const base = `${ARM}/subscriptions/${subscriptionId}`
      const group = await this.call(
        'azure',
        'GET',
        `${base}/resourcegroups/${encodeURIComponent(resourceGroup)}?api-version=${RESOURCES_API_VERSION}`,
        arm
      )
      if (group.status >= 500 || group.status === 429) return { ok: false, reason: 'unavailable' }
      // Azure answers a missing group and a group the app has no role on alike.
      if (group.status !== 200) return { ok: false, reason: 'resource_group' }
      const provider = await this.call(
        'azure',
        'GET',
        `${base}/providers/Microsoft.BotService?api-version=${RESOURCES_API_VERSION}`,
        arm
      )
      if (provider.status >= 500 || provider.status === 429) return { ok: false, reason: 'unavailable' }
      if (provider.status !== 200 || provider.body?.registrationState !== 'Registered')
        return { ok: false, reason: 'provider_unregistered' }
      return { ok: true }
    } catch (err) {
      if (err instanceof MsTeamsAgentBotError && !err.transient && err.step === 'token')
        return { ok: false, reason: 'azure_credentials' }
      return { ok: false, reason: 'unavailable' }
    }
  }
}

export type MsTeamsAgentBotsCheck =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'blueprint_credentials'
        | 'blueprint_single_tenant'
        | 'azure_credentials'
        | 'resource_group'
        | 'provider_unregistered'
        | 'unavailable'
    }

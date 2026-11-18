/** The identity service as organization SSO uses it (organization-sso.md §3, §6.1): connectors named after an organization, and the accounts behind them. */
import { LogtoApiError } from '../github/logto-identity.js'
import type { OrgSsoProtocol } from '../persistence/ports.js'

/** The identity service refused the settings; `message` is its reason, fit to show the owner. */
export class OrgSsoIdpRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgSsoIdpRejected'
  }
}

export interface OrgSsoAccount {
  primaryEmail: string | null
  /** Connectors the account holds an SSO identity on. */
  connectorIds: string[]
}

/** `missing` means the connector is gone from the identity service, so the connection needs its configuration again. */
export interface OrgSsoIdp {
  /** Create the organization's connector, or return the one a retried create left; a protocol change replaces it. */
  ensureConnector(input: { connectorName: string; protocol: OrgSsoProtocol; displayName: string }): Promise<string>
  configure(id: string, input: { displayName: string; config: Record<string, unknown> }): Promise<'ok' | 'missing'>
  /** Set the whole list of domains the connector routes, links and enforces. */
  setDomains(id: string, domains: readonly string[]): Promise<'ok' | 'missing'>
  deleteConnector(id: string): Promise<void>
  /** Null when the account no longer exists. */
  account(sub: string): Promise<OrgSsoAccount | null>
  deleteAccount(sub: string): Promise<void>
}

const PROVIDER: Record<OrgSsoProtocol, string> = { oidc: 'OIDC', saml: 'SAML' }

export const orgConnectorName = (orgId: string): string => `org-${orgId}`

type ManagementRequest = (path: string, init?: RequestInit) => Promise<Response>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function refusal(res: Response): Promise<never> {
  const body = record(await res.json().catch(() => null))
  const reason = typeof body.message === 'string' ? body.message.replace(/\.+$/, '') : `status ${res.status}`
  if (res.status >= 500) throw new LogtoApiError(`logto sso connector request failed: ${res.status}`, res.status, true)
  throw new OrgSsoIdpRejected(reason)
}

export class LogtoOrgSsoIdp implements OrgSsoIdp {
  constructor(private readonly request: ManagementRequest) {}

  async ensureConnector(input: {
    connectorName: string
    protocol: OrgSsoProtocol
    displayName: string
  }): Promise<string> {
    const list = await this.request('/api/sso-connectors')
    if (!list.ok) await refusal(list)
    const rows = (await list.json()) as unknown
    const existing = (Array.isArray(rows) ? rows.map(record) : []).find(
      (row) => row.connectorName === input.connectorName && typeof row.id === 'string'
    )
    if (existing && existing.providerName === PROVIDER[input.protocol]) return existing.id as string
    // The service-provider values were registered for the old protocol, so a switch starts a new connector.
    if (existing) await this.deleteConnector(existing.id as string)
    const created = await this.request('/api/sso-connectors', {
      method: 'POST',
      body: JSON.stringify({
        providerName: PROVIDER[input.protocol],
        connectorName: input.connectorName,
        branding: { displayName: input.displayName }
      })
    })
    if (!created.ok) await refusal(created)
    const id = record(await created.json()).id
    if (typeof id !== 'string') throw new LogtoApiError('logto returned an invalid sso connector', 502, false)
    return id
  }

  configure(id: string, input: { displayName: string; config: Record<string, unknown> }): Promise<'ok' | 'missing'> {
    return this.patch(id, { config: input.config, branding: { displayName: input.displayName } })
  }

  setDomains(id: string, domains: readonly string[]): Promise<'ok' | 'missing'> {
    return this.patch(id, { domains: [...domains] })
  }

  async deleteConnector(id: string): Promise<void> {
    const res = await this.request(`/api/sso-connectors/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) await refusal(res)
  }

  async account(sub: string): Promise<OrgSsoAccount | null> {
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}?includeSsoIdentities=true`)
    if (res.status === 404) return null
    if (!res.ok) throw new LogtoApiError(`logto user lookup failed: ${res.status}`, res.status, res.status >= 500)
    const user = record(await res.json())
    const identities = Array.isArray(user.ssoIdentities) ? user.ssoIdentities.map(record) : []
    return {
      primaryEmail: typeof user.primaryEmail === 'string' && user.primaryEmail ? user.primaryEmail : null,
      connectorIds: identities.flatMap((identity) =>
        typeof identity.ssoConnectorId === 'string' ? [identity.ssoConnectorId] : []
      )
    }
  }

  async deleteAccount(sub: string): Promise<void> {
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      throw new LogtoApiError(`logto user delete failed: ${res.status}`, res.status, res.status >= 500)
    }
  }

  private async patch(id: string, body: Record<string, unknown>): Promise<'ok' | 'missing'> {
    const res = await this.request(`/api/sso-connectors/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    })
    if (res.status === 404) return 'missing'
    if (!res.ok) await refusal(res)
    return 'ok'
  }
}

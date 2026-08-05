/** Minimal Logto Management API client for setup reconciliation and ADMIN claim. */
import { ADMIN_ROLE } from './auth.js'

export const LOGTO_GITHUB_CONNECTOR_ID = 'agentconnect-github'

const MANAGED_APP_TAG = 'agentconnectSetup'
const MANAGED_APP_TAG_VALUE = { version: 1, resource: 'browser' } as const

export interface LogtoManagementConfig {
  endpoint: string
  appId: string
  appSecret: string
  resource: string
}

export interface LogtoSetupDesired {
  applicationId?: string
  applicationName: string
  redirectUris: readonly string[]
  postLogoutRedirectUris: readonly string[]
  corsAllowedOrigins: readonly string[]
  socialProviders: readonly string[]
  github?: { clientId: string; clientSecret: string }
}

interface LogtoRole {
  id: string
  name: string
  type: 'User' | 'MachineToMachine'
  isDefault: boolean
}

interface LogtoApplication {
  id: string
  name: string
  type: string
  oidcClientMetadata: Record<string, unknown>
  customClientMetadata: Record<string, unknown>
  customData: Record<string, unknown>
}

interface LogtoConnector {
  id: string
  connectorId: string
  target: string
}

export interface LogtoAdminRoleInspection {
  exists: boolean
  type: LogtoRole['type'] | null
  isDefault: boolean | null
}

export interface LogtoSetupInspection {
  application: { id: string | null; exists: boolean; matches: boolean }
  connectors: Array<{ target: string; id: string | null; exists: boolean }>
  signInExperienceMatches: boolean
}

export interface LogtoSetupReconcileResult {
  changed: boolean
  application: { id: string; created: boolean; changed: boolean }
  connectors: Array<{ target: string; id: string; created: boolean }>
  signInExperienceChanged: boolean
  adminRoleCreated: boolean
}

export class LogtoManagementError extends Error {
  constructor(
    readonly code:
      | 'LOGTO_UNAVAILABLE'
      | 'ADMIN_ROLE_TYPE_INVALID'
      | 'APPLICATION_TYPE_INVALID'
      | 'MANAGED_APPLICATION_AMBIGUOUS'
      | 'SOCIAL_CONNECTOR_AMBIGUOUS'
      | 'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED'
      | 'SOCIAL_CONNECTOR_UNSUPPORTED',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LogtoManagementError'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  return JSON.stringify(stringArray(left)) === JSON.stringify(right)
}

function hasManagedTag(application: LogtoApplication): boolean {
  const tag = asRecord(application.customData[MANAGED_APP_TAG])
  return tag.version === MANAGED_APP_TAG_VALUE.version && tag.resource === MANAGED_APP_TAG_VALUE.resource
}

function parseApplication(value: unknown): LogtoApplication {
  const row = asRecord(value)
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.type !== 'string') {
    throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid application')
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    oidcClientMetadata: asRecord(row.oidcClientMetadata),
    customClientMetadata: asRecord(row.customClientMetadata),
    customData: asRecord(row.customData)
  }
}

function parseConnector(value: unknown): LogtoConnector | null {
  const row = asRecord(value)
  const metadata = asRecord(row.metadata)
  const target = typeof row.target === 'string' ? row.target : metadata.target
  if (typeof row.id !== 'string' || typeof row.connectorId !== 'string' || typeof target !== 'string') return null
  return { id: row.id, connectorId: row.connectorId, target }
}

export class LogtoAdminClaimClient {
  private readonly base: string
  private readonly resource: string
  private token: { value: string; expiresAt: number } | undefined
  private tokenRequest: Promise<string> | undefined
  private assignmentTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: LogtoManagementConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = 5_000
  ) {
    this.base = config.endpoint.replace(/\/+$/, '')
    this.resource = config.resource
  }

  /** Ensure the exact global User role `ADMIN` exists and assign the current subject. */
  assignAdmin(subject: string): Promise<void> {
    const assignment = this.assignmentTail.then(() => this.assign(subject))
    this.assignmentTail = assignment.catch(() => undefined)
    return assignment
  }

  /** Validate only the M2M grant. Never returns the access token. */
  async verifyClientCredentials(): Promise<void> {
    await this.accessToken()
  }

  /** Read roles without mutating Logto and report the exact ADMIN role. */
  async inspectAdminRole(): Promise<LogtoAdminRoleInspection> {
    const role = (await this.listRoles()).find((candidate) => candidate.name === ADMIN_ROLE)
    return role
      ? { exists: true, type: role.type, isDefault: role.isDefault }
      : { exists: false, type: null, isDefault: null }
  }

  async inspectSetup(desired: LogtoSetupDesired): Promise<LogtoSetupInspection> {
    const application = await this.findApplication(desired.applicationId)
    const connectors = await this.listConnectors()
    const signInTargets = await this.getSignInTargets()
    return {
      application: {
        id: application?.id ?? null,
        exists: application !== undefined,
        matches: application ? this.applicationMatches(application, desired) : false
      },
      connectors: desired.socialProviders.map((target) => {
        const matches = connectors.filter((connector) => connector.target === target)
        if (matches.length > 1) {
          throw new LogtoManagementError(
            'SOCIAL_CONNECTOR_AMBIGUOUS',
            `Logto has more than one social connector for target ${target}`
          )
        }
        return { target, id: matches[0]?.id ?? null, exists: matches.length === 1 }
      }),
      signInExperienceMatches: sameStrings(signInTargets, desired.socialProviders)
    }
  }

  async reconcileSetup(desired: LogtoSetupDesired): Promise<LogtoSetupReconcileResult> {
    const application = await this.ensureApplication(desired)
    const connectors = await this.ensureConnectors(desired)
    const signInExperienceChanged = await this.ensureSignInExperience(desired.socialProviders)
    const adminRoleCreated = (await this.ensureAdminRole()).created
    return {
      changed:
        application.changed ||
        connectors.some((connector) => connector.created) ||
        signInExperienceChanged ||
        adminRoleCreated,
      application,
      connectors,
      signInExperienceChanged,
      adminRoleCreated
    }
  }

  private async assign(subject: string): Promise<void> {
    const { role } = await this.ensureAdminRole()
    await this.request(`/api/users/${encodeURIComponent(subject)}/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [role.id] })
    })
  }

  private async ensureAdminRole(): Promise<{ role: LogtoRole; created: boolean }> {
    const roles = await this.listRoles()
    const existing = roles.find((role) => role.name === ADMIN_ROLE)
    if (existing) {
      if (existing.type !== 'User' || existing.isDefault) {
        throw new LogtoManagementError(
          'ADMIN_ROLE_TYPE_INVALID',
          'the existing Logto ADMIN role must be a non-default User role'
        )
      }
      return { role: existing, created: false }
    }

    const response = await this.request('/api/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: ADMIN_ROLE,
        description: 'AgentConnect deployment administrators',
        type: 'User',
        isDefault: false
      })
    })
    const created = (await response.json().catch(() => null)) as Partial<LogtoRole> | null
    if (
      !created ||
      typeof created.id !== 'string' ||
      created.name !== ADMIN_ROLE ||
      created.type !== 'User' ||
      created.isDefault !== false
    ) {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid ADMIN role', response.status)
    }
    return { role: created as LogtoRole, created: true }
  }

  private async ensureApplication(
    desired: LogtoSetupDesired
  ): Promise<{ id: string; created: boolean; changed: boolean }> {
    const existing = await this.findApplication(desired.applicationId)
    if (!existing) {
      const response = await this.request('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: desired.applicationName,
          description: 'AgentConnect browser application',
          type: 'SPA',
          oidcClientMetadata: {
            redirectUris: desired.redirectUris,
            postLogoutRedirectUris: desired.postLogoutRedirectUris
          },
          customClientMetadata: { corsAllowedOrigins: desired.corsAllowedOrigins },
          customData: { [MANAGED_APP_TAG]: MANAGED_APP_TAG_VALUE }
        })
      })
      return { id: parseApplication(await response.json().catch(() => null)).id, created: true, changed: true }
    }
    this.requireSpa(existing)
    if (this.applicationMatches(existing, desired)) {
      return { id: existing.id, created: false, changed: false }
    }
    const response = await this.request(`/api/applications/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oidcClientMetadata: {
          ...existing.oidcClientMetadata,
          redirectUris: desired.redirectUris,
          postLogoutRedirectUris: desired.postLogoutRedirectUris
        },
        customClientMetadata: {
          ...existing.customClientMetadata,
          corsAllowedOrigins: desired.corsAllowedOrigins
        },
        customData: { ...existing.customData, [MANAGED_APP_TAG]: MANAGED_APP_TAG_VALUE }
      })
    })
    return { id: parseApplication(await response.json().catch(() => null)).id, created: false, changed: true }
  }

  private async findApplication(applicationId: string | undefined): Promise<LogtoApplication | undefined> {
    if (applicationId) {
      try {
        const application = parseApplication(
          await this.getJson(`/api/applications/${encodeURIComponent(applicationId)}`)
        )
        this.requireSpa(application)
        return application
      } catch (error) {
        if (!(error instanceof LogtoManagementError) || error.status !== 404) throw error
      }
    }
    const tagged = (await this.listApplications()).filter(hasManagedTag)
    if (tagged.length > 1) {
      throw new LogtoManagementError(
        'MANAGED_APPLICATION_AMBIGUOUS',
        'Logto has more than one AgentConnect-managed browser application'
      )
    }
    if (tagged[0]) this.requireSpa(tagged[0])
    return tagged[0]
  }

  private requireSpa(application: LogtoApplication): void {
    if (application.type !== 'SPA') {
      throw new LogtoManagementError(
        'APPLICATION_TYPE_INVALID',
        `the selected Logto application ${application.id} must be a SPA`
      )
    }
  }

  private applicationMatches(application: LogtoApplication, desired: LogtoSetupDesired): boolean {
    return (
      application.type === 'SPA' &&
      hasManagedTag(application) &&
      sameStrings(application.oidcClientMetadata.redirectUris, desired.redirectUris) &&
      sameStrings(application.oidcClientMetadata.postLogoutRedirectUris, desired.postLogoutRedirectUris) &&
      sameStrings(application.customClientMetadata.corsAllowedOrigins, desired.corsAllowedOrigins)
    )
  }

  private async listApplications(): Promise<LogtoApplication[]> {
    const result: LogtoApplication[] = []
    for (let page = 1; ; page += 1) {
      const rows = await this.getJson<unknown>(`/api/applications?page=${page}&page_size=100`)
      if (!Array.isArray(rows)) {
        throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned invalid applications')
      }
      result.push(...rows.map(parseApplication))
      if (rows.length < 100) return result
    }
  }

  private async ensureConnectors(
    desired: LogtoSetupDesired
  ): Promise<Array<{ target: string; id: string; created: boolean }>> {
    const existing = await this.listConnectors()
    const result: Array<{ target: string; id: string; created: boolean }> = []
    for (const target of desired.socialProviders) {
      const matches = existing.filter((connector) => connector.target === target)
      if (matches.length > 1) {
        throw new LogtoManagementError(
          'SOCIAL_CONNECTOR_AMBIGUOUS',
          `Logto has more than one social connector for target ${target}`
        )
      }
      if (matches[0]) {
        result.push({ target, id: matches[0].id, created: false })
        continue
      }
      if (target !== 'github') {
        throw new LogtoManagementError(
          'SOCIAL_CONNECTOR_UNSUPPORTED',
          `automatic creation is not supported for the missing Logto social connector ${target}`
        )
      }
      if (!desired.github) {
        throw new LogtoManagementError(
          'GITHUB_CONNECTOR_CREDENTIALS_REQUIRED',
          'the Logto GitHub connector needs a login GitHub App client id and secret'
        )
      }
      const response = await this.request('/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: LOGTO_GITHUB_CONNECTOR_ID,
          connectorId: 'github-universal',
          config: desired.github,
          syncProfile: true
        })
      })
      const connector = parseConnector(await response.json().catch(() => null))
      if (!connector || connector.target !== 'github') {
        throw new LogtoManagementError(
          'LOGTO_UNAVAILABLE',
          'Logto returned an invalid GitHub connector',
          response.status
        )
      }
      existing.push(connector)
      result.push({ target, id: connector.id, created: true })
    }
    return result
  }

  private async listConnectors(): Promise<LogtoConnector[]> {
    const rows = await this.getJson<unknown>('/api/connectors')
    if (!Array.isArray(rows)) throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned invalid connectors')
    return rows.map(parseConnector).filter((connector): connector is LogtoConnector => connector !== null)
  }

  private async getSignInTargets(): Promise<string[]> {
    const value = asRecord(await this.getJson('/api/sign-in-exp'))
    if (!Array.isArray(value.socialSignInConnectorTargets)) {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned an invalid sign-in experience')
    }
    return stringArray(value.socialSignInConnectorTargets)
  }

  private async ensureSignInExperience(targets: readonly string[]): Promise<boolean> {
    if (sameStrings(await this.getSignInTargets(), targets)) return false
    await this.request('/api/sign-in-exp', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ socialSignInConnectorTargets: targets })
    })
    return true
  }

  private async listRoles(): Promise<LogtoRole[]> {
    const result: LogtoRole[] = []
    for (let page = 1; ; page += 1) {
      const rows = await this.getJson<unknown[]>(`/api/roles?page=${page}&page_size=100`)
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const candidate = row as Partial<LogtoRole>
        if (
          typeof candidate.id === 'string' &&
          typeof candidate.name === 'string' &&
          (candidate.type === 'User' || candidate.type === 'MachineToMachine') &&
          typeof candidate.isDefault === 'boolean'
        ) {
          result.push(candidate as LogtoRole)
        }
      }
      if (rows.length < 100) return result
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path)
    try {
      return (await response.json()) as T
    } catch {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned malformed JSON', response.status)
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...init.headers },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto request failed: HTTP ${response.status}`,
        response.status
      )
    }
    return response
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value
    this.tokenRequest ??= this.fetchAccessToken().finally(() => {
      this.tokenRequest = undefined
    })
    return this.tokenRequest
  }

  private async fetchAccessToken(): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/oidc/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: this.resource,
          scope: 'all'
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto token request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      throw new LogtoManagementError(
        'LOGTO_UNAVAILABLE',
        `Logto token request failed: HTTP ${response.status}`,
        response.status
      )
    }
    const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null
    if (!payload || typeof payload.access_token !== 'string' || typeof payload.expires_in !== 'number') {
      throw new LogtoManagementError('LOGTO_UNAVAILABLE', 'Logto returned a malformed token response')
    }
    this.token = {
      value: payload.access_token,
      expiresAt: this.now() + Math.max(0, payload.expires_in * 1000 - 60_000)
    }
    return this.token.value
  }
}

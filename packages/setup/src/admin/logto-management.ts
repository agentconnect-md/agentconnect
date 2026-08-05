/** Minimal Logto Management API client for the one-time ADMIN self-claim. */
import { ADMIN_ROLE } from './auth.js'

export interface LogtoManagementConfig {
  endpoint: string
  appId: string
  appSecret: string
  resource: string
}

interface LogtoRole {
  id: string
  name: string
  type: 'User' | 'MachineToMachine'
  isDefault: boolean
}

export interface LogtoAdminRoleInspection {
  exists: boolean
  type: LogtoRole['type'] | null
  isDefault: boolean | null
}

export class LogtoManagementError extends Error {
  constructor(
    readonly code: 'LOGTO_UNAVAILABLE' | 'ADMIN_ROLE_TYPE_INVALID',
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LogtoManagementError'
  }
}

export class LogtoAdminClaimClient {
  private readonly base: string
  private readonly resource: string
  private token: { value: string; expiresAt: number } | undefined
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

  /**
   * Ensure the exact global User role `ADMIN` exists and assign the current
   * subject. Logto's POST assignment adds to existing roles and is idempotent.
   */
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

  private async assign(subject: string): Promise<void> {
    const role = await this.ensureAdminRole()
    await this.request(`/api/users/${encodeURIComponent(subject)}/roles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roleIds: [role.id] })
    })
  }

  private async ensureAdminRole(): Promise<LogtoRole> {
    const roles = await this.listRoles()
    const existing = roles.find((role) => role.name === ADMIN_ROLE)
    if (existing) {
      if (existing.type !== 'User' || existing.isDefault) {
        throw new LogtoManagementError(
          'ADMIN_ROLE_TYPE_INVALID',
          'the existing Logto ADMIN role must be a non-default User role'
        )
      }
      return existing
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
    return created as LogtoRole
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

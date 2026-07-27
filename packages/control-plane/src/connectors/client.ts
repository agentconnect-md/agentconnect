/**
 * `ConnectorsClient` — the CP's network client for the open-connector admin API
 * (docs: connectors). Assembled only when `OPEN_CONNECTOR_URL` is set; the connectors
 * routes broker every browser call through it so the open-connector origin and admin
 * surface never reach the browser. open-connector runs without an admin bearer token,
 * so no auth header is sent.
 */
import type { FetchLike } from '../github/api.js'
import { filterCatalog, type OcOAuthConfig, type OcProvider } from './filter.js'

export interface ConnectorsClientOptions {
  baseUrl: string
  fetch: FetchLike
  whitelist: Set<string> | null
  blocklist: Set<string>
}

export class ConnectorsError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ConnectorsError'
  }
}

export class ConnectorsClient {
  private readonly base: string
  private readonly doFetch: FetchLike
  private readonly whitelist: Set<string> | null
  private readonly blocklist: Set<string>

  constructor(opts: ConnectorsClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.doFetch = opts.fetch
    this.whitelist = opts.whitelist
    this.blocklist = opts.blocklist
  }

  /** The open-connector MCP endpoint — the upstream url stored on each connection's
   *  `open_connector` provider row (the relay proxies agent tool calls here). */
  get mcpUrl(): string {
    return `${this.base}/mcp`
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.doFetch(`${this.base}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) }
    })
    if (!res.ok) {
      const message = await res
        .clone()
        .json()
        .then((b) => {
          const o = (b ?? {}) as { message?: unknown; error?: unknown }
          const m = o.message ?? o.error
          // open-connector's admin API can return a structured (object) message —
          // stringify it so the error is readable rather than "[object Object]".
          return typeof m === 'string' ? m : m != null ? JSON.stringify(m) : null
        })
        .catch(() => null)
      throw new ConnectorsError(message || `open-connector returned ${res.status}`, res.status)
    }
    return res.json() as Promise<T>
  }

  /** The filtered, action-stripped provider catalog for the browse UI. */
  async catalog(): Promise<{ providers: OcProvider[] }> {
    const [providers, oauthConfigs] = await Promise.all([
      this.json<OcProvider[]>('/api/providers'),
      this.json<OcOAuthConfig[]>('/api/oauth/configs')
    ])
    return { providers: filterCatalog(providers, oauthConfigs, this.whitelist, this.blocklist) }
  }

  /** Save an api-key / custom / no-auth connection under a profile name. */
  async saveConnection(
    service: string,
    body: { authType: string; connectionName: string; values?: Record<string, string> }
  ): Promise<void> {
    await this.json(`/api/connections/${encodeURIComponent(service)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  /** Start an OAuth authorization for a profile; returns the URL to open in a popup. */
  async startOAuth(service: string, connectionName: string): Promise<{ authorizationUrl?: string }> {
    return this.json<{ authorizationUrl?: string }>('/api/oauth/authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service, connectionName })
    })
  }
}

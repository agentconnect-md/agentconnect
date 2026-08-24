import { readFileSync } from 'node:fs'
import {
  IssueKeyResponse as IssueKeyResponseSchema,
  KEY_SERVER_AUTH_HEADER,
  KEY_SERVER_ISSUE_KEY_PATH,
  KEY_SERVER_REVOKE_KEY_PATH,
  KeyServerErrorBody,
  RevokeKeyResponse,
  keyGrantViolation,
  type IssueKeyRequest,
  type IssueKeyResponse
} from '@agentconnect.md/protocol'

export const DEFAULT_MODEL_KEY_TTL_SECONDS = 3_600
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export class KeyServerError extends Error {
  constructor(
    message: string,
    readonly code: 'org_suspended' | 'quota_denied' | 'unauthorized' | 'unavailable',
    readonly status?: number
  ) {
    super(message)
    this.name = 'KeyServerError'
  }
}

export interface KeyGrant extends IssueKeyResponse {
  requestedAtMs: number
  refreshAtMs?: number
  expiresAtMs?: number
}

export class KeyServerClient {
  private readonly baseUrl: URL

  constructor(
    address: string,
    private readonly opts: {
      tokenPath?: string
      fetch?: typeof globalThis.fetch
      now?: () => number
      timeoutMs?: number
    } = {}
  ) {
    this.baseUrl = new URL(address)
    // The scheme is the deployment's decision, not this client's: the bearer is a projected
    // ServiceAccount token, and the same process already carries one over an in-cluster `ws://`
    // socket to the control plane. Refusing http made one hop stricter than the boundary it lives
    // in, at the price of a private CA on the one service dialled directly rather than via the edge.
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.protocol !== 'http:') {
      throw new Error(`key-server address must be http or https, got ${this.baseUrl.protocol}`)
    }
    if (this.baseUrl.username || this.baseUrl.password) throw new Error('key-server URL must not contain credentials')
  }

  async issue(request: IssueKeyRequest): Promise<KeyGrant> {
    const requestedAtMs = (this.opts.now ?? (() => performance.timeOrigin + performance.now()))()
    const response = await this.post(KEY_SERVER_ISSUE_KEY_PATH, request)
    const parsed = IssueKeyResponseSchema.safeParse(response.body)
    if (!parsed.success)
      throw new KeyServerError('key server returned an invalid IssueKey response', 'unavailable', response.status)
    const violation = keyGrantViolation(request, parsed.data)
    if (violation)
      throw new KeyServerError(`key server returned an invalid grant: ${violation}`, 'unavailable', response.status)
    return {
      ...parsed.data,
      requestedAtMs,
      ...(parsed.data.refreshInSeconds !== undefined
        ? { refreshAtMs: requestedAtMs + parsed.data.refreshInSeconds * 1000 }
        : {}),
      ...(parsed.data.expiresInSeconds !== undefined
        ? { expiresAtMs: requestedAtMs + parsed.data.expiresInSeconds * 1000 }
        : {})
    }
  }

  async revoke(keyId: string): Promise<void> {
    const response = await this.post(KEY_SERVER_REVOKE_KEY_PATH, { keyId })
    if (!RevokeKeyResponse.safeParse(response.body).success) {
      throw new KeyServerError('key server returned an invalid RevokeKey response', 'unavailable', response.status)
    }
  }

  private token(): string | undefined {
    if (!this.opts.tokenPath) return undefined
    const token = readFileSync(this.opts.tokenPath, 'utf8').trim()
    if (!token) throw new KeyServerError('key-server token file is empty', 'unauthorized')
    return token
  }

  private async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    let token: string | undefined
    try {
      token = this.token()
    } catch (error) {
      if (error instanceof KeyServerError) throw error
      throw new KeyServerError(
        `cannot read key-server token: ${error instanceof Error ? error.message : String(error)}`,
        'unauthorized'
      )
    }
    let response: Response
    try {
      response = await (this.opts.fetch ?? globalThis.fetch)(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { [KEY_SERVER_AUTH_HEADER]: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (error instanceof KeyServerError) throw error
      throw new KeyServerError(
        `key server unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'unavailable'
      )
    }

    let responseBody: unknown
    try {
      responseBody = await response.json()
    } catch {
      throw new KeyServerError(`key server returned non-JSON HTTP ${response.status}`, 'unavailable', response.status)
    }
    if (response.ok) return { status: response.status, body: responseBody }
    const parsed = KeyServerErrorBody.safeParse(responseBody)
    if (parsed.success) {
      throw new KeyServerError(
        parsed.data.error.message ?? `key server rejected the request (${parsed.data.error.code})`,
        parsed.data.error.code,
        response.status
      )
    }
    throw new KeyServerError(`key server returned HTTP ${response.status}`, 'unavailable', response.status)
  }
}

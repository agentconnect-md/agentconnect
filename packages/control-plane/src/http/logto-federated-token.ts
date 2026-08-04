import type { FetchLike } from '../github/api.js'

const TIMEOUT_MS = 10_000

export const LOGTO_ACCOUNT_TOKEN_HEADER = 'x-ac-logto-account-token'

export type LogtoFederatedTarget = 'feishu' | 'lark'

export interface LogtoFederatedTokenSession {
  accessTokenFor(target: LogtoFederatedTarget): Promise<string>
}

export interface LogtoFederatedTokenResolver {
  forRequest(oidcSubject: string, accountToken: string): LogtoFederatedTokenSession
}

export type LogtoFederatedTokenStage = 'account_verification' | 'federated_token'

/** Account API shares the tenant origin with Logto's `/oidc` issuer. */
export function logtoAccountEndpointFromIssuer(issuer: string): string {
  const url = new URL(issuer)
  if (!/\/oidc\/?$/.test(url.pathname)) throw new Error('Logto OIDC issuer must end in /oidc')
  url.pathname = url.pathname.replace(/\/oidc\/?$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

/** Safe classification only; upstream bodies and both bearer tokens stay out of errors/logs. */
export class LogtoFederatedTokenError extends Error {
  constructor(
    message: string,
    readonly details: {
      stage: LogtoFederatedTokenStage
      status?: number
      target?: LogtoFederatedTarget
      code?: string
    }
  ) {
    super(message)
    this.name = 'LogtoFederatedTokenError'
  }

  get stage(): LogtoFederatedTokenStage {
    return this.details.stage
  }

  get status(): number | undefined {
    return this.details.status
  }

  get target(): LogtoFederatedTarget | undefined {
    return this.details.target
  }

  get code(): string | undefined {
    return this.details.code
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function safeUpstreamCode(response: Response): Promise<string | undefined> {
  const value = recordOf(await response.json().catch(() => null)).code
  const code = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined
  return code && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(code) ? code : undefined
}

/**
 * Request-bound access to Logto's federated-token vault.
 *
 * The browser presents its opaque Account API token only on Session authorization
 * reads. Before that token can select a provider credential, `/api/my-account`
 * must bind it to the same verified OIDC subject that authenticated the CP call.
 * The returned provider token is retained only by this short-lived closure.
 */
export class LogtoFederatedTokenService implements LogtoFederatedTokenResolver {
  private readonly endpoint: string

  constructor(
    endpoint: string,
    private readonly fetchImpl: FetchLike = fetch as FetchLike
  ) {
    this.endpoint = endpoint.replace(/\/$/, '')
  }

  forRequest(oidcSubject: string, accountToken: string): LogtoFederatedTokenSession {
    let verified: Promise<void> | undefined
    const tokens = new Map<LogtoFederatedTarget, Promise<string>>()
    return {
      accessTokenFor: (target) => {
        verified ??= this.verifyAccount(oidcSubject, accountToken)
        let pending = tokens.get(target)
        if (!pending) {
          pending = verified.then(() => this.fetchAccessToken(target, accountToken))
          tokens.set(target, pending)
        }
        return pending
      }
    }
  }

  private async verifyAccount(oidcSubject: string, accountToken: string): Promise<void> {
    let response: Response
    try {
      response = await this.request('/api/my-account', accountToken)
    } catch {
      throw new LogtoFederatedTokenError('Logto account verification failed', {
        stage: 'account_verification',
        code: 'request_failed'
      })
    }
    if (!response.ok) {
      const code = await safeUpstreamCode(response)
      throw new LogtoFederatedTokenError('Logto account verification failed', {
        stage: 'account_verification',
        status: response.status,
        ...(code ? { code } : {})
      })
    }
    const account = recordOf(await response.json().catch(() => null))
    if (account.id !== oidcSubject) {
      throw new LogtoFederatedTokenError('Logto account token subject mismatch', {
        stage: 'account_verification',
        status: 403,
        code: 'subject_mismatch'
      })
    }
  }

  private async fetchAccessToken(target: LogtoFederatedTarget, accountToken: string): Promise<string> {
    let response: Response
    try {
      response = await this.request(
        `/api/my-account/identities/${encodeURIComponent(target)}/access-token`,
        accountToken
      )
    } catch {
      throw new LogtoFederatedTokenError('Federated access token is unavailable', {
        stage: 'federated_token',
        target,
        code: 'request_failed'
      })
    }
    if (!response.ok) {
      const code = await safeUpstreamCode(response)
      throw new LogtoFederatedTokenError('Federated access token is unavailable', {
        stage: 'federated_token',
        target,
        status: response.status,
        ...(code ? { code } : {})
      })
    }
    const token = recordOf(await response.json().catch(() => null)).access_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new LogtoFederatedTokenError('Federated access token response is invalid', {
        stage: 'federated_token',
        target,
        status: 502,
        code: 'invalid_response'
      })
    }
    return token
  }

  private request(path: string, accountToken: string): Promise<Response> {
    return this.fetchImpl(`${this.endpoint}${path}`, {
      headers: { authorization: `Bearer ${accountToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  }
}

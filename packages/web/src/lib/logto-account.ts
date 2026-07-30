import { getAccountToken, getLogtoPublicConfig } from '@/lib/auth'

export interface SocialIdentity {
  userId: string
  details: Record<string, unknown>
}

export interface LogtoAccountProfile {
  identities: Record<string, SocialIdentity>
  /** Set when the account can prove ownership a second way (a verified email).
   *  Logto then REQUIRES that proof before identities may change, so the card
   *  collects an email code first — see `requestEmailVerification`. */
  hasSecurityVerificationMethod: boolean
  primaryEmail?: string
}

export interface SocialIdentityDetails {
  name?: string
  email?: string
  avatar?: string
}

export interface SocialLinkFlow {
  state: string
  connectorId: string
  /** The Account API verification this flow is completing. The provider's
   *  response is only meaningful against the record that started it. */
  verificationRecordId: string
  /** Echoed back on verify: Logto exchanges the code against the SAME URI it
   *  authorized with, and the connectors that keep it in session need it too. */
  redirectUri: string
  /** Proof that the caller owns this account, collected BEFORE leaving for the
   *  provider — on return the identity is saved immediately, with no UI left to
   *  ask. Absent when the account has no security verification method. */
  currentVerificationRecordId?: string
  providerName: string
  returnTo: string
  createdAt: number
}

export interface AccountNotice {
  kind: 'success' | 'error'
  message: string
}

const SOCIAL_FLOW_KEY = 'ac.social-link.flow'
const ACCOUNT_NOTICE_KEY = 'ac.social-link.notice'
const SOCIAL_FLOW_TTL_MS = 10 * 60 * 1000

export class LogtoAccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'LogtoAccountError'
  }
}

function tenantUrl(path: string): URL {
  const config = getLogtoPublicConfig()
  if (!config) throw new LogtoAccountError('Logto is not configured.', 0)
  return new URL(path, config.endpoint)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

async function responseError(response: Response): Promise<LogtoAccountError> {
  let body: Record<string, unknown> = {}
  try {
    body = asRecord(await response.json())
  } catch {
    // Some Account API errors have no JSON body. The status-specific UI copy is
    // still more useful than exposing an empty parse failure.
  }
  const code = stringValue(body.code)
  const message = stringValue(body.message) ?? `Logto Account API returned ${response.status}.`
  return new LogtoAccountError(message, response.status, code)
}

async function accountRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccountToken()
  if (!token) throw new LogtoAccountError('Your sign-in session has expired.', 401)

  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body) headers.set('content-type', 'application/json')

  const response = await fetch(tenantUrl(path), { ...init, headers })
  if (!response.ok) throw await responseError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function fetchAccountProfile(): Promise<LogtoAccountProfile> {
  const body = asRecord(await accountRequest<unknown>('/api/my-account'))
  const rawIdentities = asRecord(body.identities)
  const identities = Object.fromEntries(
    Object.entries(rawIdentities).map(([target, value]) => {
      const identity = asRecord(value)
      return [
        target,
        {
          userId: stringValue(identity.userId) ?? '',
          details: asRecord(identity.details)
        } satisfies SocialIdentity
      ]
    })
  )
  const primaryEmail = stringValue(body.primaryEmail)
  return {
    identities,
    hasSecurityVerificationMethod: body.hasSecurityVerificationMethod === true,
    ...(primaryEmail ? { primaryEmail } : {})
  }
}

/** Send an ownership-proof code to the account's own email. */
export async function requestEmailVerification(email: string): Promise<string> {
  const result = await accountRequest<{ verificationRecordId: string }>('/api/verifications/verification-code', {
    method: 'POST',
    body: JSON.stringify({
      identifier: { type: 'email', value: email },
      templateType: 'UserPermissionValidation'
    })
  })
  return result.verificationRecordId
}

/** Redeem that code; the returned record is what `logto-verification-id` names. */
export async function verifyEmailCode(email: string, verificationId: string, code: string): Promise<string> {
  const result = await accountRequest<{ verificationRecordId: string }>('/api/verifications/verification-code/verify', {
    method: 'POST',
    body: JSON.stringify({ identifier: { type: 'email', value: email }, verificationId, code })
  })
  return result.verificationRecordId
}

/**
 * Start a social link against Logto's Account API, with the user's OWN token.
 *
 * This runs in the browser on purpose. The equivalent Management API endpoint
 * gives the connector no session, so every connector that persists state while
 * building its authorization URI (Slack keeps `redirectUri` there) fails
 * upstream with a 500. The Account API's verification record carries that
 * session, so the same connectors work here.
 */
export async function createSocialVerification(
  connectorId: string,
  redirectUri: string,
  state: string
): Promise<{ verificationRecordId: string; authorizationUri: string }> {
  return accountRequest('/api/verifications/social', {
    method: 'POST',
    body: JSON.stringify({ connectorId, redirectUri, state })
  })
}

/** Exchange the provider's response for a verified identity, still unlinked. */
export async function verifySocialVerification(
  verificationRecordId: string,
  connectorData: Record<string, string>
): Promise<string> {
  const result = await accountRequest<{ verificationRecordId: string }>('/api/verifications/social/verify', {
    method: 'POST',
    body: JSON.stringify({ connectorData, verificationRecordId })
  })
  return result.verificationRecordId
}

/**
 * Attach the verified identity to this account.
 *
 * Two different proofs meet here: `verificationRecordId` proves the NEW social
 * identity, while `currentVerificationRecordId` proves the caller still owns
 * THIS account. Logto demands the second whenever the account has a security
 * verification method, and rejects the write with 403 without it.
 */
export async function saveSocialIdentity(
  verificationRecordId: string,
  currentVerificationRecordId?: string
): Promise<void> {
  await accountRequest('/api/my-account/identities', {
    method: 'POST',
    ...(currentVerificationRecordId ? { headers: { 'logto-verification-id': currentVerificationRecordId } } : {}),
    body: JSON.stringify({ newIdentifierVerificationRecordId: verificationRecordId })
  })
}

export function socialIdentityDetails(identity: SocialIdentity): SocialIdentityDetails {
  const details = identity.details
  const name = stringValue(details.name, details.displayName, details.login, details.username)
  const email = stringValue(details.email)
  const avatar = stringValue(details.avatar, details.picture, details.avatarUrl, details.avatar_url)
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatar ? { avatar } : {})
  }
}

export function createSocialState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

/** Save only the short-lived connector choice and CSRF state in this tab. */
export function writeSocialLinkFlow(flow: SocialLinkFlow): boolean {
  try {
    const value = JSON.stringify(flow)
    sessionStorage.setItem(SOCIAL_FLOW_KEY, value)
    return sessionStorage.getItem(SOCIAL_FLOW_KEY) === value
  } catch {
    return false
  }
}

export function takeSocialLinkFlow(): SocialLinkFlow | undefined {
  try {
    const value = sessionStorage.getItem(SOCIAL_FLOW_KEY)
    sessionStorage.removeItem(SOCIAL_FLOW_KEY)
    if (!value) return undefined
    const flow = asRecord(JSON.parse(value))
    if (
      typeof flow.state !== 'string' ||
      typeof flow.connectorId !== 'string' ||
      typeof flow.verificationRecordId !== 'string' ||
      typeof flow.redirectUri !== 'string' ||
      (flow.currentVerificationRecordId !== undefined && typeof flow.currentVerificationRecordId !== 'string') ||
      typeof flow.providerName !== 'string' ||
      typeof flow.returnTo !== 'string' ||
      !flow.returnTo.startsWith('/') ||
      flow.returnTo.startsWith('//') ||
      typeof flow.createdAt !== 'number' ||
      Date.now() - flow.createdAt > SOCIAL_FLOW_TTL_MS
    ) {
      return undefined
    }
    return flow as unknown as SocialLinkFlow
  } catch {
    return undefined
  }
}

export function writeAccountNotice(notice: AccountNotice): void {
  try {
    sessionStorage.setItem(ACCOUNT_NOTICE_KEY, JSON.stringify(notice))
  } catch {
    // The profile refresh still shows the new identity; the notice is optional.
  }
}

export function takeAccountNotice(): AccountNotice | undefined {
  try {
    const value = sessionStorage.getItem(ACCOUNT_NOTICE_KEY)
    sessionStorage.removeItem(ACCOUNT_NOTICE_KEY)
    if (!value) return undefined
    const notice = asRecord(JSON.parse(value))
    if ((notice.kind !== 'success' && notice.kind !== 'error') || typeof notice.message !== 'string') {
      return undefined
    }
    return notice as unknown as AccountNotice
  } catch {
    return undefined
  }
}

export function accountErrorMessage(error: unknown, context?: { providerName?: string; linking?: boolean }): string {
  const requestError =
    error instanceof LogtoAccountError ||
    (error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number')
      ? (error as Error & { status: number; code?: string })
      : undefined
  if (!requestError) return 'Something went wrong. Try again.'
  if ((requestError.status === 409 || requestError.status === 422) && context?.linking) {
    const reason = `${requestError.code ?? ''} ${requestError.message}`.toLowerCase()
    if (reason.includes('already') && (reason.includes('use') || reason.includes('link'))) {
      return `That ${context.providerName ?? 'social'} account is already linked to another AgentConnect account.`
    }
    return `The ${context.providerName ?? 'social'} authorization expired or could not be used. Try again.`
  }
  if (requestError.status === 400) return 'The social authorization response is invalid or expired. Try again.'
  // 403 while linking is Logto refusing an unproven identity change, not a dead
  // session — saying "sign in again" sent us chasing the wrong thing once.
  if (requestError.status === 403 && context?.linking) {
    return 'Verifying your account timed out. Return to Profile and start again.'
  }
  if (requestError.status === 401 || requestError.status === 403) {
    return 'Your sign-in session expired. Sign in again and retry.'
  }
  if (requestError.status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (requestError.status >= 500) return 'The sign-in provider is temporarily unavailable. Try again.'
  return requestError.message
}

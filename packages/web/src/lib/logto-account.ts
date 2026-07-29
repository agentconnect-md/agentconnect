import { getAccountToken, getLogtoPublicConfig } from '@/lib/auth'

export interface SocialConnector {
  id: string
  target: string
  name: string
  logo?: string
  logoDark?: string
}

export interface SocialIdentity {
  userId: string
  details: Record<string, unknown>
}

export interface LogtoAccountProfile {
  primaryEmail?: string
  identities: Record<string, SocialIdentity>
  hasSecurityVerificationMethod: boolean
}

export interface SocialIdentityDetails {
  name?: string
  email?: string
  avatar?: string
}

export type SocialIdentityAction = 'add' | 'replace'

export interface SocialLinkFlow {
  state: string
  socialVerificationRecordId: string
  currentVerificationRecordId?: string
  action: SocialIdentityAction
  providerName: string
  redirectUri: string
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

function connectorName(target: string, value: unknown): string {
  if (typeof value === 'string' && value) return value
  const names = asRecord(value)
  return (
    stringValue(names.en, names['en-US'], ...Object.values(names)) ?? target.charAt(0).toUpperCase() + target.slice(1)
  )
}

/** Enabled social connectors are public sign-in-experience metadata. */
export async function fetchSocialConnectors(): Promise<SocialConnector[]> {
  const config = getLogtoPublicConfig()
  if (!config) return []
  const url = new URL('/api/.well-known/experience', config.endpoint)
  url.searchParams.set('appId', config.appId)
  const response = await fetch(url)
  if (!response.ok) throw await responseError(response)

  const body = asRecord(await response.json())
  const connectors = Array.isArray(body.socialConnectors) ? body.socialConnectors : []
  return connectors.flatMap((entry) => {
    const connector = asRecord(entry)
    const id = stringValue(connector.id)
    const target = stringValue(connector.target)
    if (!id || !target) return []
    const logo = stringValue(connector.logo)
    const logoDark = stringValue(connector.logoDark)
    return [
      {
        id,
        target,
        name: connectorName(target, connector.name),
        ...(logo ? { logo } : {}),
        ...(logoDark ? { logoDark } : {})
      }
    ]
  })
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
    ...(primaryEmail ? { primaryEmail } : {}),
    identities,
    hasSecurityVerificationMethod: body.hasSecurityVerificationMethod === true
  }
}

export async function fetchSignInMethods(): Promise<{
  account: LogtoAccountProfile
  connectors: SocialConnector[]
}> {
  const [account, connectors] = await Promise.all([fetchAccountProfile(), fetchSocialConnectors()])
  return { account, connectors }
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

export async function verifyEmailCode(email: string, verificationId: string, code: string): Promise<string> {
  const result = await accountRequest<{ verificationRecordId: string }>('/api/verifications/verification-code/verify', {
    method: 'POST',
    body: JSON.stringify({
      identifier: { type: 'email', value: email },
      verificationId,
      code
    })
  })
  return result.verificationRecordId
}

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

function verificationHeaders(currentVerificationRecordId?: string): HeadersInit | undefined {
  return currentVerificationRecordId ? { 'logto-verification-id': currentVerificationRecordId } : undefined
}

export async function saveSocialIdentity(
  action: SocialIdentityAction,
  socialVerificationRecordId: string,
  currentVerificationRecordId?: string
): Promise<void> {
  await accountRequest('/api/my-account/identities', {
    method: action === 'add' ? 'POST' : 'PUT',
    headers: verificationHeaders(currentVerificationRecordId),
    body: JSON.stringify({ newIdentifierVerificationRecordId: socialVerificationRecordId })
  })
}

export async function removeSocialIdentity(target: string, currentVerificationRecordId?: string): Promise<void> {
  await accountRequest(`/api/my-account/identities/${encodeURIComponent(target)}`, {
    method: 'DELETE',
    headers: verificationHeaders(currentVerificationRecordId)
  })
}

export function createSocialState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

/** Save only short-lived verification IDs and CSRF state in this tab. */
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
      typeof flow.socialVerificationRecordId !== 'string' ||
      (flow.currentVerificationRecordId !== undefined && typeof flow.currentVerificationRecordId !== 'string') ||
      (flow.action !== 'add' && flow.action !== 'replace') ||
      typeof flow.providerName !== 'string' ||
      typeof flow.redirectUri !== 'string' ||
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
  if (!(error instanceof LogtoAccountError)) return 'Something went wrong. Try again.'
  if (error.status === 422 && context?.linking) {
    const reason = `${error.code ?? ''} ${error.message}`.toLowerCase()
    if (reason.includes('already') && (reason.includes('use') || reason.includes('link'))) {
      return `That ${context.providerName ?? 'social'} account is already connected to another AgentConnect account.`
    }
    return `The ${context.providerName ?? 'social'} authorization expired or could not be used. Try again.`
  }
  if (error.status === 400) return 'The verification code or authorization response is invalid. Try again.'
  if (error.status === 401 || error.status === 403) {
    return 'Your verification or sign-in session expired. Sign in again and retry.'
  }
  if (error.status === 429) return 'Too many attempts. Wait a moment and try again.'
  if (error.status >= 500) return 'The sign-in provider is temporarily unavailable. Try again.'
  return error.message
}

/** Google Chat credential validation shared by the Setup Server and the Control Plane (google-chat-integration.md §3). */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'

/** Google's fixed OAuth token endpoint; the key's own `token_uri` is never followed. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** The one bounded read that proves the credential; nothing is ever posted. */
export const GOOGLE_CHAT_PROBE_URL = 'https://chat.googleapis.com/v1/spaces?pageSize=1'

/** App authentication only: no user impersonation and no domain-wide delegation (§3). */
export const GOOGLE_CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'

/** Read-only scope for resolving the key's own project number; a `chat.bot` token cannot read it. */
export const GOOGLE_CLOUD_READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only'

/** Cloud Resource Manager's fixed project read, which reports the project's number beside its ID. */
export function googleCloudProjectUrl(projectId: string): string {
  return `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
}

/** Give up on a silent endpoint rather than hold the save request open. */
const PROBE_TIMEOUT_MS = 5_000

/** Bound provider text echoed into an operator-facing message. */
const MAX_PROVIDER_DETAIL = 300

export interface GoogleServiceAccountKey {
  projectId: string
  clientEmail: string
  privateKeyId?: string
  signingKey: KeyObject
  /** The canonical JSON stored as the write-only secret. */
  json: string
}

export type GoogleChatKeyCheck =
  { status: 'ok'; key: GoogleServiceAccountKey } | { status: 'invalid_key' | 'project_mismatch'; message: string }

export type GoogleChatProbeStatus = 'ok' | 'key_rejected' | 'chat_api_refused' | 'unreachable' | 'google_unavailable'

export interface GoogleChatProbeResult {
  status: GoogleChatProbeStatus
  message: string
}

export type GoogleProjectResolution =
  | { status: 'ok'; projectNumber: string }
  | {
      status:
        'key_rejected' | 'crm_disabled' | 'crm_forbidden' | 'project_unresolved' | 'unreachable' | 'google_unavailable'
      message: string
    }

/** Why a Chat app was refused; the Setup Server sends it as its error code, the Control Plane maps it to its own. */
export type GoogleChatAppFailure =
  | 'project_number_invalid'
  | 'invalid_key'
  | 'project_mismatch'
  | 'key_rejected'
  | 'crm_disabled'
  | 'crm_forbidden'
  | 'project_unresolved'
  | 'project_number_mismatch'
  | 'chat_api_refused'
  | 'unreachable'
  | 'google_unavailable'

export type GoogleChatAppCheck =
  | { status: 'ok'; key: GoogleServiceAccountKey; projectNumber: string; message: string }
  | { status: GoogleChatAppFailure; message: string }

/** Connectivity failures are retryable; every other failure is the credential's or the project's. */
export function probeFailureIsConnectivity(status: GoogleChatProbeStatus | GoogleChatAppFailure): boolean {
  return status === 'unreachable' || status === 'google_unavailable'
}

/** The numeric Project number from the Google Cloud dashboard; it is also the Chat token audience (§2). */
export function isGoogleCloudProjectNumber(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value)
}

/** Accept only a service-account key of the declared project; every other credential shape is refused (§3). */
export function checkServiceAccountKey(raw: string, projectId: string): GoogleChatKeyCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      status: 'invalid_key',
      message: 'the service-account key is not valid JSON; paste the whole downloaded key file'
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid_key', message: 'the service-account key must be a JSON object' }
  }
  const fields = parsed as Record<string, unknown>
  if (fields.type !== 'service_account') {
    return {
      status: 'invalid_key',
      message: 'only a service-account JSON key is accepted; create one under IAM & Admin → Service Accounts → Keys'
    }
  }
  const text = (name: string): string | undefined => {
    const value = fields[name]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const keyProjectId = text('project_id')
  const clientEmail = text('client_email')
  const privateKey = text('private_key')
  if (!keyProjectId || !clientEmail || !privateKey) {
    return {
      status: 'invalid_key',
      message: 'the service-account key is missing project_id, client_email, or private_key'
    }
  }
  if (keyProjectId !== projectId) {
    return {
      status: 'project_mismatch',
      message: `the key belongs to project ${keyProjectId}, not ${projectId}; keep the Chat app and its service account in one project`
    }
  }
  let signingKey: KeyObject
  try {
    signingKey = createPrivateKey({ key: privateKey, format: 'pem' })
  } catch {
    return { status: 'invalid_key', message: 'the private_key in the service-account key could not be read' }
  }
  if (signingKey.asymmetricKeyType !== 'rsa') {
    return { status: 'invalid_key', message: 'the private_key in the service-account key is not an RSA key' }
  }
  const privateKeyId = text('private_key_id')
  return {
    status: 'ok',
    key: { projectId, clientEmail, ...(privateKeyId ? { privateKeyId } : {}), signingKey, json: JSON.stringify(parsed) }
  }
}

/** Mint an app token for `chat.bot` and list at most one space; never sends a message (§3). */
export async function probeGoogleChatCredential(
  key: GoogleServiceAccountKey,
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date()
): Promise<GoogleChatProbeResult> {
  const minted = await mintAccessToken(key, GOOGLE_CHAT_BOT_SCOPE, fetchImpl, now)
  if ('status' in minted) return minted

  let chatResponse: Response
  try {
    chatResponse = await fetchImpl(GOOGLE_CHAT_PROBE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${minted.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return unreachable('the Google Chat API')
  }
  if (chatResponse.ok) {
    return {
      status: 'ok',
      message: `${key.clientEmail} authenticated to the Google Chat API as the project's Chat app`
    }
  }
  if (chatResponse.status >= 500 || chatResponse.status === 429) {
    return unavailable('the Google Chat API', chatResponse.status)
  }
  const body = await readJson(chatResponse)
  const reason = detail((body?.error as Record<string, unknown> | undefined)?.message) ?? 'no details'
  if (chatResponse.status === 401) {
    return {
      status: 'key_rejected',
      message: `Authentication failed: the Google Chat API did not accept the token issued to ${key.clientEmail} (${reason}). Create a new JSON key for that service account and paste it here.`
    }
  }
  return {
    status: 'chat_api_refused',
    message:
      chatResponse.status === 404
        ? `Chat app not found: project ${key.projectId} has no configured Chat app (${reason}). Configure the Chat app in Google Cloud Console first, then save again.`
        : `Chat API refused the app: HTTP ${chatResponse.status} for ${key.clientEmail} (${reason}). Enable the Google Chat API in project ${key.projectId} and configure its Chat app.`
  }
}

/** Read the key's own project from Cloud Resource Manager, so its number is authenticated rather than entered (§3). */
export async function resolveProjectNumber(
  key: GoogleServiceAccountKey,
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date()
): Promise<GoogleProjectResolution> {
  const minted = await mintAccessToken(key, GOOGLE_CLOUD_READ_ONLY_SCOPE, fetchImpl, now)
  if ('status' in minted) return minted

  let response: Response
  try {
    response = await fetchImpl(googleCloudProjectUrl(key.projectId), {
      method: 'GET',
      headers: { authorization: `Bearer ${minted.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return unreachable('the Cloud Resource Manager API')
  }
  if (response.status >= 500 || response.status === 429) {
    return unavailable('the Cloud Resource Manager API', response.status)
  }
  const body = await readJson(response)
  if (response.ok) {
    const projectNumber = typeof body?.projectNumber === 'string' ? body.projectNumber : undefined
    if (projectNumber && isGoogleCloudProjectNumber(projectNumber) && body?.projectId === key.projectId) {
      return { status: 'ok', projectNumber }
    }
    return {
      status: 'project_unresolved',
      message: `Cloud Resource Manager did not return the number of project ${key.projectId}; check the project ID and try again.`
    }
  }
  const error = body?.error as Record<string, unknown> | undefined
  const reason = detail(error?.message) ?? 'no details'
  if (response.status === 401) {
    return {
      status: 'key_rejected',
      message: `Authentication failed: the Cloud Resource Manager API did not accept the token issued to ${key.clientEmail} (${reason}). Create a new JSON key for that service account and paste it here.`
    }
  }
  if (response.status === 403) {
    const details: unknown[] = Array.isArray(error?.details) ? error.details : []
    const serviceDisabled = details.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).reason === 'SERVICE_DISABLED'
    )
    return serviceDisabled
      ? {
          status: 'crm_disabled',
          message: `Enable the Cloud Resource Manager API in project ${key.projectId}: AgentConnect reads the project's number through it to bind the Chat app to this key.`
        }
      : {
          status: 'crm_forbidden',
          message: `Grant ${key.clientEmail} the Browser role on project ${key.projectId} (resourcemanager.projects.get): AgentConnect reads the project's number with it to bind the Chat app to this key.`
        }
  }
  return {
    status: 'project_unresolved',
    message: `Cloud Resource Manager refused to read project ${key.projectId}: HTTP ${response.status} (${reason}). Check the project ID and try again.`
  }
}

/** Every check a Chat app passes before it is stored: key shape, the authenticated project number, then the `chat.bot` read (§3). */
export async function checkGoogleChatApp(
  input: { projectId: string; projectNumber?: string | undefined; serviceAccountKey: string },
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date()
): Promise<GoogleChatAppCheck> {
  if (input.projectNumber !== undefined && !isGoogleCloudProjectNumber(input.projectNumber)) {
    return {
      status: 'project_number_invalid',
      message: 'the project number must be the numeric Project number from the Google Cloud dashboard'
    }
  }
  const checked = checkServiceAccountKey(input.serviceAccountKey, input.projectId)
  if (checked.status !== 'ok') return checked
  const resolved = await resolveProjectNumber(checked.key, fetchImpl, now)
  if (resolved.status !== 'ok') return resolved
  if (input.projectNumber !== undefined && input.projectNumber !== resolved.projectNumber) {
    return {
      status: 'project_number_mismatch',
      message: `the project number ${input.projectNumber} does not match project ${input.projectId}, whose number is ${resolved.projectNumber}`
    }
  }
  const probe = await probeGoogleChatCredential(checked.key, fetchImpl, now)
  if (probe.status !== 'ok') return { status: probe.status, message: probe.message }
  return { status: 'ok', key: checked.key, projectNumber: resolved.projectNumber, message: probe.message }
}

type MintFailure = { status: 'key_rejected' | 'unreachable' | 'google_unavailable'; message: string }

/** One app-authenticated access token for `scope`, from Google's fixed token endpoint. */
async function mintAccessToken(
  key: GoogleServiceAccountKey,
  scope: string,
  fetchImpl: typeof fetch,
  now: () => Date
): Promise<{ accessToken: string } | MintFailure> {
  const issuedAt = Math.floor(now().getTime() / 1000)
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) })
    .setIssuer(key.clientEmail)
    .setAudience(GOOGLE_TOKEN_ENDPOINT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3_600)
    .sign(key.signingKey)

  let tokenResponse: Response
  try {
    tokenResponse = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
  } catch {
    return unreachable("Google's token endpoint")
  }
  const token = await readJson(tokenResponse)
  if (tokenResponse.status >= 500 || tokenResponse.status === 429) {
    return unavailable("Google's token endpoint", tokenResponse.status)
  }
  if (!tokenResponse.ok) {
    const error = detail(token?.error) ?? `HTTP ${tokenResponse.status}`
    const description = detail(token?.error_description)
    return {
      status: 'key_rejected',
      message:
        `Authentication failed: Google rejected the service-account key for ${key.clientEmail} (${error}${description ? `: ${description}` : ''}). ` +
        'The key may have been deleted or disabled, or its service account removed; create a new JSON key for that service account and paste it here.'
    }
  }
  const accessToken = typeof token?.access_token === 'string' ? token.access_token : undefined
  if (!accessToken) return unavailable("Google's token endpoint", tokenResponse.status)
  return { accessToken }
}

function unreachable(target: string): { status: 'unreachable'; message: string } {
  return {
    status: 'unreachable',
    message: `Connection failed: ${target} could not be reached. Check outbound HTTPS access to Google and try again; nothing was saved.`
  }
}

function unavailable(target: string, status: number): { status: 'google_unavailable'; message: string } {
  return {
    status: 'google_unavailable',
    message: `Connection failed: ${target} answered HTTP ${status} without a usable result. Try again later; nothing was saved.`
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function detail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  return trimmed.length > MAX_PROVIDER_DETAIL ? `${trimmed.slice(0, MAX_PROVIDER_DETAIL)}…` : trimmed
}

// The Control Plane registration: the Computer key and where to dial (computer-use.md §3.6); a 0600 file until keychains land.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { COMPUTER_REGISTER_PUBLIC_PATH, COMPUTER_WS_PUBLIC_PATH } from '@agentconnect.md/protocol/computer'
import { dataDir } from '../config.js'

export const Registration = z.object({
  cpUrl: z.string().url(),
  channelUrl: z.string().url(),
  computerId: z.string().uuid(),
  orgId: z.string().min(1),
  apiKeyId: z.string().min(1),
  // The Computer key: authenticates only the Computer channel; never logged or printed.
  apiKey: z.string().min(1),
  registeredAt: z.string().datetime(),
  // sha256 of the registration token this key was spent from, so a restart can tell a new token from the spent one.
  tokenSha256: z.string().optional(),
  // Set once the CP revoked the key; the daemon then refuses all input until it is registered again.
  revokedAt: z.string().datetime().optional(),
  revokedReason: z.string().optional()
})
export type Registration = z.infer<typeof Registration>

export const registrationPath = (dir = dataDir()): string => join(dir, 'computer-key.json')

export function loadRegistration(dir = dataDir()): Registration | undefined {
  let raw: string
  try {
    raw = readFileSync(registrationPath(dir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return Registration.parse(JSON.parse(raw))
}

export function saveRegistration(registration: Registration, dir = dataDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The mode argument skips a directory that already exists, so tighten it explicitly.
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  const path = registrationPath(dir)
  const tmp = `${path}.tmp`
  const body = `${JSON.stringify(Registration.parse(registration), null, 2)}\n`
  // A leftover tmp could carry a wider mode; recreate it exclusively so the key never lands outside 0600.
  rmSync(tmp, { force: true })
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, body)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Forget the key but remember the revocation, so a restart still refuses input. */
export function markRevoked(dir: string, reason: string, at = new Date()): Registration | undefined {
  const current = loadRegistration(dir)
  if (!current) return undefined
  const revoked = { ...current, apiKey: 'revoked', revokedAt: at.toISOString(), revokedReason: reason }
  saveRegistration(revoked, dir)
  return revoked
}

export function removeRegistration(dir = dataDir()): void {
  rmSync(registrationPath(dir), { force: true })
}

/** The CP base URL from what the console printed: a bare origin, a path prefix, or the exchange URL itself. */
export function cpBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed.endsWith(COMPUTER_REGISTER_PUBLIC_PATH)
    ? trimmed.slice(0, -COMPUTER_REGISTER_PUBLIC_PATH.length)
    : trimmed
}

/** The channel URL when an older CP's exchange did not name one. */
export const defaultChannelUrl = (cpUrl: string): string =>
  `${cpBaseUrl(cpUrl).replace(/^http/, 'ws')}${COMPUTER_WS_PUBLIC_PATH}`

export interface RegisterProfile {
  name: string
  isolation: 'none' | 'container' | 'vm'
  os: 'macos' | 'windows' | 'linux'
  osVersion: string
  session: 'aqua' | 'console' | 'rdp' | 'x11' | 'xvfb' | 'wayland-gnome'
  desktopDaemonVersion: string
  driverVersion: string
  capabilities?: unknown
}

const RegisteredResponse = z.object({
  computerId: z.string().uuid(),
  orgId: z.string().min(1),
  apiKeyId: z.string().min(1),
  apiKey: z.string().min(1),
  channelUrl: z.string().url().optional()
})

/** The CP refused the token itself: unknown, spent or expired. */
export class RegistrationTokenRefused extends Error {
  constructor() {
    super('the registration token is invalid, spent or expired; create a new one')
    this.name = 'RegistrationTokenRefused'
  }
}

/** Spend a one-time registration token for this desktop's Computer key. */
export async function exchangeRegistrationToken(
  cpUrl: string,
  token: string,
  profile: RegisterProfile,
  fetchImpl: typeof fetch = fetch
): Promise<Registration> {
  const base = cpBaseUrl(cpUrl)
  const response = await fetchImpl(`${base}${COMPUTER_REGISTER_PUBLIC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, ...profile }),
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 401) throw new RegistrationTokenRefused()
  if (!response.ok) throw new Error(`registration failed: HTTP ${response.status} ${await response.text()}`)
  const body = RegisteredResponse.parse(await response.json())
  return {
    cpUrl: base,
    channelUrl: body.channelUrl ?? defaultChannelUrl(base),
    computerId: body.computerId,
    orgId: body.orgId,
    apiKeyId: body.apiKeyId,
    apiKey: body.apiKey,
    registeredAt: new Date().toISOString()
  }
}

/** Re-running the console's command finds its token spent; a stored, unrevoked key for the same CP is still good. */
export async function registerOrKeep(
  dir: string,
  cpUrl: string | undefined,
  register: () => Promise<Registration>
): Promise<{ registration: Registration; kept: boolean }> {
  try {
    return { registration: await register(), kept: false }
  } catch (error) {
    if (!(error instanceof RegistrationTokenRefused) || !cpUrl) throw error
    const current = loadRegistration(dir)
    if (!current || current.revokedAt || cpBaseUrl(cpUrl) !== current.cpUrl) throw error
    return { registration: current, kept: true }
  }
}

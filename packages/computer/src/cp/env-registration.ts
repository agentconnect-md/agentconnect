// Registration from the environment, for containers: a token variable or secret file plus the CP URL (computer-use.md §3.6).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cpBaseUrl, RegistrationTokenRefused, type Registration } from './registration.js'

export const REGISTER_TOKEN_ENV = 'AGENTCONNECT_REGISTER_TOKEN'
export const REGISTER_TOKEN_FILE_ENV = 'AGENTCONNECT_REGISTER_TOKEN_FILE'
export const CP_URL_ENV = 'AGENTCONNECT_CP_URL'
export const COMPUTER_NAME_ENV = 'AGENTCONNECT_COMPUTER_NAME'

export interface EnvRegistration {
  token: string
  cpUrl: string
  name?: string
}

/** The registration the environment asks for; error messages name the variable or file, never the token. */
export function registrationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): EnvRegistration | undefined {
  let token = env[REGISTER_TOKEN_ENV]?.trim() ?? ''
  const file = env[REGISTER_TOKEN_FILE_ENV]?.trim()
  if (!token && file) {
    try {
      token = read(file).trim()
    } catch (error) {
      throw new Error(
        `cannot read ${REGISTER_TOKEN_FILE_ENV} (${file}): ${(error as NodeJS.ErrnoException).code ?? 'error'}`
      )
    }
  }
  if (!token) return undefined
  const cpUrl = env[CP_URL_ENV]?.trim()
  if (!cpUrl) throw new Error(`${CP_URL_ENV} is required with a registration token (the console prints it)`)
  const name = env[COMPUTER_NAME_ENV]?.trim()
  return { token, cpUrl, ...(name ? { name } : {}) }
}

export const tokenSha256 = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A live key for the same CP spent from this very token answers it; a different token is spent again. */
export const keepsRegistration = (current: Registration | undefined, wanted: EnvRegistration): boolean =>
  Boolean(
    current &&
    !current.revokedAt &&
    current.cpUrl === cpBaseUrl(wanted.cpUrl) &&
    current.tokenSha256 === tokenSha256(wanted.token)
  )

/** A refused token keeps only a revoked key for the same CP, so a restart with the spent token stays up, revoked. */
export const staysRevoked = (current: Registration | undefined, cpUrl: string): boolean =>
  Boolean(current?.revokedAt && current.cpUrl === cpBaseUrl(cpUrl))

export type EnvRegistrationOutcome =
  | { kind: 'none' }
  | { kind: 'kept'; registration: Registration }
  | { kind: 'registered'; registration: Registration }
  | { kind: 'stays-revoked'; registration: Registration; reason: string }

/** What `run` does with the environment's token: keep the stored key, spend the token, or stay revoked; else throw. */
export async function registerFromEnv(options: {
  wanted: EnvRegistration | undefined
  load: () => Registration | undefined
  exchange: (wanted: EnvRegistration) => Promise<Registration>
  save: (registration: Registration) => void
}): Promise<EnvRegistrationOutcome> {
  const { wanted } = options
  if (!wanted) return { kind: 'none' }
  const current = options.load()
  if (current && keepsRegistration(current, wanted)) return { kind: 'kept', registration: current }
  try {
    const registration = { ...(await options.exchange(wanted)), tokenSha256: tokenSha256(wanted.token) }
    options.save(registration)
    return { kind: 'registered', registration }
  } catch (error) {
    // A revoked desktop restarting with its spent token keeps running revoked rather than crash-looping.
    if (error instanceof RegistrationTokenRefused && current && staysRevoked(current, wanted.cpUrl)) {
      return { kind: 'stays-revoked', registration: current, reason: error.message }
    }
    throw error
  }
}

// Registration from the environment, for containers: a token variable or secret file plus the CP URL (computer-use.md §3.6).
import { readFileSync } from 'node:fs'
import { cpBaseUrl, type Registration } from './registration.js'

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

/** A stored, unrevoked key for the same CP already answers the token, which is one-time and spent by now. */
export const keepsRegistration = (current: Registration | undefined, cpUrl: string): boolean =>
  Boolean(current && !current.revokedAt && current.cpUrl === cpBaseUrl(cpUrl))

/** A refused token keeps only a revoked key for the same CP, so a restart with the spent token stays up, revoked. */
export const staysRevoked = (current: Registration | undefined, cpUrl: string): boolean =>
  Boolean(current?.revokedAt && current.cpUrl === cpBaseUrl(cpUrl))

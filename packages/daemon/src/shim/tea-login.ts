// tea reads a login only from `$XDG_CONFIG_HOME/tea/config.yml`, so the shim writes the placeholder there for a runtime that drops GITEA_TOKEN (gitea-integration.md §9).
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { CODE_HOST_CREDENTIAL_ENV } from '../credential-proxy/placeholder-helper.js'

/** The one login the shim owns in tea's config; every other login is the agent's and is kept. */
export const TEA_LOGIN_NAME = 'agentconnect'

/** A real directory at `path`, made when missing; false for a link or anything else in its place. */
function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    mkdirSync(path, { mode: 0o700 })
    return true
  }
}

interface AgentConfig {
  logins: unknown[]
  rest: Record<string, unknown>
}

const EMPTY: AgentConfig = { logins: [], rest: {} }

/** The config with the shim's own login dropped, or undefined when the file is there but is not a config this can merge into. */
function agentConfig(file: string): AgentConfig | undefined {
  let text: string
  try {
    const stat = lstatSync(file)
    // A link is replaced unread, never followed.
    if (stat.isSymbolicLink()) return EMPTY
    if (!stat.isFile()) return undefined
    text = readFileSync(file, 'utf8')
  } catch {
    return EMPTY
  }
  const config: unknown = parse(text)
  if (config === null || config === undefined) return EMPTY
  if (typeof config !== 'object' || Array.isArray(config)) return undefined
  const { logins, ...rest } = config as Record<string, unknown>
  if (logins !== undefined && logins !== null && !Array.isArray(logins)) return undefined
  const others = ((logins ?? []) as unknown[]).filter(
    (login) => (login as { name?: unknown } | null)?.name !== TEA_LOGIN_NAME
  )
  return { logins: others, rest }
}

/** Put the session's placeholder first in tea's config, as its default login; only the daemon's own placeholder is ever written. */
export function seedTeaLogin(env: Record<string, string>, log?: { warn(message: string): void }): void {
  const token = env.GITEA_TOKEN
  const url = env.GITEA_INSTANCE_URL
  // An agent's own token never lands on disk: the daemon sets GITEA_TOKEN to the placeholder git holds, or not at all.
  if (!token || !url || token !== env[CODE_HOST_CREDENTIAL_ENV]) return
  const configHome = env.XDG_CONFIG_HOME?.trim() || (env.HOME?.trim() ? join(env.HOME.trim(), '.config') : '')
  if (!isAbsolute(configHome)) return
  const dir = join(configHome, 'tea')
  const file = join(dir, 'config.yml')
  try {
    if (!realDirectory(configHome) || !realDirectory(dir)) {
      log?.warn(`acp: ${dir} is not a real directory, so tea gets its login from the environment only`)
      return
    }
    let existing: AgentConfig | undefined
    try {
      existing = agentConfig(file)
    } catch {
      existing = undefined
    }
    if (existing === undefined) {
      log?.warn(
        `acp: leaving ${file} as it is, since it is not a tea config; tea gets its login from the environment only`
      )
      return
    }
    const login = { name: TEA_LOGIN_NAME, url, token, default: true }
    // The agent's preferences and other keys stay as they were.
    const config = { ...existing.rest, logins: [login, ...existing.logins] }
    // A fresh file renamed into place, so a link at the path is replaced rather than followed.
    const temp = join(dir, `.config.yml.${process.pid}.tmp`)
    rmSync(temp, { force: true })
    writeFileSync(temp, stringify(config), { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    log?.warn(`acp: could not write tea's login (${error instanceof Error ? error.message : String(error)})`)
  }
}

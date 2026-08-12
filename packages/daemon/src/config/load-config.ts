import { chmodSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { CP_URL_ENV, type RelayRosterEntry } from '@agentconnect.md/protocol'
import { ConfigSchema, type Config } from './config-schema.js'
import { resolveRoot, configPath, defaultAgentsDir } from '../paths.js'

export interface FlatOverrides {
  apiUrl?: string
  apiKey?: string
  noCp?: boolean
  daemonId?: string
  logLevel?: Config['logging']['level']
  agentsDir?: string
  maxAgents?: number
  requireSandbox?: boolean
}

function protectConfigFile(file: string, writable = false): void {
  if (!existsSync(file)) return
  try {
    const current = statSync(file).mode & 0o777
    const desired = writable ? 0o600 : current & 0o700
    if (current !== desired) chmodSync(file, desired)
  } catch (err) {
    // Windows does not provide enforceable POSIX mode semantics. On POSIX,
    // never keep using a secret-bearing config if owner-only access cannot be
    // established.
    if (process.platform !== 'win32') throw err
  }
}

function writeConfigFile(file: string, raw: unknown): void {
  // `mode` protects new paths; chmod also repairs a legacy file created under a
  // loose umask. Do not chmod an existing custom parent directory.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  protectConfigFile(file, true)
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  protectConfigFile(file, true)
}

export function loadConfig(
  opts: { root?: string; configPath?: string; overrides?: FlatOverrides; optional?: boolean; autoCreate?: boolean } = {}
): Config {
  const root = resolveRoot(opts.root)
  const file = opts.configPath ?? configPath(root)
  // `optional` (used by `chat`) lets the daemon run with zero config: a missing
  // config.json yields the schema defaults, and runtimes fall back to the ACP registry.
  // `autoCreate` (used by `run`) goes a step further and writes that empty config to
  // disk so the daemon runs fully local (control plane disabled by default) and the
  // user has a file to edit later — no `agentconnect login` required.
  let raw: unknown
  if (existsSync(file)) {
    protectConfigFile(file)
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } else if (opts.autoCreate) {
    raw = { version: 1 }
    writeConfigFile(file, raw)
  } else if (opts.optional) {
    raw = { version: 1 }
  } else {
    throw new Error(`config not found: ${file} (create it, pass --config, or run \`agentconnect login\`)`)
  }
  const cfg = ConfigSchema.parse(raw) // throws on invalid

  const o = opts.overrides ?? {}
  if (o.daemonId) cfg.daemonId = o.daemonId
  if (o.logLevel) cfg.logging.level = o.logLevel
  if (o.maxAgents !== undefined) cfg.limits.maxAgents = o.maxAgents
  if (o.requireSandbox) cfg.security.requireSandbox = true
  if (o.apiUrl) cfg.controlPlane.url = o.apiUrl
  if (o.apiKey) cfg.controlPlane.key = o.apiKey
  // Passing --api-url/--api-key implies "connect to the CP" (it defaults off),
  // so the one-line onboarding command works without a config edit. --no-cp wins.
  if (o.apiUrl || o.apiKey) cfg.controlPlane.enabled = true
  if (o.noCp) cfg.controlPlane.enabled = false

  // An envelope daemon has no config file and no key: the operator injects the control
  // plane's own address (spec.controlPlane.url) as env, and the pod's projected token is
  // the credential. Lowest precedence — an explicit flag or config entry still wins, and
  // `--no-cp` still turns the connection off.
  const envUrl = process.env[CP_URL_ENV]?.trim()
  if (envUrl && !cfg.controlPlane.url) {
    cfg.controlPlane.url = envUrl
    if (!o.noCp) cfg.controlPlane.enabled = true
  }

  cfg.agentsDir = o.agentsDir ?? cfg.agentsDir ?? defaultAgentsDir(root)
  return cfg
}

/**
 * Persist a (freshly-minted) `daemonId` back into config.json so it is stable
 * per install. Best-effort: a write failure is swallowed (the daemon still runs
 * with the in-memory id this session).
 */
export function persistDaemonId(root: string | undefined, daemonId: string, customConfigPath?: string): void {
  try {
    const file = customConfigPath ?? configPath(resolveRoot(root))
    protectConfigFile(file)
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }
    raw.daemonId = daemonId
    writeConfigFile(file, raw)
  } catch {
    // ignore — non-fatal
  }
}

/**
 * Persist the CP-published relay roster back into config.json so the daemon can
 * re-dial its relays at boot while the CP is unreachable (graceful degradation).
 * Whole-set (CP-owned): overwrites any prior value, so a swept relay is cleared.
 * Best-effort — a write failure is swallowed (the in-memory roster still drives
 * this session's dials).
 */
export function persistRelays(root: string | undefined, relays: RelayRosterEntry[], customConfigPath?: string): void {
  try {
    const file = customConfigPath ?? configPath(resolveRoot(root))
    protectConfigFile(file)
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }
    raw.relays = relays
    writeConfigFile(file, raw)
  } catch {
    // ignore — non-fatal
  }
}

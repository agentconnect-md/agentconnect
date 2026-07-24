import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayRosterEntry } from '@agentconnect.md/protocol'
import { ConfigSchema, type Config } from './config-schema.js'
import { resolveRoot, configPath, defaultAgentsDir } from '../paths.js'

export interface FlatOverrides {
  cpUrl?: string
  cpKey?: string
  noCp?: boolean
  daemonId?: string
  logLevel?: Config['logging']['level']
  agentsDir?: string
  maxAgents?: number
  requireSandbox?: boolean
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
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } else if (opts.autoCreate) {
    raw = { version: 1 }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
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
  if (o.cpUrl) cfg.controlPlane.url = o.cpUrl
  if (o.cpKey) cfg.controlPlane.key = o.cpKey
  // Passing --cp-url/--cp-key implies "connect to the CP" (it defaults off),
  // so the one-line onboarding command works without a config edit. --no-cp wins.
  if (o.cpUrl || o.cpKey) cfg.controlPlane.enabled = true
  if (o.noCp) cfg.controlPlane.enabled = false

  cfg.agentsDir = o.agentsDir ?? cfg.agentsDir ?? defaultAgentsDir(root)
  return cfg
}

/**
 * Persist a (freshly-minted) `daemonId` back into config.json so it is stable
 * per install. Best-effort: a write failure is swallowed (the daemon still runs
 * with the in-memory id this session).
 */
export function persistDaemonId(root: string | undefined, daemonId: string): void {
  try {
    const file = configPath(resolveRoot(root))
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }
    raw.daemonId = daemonId
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
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
export function persistRelays(root: string | undefined, relays: RelayRosterEntry[]): void {
  try {
    const file = configPath(resolveRoot(root))
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }
    raw.relays = relays
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
  } catch {
    // ignore — non-fatal
  }
}

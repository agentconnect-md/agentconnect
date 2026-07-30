import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolveRoot(root?: string): string {
  const r = root ?? process.env.AGENTCONNECT_ROOT ?? join(homedir(), '.agentconnect')
  return resolve(r.replace(/^~(?=$|\/)/, homedir()))
}

export function configPath(root: string): string {
  return join(root, 'config.json')
}

export function statePath(root: string): string {
  return join(root, 'state', 'local.sqlite')
}

export function defaultAgentsDir(root: string): string {
  return join(root, 'agents')
}

export function registryPath(root: string): string {
  return join(root, 'acp_registry.json')
}

export function registryCachePath(root: string): string {
  return join(root, 'acp_registry.cache.json')
}

export function logsDir(root: string): string {
  return join(root, 'logs')
}

/**
 * Unix-domain socket the daemon's MCP control server listens on. The stdio
 * `agentconnect mcp-bridge` subprocess (spawned by the agent harness) connects
 * here to forward tool calls back to the daemon. Kept short (macOS caps UDS
 * paths at ~104 bytes) and under `run/` so it's separate from durable state.
 */
export function mcpSocketPath(root: string): string {
  return join(root, 'run', 'mcp.sock')
}

/** Daemon-private source tree for conversation-scoped admin MCP sockets. Every
 * untrusted bwrap host masks this root; an entitled cell binds back one child. */
export function delegatedMcpBrokerRoot(root: string): string {
  return join(root, 'run', 'mcp-cells')
}

/** Parent for per-conversation ACP runtime homes. */
export function delegatedMcpRuntimeHomeRoot(root: string): string {
  return join(root, 'run', 'webchat-hosts')
}

export function daemonLogPath(root: string): string {
  return join(root, 'logs', 'daemon.log')
}

export function lockPath(root: string): string {
  return join(root, 'daemon.lock')
}

/**
 * `<root>/cli-entry` — pointer file the CLI writes on every invocation, holding
 * the absolute path to the CLI's own dist entry. The daemon reads it to locate
 * the CLI for a CP-commanded upgrade (cli-daemon-split.md §3/§7.1) even when the
 * service process's PATH omits npm's global bin.
 */
export function cliEntryPointer(root: string): string {
  return join(root, 'cli-entry')
}

/**
 * The daemon entry to bake into secret-free shims (git-credential / gh / MCP
 * bridge) written into repo configs, session env, and shim scripts
 * (cli-daemon-split.md §8). These outlive any single daemon version, so they
 * must point at the STABLE `<root>/current/dist/index.js` (via the symlink)
 * rather than the running bundle's own path, which an upgrade would replace.
 *
 * Resolution: `AGENTCONNECT_DAEMON_ENTRY` (dev override) → `<root>/current` when
 * it exists (production) → the running entry `process.argv[1]` (dev / bare run
 * with no version store, where the shim writers' `.ts`→tsx branch applies).
 */
export function daemonEntryForShims(root: string): string {
  const override = process.env.AGENTCONNECT_DAEMON_ENTRY
  if (override) return override
  const current = join(root, 'current', 'dist', 'index.js')
  if (existsSync(current)) return current
  return process.argv[1] ?? current
}

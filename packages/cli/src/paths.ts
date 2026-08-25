import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Root resolution — kept BYTE-FOR-BYTE identical to the daemon's `resolveRoot`
 * (packages/daemon/src/paths.ts). The CLI and daemon MUST agree on `<root>`, or
 * the `current` symlink / `cli-entry` handshake targets the wrong tree. Any
 * change here must be mirrored there.
 */
export function resolveRoot(root?: string): string {
  const r = root ?? process.env.AGENTCONNECT_ROOT ?? defaultRoot()
  return resolve(r.replace(/^~(?=$|\/)/, homedir()))
}

/** `~/.agentconnect` — the built-in root, deliberately ignoring
 *  `AGENTCONNECT_ROOT` so callers can ask "is this root the default one?". */
export function defaultRoot(): string {
  return join(homedir(), '.agentconnect')
}

export function configPath(root: string): string {
  return join(root, 'config.json')
}

/** `<root>/service.json` — which OS-service instance owns this root (instance.ts). */
export function servicePointerPath(root: string): string {
  return join(root, 'service.json')
}

export function logsDir(root: string): string {
  return join(root, 'logs')
}

export function daemonLogPath(root: string): string {
  return join(root, 'logs', 'daemon.log')
}

/**
 * `<root>/daemon.lock` — the daemon's single-instance lock, holding the live
 * daemon's pid. Kept BYTE-FOR-BYTE identical to the daemon's `lockPath`
 * (packages/daemon/src/paths.ts). The service run shell reads it as the daemon
 * readiness signal: a login-shell launch `exec`s into the daemon (pid is
 * preserved), so lock content == spawned child pid ⇔ the daemon came up.
 */
export function daemonLockPath(root: string): string {
  return join(root, 'daemon.lock')
}

// ── version store layout (cli-daemon-split.md §3) ──

/** `<root>/versions` — parent of every installed daemon version directory. */
export function versionsDir(root: string): string {
  return join(root, 'versions')
}

/** `<root>/versions/<v>` — one extracted, self-contained daemon bundle. */
export function versionDir(root: string, version: string): string {
  return join(versionsDir(root), version)
}

/** `<root>/current` — the symlink that names the active version. */
export function currentLink(root: string): string {
  return join(root, 'current')
}

/**
 * The literal active daemon entry through the symlink: `<root>/current/dist/
 * index.js`. Baked into generated service units — always literal, never the dev
 * override, since a unit is a production artifact.
 */
export function currentDistEntry(root: string): string {
  return join(currentLink(root), 'dist', 'index.js')
}

/**
 * The daemon entry the CLI delegates to / the run shell launches:
 * `currentDistEntry`, unless `AGENTCONNECT_DAEMON_ENTRY` overrides it for in-repo
 * development (§3.1), where no version store exists.
 */
export function currentEntry(root: string): string {
  return process.env.AGENTCONNECT_DAEMON_ENTRY ?? currentDistEntry(root)
}

/** `<root>/versions.json` — CLI-private metadata (channel, previous, history). */
export function versionsJsonPath(root: string): string {
  return join(root, 'versions.json')
}

/** `<root>/versions.lock` — inter-process writer mutex for the version store (§5.5). */
export function versionsLockPath(root: string): string {
  return join(root, 'versions.lock')
}

/**
 * `<root>/cli-entry` — a pointer file holding the absolute path to the CLI's own
 * dist entry, so a service/foreground daemon can locate the CLI to run an
 * upgrade even when its PATH omits npm's global bin (§3). Written on every CLI
 * invocation (self-heal).
 */
export function cliEntryPath(root: string): string {
  return join(root, 'cli-entry')
}

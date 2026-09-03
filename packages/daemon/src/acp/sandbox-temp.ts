import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { HostKey } from './host-key.js'

// SRT opens its multiplexer at `<TMPDIR>/srt-mux-<pid>-<seq>.sock`, directly under TMPDIR, and AF_UNIX truncates the whole path at 107 usable bytes on Linux (103 on macOS). A confined host's temp dir is therefore a SHORT leaf of the agent dir; #1763 put it under the per-session runtime HOME, whose 52-byte tail overflowed that budget on every realistic install.

/** Env var carrying the daemon-composed temp root to the SRT provider; absent ⇒ the provider keeps its private-HOME default. */
export const SANDBOX_TEMP_DIR_ENV = 'AGENTCONNECT_SANDBOX_TMPDIR'

/** `<agentDir>/t` — the parent every host temp directory of one agent hangs off; the name is one byte because every byte here is socket budget. */
export function sandboxTempParent(agentDir: string): string {
  return join(resolve(agentDir), 't')
}

/** Written when this daemon creates the temp parent. `t` is a short name, not a reserved one: an agent's `workspace.path` resolves under the agent dir too, so ownership is PROVEN by this marker and never inferred from the name. */
const OWNER_MARKER = '.agentconnect-runtime-temp'

/** The only entry name this daemon creates under the temp parent, and so the only one it ever removes. */
const TEMP_LEAF = /^[0-9a-f]{8}$/

/** `<agentDir>/t/<8 hex>` — one ACP host's own temp directory, distinct per host key. */
export function sandboxTempDirFor(agentDir: string, hostKey: HostKey | undefined): string {
  return join(sandboxTempParent(agentDir), tempLeaf(hostKey))
}

function tempLeaf(hostKey: HostKey | undefined): string {
  return createHash('sha256')
    .update(hostKey ?? '')
    .digest('hex')
    .slice(0, 8)
}

/** Usable `sun_path` bytes on Linux: the struct holds 108, less the terminating NUL. */
export const AF_UNIX_PATH_MAX = 107

/** The widest socket SRT composes under TMPDIR — a Linux pid at its 22-bit ceiling. */
const WIDEST_SRT_SOCKET = 'srt-mux-4194304-0.sock'

/** Create one host's temp directory and return its canonical path. Short is not the same as bounded: a deep enough daemon root plus a long agent name still overflows `sun_path`, and it fails HERE naming the path and the limit, rather than as an opaque `listen EINVAL` three ACP start attempts deep. */
export function prepareSandboxTempDir(
  agentDir: string,
  hostKey: HostKey | undefined,
  /** Test seam: SRT confines a host on Linux alone, so only a Linux launch opens this socket and only it is held to the budget. */
  platform: NodeJS.Platform = process.platform
): string {
  const created = mkdirSync(sandboxTempParent(agentDir), { recursive: true, mode: 0o700 }) !== undefined
  const parent = join(realpathSync(resolve(agentDir)), 't')
  // Trust the resolved directory, not the composed name: a link standing in for it would move the whole temp tree out of the agent dir.
  if (realpathSync(parent) !== parent) {
    throw new Error(`runtime temp parent is not a real directory inside the agent dir: ${parent}`)
  }
  if (created) writeFileSync(join(parent, OWNER_MARKER), '', { mode: 0o600 })
  // Fail closed rather than write into, or later sweep, a directory this daemon did not make — a first-launch race puts a sibling's half-made claim here too, which the next attempt resolves.
  if (!daemonOwnsTempParent(parent)) {
    throw new Error(
      `runtime temp root "${parent}" carries no ownership marker, so this daemon did not create it — either an agent workspace or operator data sits at that path and must move, or another host of this agent is creating it right now and the next launch attempt will find it marked`
    )
  }
  const path = join(parent, tempLeaf(hostKey))
  const socket = join(path, WIDEST_SRT_SOCKET)
  const bytes = Buffer.byteLength(socket)
  if (platform === 'linux' && bytes > AF_UNIX_PATH_MAX) {
    throw new Error(
      `runtime temp dir is too deep for its SRT socket: "${socket}" is ${bytes} bytes and the limit is ${AF_UNIX_PATH_MAX} — shorten the daemon root or the agent name`
    )
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

/** Drop one host's temp directory once its child is gone; a missing one is not an error. Teardown runs on paths this daemon only COMPOSED — a launch that refused an unowned parent still reaches it — so the marker gates the removal exactly as it gates the boot sweep. */
export function removeSandboxTempDir(path: string): void {
  if (!daemonOwnsTempParent(dirname(path))) return
  rmSync(path, { recursive: true, force: true })
}

/** The marker is the whole proof: a real file, written only by the call that created the parent. */
function daemonOwnsTempParent(parent: string): boolean {
  try {
    return lstatSync(join(parent, OWNER_MARKER)).isFile()
  } catch {
    return false
  }
}

/** Reclaim, at boot only, the host temp directories a hard-killed daemon left behind — every host of the agent is stopped then, so all of them are stale. Removes only `<8 hex>` leaves of a temp parent this daemon proved it owns: never the parent, never the marker, and nothing under a `t` that belongs to someone else. Best effort: returns what it removed and never throws. */
export function reclaimStaleHostTempDirs(agentDir: string): string[] {
  const parent = sandboxTempParent(agentDir)
  if (!daemonOwnsTempParent(parent)) return []
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of entries) {
    if (!TEMP_LEAF.test(name)) continue
    try {
      // `rm -r` unlinks a leaf symlink rather than following it, and no component above one is agent-writable.
      rmSync(join(parent, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      // A stale temp tree must never stop the daemon from serving the agent; the next boot retries.
    }
  }
  return removed
}

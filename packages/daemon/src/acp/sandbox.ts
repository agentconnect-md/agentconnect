import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveCommandPath } from '../runtimes/probe.js'

/**
 * OS-level process sandbox for agent runtimes (issue #642).
 *
 * The agent subprocess reads/writes the disk with its OWN tools (ACP fs is not a
 * chokepoint), so the only enforceable boundary is the kernel. We wrap the spawn
 * command in the platform's native sandbox launcher and confine WRITES to a small
 * allow-list. Reads stay open — locking reads breaks interpreters/libs/configs for
 * little threat reduction, and the goal is "the agent can't modify anything outside
 * its workspace", not secrecy.
 *
 * SECURITY — the writable set is derived from the TRUSTED agent directory (the
 * daemon's filesystem-scan result), never from mutable `agent.json` fields. The
 * agent-dir root that holds `agent.json` and agent-local state is intentionally NOT writable (only
 * its subdirs are), so a confined runtime cannot rewrite the very config that decides
 * sandboxing (e.g. point `workspace.path` at `/`) and escape on the next respawn.
 *
 * Fail-open: `detectSandbox()` returns undefined when no mechanism is installed and
 * the caller runs the agent unconfined. `sandboxBoundary()` instead THROWS on an
 * unsafe layout — an un-sandboxable config must not silently run unconfined.
 */
export type SandboxMechanism = 'bwrap' | 'sandbox-exec'

export interface DelegatedCellMount {
  maskedRoot: string
  sourceDir: string
  targetDir: string
}

/** Raised when a requested sandbox cannot be established safely (e.g. the cwd escapes
 *  the trusted agent dir). Distinct from the "no mechanism" fail-open path. */
export class SandboxError extends Error {}

const INVALID_DELEGATED_CELL_MOUNT = 'invalid delegated cell mount'

/**
 * Delegated MCP requires enforced Linux mount/PID isolation. A present but optional
 * sandbox is insufficient because any unconfined ACP host could read another cell's
 * broker socket source.
 */
export function supportsDelegatedMcpIsolation(input: {
  platform: NodeJS.Platform
  mechanism?: SandboxMechanism
  requireSandbox: boolean
  bwrapProbePassed: boolean
}): boolean {
  return input.platform === 'linux' && input.mechanism === 'bwrap' && input.requireSandbox && input.bwrapProbePassed
}

/** The sandbox launcher available on this host, or undefined (⇒ fail-open). */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env): SandboxMechanism | undefined {
  if (process.platform === 'linux') {
    const bwrap = resolveCommandPath('bwrap', env)
    if (!bwrap) return undefined
    const probe = spawnSync(
      bwrap,
      [
        '--unshare-pid',
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--tmpfs',
        tmpdir(),
        'true'
      ],
      {
        env,
        stdio: 'ignore',
        timeout: 2_000,
        windowsHide: true
      }
    )
    return probe.status === 0 ? 'bwrap' : undefined
  }
  if (process.platform === 'darwin') return resolveCommandPath('sandbox-exec', env) ? 'sandbox-exec' : undefined
  return undefined
}

/** True when `p` resolves to a strict descendant of `root` (never `root` itself). */
function strictlyInside(root: string, p: string): boolean {
  const abs = resolve(p)
  return abs.startsWith(root + sep)
}

/** Canonicalize the existing prefix too, so a missing leaf below a symlink cannot
 * pass a lexical containment check and later bind a path outside the trusted root. */
function canonicalTarget(path: string): string {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Delegated mount inputs must already exist and be stable directories. Unlike the
 * general sandbox boundary, missing leaves are not useful here and must fail closed. */
function existingDelegatedMountDirectory(path: string): string {
  try {
    const real = realpathSync(path)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
    return real
  } catch {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }
}

/**
 * Compute the writable allow-list for a confined agent from TRUSTED inputs.
 *
 * `agentDir` is the daemon's own record of where the agent lives (a filesystem-scan
 * result), NOT anything read out of `agent.json`. The cwd must live strictly inside
 * it — else we throw rather than bind an ancestor (which would expose `agent.json`).
 * The agent-dir root itself is never returned, so config stays read-only.
 *
 * Writable set: the cwd, one private runtime HOME, the managed-memory dir, and the
 * daemon's MCP bridge socket dir (the child connects to it for platform tools).
 */
export function sandboxBoundary(opts: { agentDir: string; cwd: string; runtimeHome: string; mcpSocketPath?: string }): {
  writable: string[]
} {
  const requestedAgentDir = resolve(opts.agentDir)
  if (!isAbsolute(requestedAgentDir) || requestedAgentDir === sep) {
    throw new SandboxError(`unsafe agent dir for sandboxing: ${opts.agentDir}`)
  }
  const agentDir = canonicalTarget(requestedAgentDir)
  const cwd = canonicalTarget(opts.cwd)
  const runtimeHome = canonicalTarget(opts.runtimeHome)
  const managedMemory = canonicalTarget(join(agentDir, 'memory'))
  if (!strictlyInside(agentDir, cwd)) {
    throw new SandboxError(`workspace cwd "${opts.cwd}" is not inside the agent dir "${agentDir}"`)
  }
  if (!strictlyInside(agentDir, runtimeHome)) {
    throw new SandboxError(`runtime HOME "${opts.runtimeHome}" is not inside the agent dir "${agentDir}"`)
  }
  if (!strictlyInside(agentDir, managedMemory)) {
    throw new SandboxError(`managed memory dir is not inside the agent dir "${agentDir}"`)
  }
  const writable = new Set<string>([cwd, runtimeHome, managedMemory])
  if (opts.mcpSocketPath) writable.add(canonicalTarget(dirname(opts.mcpSocketPath)))
  return { writable: [...writable] }
}

/** Resolve symlinks so subpath rules match the kernel's canonical path (macOS /tmp
 *  → /private/tmp). */
function canonical(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    out.add(canonicalTarget(p))
  }
  return [...out]
}

/**
 * Wrap `cmd`/`args` so the process runs under `mechanism`, everything readable but
 * writes confined to `writable` (plus tmp, added here so callers can't forget it).
 */
export function sandboxWrap(
  cmd: string,
  args: string[],
  opts: { mechanism: SandboxMechanism; writable: string[]; maskedReadRoots?: string[] }
): { cmd: string; args: string[] } {
  if (opts.mechanism !== 'bwrap' && (opts.maskedReadRoots?.length ?? 0) > 0) {
    throw new SandboxError('sandbox mechanism cannot mask read roots')
  }
  const writable = canonical(opts.writable)
  if (opts.mechanism === 'bwrap') {
    const maskedReadRoots = canonical(opts.maskedReadRoots ?? [])
    const bwrap: string[] = [
      // A PID namespace is REQUIRED for the read-only root to hold: without it the
      // fresh /proc still lists the daemon (same UID), and a confined agent could
      // follow /proc/<daemon-pid>/root/... into the daemon's original writable mount
      // namespace and write arbitrary host paths (#642). --unshare-pid hides host
      // processes; --die-with-parent tears the sandbox down if the daemon dies.
      '--unshare-pid',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/', // whole fs readable...
      '--dev',
      '/dev',
      '--proc',
      '/proc', // procfs for THIS pid namespace (mounted after --unshare-pid)
      '--tmpfs',
      tmpdir(), // ...fresh writable tmp...
      ...writable.flatMap((w) => ['--bind', w, w]), // ...and these dirs writable (later binds win)
      ...maskedReadRoots.flatMap((root) => ['--tmpfs', root]), // mask daemon-owned private socket sources
      '--'
    ]
    return { cmd: 'bwrap', args: [...bwrap, cmd, ...args] }
  }
  // sandbox-exec (macOS Seatbelt): allow all, deny writes, re-allow the writable set.
  // Inline profile via -p avoids a temp file. subpath must be a realpath (canonical()).
  const seatbeltWritable = canonical([...writable, tmpdir()])
  const profile =
    '(version 1)(allow default)(deny file-write*)' +
    seatbeltWritable.map((w) => `(allow file-write* (subpath "${w}"))`).join('')
  return { cmd: 'sandbox-exec', args: ['-p', profile, cmd, ...args] }
}

/**
 * Wrap one entitled ACP host in bwrap, revealing exactly one cell-private source
 * after the common broker source root has been hidden by a tmpfs mount.
 */
export function delegatedCellSandboxWrap(
  cmd: string,
  args: string[],
  baseWritable: string[],
  mount: DelegatedCellMount,
  maskedReadRoots: string[] = [mount.maskedRoot]
): { cmd: string; args: string[] } {
  const maskedRoot = existingDelegatedMountDirectory(mount.maskedRoot)
  const sourceDir = existingDelegatedMountDirectory(mount.sourceDir)
  if (!strictlyInside(maskedRoot, sourceDir)) {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }
  const validatedMaskedRoots = maskedReadRoots.map(existingDelegatedMountDirectory)
  if (!validatedMaskedRoots.includes(maskedRoot)) {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }

  const wrapped = sandboxWrap(cmd, args, {
    mechanism: 'bwrap',
    writable: baseWritable,
    maskedReadRoots: validatedMaskedRoots
  })
  const separator = wrapped.args.indexOf('--')
  const targetDir = canonicalTarget(mount.targetDir)
  const cellBind = ['--dir', targetDir, '--bind', sourceDir, targetDir]
  return {
    cmd: wrapped.cmd,
    args: [...wrapped.args.slice(0, separator), ...cellBind, ...wrapped.args.slice(separator)]
  }
}

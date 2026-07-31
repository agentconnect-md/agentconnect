import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/**
 * OS-level process sandbox for agent runtimes (issue #312).
 *
 * The agent subprocess reads/writes the disk with its OWN tools (ACP fs is not a
 * chokepoint), so the only enforceable boundary is the kernel. We wrap the spawn
 * command through @anthropic-ai/sandbox-runtime (SRT). Each ACP host gets its own
 * provider process because SRT's manager is process-global, while AgentConnect runs
 * many differently-scoped agents concurrently.
 *
 * SECURITY — the writable set is derived from the TRUSTED agent directory (the
 * daemon's filesystem-scan result), never from mutable `agent.json` fields. The
 * agent-dir root that holds `agent.json` and agent-local state is intentionally
 * hidden; only reviewed subdirectories are re-exposed. A confined runtime cannot
 * rewrite the config that decides sandboxing (e.g. point `workspace.path` at `/`)
 * and escape on the next respawn.
 *
 * Fail-open: `detectSandbox()` returns undefined when SRT cannot establish a live
 * Linux sandbox and the caller runs the agent unconfined. `sandboxBoundary()`
 * instead THROWS on an unsafe layout — an un-sandboxable config must not silently
 * run unconfined.
 */
export type SandboxMechanism = 'bwrap'

export interface SrtSandboxPolicy {
  writable: string[]
  denyRead: string[]
  allowRead: string[]
  gitSafeDirectories?: string[]
}

export interface DelegatedCellMount {
  maskedRoot: string
  sourceDir: string
  targetDir: string
}

export type DelegatedRuntimeHomeMount = DelegatedCellMount

/** Raised when a requested sandbox cannot be established safely (e.g. the cwd escapes
 *  the trusted agent dir). Distinct from the "no mechanism" fail-open path. */
export class SandboxError extends Error {}

const INVALID_DELEGATED_CELL_MOUNT = 'invalid delegated cell mount'

/** The path injected into delegated bridge descriptors. Filesystem validation is
 * intentionally deferred until delegated launch so a bad TMPDIR cannot crash an
 * otherwise unrelated daemon startup. */
export function delegatedMcpInCellSocketDirectory(): string {
  return join(tmpdir(), 'agentconnect-admin')
}

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

function sandboxProviderLauncher(): { cmd: string; args: string[] } {
  // Source/dev/tests run through tsx. A published daemon is the bundled
  // dist/index.js and can execute its hidden provider command directly.
  const sourceEntry = fileURLToPath(new URL('../index.ts', import.meta.url))
  if (existsSync(sourceEntry)) {
    const req = createRequire(import.meta.url)
    return { cmd: process.execPath, args: [req.resolve('tsx/cli'), sourceEntry] }
  }
  const entry = process.argv[1]
  if (!entry) throw new SandboxError('cannot locate the AgentConnect sandbox provider entry')
  return { cmd: process.execPath, args: [entry] }
}

let cachedHostSandbox: { value: SandboxMechanism | undefined } | undefined

/** Live Linux SRT/bwrap support on this host, or undefined (⇒ fail-open). */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env): SandboxMechanism | undefined {
  if (env === process.env && cachedHostSandbox) return cachedHostSandbox.value
  const value = probeSandbox(env)
  if (env === process.env) cachedHostSandbox = { value }
  return value
}

/** Keep the live SRT launch out of every Daemon constructor after the first one.
 * Production has one daemon, while a Linux test process may construct hundreds. */
function probeSandbox(env: NodeJS.ProcessEnv): SandboxMechanism | undefined {
  // This rollout is intentionally Linux-only. macOS needs a runtime-neutral
  // credential strategy before private HOME + Seatbelt can be enabled safely.
  if (process.platform !== 'linux') return undefined

  const root = mkdtempSync(join(tmpdir(), 'agentconnect-srt-probe-'))
  try {
    const agentDir = join(root, 'agent')
    const writable = join(agentDir, 'workspace')
    const privateHome = join(agentDir, 'home')
    mkdirSync(writable, { recursive: true })
    mkdirSync(privateHome)
    const settingsPath = writeSandboxSettings(agentDir, {
      writable: [writable, privateHome],
      denyRead: [],
      allowRead: [],
      gitSafeDirectories: [writable]
    })
    const launch = sandboxWrap('true', [], {
      mechanism: 'bwrap',
      writable: [writable, privateHome],
      settingsPath,
      cwd: writable
    })
    const probe = spawnSync(launch.cmd, launch.args, {
      env: { ...env, HOME: privateHome },
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true
    })
    return probe.status === 0 ? 'bwrap' : undefined
  } catch {
    return undefined
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** True when `p` resolves to a strict descendant of `root` (never `root` itself). */
function strictlyInside(root: string, p: string): boolean {
  const abs = resolve(p)
  return abs.startsWith(root + sep)
}

function overlaps(a: string, b: string): boolean {
  return a === b || strictlyInside(a, b) || strictlyInside(b, a)
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
    const info = statSync(real)
    if (!info.isDirectory()) throw new Error('not a directory')
    const uid = process.getuid?.()
    if (uid !== undefined && info.uid !== uid) throw new Error('not owned by daemon uid')
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
 * Writable set: the cwd, one private runtime HOME, and the managed-memory dir.
 * Unix-socket policy deliberately remains compatibility-open during the SRT
 * migration; connecting to an existing MCP socket does not make its directory a
 * writable filesystem surface.
 */
export function sandboxBoundary(opts: { agentDir: string; cwd: string; runtimeHome: string; mcpSocketPath?: string }): {
  writable: string[]
  denyRead: string[]
  allowRead: string[]
  gitSafeDirectories: string[]
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
  const allowRead = new Set<string>([
    ...writable,
    canonicalTarget(join(agentDir, 'run', 'config-files')),
    canonicalTarget(join(agentDir, '.agentconnect', 'runtime-policy'))
  ])
  return {
    writable: [...writable],
    // Hide agent.json (including persisted runtime secrets) and every other
    // daemon-owned sibling, then carve back only the runtime's data surfaces.
    denyRead: [agentDir],
    allowRead: [...allowRead],
    gitSafeDirectories: [cwd]
  }
}

/** Resolve symlinks so SRT rules match the kernel's canonical path. */
function canonical(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    out.add(canonicalTarget(p))
  }
  return [...out]
}

/**
 * Atomically publish the trusted SRT policy outside every agent-writable path.
 */
export function writeSandboxSettings(agentDir: string, policy: SrtSandboxPolicy): string {
  const root = canonicalTarget(agentDir)
  const settingsDir = join(root, '.agentconnect', 'sandbox')
  let current = root
  for (const part of relative(root, settingsDir).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new SandboxError(`sandbox settings path contains a symlink: ${current}`)
    }
  }
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
  chmodSync(settingsDir, 0o700)
  if (!strictlyInside(root, realpathSync(settingsDir))) {
    throw new SandboxError('sandbox settings path escapes the trusted agent dir')
  }

  const config: SandboxRuntimeConfig = {
    // Preserve common proxy-aware outbound web access while SRT isolates the
    // network namespace. The provider approves unmatched domains until a
    // separate network policy is designed; SRT intentionally rejects a bare
    // wildcard in allowedDomains. Host-local ports and clients that ignore the
    // proxy environment remain explicit compatibility gaps in issue #312.
    network: {
      allowedDomains: [],
      deniedDomains: [],
      // Socket restrictions are a separate policy project. Preserve all current
      // MCP/git/runtime behavior while replacing only the filesystem wrapper.
      allowAllUnixSockets: true
    },
    filesystem: {
      // SRT's shared default temp path is not part of AgentConnect's per-agent
      // storage. The provider redirects TMPDIR into the private HOME; hide the
      // shared fallback so agents cannot exchange data through it.
      denyRead: canonical([...policy.denyRead, '/tmp/claude', '/private/tmp/claude']),
      allowRead: canonical(policy.allowRead),
      allowWrite: canonical(policy.writable),
      denyWrite: canonical(['/tmp/claude', '/private/tmp/claude']),
      // Daemon-managed Git writes the credential-helper entries outside the
      // sandbox. A confined runtime must not redirect later host-side Git via
      // core.hooksPath, core.fsmonitor, filter.*, or similar settings.
      allowGitConfig: false
    },
    ...(policy.gitSafeDirectories?.length ? { git: { safeDirectories: canonical(policy.gitSafeDirectories) } } : {})
  }

  const settingsPath = join(settingsDir, 'settings.json')
  const temporary = join(settingsDir, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, settingsPath)
    chmodSync(settingsPath, 0o600)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp may not exist or may already have been renamed.
    }
    throw error
  }
  return settingsPath
}

/** Wrap an ordinary ACP command in AgentConnect's per-host SRT provider. */
export function sandboxWrap(
  cmd: string,
  args: string[],
  opts: {
    mechanism: SandboxMechanism
    writable: string[]
    settingsPath?: string
    cwd?: string
    maskedReadRoots?: string[]
  }
): { cmd: string; args: string[] } {
  if (!opts.settingsPath || !isAbsolute(opts.settingsPath)) {
    throw new SandboxError('sandbox settings path is required')
  }
  if (!opts.cwd || !isAbsolute(opts.cwd)) {
    throw new SandboxError('sandbox cwd is required')
  }
  const provider = sandboxProviderLauncher()
  return {
    cmd: provider.cmd,
    args: [...provider.args, '__sandbox-runtime', opts.settingsPath, String(process.pid), opts.cwd, '--', cmd, ...args]
  }
}

/** Legacy bwrap base retained only for delegated cells that require source→target
 * bind remapping, which SRT cannot currently express. Ordinary ACP hosts never use it. */
function delegatedBwrapBaseWrap(
  cmd: string,
  args: string[],
  writable: string[],
  maskedReadRoots: string[]
): { cmd: string; args: string[] } {
  const bwrap: string[] = [
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
    ...canonical(writable).flatMap((path) => ['--bind', path, path]),
    ...canonical(maskedReadRoots).flatMap((path) => ['--tmpfs', path]),
    '--'
  ]
  return { cmd: 'bwrap', args: [...bwrap, cmd, ...args] }
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
  runtimeHomeMount: DelegatedRuntimeHomeMount,
  maskedReadRoots: string[] = [mount.maskedRoot, runtimeHomeMount.maskedRoot]
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
  const runtimeHomeRoot = existingDelegatedMountDirectory(runtimeHomeMount.maskedRoot)
  const runtimeHomeSource = existingDelegatedMountDirectory(runtimeHomeMount.sourceDir)
  const runtimeHomeTarget = existingDelegatedMountDirectory(runtimeHomeMount.targetDir)
  if (
    !validatedMaskedRoots.includes(runtimeHomeRoot) ||
    !strictlyInside(runtimeHomeRoot, runtimeHomeSource) ||
    !strictlyInside(runtimeHomeRoot, runtimeHomeTarget) ||
    runtimeHomeSource !== runtimeHomeTarget
  ) {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }
  let privateTmpRoot: string
  try {
    privateTmpRoot = realpathSync(tmpdir())
    if (!statSync(privateTmpRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }
  const targetDir = canonicalTarget(mount.targetDir)
  const designatedTarget = join(privateTmpRoot, 'agentconnect-admin')
  if (
    targetDir !== designatedTarget ||
    dirname(targetDir) !== privateTmpRoot ||
    [maskedRoot, sourceDir, runtimeHomeRoot, runtimeHomeSource, runtimeHomeTarget].some((path) =>
      overlaps(path, targetDir)
    )
  ) {
    throw new SandboxError(INVALID_DELEGATED_CELL_MOUNT)
  }
  const privateRoots = new Set([maskedRoot, runtimeHomeRoot])
  const safeBaseWritable = baseWritable.filter((path) => {
    const canonicalPath = canonicalTarget(path)
    return (
      !overlaps(canonicalPath, targetDir) &&
      ![...privateRoots].some((root) => canonicalPath === root || strictlyInside(root, canonicalPath))
    )
  })

  const wrapped = delegatedBwrapBaseWrap(cmd, args, safeBaseWritable, validatedMaskedRoots)
  const separator = wrapped.args.indexOf('--')
  const privateBinds = [
    '--dir',
    targetDir,
    '--bind',
    sourceDir,
    targetDir,
    '--dir',
    runtimeHomeTarget,
    '--bind',
    runtimeHomeSource,
    runtimeHomeTarget
  ]
  return {
    cmd: wrapped.cmd,
    args: [...wrapped.args.slice(0, separator), ...privateBinds, ...wrapped.args.slice(separator)]
  }
}

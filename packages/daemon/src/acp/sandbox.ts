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
export type SandboxMechanism = 'bwrap' | 'seatbelt'

export interface SrtSandboxPolicy {
  writable: string[]
  denyRead: string[]
  allowRead: string[]
  /** Carve-outs inside a write root. SRT's own mandatory protection is derived from the cwd, so a
   *  write root the cwd does not contain (a session worktree's owner `.git`) needs its own. */
  denyWrite?: string[]
  gitSafeDirectories?: string[]
  /** No network or Unix-domain socket access and no dynamic approval callback.
   * Used for audited daemon helpers such as local skills installation. */
  offline?: boolean
}

/** Raised when a requested sandbox cannot be established safely (e.g. the cwd escapes
 *  the trusted agent dir). Distinct from the "no mechanism" fail-open path. */
export class SandboxError extends Error {}

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

/** A host probe result: the live mechanism, or why this host cannot confine. */
export interface SandboxProbe {
  mechanism: SandboxMechanism | undefined
  /** The provider's own failure text — the missing dependency names live here. */
  reason?: string
}

let cachedHostSandbox: SandboxProbe | undefined

/** Live Linux SRT/bwrap support on this host, or undefined (⇒ fail-open). */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env): SandboxMechanism | undefined {
  return probeSandboxHost(env).mechanism
}

/** The same one-shot probe, keeping the failure reason for the startup preflight log. */
export function probeSandboxHost(env: NodeJS.ProcessEnv = process.env): SandboxProbe {
  if (env === process.env && cachedHostSandbox) return cachedHostSandbox
  const probe = probeSandbox(env)
  if (env === process.env) cachedHostSandbox = probe
  return probe
}

/** Keep the live SRT launch out of every Daemon constructor after the first one.
 * Production has one daemon, while a Linux test process may construct hundreds. */
function probeSandbox(env: NodeJS.ProcessEnv): SandboxProbe {
  // This rollout is intentionally Linux-only. macOS needs a runtime-neutral
  // credential strategy before private HOME + Seatbelt can be enabled safely.
  if (process.platform !== 'linux') return { mechanism: undefined, reason: `unsupported platform ${process.platform}` }

  const root = mkdtempSync(join(tmpdir(), 'agentconnect-srt-probe-'))
  try {
    const agentDir = join(root, 'agent')
    const writable = join(agentDir, 'workspace')
    const privateHome = join(agentDir, 'home')
    mkdirSync(writable, { recursive: true })
    mkdirSync(privateHome)
    const settingsPath = writeSandboxSettings(agentDir, 'probe', {
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
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })
    if (probe.status === 0) return { mechanism: 'bwrap' }
    return { mechanism: undefined, reason: probeFailureReason(probe) }
  } catch (error) {
    return { mechanism: undefined, reason: boundedReason(error instanceof Error ? error.message : String(error)) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** SRT reports missing host dependencies on the provider's stderr; prefer that over a bare exit code. */
function probeFailureReason(probe: { stderr?: string; status: number | null; signal: string | null; error?: Error }) {
  const stderr = boundedReason(probe.stderr ?? '')
  if (stderr) return stderr
  if (probe.error) return boundedReason(probe.error.message)
  if (probe.signal) return `the SRT probe was killed by ${probe.signal}`
  return `the SRT probe exited with status ${probe.status ?? 'unknown'}`
}

/** One bounded log line: SRT's message is multi-line and the daemon logger is line-oriented. */
function boundedReason(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed
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

/**
 * Compute the writable allow-list for a confined agent from TRUSTED inputs.
 *
 * `agentDir` is the daemon's own record of where the agent lives (a filesystem-scan
 * result), NOT anything read out of `agent.json`. The cwd must live strictly inside
 * it — else we throw rather than bind an ancestor (which would expose `agent.json`).
 * The agent-dir root itself is never returned, so config stays read-only.
 *
 * Writable set: the cwd, one private runtime HOME, and the managed-memory dir.
 * A runtime credential adapter may add one credential-only host file/directory;
 * it is a separate trusted write capability, never a general read root.
 * AF_UNIX remains available because the ACP parent needs the daemon MCP channel
 * and model-authored Git may need the credential channel. Host socket trees are
 * hidden by the caller; exact AgentConnect sockets are re-exposed read-only when
 * an ancestor is hidden, without making their directories writable.
 */
export function sandboxBoundary(opts: {
  agentDir: string
  cwd: string
  runtimeHome: string
  mcpSocketPath?: string
  trustedReadRoots?: string[]
  trustedWriteRoots?: string[]
}): {
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
  const writable = new Set<string>([
    cwd,
    runtimeHome,
    managedMemory,
    ...(opts.trustedWriteRoots ?? []).map(canonicalTarget)
  ])
  const allowRead = new Set<string>([
    ...writable,
    canonicalTarget(join(agentDir, 'run', 'config-files')),
    canonicalTarget(join(agentDir, '.agentconnect', 'runtime-policy')),
    ...(opts.mcpSocketPath ? [canonicalTarget(opts.mcpSocketPath)] : []),
    ...(opts.trustedReadRoots ?? []).map(canonicalTarget)
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

/** Daemon-owned home of one host's SRT policy: `<agentDir>/.agentconnect/sandbox/<hostDir>`. */
export function sandboxSettingsDir(agentDir: string, hostDir: string): string {
  return join(agentDir, '.agentconnect', 'sandbox', hostDir)
}

/** Drop a stopped host's policy directory; a missing one is not an error. */
export function removeSandboxSettings(agentDir: string, hostDir: string): void {
  rmSync(sandboxSettingsDir(agentDir, hostDir), { recursive: true, force: true })
}

// Atomically publish the trusted SRT policy outside every agent-writable path, one directory per host.
export function writeSandboxSettings(agentDir: string, hostDir: string, policy: SrtSandboxPolicy): string {
  const root = canonicalTarget(agentDir)
  const settingsDir = sandboxSettingsDir(root, hostDir)
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

  const denyRead = canonical(policy.denyRead)
  for (const fallback of canonical(['/tmp/claude', '/private/tmp/claude'])) {
    const alreadyHidden = denyRead.some((denied) => {
      try {
        return statSync(denied).isDirectory() && (fallback === denied || strictlyInside(denied, fallback))
      } catch {
        return false
      }
    })
    if (!alreadyHidden) denyRead.push(fallback)
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
      // Linux cannot filter AF_UNIX by pathname, so an ordinary ACP host keeps
      // Unix sockets available for the parent and the model-side Git credential
      // helper; filesystem and network namespace visibility limit which host
      // sockets are reachable. The offline skills sandbox is stricter — it blocks
      // ALL Unix sockets through the apply-seccomp helper — so deny them there.
      allowAllUnixSockets: policy.offline !== true
    },
    filesystem: {
      // SRT's shared default temp path is not part of AgentConnect's per-agent
      // storage. The provider redirects TMPDIR into the private HOME; hide the
      // shared fallback so agents cannot exchange data through it.
      denyRead,
      allowRead: canonical(policy.allowRead),
      allowWrite: canonical(policy.writable),
      denyWrite: canonical([...(policy.denyWrite ?? []), '/tmp/claude', '/private/tmp/claude']),
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
    offline?: boolean
    startGated?: boolean
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
    args: [
      ...provider.args,
      opts.offline ? '__sandbox-runtime-offline' : '__sandbox-runtime',
      opts.settingsPath,
      String(process.pid),
      opts.cwd,
      ...(opts.startGated ? ['--start-gated'] : []),
      '--',
      cmd,
      ...args
    ]
  }
}

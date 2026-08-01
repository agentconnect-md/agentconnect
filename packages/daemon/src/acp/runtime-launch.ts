import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { sandboxBoundary, writeSandboxSettings, type SandboxMechanism } from './sandbox.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { compactReadRoots } from '../runtimes/read-roots.js'
import { prepareSharedRuntimeCredentials } from '../runtimes/runtime-credentials.js'
import { prepareRuntimeHome, runtimeHomeEnvironment, runtimeHomePath } from '../runtimes/runtime-home.js'
import { RUNTIME_STATE_LOCATIONS, runtimeStateLocations } from '../runtimes/probe.js'

export interface PreparedRuntimeLaunch {
  env: Record<string, string>
  /** Sandboxed launches carry a sanitized environment; unsandboxed launches inherit the daemon environment. */
  inheritProcessEnv: boolean
  runtimeHome?: string
  sandbox?: {
    mechanism: SandboxMechanism
    writable: string[]
    settingsPath: string
    cwd: string
    denyReadRoots: string[]
    allowReadRoots: string[]
  }
}

/** Daemon policy overrides the per-agent preference. Without an available host
 * mechanism, an optional sandbox request is ineffective. */
export function effectiveRunInSandbox(
  requireSandbox: boolean,
  requested: boolean,
  mechanism: SandboxMechanism | undefined
): boolean {
  return requireSandbox || (requested && mechanism !== undefined)
}

/** Prepare one ACP adapter launch. A private HOME is normally part of sandbox
 * isolation, but security probes and runtimes with generated private policy may
 * request the same environment isolation without an OS sandbox. */
export function prepareRuntimeLaunch(opts: {
  runtimeId: string
  runtime?: RuntimeDef
  scopeDir: string
  cwd: string
  runInSandbox: boolean
  isolateHome?: boolean
  explicitEnv?: Record<string, string>
  /** Host state roots used only to seed the private HOME. Probe launches keep
   * these separate from their deliberately tiny child environment. */
  stateSourceEnv?: NodeJS.ProcessEnv
  hostEnv?: NodeJS.ProcessEnv
  /** Trusted daemon root. Required for an enforced sandbox so all daemon-owned
   * state is hidden before current-agent surfaces are carved back. */
  daemonRoot?: string
  /** Configured agents directory when it is outside daemonRoot. */
  agentsRoot?: string
  /** Daemon/registry-owned executable and package roots needed to start the
   * runtime and its configured stdio children. Never derive this from agent env. */
  trustedRuntimeReadRoots?: string[]
  /** Test seam. Shared login remains Linux-only with the sandbox rollout. */
  credentialPlatform?: NodeJS.Platform
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
}): PreparedRuntimeLaunch {
  if (!opts.runInSandbox && !opts.isolateHome) {
    return { env: opts.explicitEnv ?? {}, inheritProcessEnv: true }
  }
  if (opts.runInSandbox && !opts.sandboxMechanism) {
    throw new Error('OS sandbox requested but this host has no supported Linux SRT/bwrap mechanism')
  }
  if (opts.runInSandbox && !opts.daemonRoot) {
    throw new Error('OS sandbox requested without the trusted AgentConnect daemon root')
  }

  const stateSourceEnv = opts.stateSourceEnv ?? opts.hostEnv ?? process.env
  const existingRealpath = (path: string): string => {
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
  const safeRoot = (path: string, label: string): string => {
    if (!isAbsolute(path)) throw new Error(`unsafe ${label} for sandboxing: ${path}`)
    const real = existingRealpath(path)
    if (real === sep) throw new Error(`unsafe ${label} for sandboxing: ${path}`)
    return real
  }
  const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  // Validate every broad boundary and the current-agent layout before touching
  // host credentials. A bad daemon root or escaping workspace must fail without
  // partially migrating login state.
  let protectedRoots: string[] = []
  let denyReadRoots: string[] = []
  if (opts.runInSandbox) {
    sandboxBoundary({ agentDir: opts.scopeDir, cwd: opts.cwd, runtimeHome: runtimeHomePath(opts.scopeDir) })
    const daemonRoot = safeRoot(opts.daemonRoot!, 'AgentConnect daemon root')
    const agentRoot = safeRoot(opts.scopeDir, 'agent root')
    const hostHomeRoots = compactReadRoots(
      [...new Set([stateSourceEnv.HOME, homedir()].filter((path): path is string => Boolean(path)))].map((path) =>
        safeRoot(path, 'host HOME')
      )
    )
    const sharedTempRoots = ['/tmp', '/var/tmp', stateSourceEnv.TMPDIR, stateSourceEnv.TMP, stateSourceEnv.TEMP]
      .filter((path): path is string => Boolean(path))
      .map((path) => safeRoot(path, 'shared temp root'))
    const allRuntimeStateRoots = Object.keys(RUNTIME_STATE_LOCATIONS).flatMap((id) =>
      runtimeStateLocations(id, stateSourceEnv).map((location) => safeRoot(location.source, `${id} host state root`))
    )
    protectedRoots = [
      daemonRoot,
      agentRoot,
      ...(opts.agentsRoot ? [safeRoot(opts.agentsRoot, 'agents root')] : []),
      ...hostHomeRoots,
      ...sharedTempRoots,
      ...allRuntimeStateRoots
    ]
    denyReadRoots = compactReadRoots(protectedRoots)
  }

  const validateException = (path: string, label: string): string => {
    const trusted = safeRoot(path, label)
    // An exception may sit below a hidden root, but must never equal or contain
    // one: that would reopen HOME, daemon state, temp, or an entire agent root.
    const broadened = protectedRoots.find((denied) => inside(trusted, denied))
    if (broadened) throw new Error(`${label} "${trusted}" would reopen protected path "${broadened}"`)
    return trusted
  }
  const trustedRuntimeReadRoots = compactReadRoots(
    (opts.trustedRuntimeReadRoots ?? [])
      .map((path) => validateException(path, 'trusted runtime read root'))
      // The root filesystem is already read-only. A carve-back is needed only
      // when a broad read deny would otherwise hide this installation path.
      .filter((trusted) => denyReadRoots.some((denied) => inside(denied, trusted)))
  )

  const credentials = prepareSharedRuntimeCredentials({
    runtimeId: opts.runtimeId,
    runtime: opts.runtime,
    hostEnv: stateSourceEnv,
    platform: opts.credentialPlatform
  })
  const runtimeHome = prepareRuntimeHome(
    opts.runtimeId,
    opts.scopeDir,
    stateSourceEnv,
    undefined,
    credentials?.seedExclusions
  )
  credentials?.preparePrivateHome(runtimeHome)
  const env = {
    ...runtimeHomeEnvironment(opts.runtimeId, runtimeHome, opts.explicitEnv, opts.hostEnv),
    ...credentials?.env
  }

  if (!opts.runInSandbox) {
    return { env, inheritProcessEnv: false, runtimeHome }
  }

  // PATH entries supplied by version managers are commonly symlinks below the
  // now-hidden host HOME. Resolve existing absolute entries while still outside
  // the namespace so runtime-spawned tools use the reviewed real installation.
  if (env.PATH) {
    env.PATH = env.PATH.split(delimiter)
      .map((entry) => {
        if (!isAbsolute(entry) || !existsSync(entry)) return entry
        try {
          return realpathSync(entry)
        } catch {
          return entry
        }
      })
      .join(delimiter)
  }
  const credentialWritableRoots = compactReadRoots(
    (credentials?.writablePaths ?? []).map((path) => validateException(path, 'shared credential write root'))
  )

  const boundary = sandboxBoundary({
    agentDir: opts.scopeDir,
    cwd: opts.cwd,
    runtimeHome,
    mcpSocketPath: opts.mcpSocketPath,
    trustedReadRoots: trustedRuntimeReadRoots,
    trustedWriteRoots: credentialWritableRoots
  })
  // SRT write roots must exist before spawn.
  // This also initializes workspace/memory for a newly-created agent.
  for (const path of boundary.writable) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
  }
  const settingsPath = writeSandboxSettings(opts.scopeDir, {
    writable: boundary.writable,
    // Host user data is default-denied. Re-open only the current agent surfaces
    // plus trusted executable/package roots above; never an agent-provided path.
    denyRead: denyReadRoots,
    allowRead: boundary.allowRead,
    gitSafeDirectories: boundary.gitSafeDirectories
  })
  return {
    env,
    inheritProcessEnv: false,
    runtimeHome,
    sandbox: {
      mechanism: opts.sandboxMechanism!,
      writable: boundary.writable,
      settingsPath,
      cwd: boundary.gitSafeDirectories[0]!,
      denyReadRoots,
      allowReadRoots: boundary.allowRead
    }
  }
}

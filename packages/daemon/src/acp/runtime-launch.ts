import { mkdirSync } from 'node:fs'
import { sandboxBoundary, writeSandboxSettings, type SandboxMechanism } from './sandbox.js'
import { prepareRuntimeHome, runtimeHomeEnvironment } from '../runtimes/runtime-home.js'
import { runtimeStateLocations } from '../runtimes/probe.js'

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
    maskedReadRoots?: string[]
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
  scopeDir: string
  cwd: string
  runInSandbox: boolean
  isolateHome?: boolean
  explicitEnv?: Record<string, string>
  /** Host state roots used only to seed the private HOME. Probe launches keep
   * these separate from their deliberately tiny child environment. */
  stateSourceEnv?: NodeJS.ProcessEnv
  hostEnv?: NodeJS.ProcessEnv
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
  /** Daemon-private roots every untrusted bwrap child must see as empty. */
  maskedReadRoots?: string[]
}): PreparedRuntimeLaunch {
  if ((opts.maskedReadRoots?.length ?? 0) > 0 && (!opts.runInSandbox || opts.sandboxMechanism !== 'bwrap')) {
    throw new Error('daemon-private read roots can only be masked by an enforced bwrap launch')
  }
  if (!opts.runInSandbox && !opts.isolateHome) {
    return { env: opts.explicitEnv ?? {}, inheritProcessEnv: true }
  }
  if (opts.runInSandbox && !opts.sandboxMechanism) {
    throw new Error('OS sandbox requested but this host has no supported Linux SRT/bwrap mechanism')
  }

  const stateSourceEnv = opts.stateSourceEnv ?? opts.hostEnv ?? process.env
  const runtimeHome = prepareRuntimeHome(opts.runtimeId, opts.scopeDir, stateSourceEnv)
  const env = runtimeHomeEnvironment(opts.runtimeId, runtimeHome, opts.explicitEnv, opts.hostEnv)

  if (!opts.runInSandbox) {
    return { env, inheritProcessEnv: false, runtimeHome }
  }

  const boundary = sandboxBoundary({
    agentDir: opts.scopeDir,
    cwd: opts.cwd,
    runtimeHome,
    mcpSocketPath: opts.mcpSocketPath
  })
  // SRT write roots (and delegated bwrap bind sources) must exist before spawn.
  // This also initializes workspace/memory for a newly-created agent.
  for (const path of boundary.writable) mkdirSync(path, { recursive: true })
  const settingsPath = writeSandboxSettings(opts.scopeDir, {
    writable: boundary.writable,
    // The reviewed runtime state was copied into the private HOME above. Hide
    // its host source so the child cannot bypass isolation or read later edits.
    denyRead: [
      ...boundary.denyRead,
      ...(opts.maskedReadRoots ?? []),
      ...runtimeStateLocations(opts.runtimeId, stateSourceEnv).map((location) => location.source)
    ],
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
      ...(opts.maskedReadRoots?.length ? { maskedReadRoots: opts.maskedReadRoots } : {})
    }
  }
}

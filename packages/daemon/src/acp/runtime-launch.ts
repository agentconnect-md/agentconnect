import { mkdirSync } from 'node:fs'
import { sandboxBoundary, type SandboxMechanism } from './sandbox.js'
import { prepareRuntimeHome, runtimeHomeEnvironment } from '../runtimes/runtime-home.js'

export interface PreparedRuntimeLaunch {
  env: Record<string, string>
  /** Sandboxed launches carry a sanitized environment; unsandboxed launches inherit the daemon environment. */
  inheritProcessEnv: boolean
  runtimeHome?: string
  sandbox?: { mechanism: SandboxMechanism; writable: string[] }
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
}): PreparedRuntimeLaunch {
  if (!opts.runInSandbox && !opts.isolateHome) {
    return { env: opts.explicitEnv ?? {}, inheritProcessEnv: true }
  }
  if (opts.runInSandbox && !opts.sandboxMechanism) {
    throw new Error('OS sandbox requested but this host has no bwrap/sandbox-exec')
  }

  const runtimeHome = prepareRuntimeHome(opts.runtimeId, opts.scopeDir, opts.stateSourceEnv ?? opts.hostEnv)
  const env = runtimeHomeEnvironment(opts.runtimeId, runtimeHome, opts.explicitEnv, opts.hostEnv)

  if (!opts.runInSandbox) {
    return { env, inheritProcessEnv: false, runtimeHome }
  }

  const { writable } = sandboxBoundary({
    agentDir: opts.scopeDir,
    cwd: opts.cwd,
    runtimeHome,
    mcpSocketPath: opts.mcpSocketPath
  })
  // Bubblewrap bind sources must exist before spawn. This also initializes the
  // workspace/memory directories for a newly-created agent.
  for (const path of writable) mkdirSync(path, { recursive: true })
  return {
    env,
    inheritProcessEnv: false,
    runtimeHome,
    sandbox: { mechanism: opts.sandboxMechanism!, writable }
  }
}

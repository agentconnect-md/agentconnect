import { materializeConfigFiles, type MaterializeResult } from '../shim/config-file-env.js'
import { composeRuntimeLaunch, type ComposedRuntimeLaunch } from './compose.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import type { HostKey } from '../acp/host-key.js'
import type { MemoryProviderKind } from '../memory/provider.js'
import type { RuntimeDef } from '../config/config-schema.js'

/** Config-file materialization result plus the pre-strip env it was planned from
 * (the daemon snapshots that env so an idle sweep can re-write the files later). */
export interface AssembledConfigFiles extends MaterializeResult {
  sourceEnv: Record<string, string>
}

export interface AssembledRuntimeLaunch extends ComposedRuntimeLaunch {
  /** The merged env handed to the launch (`runtimeEnv` under `agentEnv`), after materialization. */
  launchEnv: Record<string, string>
  /** Undefined when `configFileDir` was omitted, i.e. materialization was skipped. */
  configFiles?: AssembledConfigFiles
}

/** Every parameter a launch site may vary. Optional fields are declared here so
 * that a caller omitting one is a visible choice rather than invisible drift. */
export interface AssembleRuntimeLaunchOptions {
  runtimeId: string
  runtime: RuntimeDef
  provider: MemoryProviderKind
  scopeDir: string
  cwd: string
  /** The host this launch builds; keys its sandbox policy directory under the agent dir. */
  hostKey: HostKey
  runInSandbox: boolean
  daemonRoot?: string
  agentsRoot?: string
  /** Runtime-def env; config-file data vars are stripped from it in place. */
  runtimeEnv: Record<string, string>
  /** Agent/session env; config-file pointer vars are merged into it in place. */
  agentEnv: Record<string, string>
  /** Agent dir receiving materialized config-file secrets; omit to skip materialization. */
  configFileDir?: string
  /** Last mutation of the merged launch env before read roots and compose (k8s model credentials). */
  finalizeLaunchEnv?: (launchEnv: Record<string, string>) => void
  /** Daemon-owned code/socket/config carve-backs; a function receives the final launch env. */
  runtimeReadRoots?: string[] | ((launchEnv: Record<string, string>) => string[] | undefined)
  trustedWorkspaceWriteRoots?: string[]
  trustedPrimaryCheckout?: string
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
  allowModelToolUnixSockets?: boolean
  isolateHome?: boolean
  stateSourceEnv?: NodeJS.ProcessEnv
  hostEnv?: NodeJS.ProcessEnv
  k8s?: boolean
  hostPackageCache?: boolean
}

/**
 * The single launch-assembly entry: materialize config-file secrets, merge the
 * resulting child env, then compose the runtime launch from it.
 *
 * Config-file secrets (shim/config-file-env.ts) materialize `*_DATA` contents
 * under the agent dir and point the tool-native env vars (KUBECONFIG /
 * DOCKER_CONFIG) at the result; the raw values are stripped from the child env.
 * Detection spans the runtime-def env too, so an explicit pointer var configured
 * anywhere wins and skips materialization.
 */
export function assembleRuntimeLaunch(opts: AssembleRuntimeLaunchOptions): AssembledRuntimeLaunch {
  let configFiles: AssembledConfigFiles | undefined
  if (opts.configFileDir !== undefined) {
    const sourceEnv = { ...opts.runtimeEnv, ...opts.agentEnv }
    const materialized = materializeConfigFiles(opts.configFileDir, sourceEnv)
    for (const name of materialized.strip) {
      delete opts.agentEnv[name]
      delete opts.runtimeEnv[name]
    }
    Object.assign(opts.agentEnv, materialized.env)
    configFiles = { ...materialized, sourceEnv }
  }

  const launchEnv = { ...opts.runtimeEnv, ...opts.agentEnv }
  opts.finalizeLaunchEnv?.(launchEnv)
  const runtimeReadRoots =
    typeof opts.runtimeReadRoots === 'function' ? opts.runtimeReadRoots(launchEnv) : opts.runtimeReadRoots

  const composed = composeRuntimeLaunch({
    runtimeId: opts.runtimeId,
    runtime: opts.runtime,
    provider: opts.provider,
    scopeDir: opts.scopeDir,
    cwd: opts.cwd,
    hostKey: opts.hostKey,
    runInSandbox: opts.runInSandbox,
    daemonRoot: opts.daemonRoot,
    agentsRoot: opts.agentsRoot,
    explicitEnv: launchEnv,
    runtimeReadRoots,
    trustedWorkspaceWriteRoots: opts.trustedWorkspaceWriteRoots,
    trustedPrimaryCheckout: opts.trustedPrimaryCheckout,
    sandboxMechanism: opts.sandboxMechanism,
    mcpSocketPath: opts.mcpSocketPath,
    allowModelToolUnixSockets: opts.allowModelToolUnixSockets,
    isolateHome: opts.isolateHome,
    stateSourceEnv: opts.stateSourceEnv,
    hostEnv: opts.hostEnv,
    ...(opts.k8s ? { k8s: true as const } : {}),
    ...(opts.hostPackageCache ? { hostPackageCache: true as const } : {})
  })
  return { ...composed, launchEnv, ...(configFiles ? { configFiles } : {}) }
}

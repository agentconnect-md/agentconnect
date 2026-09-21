import { configFilesForLaunch, materializeConfigFiles, type MaterializeResult } from '../shim/config-file-env.js'
import type { SpawnFile } from '../acp/spawn-driver.js'
import { composeRuntimeLaunch, type ComposedRuntimeLaunch } from './compose.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import type { HostKey } from '../acp/host-key.js'
import type { MemoryProviderKind } from '../memory/provider.js'
import type { RuntimeDef, SandboxMount } from '../config/config-schema.js'

/** The config-file plan plus the pre-strip env it came from, which the idle sweep re-materializes this disk's files from. */
export interface AssembledConfigFiles extends MaterializeResult {
  sourceEnv: Record<string, string>
  /** Set for a runtime on another filesystem: what its launch writes there and the directory it empties first; nothing was written here. */
  launch?: { dir: string; files: SpawnFile[] }
}

export interface AssembledRuntimeLaunch extends ComposedRuntimeLaunch {
  /** The merged env handed to the launch (`runtimeEnv` under `agentEnv`), after materialization. */
  launchEnv: Record<string, string>
  /** Undefined when neither `configFileDir` nor `configFileLaunchDir` was given, i.e. config files were skipped. */
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
  /** Instead of `configFileDir`: a directory in the runtime's own filesystem (a pool pod, another machine), written by the launch's driver. */
  configFileLaunchDir?: string
  /** Last mutation of the merged launch env before read roots and compose (k8s model credentials). */
  finalizeLaunchEnv?: (launchEnv: Record<string, string>) => void
  /** Daemon-owned code/socket/config carve-backs; a function receives the final launch env. */
  runtimeReadRoots?: string[] | ((launchEnv: Record<string, string>) => string[] | undefined)
  /** Operator-declared writable `sandbox.mounts`, already normalized. */
  runtimeWriteRoots?: string[]
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
  microsandbox?: {
    mounts: SandboxMount[]
    trustedSessionDir?: string
    trustedMounts?: SandboxMount[]
  }
  /** A session placed on another machine: its HOME in that machine's coordinates. */
  executor?: { home: string }
  /** A session whose clones are off this disk: their `.git` where they are (see prepareRuntimeLaunch). */
  sessionGitDirs?: string[]
}

/** The single launch-assembly entry: turn `*_DATA` secrets (from either env, so an explicit pointer anywhere wins) into files and pointers, merge the child env, then compose the launch. */
export function assembleRuntimeLaunch(opts: AssembleRuntimeLaunchOptions): AssembledRuntimeLaunch {
  let configFiles: AssembledConfigFiles | undefined
  if (opts.configFileDir !== undefined || opts.configFileLaunchDir !== undefined) {
    const sourceEnv = { ...opts.runtimeEnv, ...opts.agentEnv }
    const carried =
      opts.configFileLaunchDir === undefined ? undefined : configFilesForLaunch(opts.configFileLaunchDir, sourceEnv)
    const { env, strip, notices } = carried ?? materializeConfigFiles(opts.configFileDir!, sourceEnv)
    for (const name of strip) {
      delete opts.agentEnv[name]
      delete opts.runtimeEnv[name]
    }
    Object.assign(opts.agentEnv, env)
    configFiles = {
      env,
      strip,
      notices,
      sourceEnv,
      ...(carried ? { launch: { dir: carried.dir, files: carried.files } } : {})
    }
  }

  const launchEnv = { ...opts.runtimeEnv, ...opts.agentEnv }
  opts.finalizeLaunchEnv?.(launchEnv)
  const runtimeReadRoots =
    typeof opts.runtimeReadRoots === 'function' ? opts.runtimeReadRoots(launchEnv) : opts.runtimeReadRoots

  const composed = composeRuntimeLaunch({
    ...(opts.microsandbox ? { microsandbox: opts.microsandbox } : {}),
    ...(opts.executor ? { executor: opts.executor } : {}),
    ...(opts.sessionGitDirs ? { sessionGitDirs: opts.sessionGitDirs } : {}),
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
    runtimeWriteRoots: opts.runtimeWriteRoots,
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

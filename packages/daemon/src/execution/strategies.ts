import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Logger } from '../log.js'
import { hostShimUnavailableReason, startHostShim, type HostShim, type HostShimInput } from './host-shim.js'

/** The v1 execution strategies of session-executors.md §5; `srt` and `docker` come later. */
export type ExecutionStrategy = 'host' | 'microsandbox'

export const EXECUTION_STRATEGIES: readonly ExecutionStrategy[] = ['host', 'microsandbox']

export type StrategyAvailability = { available: true } | { available: false; reason: string }

/** The EFFECTIVE table: what this machine can run now, each entry with the reason it cannot. The executor facet reports its own reading of it at registration. */
export function effectiveStrategies(input: {
  platform?: NodeJS.Platform
  /** The existing sandbox probe: whether microsandbox is the configured backend, and why it is down when it is. */
  microsandbox: { configured: boolean; unavailable?: string }
}): Record<ExecutionStrategy, StrategyAvailability> {
  const host = hostShimUnavailableReason(input.platform ?? process.platform)
  const microsandbox = !input.microsandbox.configured
    ? 'microsandbox is not the configured sandbox backend'
    : input.microsandbox.unavailable
  return {
    host: host ? { available: false, reason: host } : { available: true },
    microsandbox: microsandbox ? { available: false, reason: microsandbox } : { available: true }
  }
}

/** One session's environment on this machine, as the strategy that started it hands it over. */
export interface SessionEnvironment {
  /** Opens the shim; the facet's pipe hands an admitted dial to it and parses nothing (§6). */
  connect: () => Duplex | Promise<Duplex>
  /** Where the shim binds its tunnel sockets and writes its Git config, which the `prepare` reply names (§5). */
  runtimeRoot: string
  /** Where this executor's helper entries live; absent ⇒ the image's own layout, which is a VM's case (§5). */
  helperRoot?: string
  /** `shimPaths` keys this environment has nothing at, so a holder must not configure them. */
  missingHelpers: string[]
  exited: Promise<unknown>
  /** Stop the shim and free the slot; the session's directory and the applied generation stay (§7). */
  stop(): Promise<void>
}

/** What seeding a session HOME left pointing at this machine (§8): the env a runtime is pointed at, and the sign-in files and directories the HOME names or links to. */
export interface SessionSeed {
  env: Record<string, string>
  /** Paths on this machine: a host process already sees them, a VM must be given them. */
  paths: string[]
}

/** How one strategy gives a session leaf an environment: everything above this is strategy-agnostic (§5). */
export interface StrategyLauncher {
  start(input: {
    daemonRoot: string
    sessionLeaf: string
    log: Logger
    seed?: SessionSeed
  }): Promise<SessionEnvironment>
  /** Remove what the strategy owns beyond the session's directory — a VM and its disks; `host` owns nothing that outlives its shim. */
  discard?(sessionLeaf: string): Promise<void>
}

/** The `host` strategy (§5): the shim as a plain child of this daemon, reached over the unix socket inside its private runtime root. */
export function hostLauncher(start: (input: HostShimInput) => Promise<HostShim> = startHostShim): StrategyLauncher {
  return {
    start: async ({ seed, ...input }) => {
      // A host shim shares this machine's filesystem, so the seed's pointers are all it needs.
      const shim = await start({ ...input, ...(seed ? { seedEnv: seed.env } : {}) })
      return {
        connect: () => connect(shim.socketPath),
        runtimeRoot: shim.runtimeRoot,
        helperRoot: shim.helperRoot,
        missingHelpers: shim.missingHelpers,
        exited: shim.exited,
        stop: () => shim.stop()
      }
    }
  }
}

import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import type { MicrosandboxSecret } from '../microsandbox/secrets.js'
import { hostShimUnavailableReason, startHostShim, type HostShim, type HostShimInput } from './host-shim.js'

/** The strategies the executor facet can prepare (session-executors.md §5); `srt` joins with R1 and `docker` later. */
export type ExecutionStrategy = 'host' | 'microsandbox'

export const EXECUTION_STRATEGIES: readonly ExecutionStrategy[] = ['host', 'microsandbox']

/** The strategies this machine runs its own sessions in: the `sandbox` table's keys (§5). */
export type SandboxStrategy = 'host' | 'srt' | 'microsandbox'

export const SANDBOX_STRATEGIES: readonly SandboxStrategy[] = ['host', 'srt', 'microsandbox']

export type StrategyAvailability = { available: true } | { available: false; reason: string }

export type StrategyTable = Record<SandboxStrategy, StrategyAvailability>

/** The strategy an agent's sessions run in (§5): its `execution`, or for one the Control Plane has not migrated, `runInSandbox` read as the migration will read it. */
export function agentStrategyOf(
  agent: { execution?: string; runInSandbox?: boolean },
  legacyBackend: 'srt' | 'microsandbox' | undefined
): string {
  if (agent.execution) return agent.execution
  return agent.runInSandbox ? (legacyBackend ?? 'srt') : 'host'
}

/** Whether a slug names one of this machine's strategies. */
export function isSandboxStrategy(name: string | undefined): name is SandboxStrategy {
  return SANDBOX_STRATEGIES.includes(name as SandboxStrategy)
}

/** The machine's own EFFECTIVE table (§5): configured is what it offers, and a probe's reason is why an offered sandbox cannot run; `host` is the direct child, available on every platform. */
export function machineStrategies(input: {
  offered: Record<SandboxStrategy, boolean>
  /** Why a probe failed; absent ⇒ it passed. */
  unavailable: Partial<Record<Exclude<SandboxStrategy, 'host'>, string>>
}): StrategyTable {
  const entry = (strategy: SandboxStrategy): StrategyAvailability => {
    if (!input.offered[strategy]) return { available: false, reason: `sandbox.${strategy} is off on this daemon` }
    const reason = strategy === 'host' ? undefined : input.unavailable[strategy]
    return reason ? { available: false, reason } : { available: true }
  }
  return { host: entry('host'), srt: entry('srt'), microsandbox: entry('microsandbox') }
}

/** Refuse a start whose table has nothing available, which keeps today's fail-closed rule (§5). */
export function assertSomeStrategyAvailable(table: StrategyTable): void {
  if (SANDBOX_STRATEGIES.some((strategy) => table[strategy].available)) return
  const why = SANDBOX_STRATEGIES.map((strategy) => `${strategy}: ${strategyReason(table[strategy])}`).join('; ')
  throw new Error(`daemon startup refused: no execution strategy can run on this machine (${why})`)
}

/** The table the executor facet reports to other members (§5): the machine's own, with `host` Linux-only. */
export function effectiveStrategies(input: {
  platform?: NodeJS.Platform
  table: StrategyTable
}): Record<ExecutionStrategy, StrategyAvailability> {
  const hostShim = hostShimUnavailableReason(input.platform ?? process.platform)
  return {
    host: hostShim && input.table.host.available ? { available: false, reason: hostShim } : input.table.host,
    microsandbox: input.table.microsandbox
  }
}

export function strategyReason(entry: StrategyAvailability): string {
  return entry.available ? 'available' : entry.reason
}

/** A session whose strategy this machine cannot run: refused with the probe's reason, never started in a weaker boundary (§5). */
export class StrategyUnavailableError extends Error {
  constructor(
    readonly agentId: string,
    readonly strategy: string,
    readonly reason: string
  ) {
    super(`agent "${agentId}" runs its sessions in the ${strategy} strategy, which this daemon cannot run: ${reason}`)
    this.name = 'StrategyUnavailableError'
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
  /** What the in-process entry needs of an environment this machine drives itself (§11 step 4); absent on a hosted one. */
  local?: LocalSessionEnvironment
}

/** A local environment as its own daemon drives it: the shim's identity to compare, and what a remote holder has no use for. */
export interface LocalSessionEnvironment {
  /** The one-time token the shim presents, compared on every dial: a local dial crosses no pipe that could prove it. */
  identity: string
  /** What every runtime starts from beneath its launch's env, which a complete-env shim takes as all there is. */
  runtimeEnv: Record<string, string>
  /** Drop the runtime stderr the shim relays until the returned release, for a launch that asked for silence. */
  quiet(): () => void
  /** Fence the environment: it stops with what runs in it, and its next use starts it again. */
  fail(): void
}

/** What seeding a session HOME left pointing at this machine (§8): the env a runtime is pointed at, and the sign-in files and directories the HOME names or links to. */
export interface SessionSeed {
  env: Record<string, string>
  /** Paths on this machine: a host process already sees them, a VM must be given them. */
  paths: string[]
  /** The placeholder substitutions a VM fixes when it starts, for values its HOME holds placeholders of (§8). */
  secrets?: MicrosandboxSecret[]
}

/** The environment a launcher starts (§11 step 3): built from a leaf by the facet, or by the local placement rule for this machine's own sessions. */
export interface EnvironmentDescriptor {
  /** `executor/<leaf>` hosted, `<agentId>/…` local: two spaces that cannot collide, and neither changes. */
  id: string
  /** The directory the environment's durable state lives under. */
  workspaceRoot: string
  mounts: SandboxMount[]
  secrets?: MicrosandboxSecret[]
  /** A session this machine hosts for another member: its shim bound by that member through the executor's pipe (§6), and started with what the HOME seed points a runtime at. Absent on every local environment. */
  hosted?: { env: Record<string, string> }
}

/** How one strategy starts an environment it is handed: everything above this is strategy-agnostic (§5). */
export interface StrategyLauncher {
  /** Seeds a session HOME itself, with protections the facet's plain seed lacks (a VM's placeholders, §8), in place of that seed; whatever it must be ready for first is its own to await. */
  seedHome?(home: string, log: Logger): Promise<SessionSeed>
  start(input: { environment: EnvironmentDescriptor; log: Logger }): Promise<SessionEnvironment>
  /** Remove what the strategy owns beyond the environment's directory — a VM and its disks — by the environment's id; `host` owns nothing that outlives its shim. */
  discard?(id: string): Promise<void>
  /** Hold a local environment against its owner's idle stop until the returned release; absent where nothing on this machine judges idleness but the facet's linger. */
  hold?(environment: EnvironmentDescriptor): () => void
  /** Whether two descriptors start the same environment, by the strategy's own rule; absent ⇒ one id is one environment. */
  sameEnvironment?(a: EnvironmentDescriptor, b: EnvironmentDescriptor): boolean
}

/** The `host` strategy (§5): the shim as a plain child of this daemon, reached over the unix socket inside its private runtime root under `daemonRoot`. */
export function hostLauncher(
  daemonRoot: string,
  start: (input: HostShimInput) => Promise<HostShim> = startHostShim
): StrategyLauncher {
  return {
    start: async ({ environment, log }) => {
      // A host shim shares this machine's filesystem, so the workspace root and the seed's pointers are all it needs.
      const shim = await start({
        daemonRoot,
        workspaceRoot: environment.workspaceRoot,
        log,
        ...(environment.hosted ? { seedEnv: environment.hosted.env } : {})
      })
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

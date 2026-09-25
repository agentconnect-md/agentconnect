// The `srt` strategy's launcher (session-executors.md §5, §11): SRT around the shim, for an environment this machine hosts for another member and for this machine's own confined sessions, which `LocalExecutor` drives under the daemon's session idle policy.
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { basename, join, relative } from 'node:path'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import { localWorkspaceFs, RoutedWorkspaceFs, type WorkspaceFs } from '../workspace/workspace-fs.js'
import { startHostShim, type HostShim, type HostShimInput } from './host-shim.js'
import { srtShimBoundary } from './srt-shim.js'
import type { EnvironmentDescriptor, SessionEnvironment, StrategyLauncher } from './strategies.js'

/** A confined session's environment id: `<agentId>/session-<leaf>`, named by its session directory. */
export function localSrtEnvironmentId(agentId: string, sessionDir: string): string {
  return `${agentId}/${basename(sessionDir)}`
}

/** A local environment's fixed runtime-root leaf: its launch names the shim's tunnel sockets before the shim starts. */
export function localSrtRootName(environmentId: string): string {
  return createHash('sha256').update(`srt:${environmentId}`).digest('hex').slice(0, 12)
}

/** Where a local environment's shim binds its sockets and SRT its temp root: `<daemonRoot>/hs/<leaf>`. */
export function localSrtRuntimeRoot(daemonRoot: string, environmentId: string): string {
  return join(daemonRoot, 'hs', localSrtRootName(environmentId))
}

/** The launcher, and the lifecycle of the shims it starts for this machine's own environments. */
export interface SrtLauncher extends StrategyLauncher {
  /** Stop each local environment nothing holds and nothing has used since `before`. */
  suspendIdle(before: number): Promise<void>
  /** Stop a local environment its host left, unless something still holds it; says whether it stopped. */
  stopUnlessBusy(id: string): Promise<boolean>
  /** Stop every local environment whose id matches, draining what runs in it; a next use starts it again. */
  stopMatching(matches: (id: string) => boolean): Promise<void>
  stopAll(): Promise<void>
}

interface Running {
  environment: EnvironmentDescriptor
  shim: HostShim
  startedAt: number
}

/** Holds on an environment id, counted from before its shim starts: the entry holds a launch first and starts it after. */
interface Usage {
  holds: number
  lastUsed: number
}

const mountKey = (mount: SandboxMount): string => JSON.stringify([mount.source, mount.target])

/** Whether a running environment's policy already grants every mount a request names: the policy is fixed when the boundary starts. */
function grants(running: EnvironmentDescriptor, requested: EnvironmentDescriptor): boolean {
  if (running.id !== requested.id || running.workspaceRoot !== requested.workspaceRoot) return false
  const granted = new Map(running.mounts.map((mount) => [mountKey(mount), mount.mode]))
  return requested.mounts.every((mount) => {
    const mode = granted.get(mountKey(mount))
    return mode === mount.mode || (mode === 'writable' && mount.mode === 'readonly')
  })
}

/** SRT around the shim (§5). A hosted environment gets a random runtime root and its holder's seed; a local one a root fixed by its id, the complete-env flag and its token compared in process (§11). */
export function srtLauncher(
  daemonRoot: string,
  deps: {
    /** This machine's agents directory, hidden from every environment like the daemon root. */
    agentsRoot?: string
    /** The code the shim and its runtimes read beyond what each environment mounts: node, the runtime installs and this daemon's helpers. */
    readRoots: () => string[]
    now?: () => number
    hostEnv?: NodeJS.ProcessEnv
  },
  start: (input: HostShimInput) => Promise<HostShim> = startHostShim
): SrtLauncher {
  const now = deps.now ?? Date.now
  const running = new Map<string, Running>()
  const usage = new Map<string, Usage>()

  const boundary = (environment: EnvironmentDescriptor, log: Logger) =>
    srtShimBoundary({
      daemonRoot,
      ...(deps.agentsRoot ? { agentsRoot: deps.agentsRoot } : {}),
      mounts: environment.mounts,
      readRoots: deps.readRoots(),
      ...(deps.hostEnv ? { hostEnv: deps.hostEnv } : {}),
      log
    })
  const stopMatching = async (matches: (id: string) => boolean): Promise<void> => {
    const stopping = [...running.entries()].filter(([id]) => matches(id)).map(([, state]) => state.shim.stop())
    await Promise.allSettled(stopping)
  }
  const held = (id: string): boolean => (usage.get(id)?.holds ?? 0) > 0
  const forgetIdleUsage = (id: string): void => {
    if (!held(id) && !running.has(id)) usage.delete(id)
  }
  const environmentOf = (shim: HostShim): SessionEnvironment => ({
    connect: () => connect(shim.socketPath),
    runtimeRoot: shim.runtimeRoot,
    helperRoot: shim.helperRoot,
    missingHelpers: shim.missingHelpers,
    exited: shim.exited,
    stop: () => shim.stop()
  })

  return {
    start: async ({ environment, log }: { environment: EnvironmentDescriptor; log: Logger }) => {
      // A hosted environment's lifecycle is the executor facet's: its linger, release and backstop (§7).
      if (environment.hosted) {
        const shim = await start({
          daemonRoot,
          workspaceRoot: environment.workspaceRoot,
          log,
          seedEnv: environment.hosted.env,
          boundary: boundary(environment, log)
        })
        return environmentOf(shim)
      }
      // The entry starts an id again only once nothing holds its old launch: a changed descriptor, or a shim it gave up on, still owns the fixed root.
      await running.get(environment.id)?.shim.stop()
      const shim = await start({
        daemonRoot,
        workspaceRoot: environment.workspaceRoot,
        log,
        runtimeRootName: localSrtRootName(environment.id),
        completeEnv: true,
        boundary: boundary(environment, log)
      })
      const state: Running = { environment, shim, startedAt: now() }
      running.set(environment.id, state)
      void shim.exited.then(() => {
        if (running.get(environment.id) === state) running.delete(environment.id)
        forgetIdleUsage(environment.id)
      })
      return {
        ...environmentOf(shim),
        // The launch env is this daemon's whole composition, so the shim adds nothing beneath it.
        local: { identity: shim.token, runtimeEnv: {}, quiet: () => shim.quiet(), fail: () => void shim.stop() }
      }
    },
    hold: (environment) => {
      const id = environment.id
      const entry = usage.get(id) ?? { holds: 0, lastUsed: now() }
      usage.set(id, entry)
      entry.holds += 1
      entry.lastUsed = now()
      let released = false
      return () => {
        if (released) return
        released = true
        entry.holds -= 1
        entry.lastUsed = now()
        forgetIdleUsage(id)
      }
    },
    // A request the running boundary already grants — the Git of a session whose runtime is up — reuses it; anything more is another environment.
    sameEnvironment: (current, requested) => grants(current, requested),
    suspendIdle: async (before) => {
      const idle = [...running.entries()].filter(
        ([id, state]) => !held(id) && Math.max(state.startedAt, usage.get(id)?.lastUsed ?? 0) <= before
      )
      await Promise.allSettled(idle.map(([, state]) => state.shim.stop()))
    },
    stopUnlessBusy: async (id) => {
      const state = running.get(id)
      if (!state) return true
      if (held(id)) return false
      await state.shim.stop()
      return true
    },
    stopMatching,
    stopAll: () => stopMatching(() => true)
  }
}

/** The environment whose directory holds `path` strictly inside it: its shim reaches neither its own root nor anything outside. */
function insideEnvironment(
  environmentAt: (path: string) => EnvironmentDescriptor | undefined,
  path: string
): EnvironmentDescriptor | undefined {
  const environment = environmentAt(path)
  return environment && relative(environment.workspaceRoot, path) !== '' ? environment : undefined
}

/** A confined session's files through its shim, and everything else — the session directory itself included — on this disk. */
export class SrtWorkspaceFs extends RoutedWorkspaceFs {
  constructor(
    private readonly environmentAt: (path: string) => EnvironmentDescriptor | undefined,
    private readonly fsOf: (environment: EnvironmentDescriptor) => WorkspaceFs
  ) {
    super(async (path) => {
      const environment = insideEnvironment(environmentAt, path)
      return environment ? fsOf(environment) : localWorkspaceFs
    })
  }

  override async rename(from: string, to: string): Promise<void> {
    // A move across the session directory's edge is this disk's.
    const environment = insideEnvironment(this.environmentAt, from)
    const same = environment !== undefined && insideEnvironment(this.environmentAt, to)?.id === environment.id
    return (same ? this.fsOf(environment) : localWorkspaceFs).rename(from, to)
  }
}

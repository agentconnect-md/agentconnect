// This machine's own srt environments (session-executors.md §11): the srt launcher's local mode, which `LocalExecutor` drives; the daemon's session idle policy is their idle judge, as it is a local VM's.
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { basename, join } from 'node:path'
import type { SandboxMount } from '../config/config-schema.js'
import type { Logger } from '../log.js'
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

export interface LocalSrtLauncher extends StrategyLauncher {
  /** Stop each environment nothing holds and nothing has used since `before`. */
  suspendIdle(before: number): Promise<void>
  /** Stop an environment its host left, unless something still holds it; says whether it stopped. */
  stopUnlessBusy(id: string): Promise<boolean>
  /** Stop every environment whose id matches, draining what runs in it; a next use starts it again. */
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

const mountKey = (mounts: SandboxMount[]): string =>
  JSON.stringify(mounts.map((mount) => [mount.source, mount.target, mount.mode]).sort())

/** The local srt launcher: one SRT-wrapped shim per environment, started with this daemon's complete launch env and bound in process. */
export function localSrtLauncher(deps: {
  daemonRoot: string
  agentsRoot?: string
  /** The code the shim and its runtimes read beyond what each launch mounts: node and this machine's runtime installs. */
  readRoots: () => string[]
  now?: () => number
  hostEnv?: NodeJS.ProcessEnv
  /** Test seam: how the shim starts. */
  start?: (input: HostShimInput) => Promise<HostShim>
}): LocalSrtLauncher {
  const now = deps.now ?? Date.now
  const start = deps.start ?? startHostShim
  const running = new Map<string, Running>()
  const usage = new Map<string, Usage>()

  const stopMatching = async (matches: (id: string) => boolean): Promise<void> => {
    const stopping = [...running.entries()].filter(([id]) => matches(id)).map(([, state]) => state.shim.stop())
    await Promise.allSettled(stopping)
  }
  const held = (id: string): boolean => (usage.get(id)?.holds ?? 0) > 0
  const forgetIdleUsage = (id: string): void => {
    if (!held(id) && !running.has(id)) usage.delete(id)
  }

  return {
    start: async ({ environment, log }: { environment: EnvironmentDescriptor; log: Logger }) => {
      // The entry starts an id again only once nothing holds its old launch: a changed descriptor, or a shim it gave up on, still owns the fixed root.
      await running.get(environment.id)?.shim.stop()
      const shim = await start({
        daemonRoot: deps.daemonRoot,
        workspaceRoot: environment.workspaceRoot,
        log,
        runtimeRootName: localSrtRootName(environment.id),
        completeEnv: true,
        boundary: srtShimBoundary({
          daemonRoot: deps.daemonRoot,
          ...(deps.agentsRoot ? { agentsRoot: deps.agentsRoot } : {}),
          mounts: environment.mounts,
          readRoots: deps.readRoots(),
          ...(deps.hostEnv ? { hostEnv: deps.hostEnv } : {}),
          log
        })
      })
      const state: Running = { environment, shim, startedAt: now() }
      running.set(environment.id, state)
      void shim.exited.then(() => {
        if (running.get(environment.id) === state) running.delete(environment.id)
        forgetIdleUsage(environment.id)
      })
      const started: SessionEnvironment = {
        connect: () => connect(shim.socketPath),
        runtimeRoot: shim.runtimeRoot,
        helperRoot: shim.helperRoot,
        missingHelpers: shim.missingHelpers,
        exited: shim.exited,
        stop: () => shim.stop(),
        // The launch env is this daemon's whole composition, so the shim adds nothing beneath it.
        local: { identity: shim.token, runtimeEnv: {}, quiet: () => shim.quiet(), fail: () => void shim.stop() }
      }
      return started
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
    // The policy is fixed when the boundary starts, so a descriptor that mounts anything else is another environment.
    sameEnvironment: (a, b) =>
      a.id === b.id && a.workspaceRoot === b.workspaceRoot && mountKey(a.mounts) === mountKey(b.mounts),
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

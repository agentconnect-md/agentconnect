import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../log.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import type { AcpProbeClient } from '../acp/probe-client.js'
import {
  preparedProbeLaunch,
  probeCallbacks,
  type ProbeHostFactory,
  type ProbeHostPolicy,
  type ProbeLaunchPlan
} from './runtime-prober.js'
import { capsFromConfigOptions } from './config-caps.js'
import type { EnumerateFn } from './model-catalog.js'

/**
 * The real ACP per-model enumerator behind ModelCatalogService (design doc
 * runtime-model-catalog.md §3.2): one disposable session in an ISOLATED HOME,
 * serial `set_config_option` per model, each response's raw config options
 * distilled into that model's capability entry.
 *
 * Isolation is a hard precondition — some agents persist set values as the
 * user's defaults, so enumeration must never touch the real HOME. The launch
 * reuses the curated probe plan (`composeRuntimeLaunch` with a private seeded
 * HOME); when that plan can't be built the enumerator returns `undefined` and
 * the runtime keeps phase-1-only data.
 */
export interface ModelEnumeratorDeps {
  log?: Logger
  sandboxMechanism?: SandboxMechanism
  daemonRoot?: string
  agentsRoot?: string
  mcpSocketPath?: string
  /** Constructs the probe client — `defaultProbeHostFactory()` in production. */
  hostFactory: ProbeHostFactory
}

/** Kept short so restore-before-kill always fits inside the total budget. */
const RESTORE_GRACE_MS = 5_000

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

export function makeModelEnumerator(deps: ModelEnumeratorDeps): EnumerateFn {
  return async (runtimeId, rt, modelIds, budget) => {
    if (!deps.sandboxMechanism) {
      deps.log?.debug(`catalog: ${runtimeId} skipped because no supported OS sandbox is available`)
      return undefined
    }
    // Enumeration runs only under the OS sandbox; an externalExecution runtime
    // cannot be confined, so it keeps its probe-derived model list instead.
    if (rt.externalExecution) {
      deps.log?.debug(`catalog: ${runtimeId} skipped because its execution lives outside the OS sandbox`)
      return undefined
    }
    const scope = mkdtempSync(join(tmpdir(), 'ac-catalog-'))
    const cwd = join(scope, 'workspace')
    mkdirSync(cwd, { recursive: true })
    let host: AcpProbeClient | undefined
    try {
      let launch: ProbeLaunchPlan | undefined
      try {
        launch = preparedProbeLaunch(runtimeId, rt, cwd, {
          curated: true, // curated plan = isolated seeded HOME, even without an OS sandbox
          log: deps.log,
          hostEnv: process.env,
          runInSandbox: deps.sandboxMechanism !== undefined,
          daemonRoot: deps.daemonRoot,
          agentsRoot: deps.agentsRoot,
          sandboxMechanism: deps.sandboxMechanism,
          mcpSocketPath: deps.mcpSocketPath
        })
      } catch (err) {
        deps.log?.debug(`catalog: ${runtimeId} isolation unavailable, skipping enumeration: ${(err as Error).message}`)
        return undefined
      }
      if (!launch) return undefined

      const policy: ProbeHostPolicy = {
        ...probeCallbacks,
        env: launch.env,
        inheritProcessEnv: launch.inheritProcessEnv,
        ...(launch.sandbox ? { sandbox: launch.sandbox } : {})
      }
      const effectiveRuntime = launch.runtime ?? rt
      host = deps.hostFactory(effectiveRuntime, runtimeId, cwd, policy)
      const activeHost = host

      const deadline = Date.now() + budget.totalMs
      await withTimeout(activeHost.start(), budget.perModelMs, `${runtimeId} start`)
      const sid = await withTimeout(activeHost.newSession(cwd, []), budget.perModelMs, `${runtimeId} session/new`)
      const initial = activeHost.sessionConfigOptions?.(sid)
      if (!initial) return { models: [], aborted: 'runtime advertises no session config options' }
      const setSessionModel = activeHost.setSessionModel?.bind(activeHost)
      if (!setSessionModel) return { models: [], aborted: 'runtime cannot switch the session model' }
      const initialModel = capsFromConfigOptions(initial).currentModel

      const collected: Awaited<ReturnType<EnumerateFn>> & object = { models: [] }
      for (const id of modelIds) {
        if (id === 'default') continue // "no explicit model", not an enumerable entry
        if (Date.now() > deadline - RESTORE_GRACE_MS) {
          collected.aborted = 'total budget exhausted'
          break
        }
        try {
          await withTimeout(setSessionModel(sid, id), budget.perModelMs, `${runtimeId} set model ${id}`)
        } catch (err) {
          deps.log?.debug(`catalog: ${runtimeId} model "${id}" skipped: ${(err as Error).message}`)
          continue
        }
        const after = activeHost.sessionConfigOptions?.(sid)
        const caps = after ? capsFromConfigOptions(after) : undefined
        if (!caps || caps.currentModel !== id) {
          // The selector is advertised but the write path is a no-op (real
          // ecosystem behavior) — a response describing the OLD model would
          // poison every entry, so give up on enumeration entirely.
          collected.aborted = `set_config_option did not switch the model (asked "${id}", still "${caps?.currentModel ?? 'unknown'}")`
          break
        }
        // Deliberately NO defaultEffort here: after a model switch the effort
        // select's currentValue is carry-over session state (a supported level
        // survives the switch; verified against claude-agent-acp 0.59.0), not
        // the model's own default. Only phase 1 (fresh-session initial state)
        // and native drivers may claim a default.
        collected.models.push({
          id,
          ...(caps.modelName ? { name: caps.modelName } : {}),
          efforts: caps.efforts,
          fastMode: caps.fastMode
        })
      }

      // Restore the initial selection BEFORE teardown — second line of defense in
      // case home isolation was misconfigured; runs on the abort paths too.
      if (
        initialModel &&
        initialModel !== capsFromConfigOptions(activeHost.sessionConfigOptions?.(sid) ?? []).currentModel
      ) {
        await withTimeout(setSessionModel(sid, initialModel), RESTORE_GRACE_MS, `${runtimeId} restore model`).catch(
          (err) => deps.log?.debug(`catalog: ${runtimeId} restore selection failed: ${(err as Error).message}`)
        )
      }
      return collected
    } finally {
      await host?.stop().catch(() => {})
      try {
        rmSync(scope, { recursive: true, force: true })
      } catch {
        // best-effort cleanup — never mask the enumeration result
      }
    }
  }
}

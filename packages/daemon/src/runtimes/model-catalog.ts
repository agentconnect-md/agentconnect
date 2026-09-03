import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { EffortOption } from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import type { RuntimeCatalogMetaRecord, RuntimeModelCapRecord } from '../store/local-store.js'
import { curatedProbeEnvironment } from './runtime-prober.js'
import { resolveCommandPath } from './probe.js'

/**
 * Model-catalog discovery service (design doc runtime-model-catalog.md §3.1–§3.3a):
 * the driver registry (native one-shot catalogs), the discovery gate, and the
 * per-runtime scheduler (single-flight, generation fencing, exponential backoff,
 * budgets). The generic per-model ACP enumerator is injected as `EnumerateFn`
 * (model-enumerator.ts in prod, fakes in tests) — this module decides WHEN and
 * WITH WHAT to discover, persists results into the LocalStore cache tables, and
 * reports completion via `onUpdated` so the daemon can re-emit facts.
 *
 * Nothing here is on any hot path: `noteProbe` never throws and only awaits its gate read —
 * discovery runs as a fire-and-forget background task whose every cache write is
 * fenced by the runtime's current generation.
 */

/** The LocalStore surface the service writes through (structural — tests inject a fake). */
export interface CatalogStorePort {
  recordRuntimeCatalogMeta(meta: Omit<RuntimeCatalogMetaRecord, 'complete' | 'modelsHash'>): Promise<void>
  markRuntimeCatalogComplete(
    runtimeId: string,
    fingerprint: string,
    modelsHash: string,
    observedAt: number
  ): Promise<void>
  upsertRuntimeModelCap(rec: RuntimeModelCapRecord): Promise<void>
  pruneRuntimeModelCaps(runtimeId: string, keepModelIds: string[]): Promise<void>
  getRuntimeCatalogMeta(runtimeId: string): Promise<RuntimeCatalogMetaRecord | undefined>
  listRuntimeModelCaps(runtimeId?: string): Promise<RuntimeModelCapRecord[]>
}

/** One model's RAW advertised capabilities (cache shape — no daemon-synthesized tiers). */
export interface ModelCaps {
  name?: string
  description?: string
  efforts?: EffortOption[]
  defaultEffort?: string
  fastMode?: boolean
}

/** A driver's one-shot discovery result: the runtime's full catalog. */
export interface DriverCatalog {
  models: Array<{ id: string } & ModelCaps>
  defaultModel?: string
}

export interface DriverDiscoverOptions {
  timeoutMs: number
  /** Curated allowlist env ONLY (curatedProbeEnvironment) — a driver child never
   *  inherits the daemon's full environment. */
  env: Record<string, string>
  log?: Logger
  /** Service-side cancellation (stop() / fingerprint change) — built-in drivers
   *  kill their process tree on abort. */
  signal?: AbortSignal
}

export interface ModelCatalogDriver {
  /** Whether this driver owns the runtime's catalog discovery. Exact runtime-id
   *  match only — no fuzzy guessing (design §3.1). */
  supports(runtimeId: string): boolean
  /** One discovery task returning the full catalog; the driver spawns its own
   *  pure-discovery process (no prompts, no MCP) and kills it when done. */
  discover(runtimeId: string, rt: RuntimeDef, opts: DriverDiscoverOptions): Promise<DriverCatalog>
}

export interface EnumerateResult {
  models: Array<{ id: string } & ModelCaps>
  /** Set when enumeration gave up mid-run (budget exhausted, model switch no-op). */
  aborted?: string
}

/** The generic ACP per-model enumerator seam. `undefined` = enumeration is
 *  unavailable for this runtime (e.g. isolation impossible) — the caller keeps
 *  phase-1 data and records nothing. */
export type EnumerateFn = (
  runtimeId: string,
  rt: RuntimeDef,
  modelIds: string[],
  budget: { perModelMs: number; totalMs: number }
) => Promise<EnumerateResult | undefined>

/** Discovery-generation fingerprint (design §3.3a): runtime id + probed adapter
 *  version + a hash of the launch definition. Env contributes variable NAMES only —
 *  values may be credentials and the fingerprint lands in SQLite. */
export function catalogFingerprint(runtimeId: string, probedVersion: string | undefined, rt: RuntimeDef): string {
  const launch = createHash('sha256')
    .update(JSON.stringify([rt.command, rt.args, rt.env.map((e) => e.name).sort()]))
    .digest('hex')
  return `${runtimeId}\n${probedVersion ?? 'unknown'}\n${launch}`
}

/** Order/duplicate-insensitive hash of an advertised model-id set (gate rule 3). */
export function modelsHash(models: string[]): string {
  return createHash('sha256')
    .update([...new Set(models)].sort().join('\n'))
    .digest('hex')
}

/** Driver budget — same ceiling as a runtime probe. */
const DRIVER_TIMEOUT_MS = 30_000
/** Enumeration budgets (design §3.2): per-model set timeout / per-runtime total. */
const ENUMERATE_PER_MODEL_MS = 10_000
const ENUMERATE_TOTAL_MS = 120_000
/** Cap on ids handed to the enumerator — an incomplete matrix beats a runaway
 *  enumeration (multi-provider runtimes really do advertise dozens of models). */
const MAX_ENUMERATED_MODELS = 64
/** Gate rule 2 retry backoff: exponential from 30s, capped at 1h, per runtime. */
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 3_600_000
/** Gate rule 4: driver-built catalogs are re-discovered after this age — cheap,
 *  and it catches per-model capability drift the model-set diff can't see. */
const NATIVE_CATALOG_TTL_MS = 24 * 3_600_000

export interface ModelCatalogServiceDeps {
  store: CatalogStorePort
  log?: Logger
  /** Clock seam (backoff/TTL arithmetic + observedAt stamps). */
  now?: () => number
  /** Driver registry override — default is the built-in [codex, opencode, kilo]. */
  drivers?: ModelCatalogDriver[]
  /** The per-model ACP enumerator (daemon.ts provides the isolated-host one). */
  enumerate: EnumerateFn
  /** Driver child environment — default curatedProbeEnvironment(process.env). */
  driverEnv?: () => Record<string, string>
  /** Fires after the cache writes of a finished (or driver-completed) discovery. */
  onUpdated: (runtimeId: string) => Promise<void>
}

interface InflightTask {
  fingerprint: string
  generation: number
  controller: AbortController
}

interface BackoffState {
  fingerprint: string
  failures: number
  nextAttemptAt: number
}

export class ModelCatalogService {
  private readonly deps: ModelCatalogServiceDeps
  private readonly drivers: ModelCatalogDriver[]
  private readonly now: () => number
  private readonly driverEnv: () => Record<string, string>
  /** Current discovery generation per runtime — stale tasks compare against this
   *  before EVERY cache write and stop silently on a mismatch. */
  private readonly generations = new Map<string, number>()
  private readonly inflight = new Map<string, InflightTask>()
  private readonly backoff = new Map<string, BackoffState>()
  private stopped = false

  constructor(deps: ModelCatalogServiceDeps) {
    this.deps = deps
    this.drivers = deps.drivers ?? builtInCatalogDrivers()
    this.now = deps.now ?? Date.now
    this.driverEnv = deps.driverEnv ?? (() => curatedProbeEnvironment(process.env))
  }

  /** Called from the probe sweep fold for each successfully probed, admitted
   *  runtime. Evaluates the §3.3 discovery gate and (maybe) schedules a background
   *  discovery. Never throws, never blocks. */
  async noteProbe(input: {
    runtimeId: string
    rt: RuntimeDef
    probedVersion?: string
    models: string[]
  }): Promise<void> {
    try {
      if (this.stopped) return
      // No advertised models ⇒ nothing to discover (phase 1 owns runtime-level data).
      if (input.models.length === 0) return
      const fingerprint = catalogFingerprint(input.runtimeId, input.probedVersion, input.rt)

      const running = this.inflight.get(input.runtimeId)
      if (running) {
        // Per-RUNTIME single-flight: a same-fingerprint re-evaluation is a no-op;
        // a fingerprint change cancels the in-flight task (its remaining writes
        // turn stale) before the gate decides whether to start a replacement.
        if (running.fingerprint === fingerprint) return
        this.cancel(input.runtimeId)
      }

      // A fingerprint change is a new generation — retry bookkeeping starts fresh.
      const prevBackoff = this.backoff.get(input.runtimeId)
      if (prevBackoff && prevBackoff.fingerprint !== fingerprint) this.backoff.delete(input.runtimeId)

      const reason = await this.gateReason(input, fingerprint)
      if (!reason) return
      const wait = this.backoff.get(input.runtimeId)
      if (wait && this.now() < wait.nextAttemptAt) return
      this.start(input, fingerprint, reason)
    } catch (err) {
      this.deps.log?.warn(`catalog: ${input.runtimeId} gate evaluation failed: ${(err as Error).message}`)
    }
  }

  /** Cancel in-flight discoveries and kill driver child processes. Built-in
   *  drivers kill their process tree from the abort listener, so children die
   *  now; orphaned task promises settle on their own with every write dropped as
   *  stale. The enumerator has no cancellation channel (it tears its host down in
   *  its own finally), so shutdown deliberately does not block on it. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const [runtimeId, task] of this.inflight) {
      this.generations.set(runtimeId, (this.generations.get(runtimeId) ?? task.generation) + 1)
      task.controller.abort()
    }
    this.inflight.clear()
  }

  /** §3.3 discovery gate — the first matching rule names why discovery is due. */
  private async gateReason(
    input: { runtimeId: string; models: string[] },
    fingerprint: string
  ): Promise<string | undefined> {
    const meta = await this.deps.store.getRuntimeCatalogMeta(input.runtimeId)
    if (!meta || meta.fingerprint !== fingerprint) return 'fingerprint changed'
    // Phase 1 writes meta WITHOUT complete, so a fresh install keeps this open.
    if (!meta.complete) return 'catalog incomplete'
    if (modelsHash(input.models) !== meta.modelsHash) return 'advertised model set changed'
    if (meta.source === 'native' && this.now() - meta.observedAt > NATIVE_CATALOG_TTL_MS) return 'native catalog TTL'
    return undefined
  }

  private cancel(runtimeId: string): void {
    const task = this.inflight.get(runtimeId)
    if (!task) return
    this.generations.set(runtimeId, (this.generations.get(runtimeId) ?? task.generation) + 1)
    task.controller.abort()
    this.inflight.delete(runtimeId)
  }

  private isCurrent(runtimeId: string, generation: number): boolean {
    return !this.stopped && this.generations.get(runtimeId) === generation
  }

  private noteFailure(runtimeId: string, fingerprint: string): void {
    const prev = this.backoff.get(runtimeId)
    const failures = prev && prev.fingerprint === fingerprint ? prev.failures + 1 : 1
    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS)
    this.backoff.set(runtimeId, { fingerprint, failures, nextAttemptAt: this.now() + delayMs })
  }

  private start(
    input: { runtimeId: string; rt: RuntimeDef; models: string[] },
    fingerprint: string,
    reason: string
  ): void {
    const generation = (this.generations.get(input.runtimeId) ?? 0) + 1
    this.generations.set(input.runtimeId, generation)
    const task: InflightTask = { fingerprint, generation, controller: new AbortController() }
    this.inflight.set(input.runtimeId, task)
    this.deps.log?.info(
      `catalog: ${input.runtimeId} discovery scheduled (${reason}; ${input.models.length} advertised model(s))`
    )
    void this.runDiscovery(input, fingerprint, generation, task.controller.signal)
      .catch((err) =>
        this.deps.log?.warn(`catalog: ${input.runtimeId} discovery task failed: ${(err as Error).message}`)
      )
      .finally(() => {
        if (this.inflight.get(input.runtimeId) === task) this.inflight.delete(input.runtimeId)
      })
  }

  private async runDiscovery(
    input: { runtimeId: string; rt: RuntimeDef; models: string[] },
    fingerprint: string,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    const { runtimeId, rt } = input
    const startedAt = this.now()

    const driver = this.drivers.find((d) => d.supports(runtimeId))
    if (driver) {
      try {
        const catalog = await withTimeout(
          driver.discover(runtimeId, rt, {
            timeoutMs: DRIVER_TIMEOUT_MS,
            env: this.driverEnv(),
            log: this.deps.log,
            signal
          }),
          DRIVER_TIMEOUT_MS,
          `${runtimeId} driver discovery`
        )
        if (!this.isCurrent(runtimeId, generation)) return
        if (this.validateDriverCatalog(runtimeId, catalog, input.models)) {
          await this.commitDiscovery(input, fingerprint, generation, 'native', catalog.models, catalog.defaultModel)
          if (!this.isCurrent(runtimeId, generation)) return
          this.deps.log?.info(
            `catalog: ${runtimeId} native discovery complete (${catalog.models.length} model(s), ${this.now() - startedAt}ms)`
          )
          await this.deps.onUpdated(runtimeId)
          return
        }
        // Discarded (empty / id-scheme mismatch) — fall through to enumeration.
      } catch (err) {
        if (!this.isCurrent(runtimeId, generation)) return
        this.deps.log?.warn(
          `catalog: ${runtimeId} driver discovery failed, falling back to enumeration: ${(err as Error).message}`
        )
      }
    }

    const requested = input.models.filter((id) => id !== 'default')
    const capped = requested.slice(0, MAX_ENUMERATED_MODELS)
    if (capped.length < requested.length) {
      this.deps.log?.warn(
        `catalog: ${runtimeId} advertises ${requested.length} models — enumerating the first ${MAX_ENUMERATED_MODELS}, dropping ${requested.length - capped.length}`
      )
    }
    let result: EnumerateResult | undefined
    try {
      result = await this.deps.enumerate(runtimeId, rt, capped, {
        perModelMs: ENUMERATE_PER_MODEL_MS,
        totalMs: ENUMERATE_TOTAL_MS
      })
    } catch (err) {
      if (!this.isCurrent(runtimeId, generation)) return
      this.noteFailure(runtimeId, fingerprint)
      this.deps.log?.warn(`catalog: ${runtimeId} enumeration failed: ${(err as Error).message}`)
      return
    }
    if (!this.isCurrent(runtimeId, generation)) return
    if (result === undefined) {
      // Enumeration unavailable for this runtime (e.g. isolation impossible) —
      // record nothing, keep phase-1 data; backoff paces the retries.
      this.noteFailure(runtimeId, fingerprint)
      this.deps.log?.debug(`catalog: ${runtimeId} enumeration unavailable — keeping phase-1 data`)
      return
    }
    const r = result

    const complete = !r.aborted && capped.every((id) => r.models.some((m) => m.id === id))
    if (complete) {
      await this.commitDiscovery(input, fingerprint, generation, 'acp', r.models, undefined)
      if (!this.isCurrent(runtimeId, generation)) return
      this.deps.log?.info(
        `catalog: ${runtimeId} enumeration complete (${r.models.length} model(s), ${this.now() - startedAt}ms)`
      )
    } else {
      // Aborted/partial: keep what was learned, meta stays incomplete so the
      // gate retries (with backoff); last-good rows for other models survive.
      const observedAt = this.now()
      for (const m of r.models) {
        if (!this.isCurrent(runtimeId, generation)) return
        await this.upsertModel(runtimeId, fingerprint, m, observedAt)
      }
      this.noteFailure(runtimeId, fingerprint)
      this.deps.log?.warn(
        `catalog: ${runtimeId} enumeration incomplete (${r.models.length}/${capped.length} model(s)${r.aborted ? `; ${r.aborted}` : ''}) — keeping partial rows`
      )
      if (r.models.length === 0) return
    }
    await this.deps.onUpdated(runtimeId)
  }

  /** A non-empty driver catalog must share the probe's id scheme: fewer than half
   *  of the advertised ids present ⇒ the driver speaks different ids (e.g. compound
   *  provider/model) and its result would not join `models[]` — discard it. */
  private validateDriverCatalog(runtimeId: string, catalog: DriverCatalog, advertised: string[]): boolean {
    if (catalog.models.length === 0) {
      this.deps.log?.warn(`catalog: ${runtimeId} driver returned an empty catalog — falling back to enumeration`)
      return false
    }
    if (advertised.length > 0) {
      const ids = new Set(catalog.models.map((m) => m.id))
      const matched = advertised.filter((id) => ids.has(id)).length
      if (matched * 2 < advertised.length) {
        this.deps.log?.warn(
          `catalog: ${runtimeId} driver ids match only ${matched}/${advertised.length} advertised models — id-scheme mismatch, falling back to enumeration`
        )
        return false
      }
    }
    return true
  }

  /** Persist one COMPLETE discovery: model rows, meta (source + preserved phase-1
   *  fields), the complete flag keyed to the probed models hash, prune-on-success. */
  private async commitDiscovery(
    input: { runtimeId: string; models: string[] },
    fingerprint: string,
    generation: number,
    source: 'native' | 'acp',
    models: Array<{ id: string } & ModelCaps>,
    driverDefaultModel: string | undefined
  ): Promise<void> {
    const { runtimeId } = input
    const observedAt = this.now()
    for (const m of models) {
      if (!this.isCurrent(runtimeId, generation)) return
      await this.upsertModel(runtimeId, fingerprint, m, observedAt)
    }
    if (!this.isCurrent(runtimeId, generation)) return
    // Preserve phase-1 meta fields the discovery has no source for (permission
    // modes always; default model unless the driver named one — design §5).
    const prev = await this.deps.store.getRuntimeCatalogMeta(runtimeId)
    const defaultModel = driverDefaultModel ?? prev?.defaultModel
    await this.deps.store.recordRuntimeCatalogMeta({
      runtimeId,
      fingerprint,
      source,
      ...(defaultModel ? { defaultModel } : {}),
      ...(prev?.permissionModes ? { permissionModes: prev.permissionModes } : {}),
      observedAt
    })
    await this.deps.store.markRuntimeCatalogComplete(runtimeId, fingerprint, modelsHash(input.models), observedAt)
    // Keep everything still advertised even when this round learned no caps for
    // it — prune only models that vanished from both the catalog and the probe.
    await this.deps.store.pruneRuntimeModelCaps(runtimeId, [...new Set([...models.map((m) => m.id), ...input.models])])
    this.backoff.delete(runtimeId)
  }

  private async upsertModel(
    runtimeId: string,
    fingerprint: string,
    m: { id: string } & ModelCaps,
    observedAt: number
  ): Promise<void> {
    const { id, ...caps } = m
    await this.deps.store.upsertRuntimeModelCap({ runtimeId, modelId: id, fingerprint, caps, observedAt })
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

// ── built-in drivers (design §3.1) ──────────────────────────────────────────
// codex + opencode + kilo. claude has NO driver in this PR — the generic
// enumerator covers its handful of models; the Agent-SDK driver is the
// designated follow-up.

function builtInCatalogDrivers(): ModelCatalogDriver[] {
  return [new CodexAppServerDriver(), new LocalServeCatalogDriver('opencode'), new LocalServeCatalogDriver('kilo')]
}

function pickString(rec: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const value = rec[camel] ?? rec[snake]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function pickArray(rec: Record<string, unknown>, camel: string, snake: string): unknown[] | undefined {
  const value = rec[camel] ?? rec[snake]
  return Array.isArray(value) ? value : undefined
}

/** Map a codex `model/list` result into the driver catalog shape. Keys are
 *  handled in both camelCase and snake_case — the RPC speaks camelCase but the
 *  on-disk model cache (which the server may echo) uses snake_case. */
export function codexModelsFromListResult(result: unknown): DriverCatalog {
  const models: DriverCatalog['models'] = []
  let defaultModel: string | undefined
  const data = result && typeof result === 'object' ? (result as Record<string, unknown>).data : undefined
  if (!Array.isArray(data)) return { models }
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const id = rec.id
    // The literal "default" entry means "no explicit model" (the probe filters it
    // from models[] the same way) — it is not a catalog entry.
    if (typeof id !== 'string' || id === '' || id === 'default') continue
    const name = pickString(rec, 'displayName', 'display_name')
    const modelDescription = typeof rec.description === 'string' && rec.description !== '' ? rec.description : undefined
    const efforts: EffortOption[] = (
      pickArray(rec, 'supportedReasoningEfforts', 'supported_reasoning_efforts') ?? []
    ).flatMap((e): EffortOption[] => {
      if (typeof e === 'string' && e !== '') return [{ value: e }]
      if (!e || typeof e !== 'object') return []
      const eo = e as Record<string, unknown>
      const value = pickString(eo, 'reasoningEffort', 'reasoning_effort')
      if (!value) return []
      const description = typeof eo.description === 'string' && eo.description !== '' ? eo.description : undefined
      return [{ value, ...(description ? { description } : {}) }]
    })
    const defaultEffort = pickString(rec, 'defaultReasoningEffort', 'default_reasoning_effort')
    const tiers = pickArray(rec, 'additionalSpeedTiers', 'additional_speed_tiers') ?? []
    const fastMode = tiers.some(
      (t) =>
        t === 'fast' ||
        (t !== null &&
          typeof t === 'object' &&
          pickString(t as Record<string, unknown>, 'speedTier', 'speed_tier') === 'fast')
    )
    // The wire carries an explicit default-model marker (codex-rs derives it
    // from catalog priority + visibility and stamps it on model/list).
    if (rec.isDefault === true || rec.is_default === true) defaultModel ??= id
    models.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(modelDescription ? { description: modelDescription } : {}),
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      fastMode
    })
  }
  return { models, ...(defaultModel ? { defaultModel } : {}) }
}

/** SIGKILL the driver child's whole process group (detached spawn) so wrapper
 *  grandchildren die too; direct kill is the Windows / already-gone fallback. */
function killDriverTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // Group already reaped or never ours — fall through to the direct kill.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited.
  }
}

/** codex native catalog: `codex app-server` speaks newline-delimited JSON-RPC on
 *  stdio; `initialize` + `model/list` return every model with its reasoning-effort
 *  tiers, default effort, and speed tiers — one round-trip, no ACP session. */
class CodexAppServerDriver implements ModelCatalogDriver {
  supports(runtimeId: string): boolean {
    return runtimeId === 'codex'
  }

  discover(runtimeId: string, _rt: RuntimeDef, opts: DriverDiscoverOptions): Promise<DriverCatalog> {
    return new Promise<DriverCatalog>((resolve, reject) => {
      const child = spawn('codex', ['app-server'], {
        env: opts.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32' // own group so the tree kill reaches wrapper grandchildren
      })
      let settled = false
      const finish = (err: Error | undefined, catalog?: DriverCatalog): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        killDriverTree(child)
        if (err) reject(err)
        else resolve(catalog!)
      }
      const onAbort = (): void => finish(new Error(`${runtimeId} driver discovery cancelled`))
      const timer = setTimeout(
        () => finish(new Error(`codex app-server timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs
      )
      opts.signal?.addEventListener('abort', onAbort)
      child.on('error', (err) => finish(new Error(`codex app-server spawn failed: ${err.message}`)))
      child.on('exit', (code, sig) => finish(new Error(`codex app-server exited (${sig ?? code}) before model/list`)))
      child.stdin!.on('error', () => {}) // EPIPE after an early exit — the exit handler reports

      let buffered = ''
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        buffered += chunk
        let nl: number
        while ((nl = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          if (!line) continue
          let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
          try {
            msg = JSON.parse(line)
          } catch {
            continue // non-protocol noise on stdout
          }
          if (msg.id === 1) {
            if (msg.error) return finish(new Error(`codex initialize failed: ${msg.error.message ?? 'unknown error'}`))
            child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })}\n`)
          } else if (msg.id === 2) {
            if (msg.error) return finish(new Error(`codex model/list failed: ${msg.error.message ?? 'unknown error'}`))
            return finish(undefined, codexModelsFromListResult(msg.result))
          }
        }
      })
      child.stdin!.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'agentconnect', title: 'AgentConnect', version: '0.0.0' },
            capabilities: null
          }
        })}\n`
      )
    })
  }
}

/** Map an opencode/kilo `GET /config/providers` payload into the driver catalog
 *  shape: catalog ids are `provider.id + '/' + model.id` (`models` is an object
 *  keyed by model id, or an array on older builds), and a model's `variants`
 *  object keys are its effort tiers. */
export function opencodeModelsFromProviders(payload: unknown): DriverCatalog {
  const models: DriverCatalog['models'] = []
  const providers =
    payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).providers)
      ? ((payload as Record<string, unknown>).providers as unknown[])
      : Array.isArray(payload)
        ? payload
        : []
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue
    const prov = provider as Record<string, unknown>
    const providerId = typeof prov.id === 'string' && prov.id !== '' ? prov.id : undefined
    if (!providerId) continue
    const raw = prov.models
    const entries: Array<[string | undefined, unknown]> = Array.isArray(raw)
      ? raw.map((m) => [undefined, m])
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>)
        : []
    for (const [key, entry] of entries) {
      const model = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
      const modelId = key ?? (typeof model.id === 'string' && model.id !== '' ? model.id : undefined)
      if (!modelId) continue
      const name = typeof model.name === 'string' && model.name !== '' ? model.name : undefined
      const variants =
        model.variants && typeof model.variants === 'object' && !Array.isArray(model.variants)
          ? Object.keys(model.variants as Record<string, unknown>)
          : []
      models.push({
        id: `${providerId}/${modelId}`,
        ...(name ? { name } : {}),
        efforts: variants.map((value) => ({ value }))
        // No fastMode: these runtimes have no fast toggle to observe here.
      })
    }
  }
  return { models }
}

/** Grab an OS-assigned loopback port, then release it for the driver child.
 *  (Bind-then-release: a tiny race window, acceptable for a discovery process.) */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port assigned'))))
    })
  })
}

/** Derive the `serve` invocation from the runtime's own launch definition:
 *  replacing the trailing ACP-entry arg (`acp`) with the serve argv makes the
 *  npx distribution (`npx -y @kilocode/cli acp` — the registry ships kilo npx-
 *  first, so a bare `kilo` bin usually is NOT on PATH) and downloaded-archive
 *  binaries (`./opencode acp`) both work; a bare PATH bin is the last resort. */
export function serveInvocationFor(
  bin: string,
  rt: RuntimeDef | undefined,
  serveArgs: string[]
): { command: string; args: string[] } {
  const acpAt = rt ? rt.args.lastIndexOf('acp') : -1
  if (rt && rt.command && acpAt !== -1) {
    const args = [...rt.args]
    args.splice(acpAt, args.length - acpAt, ...serveArgs)
    // `./opencode`-style archive commands resolve via literal path then PATH
    // basename (probe.ts); an unresolvable command falls through as-is so the
    // spawn error carries the real name.
    return { command: resolveCommandPath(rt.command) ?? rt.command, args }
  }
  return { command: bin, args: serveArgs }
}

/** opencode-lineage native catalog (opencode + its kilo fork): `<bin> serve` on a
 *  random loopback-only port, then `GET /config/providers` — the same data source
 *  the runtime builds its own model selector from (`serve --port/--hostname` and
 *  the route verified against opencode 1.18.3 / kilocode 7.4.11 sources). */
class LocalServeCatalogDriver implements ModelCatalogDriver {
  constructor(private readonly bin: 'opencode' | 'kilo') {}

  supports(runtimeId: string): boolean {
    return runtimeId === this.bin
  }

  async discover(_runtimeId: string, rt: RuntimeDef, opts: DriverDiscoverOptions): Promise<DriverCatalog> {
    const port = await freeLoopbackPort()
    const deadline = Date.now() + opts.timeoutMs
    // The serve process must come up unauthenticated: with (OPENCODE|KILO)_
    // SERVER_PASSWORD set it would 401 every catalog GET. The curated allowlist
    // never passes them today — strip defensively in case driverEnv widens.
    const env = { ...opts.env }
    delete env.OPENCODE_SERVER_PASSWORD
    delete env.KILO_SERVER_PASSWORD
    const invocation = serveInvocationFor(this.bin, rt, ['serve', '--port', String(port), '--hostname', '127.0.0.1'])
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32'
    })
    let exited: string | undefined
    let spawnError: Error | undefined
    child.on('exit', (code, sig) => (exited = `${this.bin} serve exited (${sig ?? code}) before serving the catalog`))
    child.on('error', (err) => (spawnError = new Error(`${this.bin} serve spawn failed: ${err.message}`)))
    const onAbort = (): void => killDriverTree(child)
    opts.signal?.addEventListener('abort', onAbort)
    try {
      // Poll until the server answers; startup time dominates, so a coarse
      // interval is fine and keeps the child's serve log quiet.
      while (Date.now() < deadline) {
        if (opts.signal?.aborted) throw new Error(`${this.bin} driver discovery cancelled`)
        if (spawnError) throw spawnError
        if (exited) throw new Error(exited)
        try {
          const res = await fetch(`http://127.0.0.1:${port}/config/providers`, { signal: AbortSignal.timeout(2_000) })
          if (res.ok) return opencodeModelsFromProviders(await res.json())
          // An auth-gated server (server password set outside our env, or kilo's
          // provider-auth 401) will not recover within the budget — fail fast to
          // the enumeration fallback instead of polling out the clock.
          if (res.status === 401) throw new Error(`${this.bin} serve requires authentication (401)`)
        } catch (err) {
          if (err instanceof Error && err.message.includes('(401)')) throw err
          // Not up yet (or a transient refusal) — keep polling until the deadline.
        }
        await delay(250)
      }
      throw new Error(`${this.bin} serve did not answer /config/providers within ${opts.timeoutMs}ms`)
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      killDriverTree(child)
    }
  }
}

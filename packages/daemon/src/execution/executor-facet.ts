// The executor facet (session-executors.md §3, §6, §7): this daemon hosting `session`-isolated sessions for the other members of its group.
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_BACKOFF_CAP_MS, systemClock, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import type {
  ExecutorFacts,
  ExecutorPrepareRefusal,
  ExecutorPrepareReq,
  ExecutorPrepareResult,
  ExecutorReleaseReq,
  ExecutorReleaseResult
} from '@agentconnect.md/protocol'
import { sessionKeyDirName } from '../acp/host-key.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { DEFAULT_ORPHAN_GRACE_MS } from '../k8s/orphan-reconciler.js'
import type { Logger } from '../log.js'
import { prepareSharedRuntimeCredentials } from '../runtimes/runtime-credentials.js'
import { prepareRuntimeHome } from '../runtimes/runtime-home.js'
import { PIPE_KEY_BYTES, startPipeListener, type PipeListener, type PipeListenerOptions } from './executor-pipe.js'
import { startHostShim, sweepStaleHostShims, type HostShim } from './host-shim.js'
import type { ExecutionStrategy, StrategyAvailability } from './strategies.js'

/** No admitted pipe for this long stops an environment: two of the holder dialer's capped reconnect delays, so a blip it is still retrying through never reads as idle. */
export const IDLE_LINGER_MS = 2 * DEFAULT_BACKOFF_CAP_MS
/** The pool reconciler's window, for its reason: nothing touched within it is judged, and a sweep runs once per window. */
export const ORPHAN_GRACE_MS = DEFAULT_ORPHAN_GRACE_MS
// Every hosted environment re-dialing at once, twice over; the floor keeps a small machine reachable.
const MIN_PENDING_HANDSHAKES = 8

const RECORD_FILE = /^(session-[a-f0-9]{24})\.json$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The inventory entry kept beside an environment: the pool's claim labels, the generation applied and the launch it belongs to, and the two times the backstop reads. */
interface EnvironmentRecord {
  agentId: string
  generation: number
  launchId: string
  preparedAt: number
  /** Last prepare or admitted dial. Persisted so a restart does not reset the retention clock. */
  lastUsedAt: number
}

type RunningShim = Pick<HostShim, 'socketPath' | 'runtimeRoot' | 'helperRoot' | 'missingHelpers' | 'exited' | 'stop'>

interface Environment extends EnvironmentRecord {
  leaf: string
  shim?: RunningShim
  /** Admits dials while set; minted per launch and never written anywhere. */
  key?: Buffer
  /** The applied generation's answer, for as long as that launch lives here. */
  reply?: Extract<ExecutorPrepareResult, { status: 'ready' }>
  launching?: Promise<ExecutorPrepareResult>
  stopping?: Promise<void>
  discarding?: Promise<void>
  idle?: TimerHandle
}

export interface ExecutorFacetDeps {
  daemonRoot: string
  /** `sandbox.share`, the machine owner's consent: off, this machine is nobody's candidate and creates nothing. */
  share: boolean
  strategies: () => Record<ExecutionStrategy, StrategyAvailability>
  /** `limits.maxConcurrentSessions`, read per request because `config/push` may move it. */
  capacity: () => number
  /** This machine's own live isolated sessions: part of the load a holder compares, never refused themselves. */
  ownSessions: () => number
  draining: () => boolean
  /** The local address the control connection leaves from, which is where a LAN peer reaches this machine (§13). */
  endpointHost: () => string | undefined
  /** Seed a session HOME from this machine's runtime sign-in (§8). */
  seedHome: (home: string) => void
  /** The CP's `agent/exists`; a throw is "cannot answer". */
  agentsExist: (agentIds: string[]) => Promise<Set<string>>
  /** This machine's `sessions.retention` as a window; null ⇒ `never`, and an environment nobody uses is kept forever. */
  retentionMs: () => number | null
  log: Logger
  clock?: Clock
  /** Test seams: a stub in place of the Linux-only launcher, and the listener's bind address and handshake budget. */
  startShim?: (input: { daemonRoot: string; sessionLeaf: string; log: Logger }) => Promise<RunningShim>
  listen?: Pick<PipeListenerOptions, 'host' | 'handshakeTimeoutMs'>
}

export interface ExecutorFacet {
  /** The registration facts, or undefined while the facet is dark: then nothing new is sent. */
  facts(): ExecutorFacts | undefined
  /** The heartbeat's `hostedSessions`: environments live here plus this machine's own isolated sessions. */
  hostedSessions(): number | undefined
  /** A relayed `executor/prepare`. Its `ready` answer carries the pipe's key: never log it. */
  prepare(req: ExecutorPrepareReq): Promise<ExecutorPrepareResult>
  /** A relayed `executor/release`: the holder retired the session, so the environment goes. Answered even while the facet is dark. */
  release(req: ExecutorReleaseReq): Promise<ExecutorReleaseResult>
  /** One orphan sweep; the facet also runs it on its own schedule. */
  reconcile(): Promise<void>
  /** The shutdown drain's share: hosted environments get `deadlineMs`, then their shims stop. */
  drain(deadlineMs: number): Promise<void>
  stop(): Promise<void>
}

const refused = (reason: ExecutorPrepareRefusal): ExecutorPrepareResult => ({ status: 'refused', reason })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** An environment's record fields alone — never the live half, whose `key` must not reach the disk. */
const applied = (env: Environment): EnvironmentRecord => ({
  agentId: env.agentId,
  generation: env.generation,
  launchId: env.launchId,
  preparedAt: env.preparedAt,
  lastUsedAt: env.lastUsedAt
})

/** Seed a session HOME the way the local confined tier does, for every runtime this machine admits: the `prepare` names none. */
export function seedSessionHome(
  home: string,
  runtimes: Record<string, RuntimeDef>,
  log: Pick<Logger, 'warn'>,
  hostEnv: NodeJS.ProcessEnv = process.env
): void {
  for (const [runtimeId, runtime] of Object.entries(runtimes)) {
    try {
      const credentials = prepareSharedRuntimeCredentials({ runtimeId, runtime, hostEnv })
      prepareRuntimeHome(runtimeId, home, hostEnv, home, credentials?.seedExclusions)
      credentials?.preparePrivateHome(home)
    } catch (error) {
      // One runtime's conflicting sign-in must not cost a session that runs another.
      log.warn(`executor: could not seed the ${runtimeId} sign-in into a session HOME (${message(error)})`)
    }
  }
}

function syncPath(path: string): void {
  // Windows has no directory fsync; the `host` strategy is Linux-only anyway.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Durable before it returns: a generation applied and then forgotten would let a replay mint a second key. */
function writeRecord(dir: string, leaf: string, record: EnvironmentRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${leaf}.json`)
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    syncPath(temp)
    renameSync(temp, file)
    syncPath(dir)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function loadRecords(dir: string, log: Pick<Logger, 'warn'>): Map<string, EnvironmentRecord> {
  const records = new Map<string, EnvironmentRecord>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return records
  }
  let unreadable = 0
  for (const name of names) {
    const leaf = RECORD_FILE.exec(name)?.[1]
    if (!leaf) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<EnvironmentRecord>
      if (typeof raw.agentId !== 'string' || !UUID.test(raw.agentId)) throw new Error('agent')
      if (!Number.isSafeInteger(raw.generation) || raw.generation! < 1) throw new Error('generation')
      if (typeof raw.launchId !== 'string' || !UUID.test(raw.launchId)) throw new Error('launch')
      if (!Number.isFinite(raw.preparedAt) || !Number.isFinite(raw.lastUsedAt)) throw new Error('times')
      records.set(leaf, {
        agentId: raw.agentId,
        generation: raw.generation!,
        launchId: raw.launchId,
        preparedAt: raw.preparedAt!,
        lastUsedAt: raw.lastUsedAt!
      })
    } catch {
      unreadable += 1
    }
  }
  if (unreadable > 0)
    log.warn(`executor: ${unreadable} environment record(s) under ${dir} could not be read and are left alone`)
  return records
}

class Facet implements ExecutorFacet {
  private readonly environments = new Map<string, Environment>()
  private readonly clock: Clock
  private readonly sessionsDir: string
  private listener?: PipeListener
  private startGate: Promise<void> = Promise.resolve()
  private reconcileTimer?: TimerHandle
  private drained?: Promise<void>
  private noPipes?: () => void
  private stopped = false

  constructor(private readonly deps: ExecutorFacetDeps) {
    this.clock = deps.clock ?? systemClock
    this.sessionsDir = join(deps.daemonRoot, 'sessions')
  }

  async start(): Promise<void> {
    const { deps } = this
    // Every shim start queues behind this gate, so none starts over a session an earlier life's shim still runs in.
    this.startGate = sweepStaleHostShims(deps.daemonRoot, deps.log).catch((error: unknown) =>
      deps.log.warn(`executor: sweeping what an earlier run left failed (${message(error)})`)
    )
    await this.startGate
    for (const [leaf, record] of loadRecords(this.sessionsDir, deps.log))
      this.environments.set(leaf, { leaf, ...record })
    const host = deps.strategies().host
    if (!deps.share) {
      // The default, so it is said quietly unless an earlier run left something behind.
      const left = this.environments.size
      if (left === 0) deps.log.debug('executor: off — sandbox.share is not set')
      else
        deps.log.info(
          `executor: sandbox.share is off — ${left} environment(s) of an earlier run stay until their sessions retire`
        )
    } else if (!host.available) {
      deps.log.warn(
        `executor: sandbox.share is on but the facet stays off — no strategy can run here (host: ${host.reason})`
      )
    } else {
      try {
        this.listener = await startPipeListener({
          ...deps.listen,
          admission: (identity) => {
            const env = this.environments.get(identity)
            return env?.key && env.shim ? { key: env.key, socketPath: env.shim.socketPath } : undefined
          },
          onPipe: (identity, open) => this.onPipe(identity, open),
          maxPending: () => Math.max(MIN_PENDING_HANDSHAKES, 2 * this.capacity()),
          log: deps.log
        })
        deps.log.info(
          `executor: hosting sessions of this machine's group — TLS-PSK listener on port ${this.listener.port}`
        )
      } catch (error) {
        deps.log.warn(
          `executor: sandbox.share is on but the facet stays off — its listener could not bind (${message(error)})`
        )
      }
    }
    if (this.listener || this.environments.size > 0) this.armReconcile()
  }

  facts(): ExecutorFacts | undefined {
    if (!this.listener) return undefined
    const host = this.deps.endpointHost()
    return {
      enabled: true,
      strategies: {
        host: this.deps.strategies().host,
        // Offered once this facet can prepare one; until then a holder reads why not.
        microsandbox: { available: false, reason: 'the executor facet does not prepare microsandbox environments yet' }
      },
      ...(host ? { endpoint: { host, port: this.listener.port } } : {}),
      capacity: this.capacity()
    }
  }

  hostedSessions(): number | undefined {
    return this.listener ? this.liveCount() : undefined
  }

  async prepare(req: ExecutorPrepareReq): Promise<ExecutorPrepareResult> {
    const leaf = sessionKeyDirName(req.sessionKey)
    // NOTHING above the record may await: prepares are applied in arrival order, which the CP made authorization order (§6),
    // and one that yields here could be overtaken by a later holder's. A discard owns the directory, so rather than waiting for
    // it — the wait that used to reorder exactly this — the launch is retired and the holder's next one, moments later, creates it.
    const known = this.environments.get(leaf)
    if (known?.discarding) return refused('launch_retired')
    if (!this.listener) return refused('facet_off')
    if (this.stopped || this.deps.draining()) return refused('draining')
    if (req.strategy !== 'host') return refused('strategy_unavailable')
    if (known) {
      // The CP vouched that the asker holds `req.agentId`; that says nothing about another agent's environment.
      if (known.agentId !== req.agentId) return refused('not_holder')
      if (known.launchId === req.launchId) {
        // The same launch asked again: its answer in flight or as given — the same key, nothing rotated — or none at all once it is gone.
        if (known.launching) return known.launching
        return known.reply ? { ...known.reply, liveCount: this.liveCount() } : refused('launch_retired')
      }
    }
    // A slot is a live shim or a preparation in flight; an environment that already has one needs no second.
    if (!known?.shim && !known?.launching && this.liveCount() >= this.capacity()) {
      return { status: 'full', liveCount: this.liveCount() }
    }
    // The executor allocates the generation, because it is the single writer of this environment and knows what it last applied.
    const now = this.clock.now()
    const generation = (known?.generation ?? 0) + 1
    const record = { agentId: req.agentId, generation, launchId: req.launchId, preparedAt: now, lastUsedAt: now }
    writeRecord(this.sessionsDir, leaf, record)
    const env: Environment = Object.assign(known ?? { leaf }, record)
    this.environments.set(leaf, env)
    // Rotation is the fence (§6): the old key, its cached answer and the pipe it admitted go before the new launch starts.
    this.retire(env)
    const launching = this.launch(env, generation)
    env.launching = launching
    const settled = (): void => {
      if (env.launching !== launching) return
      env.launching = undefined
      // Whatever the launch left running stops after the linger unless a holder dials it.
      if (env.shim && !this.listener?.piped(leaf)) this.armIdle(env)
    }
    launching.then(settled, settled)
    return launching
  }

  private async launch(env: Environment, generation: number): Promise<ExecutorPrepareResult> {
    await this.serializeStart(async () => {
      if (env.stopping) await env.stopping
      if (this.stopped) throw new Error('the executor facet is stopping')
      if (env.shim || env.generation !== generation) return
      this.deps.seedHome(join(this.sessionsDir, env.leaf, 'home'))
      const shim = await (this.deps.startShim ?? startHostShim)({
        daemonRoot: this.deps.daemonRoot,
        sessionLeaf: env.leaf,
        log: this.deps.log
      })
      if (this.stopped) {
        await shim.stop()
        throw new Error('the executor facet is stopping')
      }
      env.shim = shim
      void shim.exited.then(() => this.shimExited(env, shim))
    })
    // A newer launch took the environment while this one was starting it, and owns the key now.
    if (env.generation !== generation || !env.shim || !this.listener) return refused('launch_retired')
    const host = this.deps.endpointHost()
    if (!host) throw new Error('the control connection has no local address to publish')
    env.key = randomBytes(PIPE_KEY_BYTES)
    env.reply = {
      status: 'ready',
      generation,
      endpoint: { host, port: this.listener.port },
      psk: env.key.toString('base64url'),
      runtimeRoot: env.shim.runtimeRoot,
      helperRoot: env.shim.helperRoot,
      ...(env.shim.missingHelpers.length > 0 ? { missingHelpers: env.shim.missingHelpers } : {}),
      liveCount: this.liveCount()
    }
    return env.reply
  }

  // One environment start at a time, as the microsandbox manager starts VMs, so the VM strategy inherits the rule.
  private async serializeStart<T>(operation: () => Promise<T>): Promise<T> {
    const ahead = this.startGate
    let done!: () => void
    this.startGate = new Promise<void>((resolve) => (done = resolve))
    await ahead
    try {
      return await operation()
    } finally {
      done()
    }
  }

  private capacity(): number {
    return Math.max(0, this.deps.capacity())
  }

  private liveCount(): number {
    let hosted = 0
    for (const env of this.environments.values()) if (env.shim || env.launching) hosted += 1
    return hosted + this.deps.ownSessions()
  }

  /** Drop what a launch gave out: the key stops admitting, a replay finds no answer, and the pipe admitted under it closes. */
  private retire(env: Environment): void {
    env.key = undefined
    env.reply = undefined
    this.clearIdle(env)
    this.listener?.close(env.leaf)
  }

  private onPipe(leaf: string, open: boolean): void {
    const env = this.environments.get(leaf)
    if (env && open) {
      this.clearIdle(env)
      this.touch(env)
    } else if (env?.key) this.armIdle(env)
    if (!open && this.listener?.pipeCount() === 0) this.noPipes?.()
  }

  /** A dial is use, and the backstop measures from it. Persisted, so a restart does not reset an environment's retention clock. */
  private touch(env: Environment): void {
    env.lastUsedAt = this.clock.now()
    try {
      writeRecord(this.sessionsDir, env.leaf, applied(env))
    } catch (error) {
      // A stamp that will not persist costs at worst an early backstop discard; it must not cost the session its pipe.
      this.deps.log.warn(`executor: recording the last use of ${env.leaf} failed (${message(error)})`)
    }
  }

  private armIdle(env: Environment): void {
    this.clearIdle(env)
    env.idle = this.clock.setTimeout(() => {
      env.idle = undefined
      if (env.launching || this.listener?.piped(env.leaf)) return
      this.deps.log.info(
        `executor: stopping ${env.leaf} of agent ${env.agentId} — no holder dialed it within the linger`
      )
      void this.stopEnvironment(env)
    }, IDLE_LINGER_MS)
  }

  private clearIdle(env: Environment): void {
    if (env.idle !== undefined) this.clock.clearTimeout(env.idle)
    env.idle = undefined
  }

  /** Stop the shim and free its slot; the directory and the applied generation stay. */
  private stopEnvironment(env: Environment): Promise<void> {
    this.retire(env)
    const shim = env.shim
    if (!shim) return Promise.resolve()
    return (env.stopping ??= shim
      .stop()
      .catch((error: unknown) => this.deps.log.warn(`executor: stopping ${env.leaf} failed (${message(error)})`))
      .then(() => {
        if (env.shim === shim) env.shim = undefined
        env.stopping = undefined
      }))
  }

  private shimExited(env: Environment, shim: RunningShim): void {
    if (env.shim !== shim) return
    env.shim = undefined
    if (env.stopping) return
    this.retire(env)
    this.deps.log.warn(`executor: the shim of ${env.leaf} (agent ${env.agentId}) exited on its own`)
  }

  private armReconcile(): void {
    this.reconcileTimer = this.clock.setTimeout(() => {
      this.reconcileTimer = undefined
      void this.reconcile()
        .catch((error: unknown) => this.deps.log.warn(`executor: the orphan reconcile failed (${message(error)})`))
        .finally(() => {
          if (!this.stopped) this.armReconcile()
        })
    }, ORPHAN_GRACE_MS)
  }

  /** The backstop (§7). A holder's `release` is how an environment normally goes; this is what survives a holder that never sends one. */
  async reconcile(): Promise<void> {
    const { log } = this.deps
    const now = this.clock.now()
    const retention = this.deps.retentionMs()
    const unused = (env: Environment): boolean =>
      !env.shim && !env.launching && !env.discarding && !this.listener?.piped(env.leaf)
    // Never one in use, and never one younger than the grace: a session born moments ago has not had time to be dialed.
    const candidates = [...this.environments.values()].filter(
      (env) => unused(env) && now - env.preparedAt >= ORPHAN_GRACE_MS
    )
    if (candidates.length === 0) return
    let known: Set<string>
    try {
      known = await this.deps.agentsExist([...new Set(candidates.map((env) => env.agentId))])
    } catch (error) {
      // The one authority failing to answer keeps everything: a lookup that cannot be made is not an absence.
      log.warn(`executor: the orphan reconcile could not ask (${message(error)}) — keeping every environment`)
      return
    }
    const orphans: Array<{ env: Environment; was: EnvironmentRecord; why: string }> = []
    for (const env of candidates) {
      const was = applied(env)
      if (!known.has(env.agentId)) orphans.push({ env, was, why: 'the control plane no longer knows its agent' })
      else if (retention !== null && now - env.lastUsedAt >= retention)
        orphans.push({ env, was, why: "nothing dialed or prepared it within this machine's session retention" })
    }
    for (const { env, was, why } of orphans) {
      // Checked again with no await in between: an environment a `prepare` or a dial touched since the lookup is never the one deleted.
      if (!unused(env) || env.generation !== was.generation || env.lastUsedAt !== was.lastUsedAt) continue
      env.discarding = this.discard(env, why)
      await env.discarding
    }
  }

  release(req: ExecutorReleaseReq): Promise<ExecutorReleaseResult> {
    const env = this.environments.get(sessionKeyDirName(req.sessionKey))
    if (!env) return Promise.resolve({ status: 'unknown' })
    // The CP vouched that the asker holds `req.agentId`; that says nothing about another agent's environment.
    if (env.agentId !== req.agentId) return Promise.resolve({ status: 'refused', reason: 'not_holder' })
    // A session key outlives its launches, and a release can be retransmitted or reordered past a prepare. Fenced to the
    // launch it retires, a late one finds the environment on another launch and removes nothing.
    if (env.launchId !== req.launchId) return Promise.resolve({ status: 'unknown' })
    // Marked with nothing awaited first, so a prepare arriving meanwhile is retired rather than resurrecting what is going.
    return (env.discarding ??= this.remove(env)).then(() => ({ status: 'released' }))
  }

  /** The holder judged the session retired, pipe and all; nothing here outranks that. A removal that fails is logged and left to the backstop. */
  private async remove(env: Environment): Promise<void> {
    // A launch still starting owns a shim this environment is about to stop being: let it finish, or its process outlives
    // the map entry that could have stopped it. Nothing new starts meanwhile — `discarding` is already set.
    await env.launching?.catch(() => undefined)
    await this.stopEnvironment(env)
    await this.discard(env, 'its holder released it')
  }

  // Dirtiness is never judged here: a holder's `release`, a removed agent or an expired retention is the only evidence acted on.
  private async discard(env: Environment, why: string): Promise<void> {
    try {
      await rm(join(this.sessionsDir, env.leaf), { recursive: true, force: true })
      // The record goes last, so a discard cut short is finished by the next sweep rather than forgotten.
      rmSync(join(this.sessionsDir, `${env.leaf}.json`), { force: true })
      this.environments.delete(env.leaf)
      this.deps.log.info(`executor: discarded ${env.leaf} of agent ${env.agentId} — ${why}`)
    } catch (error) {
      this.deps.log.warn(`executor: discarding ${env.leaf} failed (${message(error)})`)
    } finally {
      env.discarding = undefined
    }
  }

  drain(deadlineMs: number): Promise<void> {
    return (this.drained ??= (async () => {
      // Parsing nothing, the facet cannot tell a busy pipe from an idle one: any pipe spends the budget, none spends nothing.
      if ((this.listener?.pipeCount() ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = this.clock.setTimeout(resolve, deadlineMs)
          this.noPipes = () => {
            this.clock.clearTimeout(timer)
            resolve()
          }
        })
      }
      await this.stopAll()
    })())
  }

  private async stopAll(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.environments.values()].map((env) => env.launching))
    await Promise.all([...this.environments.values()].map((env) => this.stopEnvironment(env)))
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer !== undefined) this.clock.clearTimeout(this.reconcileTimer)
    this.reconcileTimer = undefined
    await this.stopAll()
    await this.listener?.stop()
    this.listener = undefined
  }
}

/** Start the facet. It is ON only when `sandbox.share` is set, a strategy is available and the listener is bound; otherwise it is dark, says why, and still reconciles what an earlier run left. */
export async function startExecutorFacet(deps: ExecutorFacetDeps): Promise<ExecutorFacet> {
  const facet = new Facet(deps)
  await facet.start()
  return facet
}

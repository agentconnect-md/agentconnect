// Unattended upgrade onto the CP-announced release (daemon-auto-upgrade.md §4.2, §5, §7): the CP decides what, this decides when.
import { createHash } from 'node:crypto'
import {
  CONFIG_KEY_UPGRADE_AUTO,
  CONFIG_KEY_UPGRADE_LATEST,
  DaemonRelease,
  LIFECYCLE_DEFERRED_REASON,
  type DaemonLifecycleBegin,
  type DaemonLifecycleBeginOk,
  type DaemonLifecycleProgress
} from '@agentconnect.md/protocol'
import { WireError, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import type { Quiescence } from './quiescence.js'
import {
  deleteTrialMarker,
  readAutoUpgradeState,
  readTrialMarker,
  writeAutoUpgradeState,
  writeTrialMarker,
  type AutoUpgradeState
} from './auto-upgrade-store.js'

export const AUTO_UPGRADE_EVALUATE_MS = 5 * 60_000
export const AUTO_UPGRADE_EVALUATE_JITTER_MS = 60_000
export const AUTO_UPGRADE_QUIET_MS = 5 * 60_000
export const AUTO_UPGRADE_IDLE_WAIT_MS = 10 * 60_000
export const AUTO_UPGRADE_STABLE_SPREAD_MS = 2 * 60 * 60_000
export const AUTO_UPGRADE_RETRY_BASE_MS = 5 * 60_000
export const AUTO_UPGRADE_RETRY_CAP_MS = 60 * 60_000
// Register rejections a trial version tolerates before restoring `from` (§7.2).
export const TRIAL_REGISTER_REJECTIONS = 2

// The CLI's `installTarget` wording for a version whose `engines.node` this host cannot run.
const ENGINE_MISMATCH_RE = /requires Node .* but this CLI runs on/

const AUTO_UPGRADE_CONFIG_KEYS: ReadonlySet<string> = new Set([CONFIG_KEY_UPGRADE_AUTO, CONFIG_KEY_UPGRADE_LATEST])

export interface CliRunResult {
  ok: boolean
  stderr: string
}

/** The shared admission/drain/exit seam `FleetUpgradeCoordinator` owns, so CP-commanded and automatic ops exclude each other. */
export interface AutoUpgradeLifecycle {
  reserve(
    targetVersion: string
  ): { accepted: true; root: string; cliEntry: string } | { accepted: false; reason: string }
  release(): void
  /** `agentconnect upgrade --to <v> --root <root>`: prepare and switch `current`. */
  install(cliEntry: string, targetVersion: string, root: string): Promise<boolean>
  /** Drain and exit with the reserved restart code; reports `restarting` for an operation. */
  exit(operationId?: string): void
}

/** The control-plane calls the upgrader makes; absent while no CP client exists. */
export interface AutoUpgradeCp {
  /** Mid-handshake: READY (and `serverFeatures`) is moments away, so wait for it rather than skip the record. */
  handshaking(): boolean
  /** READY and the CP advertised `daemon/lifecycle/begin`. */
  canBeginLifecycle(): boolean
  beginLifecycle(req: DaemonLifecycleBegin): Promise<DaemonLifecycleBeginOk>
  reportProgress(progress: DaemonLifecycleProgress): Promise<void>
}

/** Exactly what the AutoUpgrader touches on the Daemon. */
export interface AutoUpgradeHost {
  log(): Logger
  clock(): Clock
  root(): string
  daemonId(): string | undefined
  /** The running daemon version (`DAEMON_VERSION`). */
  version(): string
  /** The `bootstrapUpgradeCapable()` predicate: CLI/service-supervised, not k8s, a CLI entry on disk. */
  eligible(): boolean
  quiescence(): Quiescence
  /** Run `agentconnect <args> --root <root>` through the stable CLI entry. */
  runCli(args: string[]): Promise<CliRunResult>
  lifecycle(): AutoUpgradeLifecycle
  cp(): AutoUpgradeCp | undefined
  /** Exit for the supervisor's relaunch after a register-rejection rollback. */
  exitForRollback(): void
  random?(): number
}

/** The config-apply seam: routes the switch and the release here instead of into `cfg`. */
export interface AutoUpgradeConfigSink {
  applyConfigKeys(keys: Record<string, unknown>): { applied: string[]; ignored: string[] }
  applyRegisterOk(snap: { autoUpgrade?: boolean; release?: DaemonRelease }): void
}

/** The CP-client seam: trial settlement on READY and the register-rejection rollback. */
export interface AutoUpgradeCpHooks {
  onCpReady(): Promise<void>
  onRegisterRejected(err: WireError): void
}

/** Split a `config/push` payload into the auto-upgrade keys and the rest. */
export function splitAutoUpgradeKeys(keys: Record<string, unknown>): {
  upgrade: Record<string, unknown>
  rest: Record<string, unknown>
} {
  const upgrade: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(keys)) (AUTO_UPGRADE_CONFIG_KEYS.has(key) ? upgrade : rest)[key] = value
  return { upgrade, rest }
}

type ParsedVersion = { core: number[]; pre: string[] }

function parseVersion(v: string): ParsedVersion | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return undefined
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative when a < b, undefined when either is not a semver. */
export function compareSemver(a: string, b: string): number | undefined {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return undefined
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** §5.1: a deterministic per-(daemon, version) floor, so one bad release does not reach every daemon at once. */
export function rolloutDelayMs(daemonId: string, version: string, channel: string): number {
  const spread = channel === 'rc' ? 0 : AUTO_UPGRADE_STABLE_SPREAD_MS
  if (spread === 0) return 0
  const digest = createHash('sha256').update(`${daemonId}\0${version}`).digest()
  return digest.readUIntBE(0, 6) % spread
}

type IdleWaitOutcome = 'idle' | 'busy' | 'withdrawn' | 'disabled' | 'stopped'

export class AutoUpgrader implements AutoUpgradeConfigSink, AutoUpgradeCpHooks {
  private state: AutoUpgradeState = { skipped: [] }
  private staged?: string
  private backoff?: { version: string; attempts: number; until: number }
  private upgrading?: { target: string }
  private exiting = false
  private stopped = true
  private running?: Promise<void>
  private rerun = false
  private timer?: TimerHandle
  private wakeAt?: number
  private wakeWaiter?: () => void
  private unsubscribe?: () => void
  private registerRejections = 0

  constructor(private readonly host: AutoUpgradeHost) {}

  /** Load persisted state and start the evaluation timer; a rolled-back version is skipped before any CP contact. */
  start(): void {
    this.stopped = false
    this.state = readAutoUpgradeState(this.host.root())
    const version = this.host.version()
    // Running a skipped version means someone chose it by hand; that lifts the skip (§7.3).
    if (this.state.skipped.some((s) => s.version === version)) {
      this.state.skipped = this.state.skipped.filter((s) => s.version !== version)
      this.persist()
    }
    const marker = readTrialMarker(this.host.root())
    if (marker?.rolledBack) this.skip(marker.to, marker.rolledBack.reason)
    // An announcement persisted by an older binary is re-judged against this one.
    if (this.state.release !== undefined) this.adoptRelease(this.state.release)
    this.unsubscribe = this.host.quiescence().onChange(() => this.poke())
    this.armTimer()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer !== undefined) this.host.clock().clearTimeout(this.timer)
    this.timer = undefined
    this.wakeWaiter?.()
  }

  /** The switch is on and this daemon could carry an upgrade out unattended. */
  active(): boolean {
    return this.state.enabled === true && this.host.eligible()
  }

  candidate(): string | undefined {
    return this.state.candidate?.version
  }

  skipped(): readonly { version: string; reason: string }[] {
    return this.state.skipped
  }

  applyConfigKeys(keys: Record<string, unknown>): { applied: string[]; ignored: string[] } {
    const applied: string[] = []
    const ignored: string[] = []
    for (const [key, value] of Object.entries(keys)) {
      if (key === CONFIG_KEY_UPGRADE_AUTO && typeof value === 'boolean') {
        this.setEnabled(value)
        applied.push(key)
      } else if (key === CONFIG_KEY_UPGRADE_LATEST && (value === null || DaemonRelease.safeParse(value).success)) {
        this.setRelease(value === null ? null : DaemonRelease.parse(value))
        applied.push(key)
      } else ignored.push(key)
    }
    return { applied, ignored }
  }

  applyRegisterOk(snap: { autoUpgrade?: boolean; release?: DaemonRelease }): void {
    // Absent means an older CP or an unresolved release: keep what was persisted.
    if (snap.autoUpgrade !== undefined) this.setEnabled(snap.autoUpgrade, false)
    if (snap.release) this.setRelease(snap.release, false)
  }

  setEnabled(enabled: boolean, evaluate = true): void {
    if (this.state.enabled === enabled) return
    this.state.enabled = enabled
    this.persist()
    this.host.log().info(`auto-upgrade: switch ${enabled ? 'on' : 'off'}`)
    if (evaluate) this.poke()
    else this.wakeWaiter?.()
  }

  /** Each announcement replaces the last; one that is not strictly newer clears the candidate (§4.2). */
  setRelease(release: DaemonRelease | null, evaluate = true): void {
    this.state.release = release
    this.adoptRelease(release)
    this.persist()
    if (evaluate) this.poke()
    else this.wakeWaiter?.()
  }

  private adoptRelease(release: DaemonRelease | null): void {
    const current = this.state.candidate
    const newer =
      release !== null &&
      (compareSemver(release.version, this.host.version()) ?? 0) > 0 &&
      !this.state.skipped.some((s) => s.version === release.version)
    if (!newer) {
      if (current) {
        const why = release ? `announced ${release.version} is not newer or is skipped` : 'no release announced'
        this.host.log().info(`auto-upgrade: dropping candidate ${current.version} — ${why}`)
      }
      this.state.candidate = undefined
      this.staged = undefined
      return
    }
    if (current?.version === release.version) {
      current.channel = release.channel
      return
    }
    this.state.candidate = { version: release.version, channel: release.channel, firstSeenAt: this.host.clock().now() }
    this.staged = undefined
    this.backoff = undefined
    this.host.log().info(`auto-upgrade: candidate ${release.version} (${release.channel})`)
  }

  async onCpReady(): Promise<void> {
    this.registerRejections = 0
    if (!this.upgrading) await this.settleTrialMarker()
    this.poke()
  }

  /** §7.2: a trial version the CP authenticates but refuses to register, twice, restores `from`. Unreachable is never a reason. */
  onRegisterRejected(err: WireError): void {
    if (err.retryable) return
    const root = this.host.root()
    const marker = readTrialMarker(root)
    if (!marker || marker.rolledBack || marker.to !== this.host.version() || this.exiting) return
    this.registerRejections += 1
    this.host.log().warn(`auto-upgrade: register rejected on trial ${marker.to} (${err.code}: ${err.message})`)
    if (this.registerRejections < TRIAL_REGISTER_REJECTIONS) return
    this.exiting = true
    const reason = `register rejected: ${err.code}`.slice(0, 500)
    void (async () => {
      const restored = await this.host.runCli(['version', 'use', marker.from])
      if (!restored.ok) {
        this.host.log().error(`auto-upgrade: could not restore ${marker.from}: ${restored.stderr.trim()}`)
        this.exiting = false
        return
      }
      writeTrialMarker(root, { ...marker, rolledBack: { reason, at: new Date(this.host.clock().now()).toISOString() } })
      this.skip(marker.to, reason)
      this.host.log().error(`auto-upgrade: rolled back ${marker.to} → ${marker.from} (${reason}); restarting`)
      this.host.exitForRollback()
    })()
  }

  /** Re-evaluate now (announcement, switch, quiescence edge) and wake an idle wait. */
  poke(): void {
    this.wakeWaiter?.()
    void this.evaluate()
  }

  /** Single-flight evaluation; overlapping triggers coalesce into one more pass. */
  evaluate(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const run = (async () => {
      try {
        do {
          this.rerun = false
          this.wakeAt = undefined
          await this.step()
        } while (this.rerun && !this.stopped)
      } catch (err) {
        this.host.log().error(`auto-upgrade: evaluation failed: ${formatErr(err)}`)
      } finally {
        this.running = undefined
        this.armTimer()
      }
    })()
    this.running = run
    return run
  }

  private async step(): Promise<void> {
    if (!this.active() || this.exiting) return
    const candidate = this.state.candidate
    if (!candidate) return
    const now = this.host.clock().now()
    const notBefore =
      candidate.firstSeenAt + rolloutDelayMs(this.host.daemonId() ?? '', candidate.version, candidate.channel)
    if (now < notBefore) return this.wakeAtLeast(notBefore)
    if (this.backoff?.version === candidate.version && now < this.backoff.until)
      return this.wakeAtLeast(this.backoff.until)
    if (this.staged !== candidate.version) {
      if (!(await this.stage(candidate.version))) return
      if (this.state.candidate?.version !== candidate.version || !this.active()) return
    }
    if (!this.idle(false)) return
    if (this.host.cp()?.handshaking()) return
    await this.upgrade(candidate.version)
  }

  private async stage(version: string): Promise<boolean> {
    const log = this.host.log()
    log.info(`auto-upgrade: staging ${version}`)
    const result = await this.host.runCli(['version', 'install', version])
    if (result.ok) {
      this.staged = version
      if (this.backoff?.version === version) this.backoff = undefined
      return true
    }
    if (ENGINE_MISMATCH_RE.test(result.stderr)) {
      log.warn(`auto-upgrade: ${version} cannot run on this host's Node — skipping it`)
      this.skip(version, 'engines')
      return false
    }
    this.retryLater(
      version,
      `could not stage ${version}: ${result.stderr.trim().split('\n').pop() ?? 'install failed'}`
    )
    return false
  }

  private retryLater(version: string, why: string, delayMs?: number): void {
    const attempts = this.backoff?.version === version ? this.backoff.attempts + 1 : 1
    const delay = delayMs ?? Math.min(AUTO_UPGRADE_RETRY_CAP_MS, AUTO_UPGRADE_RETRY_BASE_MS * 2 ** (attempts - 1))
    this.backoff = { version, attempts, until: this.host.clock().now() + delay }
    this.host.log().warn(`auto-upgrade: ${why}; retrying in ${Math.round(delay / 60_000)} min`)
  }

  /** Quiescent and quiet long enough; `holdsLifecycle` discounts the reservation this upgrader itself holds. */
  private idle(holdsLifecycle: boolean): boolean {
    const q = this.host.quiescence()
    if (q.busyReason(holdsLifecycle) !== undefined) return false
    const quietFor = q.quietForMs()
    if (quietFor >= AUTO_UPGRADE_QUIET_MS) return true
    this.wakeAtLeast(this.host.clock().now() + AUTO_UPGRADE_QUIET_MS - quietFor)
    return false
  }

  private async upgrade(target: string): Promise<void> {
    const log = this.host.log()
    const lifecycle = this.host.lifecycle()
    const admission = lifecycle.reserve(target)
    if (!admission.accepted) {
      log.info(`auto-upgrade: not now — ${admission.reason}`)
      return
    }
    const from = this.host.version()
    const root = this.host.root()
    this.upgrading = { target }
    let operationId: string | undefined
    try {
      const cp = this.host.cp()
      if (cp?.canBeginLifecycle()) {
        try {
          operationId = (
            await cp.beginLifecycle({ op: 'upgrade', trigger: 'auto', fromVersion: from, targetVersion: target })
          ).operationId
        } catch (err) {
          if (err instanceof WireError && err.code === 'CONFLICT') {
            this.retryLater(
              target,
              'another lifecycle operation is pending on the control plane',
              AUTO_UPGRADE_RETRY_BASE_MS
            )
            return
          }
          log.warn(`auto-upgrade: proceeding without an operation record: ${formatErr(err)}`)
        }
      }
      writeTrialMarker(root, {
        from,
        to: target,
        ...(operationId ? { operationId } : {}),
        startedAt: new Date(this.host.clock().now()).toISOString(),
        failures: 0
      })
      log.info(`auto-upgrade: upgrading ${from} → ${target}${operationId ? ` (operation ${operationId})` : ''}`)
      await this.report(operationId, 'preparing')
      if (!(await lifecycle.install(admission.cliEntry, target, admission.root))) {
        deleteTrialMarker(root)
        this.staged = undefined
        await this.report(operationId, 'failed', `could not prepare ${target}`)
        this.retryLater(target, `could not prepare ${target}`)
        return
      }
      const outcome = await this.waitForIdle(target)
      if (outcome === 'idle') {
        this.exiting = true
        lifecycle.exit(operationId)
        return
      }
      // A process stop mid-wait leaves the switch and the marker: the next boot is the trial.
      if (outcome === 'stopped') return
      await this.revert(from, target, operationId, outcome)
    } catch (err) {
      log.error(`auto-upgrade: upgrade to ${target} failed: ${formatErr(err)}`)
    } finally {
      this.upgrading = undefined
      if (!this.exiting) lifecycle.release()
    }
  }

  private async revert(
    from: string,
    target: string,
    operationId: string | undefined,
    outcome: IdleWaitOutcome
  ): Promise<void> {
    const log = this.host.log()
    const restored = await this.host.runCli(['version', 'use', from])
    // Without the switch back, the marker must stay: the next boot runs `target` and needs its trial protection.
    if (restored.ok) deleteTrialMarker(this.host.root())
    else log.error(`auto-upgrade: could not switch back to ${from}: ${restored.stderr.trim()}`)
    const reason =
      outcome === 'busy'
        ? LIFECYCLE_DEFERRED_REASON
        : outcome === 'withdrawn'
          ? `release ${target} withdrawn`
          : 'auto-upgrade turned off'
    log.info(`auto-upgrade: upgrade to ${target} put off (${reason}); staying on ${from}`)
    await this.report(operationId, 'failed', reason)
  }

  /** Wait up to the idle budget for quiescence after preparing; a withdrawn release or switch-off aborts it. */
  private async waitForIdle(target: string): Promise<IdleWaitOutcome> {
    const clock = this.host.clock()
    const deadline = clock.now() + AUTO_UPGRADE_IDLE_WAIT_MS
    for (;;) {
      if (this.stopped) return 'stopped'
      if (!this.active()) return 'disabled'
      if (this.state.candidate?.version !== target) return 'withdrawn'
      this.wakeAt = undefined
      if (this.idle(true)) return 'idle'
      const now = clock.now()
      if (now >= deadline) return 'busy'
      const wakeAt = Math.min(deadline, this.wakeAt ?? deadline)
      await new Promise<void>((resolve) => {
        const timer = clock.setTimeout(() => done(), Math.max(0, wakeAt - now))
        const done = () => {
          clock.clearTimeout(timer)
          if (this.wakeWaiter === done) this.wakeWaiter = undefined
          resolve()
        }
        this.wakeWaiter = done
      })
    }
  }

  private async settleTrialMarker(): Promise<void> {
    const root = this.host.root()
    const marker = readTrialMarker(root)
    if (!marker) return
    const log = this.host.log()
    if (marker.rolledBack) {
      this.skip(marker.to, marker.rolledBack.reason)
      await this.report(marker.operationId, 'failed', `rolled back: ${marker.rolledBack.reason}`)
      log.warn(
        `auto-upgrade: ${marker.to} was rolled back (${marker.rolledBack.reason}); staying on ${this.host.version()}`
      )
    } else if (marker.to === this.host.version()) {
      log.info(`auto-upgrade: ${marker.from} → ${marker.to} reached READY`)
    }
    deleteTrialMarker(root)
  }

  private skip(version: string, reason: string): void {
    if (!this.state.skipped.some((s) => s.version === version)) {
      this.state.skipped.push({ version, reason, at: new Date(this.host.clock().now()).toISOString() })
    }
    if (this.state.candidate?.version === version) {
      this.state.candidate = undefined
      this.staged = undefined
    }
    this.persist()
  }

  private async report(
    operationId: string | undefined,
    phase: DaemonLifecycleProgress['phase'],
    reason?: string
  ): Promise<void> {
    const cp = this.host.cp()
    if (!operationId || !cp) return
    try {
      await cp.reportProgress({ operationId, phase, ...(reason ? { reason: reason.slice(0, 500) } : {}) })
    } catch (err) {
      this.host.log().warn(`auto-upgrade: could not report ${phase}: ${formatErr(err)}`)
    }
  }

  private persist(): void {
    try {
      writeAutoUpgradeState(this.host.root(), this.state)
    } catch (err) {
      this.host.log().warn(`auto-upgrade: could not persist state: ${formatErr(err)}`)
    }
  }

  private wakeAtLeast(at: number): void {
    this.wakeAt = this.wakeAt === undefined ? at : Math.min(this.wakeAt, at)
  }

  private armTimer(): void {
    if (this.stopped) return
    const clock = this.host.clock()
    if (this.timer !== undefined) clock.clearTimeout(this.timer)
    const jitter = Math.floor((this.host.random?.() ?? Math.random()) * AUTO_UPGRADE_EVALUATE_JITTER_MS)
    const periodic = AUTO_UPGRADE_EVALUATE_MS + jitter
    const delay = this.wakeAt === undefined ? periodic : Math.min(periodic, Math.max(0, this.wakeAt - clock.now()))
    this.timer = clock.setTimeout(() => {
      this.timer = undefined
      void this.evaluate()
    }, delay)
  }
}

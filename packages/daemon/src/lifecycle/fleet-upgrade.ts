import {
  K8S_SUPERVISOR,
  RESERVED_RESTART_CODE,
  type DaemonControlAck,
  type DaemonLifecycleProgress
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import { cliEntryPointer, resolveRoot } from '../paths.js'
import { readCliEntry, runCliUpgrade } from './cli-upgrade.js'
import type { BootstrapUpgradeOutcome } from '../cp/client.js'
import type { Logger } from '../log.js'
import { DAEMON_VERSION } from '../version.js'
import { formatErr } from '../daemon/text.js'

/** Exactly what the fleet restart/upgrade path touches on the Daemon. */
export interface FleetUpgradeHost {
  log: () => Logger
  clock: () => Clock
  shutdownDrainMs: () => number
  /** Who supervises this process — 'cli', 'service', 'k8s', or absent (bare `run`). */
  supervisor: () => string | undefined
  k8s: () => boolean
  root: () => string | undefined
  configPath: () => string | undefined
  upgradeInstaller: () => typeof runCliUpgrade | undefined
  reportProgress: (progress: DaemonLifecycleProgress) => Promise<void>
  stop: () => Promise<void>
  requestExit: (code: number) => void
}

type FleetExitKind = 'restart' | 'upgrade'

type FleetAdmission =
  { accepted: false; reason: string } | { accepted: true; root: string; cliEntry?: string; willDrainUntil?: string }

/** CP-commanded daemon restart and self-installing upgrade (§7.1/§7.2). */
export class FleetUpgradeCoordinator {
  // Guards against a second CP lifecycle command (restart/upgrade) racing one
  // already in flight (§7.1). Cleared only if an upgrade aborts before exiting.
  private lifecycleInFlight = false
  private fleetUpgradeInFlight?: { targetVersion: string; installation: Promise<boolean> }
  private fleetExitStarted = false

  constructor(private readonly host: FleetUpgradeHost) {}

  private admitFleetExit(kind: FleetExitKind, targetVersion?: string): FleetAdmission {
    const log = this.host.log()
    const refuse = (reason: string) => {
      log.warn(`cp: ${kind} refused — ${reason}`)
      return { accepted: false as const, reason }
    }
    const supervisor = this.host.supervisor()
    const imageOwnsVersion = "the running version is this pod's image — roll the Deployment instead of self-installing"
    // Refused on the MODE, not the marker: a live upgrade is delivered without consulting
    // the advertised capability, so this is the last line of defence, and an inherited
    // AGENTCONNECT_SUPERVISOR plus a stale cli-entry on the root volume must not reach the
    // installer — the same invariant bootstrapUpgradeCapable() already holds.
    if (kind === 'upgrade' && this.host.k8s()) return refuse(imageOwnsVersion)
    // The kubelet restarts the container in place after the reserved exit code, but never
    // changes the image, so it supervises restart and not upgrade.
    if (supervisor === K8S_SUPERVISOR) {
      if (kind === 'upgrade') return refuse(imageOwnsVersion)
    } else if (supervisor !== 'cli' && supervisor !== 'service') {
      const reason = `no supervisor (AGENTCONNECT_SUPERVISOR=${supervisor ?? 'unset'}) — a bare \`run\` cannot ${kind}; use the CLI or an installed service`
      return refuse(reason)
    }
    if (this.lifecycleInFlight) {
      return refuse('another lifecycle operation is already in progress')
    }

    const root = resolveRoot(this.host.root())
    let cliEntry: string | undefined
    if (kind === 'upgrade') {
      cliEntry = readCliEntry(root)
      if (!cliEntry) {
        const reason = `cannot locate the CLI (${cliEntryPointer(root)} missing or invalid) to run the upgrade`
        return refuse(reason)
      }
      if (!targetVersion) return refuse('upgrade requires a targetVersion')
    }

    this.lifecycleInFlight = true
    const willDrainUntil =
      kind === 'restart' ? new Date(this.host.clock().now() + this.host.shutdownDrainMs()).toISOString() : undefined
    log.info(`cp: ${kind}${targetVersion ? ` → ${targetVersion}` : ''} accepted`)
    return { accepted: true, root, ...(cliEntry ? { cliEntry } : {}), ...(willDrainUntil ? { willDrainUntil } : {}) }
  }

  private async reportProgress(
    operationId: string | undefined,
    phase: DaemonLifecycleProgress['phase']
  ): Promise<void> {
    if (!operationId) return
    try {
      await this.host.reportProgress({ operationId, phase })
    } catch (err) {
      this.host.log().warn(`cp: could not report upgrade progress: ${formatErr(err)}`)
    }
  }

  private startFleetUpgrade(
    cliEntry: string,
    targetVersion: string,
    root: string,
    operationId?: string
  ): Promise<boolean> {
    const log = this.host.log()
    const installation = Promise.resolve()
      .then(async () => {
        await this.reportProgress(operationId, 'preparing')
        return (this.host.upgradeInstaller() ?? runCliUpgrade)(
          cliEntry,
          targetVersion,
          root,
          log,
          this.host.configPath()
        )
      })
      .catch((err) => {
        log.error(`cp: could not install daemon ${targetVersion}: ${formatErr(err)}`)
        return false
      })
      .then(async (ok) => {
        if (!ok) {
          await this.reportProgress(operationId, 'failed')
          log.error(`cp: upgrade to ${targetVersion} aborted — daemon continues on the current version`)
          this.lifecycleInFlight = false
          if (this.fleetUpgradeInFlight?.installation === installation) this.fleetUpgradeInFlight = undefined
        }
        return ok
      })
    this.fleetUpgradeInFlight = { targetVersion, installation }
    return installation
  }

  private finishFleetExit(kind: FleetExitKind, operationId?: string): void {
    if (this.fleetExitStarted) return
    this.fleetExitStarted = true
    void (async () => {
      try {
        await this.reportProgress(operationId, 'restarting')
        await this.host.stop()
      } catch (err) {
        this.host.log().error(`cp: ${kind} shutdown failed: ${formatErr(err)}`)
      } finally {
        this.host.requestExit(RESERVED_RESTART_CODE)
      }
    })()
  }

  /** Admit immediately, then install before the existing drain-and-relaunch path. */
  scheduleFleetExit(kind: FleetExitKind, targetVersion?: string, operationId?: string): DaemonControlAck {
    const admission = this.admitFleetExit(kind, targetVersion)
    if (!admission.accepted) return admission
    void (async () => {
      if (
        kind === 'upgrade' &&
        !(await this.startFleetUpgrade(admission.cliEntry!, targetVersion!, admission.root, operationId))
      ) {
        return
      }
      this.finishFleetExit(kind, operationId)
    })()

    return { accepted: true, ...(admission.willDrainUntil ? { willDrainUntil: admission.willDrainUntil } : {}) }
  }

  async runBootstrapFleetUpgrade(targetVersion: string, operationId?: string): Promise<BootstrapUpgradeOutcome> {
    if (targetVersion === DAEMON_VERSION) return { status: 'current' }
    const existing = this.fleetUpgradeInFlight
    if (existing?.targetVersion === targetVersion) {
      const installed = await existing.installation
      if (installed) await this.reportProgress(operationId, 'restarting')
      return installed
        ? { status: 'installed', restart: () => this.finishFleetExit('upgrade') }
        : { status: 'failed', reason: `failed to install ${targetVersion}` }
    }
    const admission = this.admitFleetExit('upgrade', targetVersion)
    if (!admission.accepted) return { status: 'failed', reason: admission.reason }
    if (!(await this.startFleetUpgrade(admission.cliEntry!, targetVersion, admission.root, operationId))) {
      return { status: 'failed', reason: `failed to install ${targetVersion}` }
    }
    await this.reportProgress(operationId, 'restarting')
    return { status: 'installed', restart: () => this.finishFleetExit('upgrade') }
  }
}

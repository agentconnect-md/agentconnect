import { K8S_SUPERVISOR, RESERVED_RESTART_CODE, type DaemonControlAck } from '@agentconnect.md/protocol'
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
  upgradeInstaller: () => typeof runCliUpgrade | undefined
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

  private startFleetUpgrade(cliEntry: string, targetVersion: string, root: string): Promise<boolean> {
    const log = this.host.log()
    const installation = Promise.resolve()
      .then(() => (this.host.upgradeInstaller() ?? runCliUpgrade)(cliEntry, targetVersion, root, log))
      .catch((err) => {
        log.error(`cp: could not install daemon ${targetVersion}: ${formatErr(err)}`)
        return false
      })
      .then((ok) => {
        if (!ok) {
          log.error(`cp: upgrade to ${targetVersion} aborted — daemon continues on the current version`)
          this.lifecycleInFlight = false
          if (this.fleetUpgradeInFlight?.installation === installation) this.fleetUpgradeInFlight = undefined
        }
        return ok
      })
    this.fleetUpgradeInFlight = { targetVersion, installation }
    return installation
  }

  private finishFleetExit(kind: FleetExitKind): void {
    if (this.fleetExitStarted) return
    this.fleetExitStarted = true
    void (async () => {
      try {
        await this.host.stop()
      } catch (err) {
        this.host.log().error(`cp: ${kind} shutdown failed: ${formatErr(err)}`)
      } finally {
        this.host.requestExit(RESERVED_RESTART_CODE)
      }
    })()
  }

  /** Admit immediately, then install before the existing drain-and-relaunch path. */
  scheduleFleetExit(kind: FleetExitKind, targetVersion?: string): DaemonControlAck {
    const admission = this.admitFleetExit(kind, targetVersion)
    if (!admission.accepted) return admission
    void (async () => {
      if (kind === 'upgrade' && !(await this.startFleetUpgrade(admission.cliEntry!, targetVersion!, admission.root))) {
        return
      }
      this.finishFleetExit(kind)
    })()

    return { accepted: true, ...(admission.willDrainUntil ? { willDrainUntil: admission.willDrainUntil } : {}) }
  }

  async runBootstrapFleetUpgrade(targetVersion: string): Promise<BootstrapUpgradeOutcome> {
    if (targetVersion === DAEMON_VERSION) return { status: 'current' }
    const existing = this.fleetUpgradeInFlight
    if (existing?.targetVersion === targetVersion) {
      const installed = await existing.installation
      return installed
        ? { status: 'installed', restart: () => this.finishFleetExit('upgrade') }
        : { status: 'failed', reason: `failed to install ${targetVersion}` }
    }
    const admission = this.admitFleetExit('upgrade', targetVersion)
    if (!admission.accepted) return { status: 'failed', reason: admission.reason }
    if (!(await this.startFleetUpgrade(admission.cliEntry!, targetVersion, admission.root))) {
      return { status: 'failed', reason: `failed to install ${targetVersion}` }
    }
    return { status: 'installed', restart: () => this.finishFleetExit('upgrade') }
  }
}

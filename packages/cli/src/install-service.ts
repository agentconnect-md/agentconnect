/** The privileged half of service lifecycle. A Linux system unit is written by root
 *  but run as the operator's account, so install/uninstall re-execute themselves
 *  through sudo while `up`/`down`/`restart` stay unprivileged via the polkit rule. */
import {
  defaultElevateDeps,
  elevate,
  findUserScopeUnit,
  installService,
  isElevated,
  repairRootOwnership,
  retireUserScopeUnit,
  serviceAccountFor,
  shouldBakeRootEnv,
  uninstallService,
  type ControllerTarget,
  type ElevateDeps,
  type Exec,
  type OwnershipDeps,
  type InstallOpts,
  type ServiceController
} from './service/index.js'
import { findInstanceUnit } from './service/discover.js'

export interface ServiceCommandParams {
  root: string
  instance?: string
  cliEntry: string
  execPath?: string
  /** `--service-user`: which account a new system unit runs as. */
  serviceUser?: string
  /** `--service-path`: the pre-sudo `PATH` snapshot, since sudo replaces `PATH`. */
  servicePath?: string
  log?: (m: string) => void
  platform?: NodeJS.Platform
  /** Test seams: injected process runner and unit/polkit directories, plus the
   *  elevation dependencies, so the whole flow is drivable without root. */
  exec?: Exec
  home?: string
  systemUnitDir?: string
  polkitDir?: string
  elevateDeps?: ElevateDeps
  ownershipDeps?: OwnershipDeps
}

/** `delegated` means sudo ran a second CLI that did the work; its code is the result. */
export type ServiceCommandOutcome =
  { kind: 'done'; controller: ServiceController; unprivilegedControl: boolean } | { kind: 'delegated'; code: number }

function targetOf(p: ServiceCommandParams): ControllerTarget {
  return {
    root: p.root,
    ...(p.instance !== undefined ? { instance: p.instance } : {}),
    ...(p.platform !== undefined ? { platform: p.platform } : {}),
    ...(p.exec !== undefined ? { exec: p.exec } : {}),
    ...(p.home !== undefined ? { home: p.home } : {}),
    ...(p.systemUnitDir !== undefined ? { systemUnitDir: p.systemUnitDir } : {}),
    ...(p.polkitDir !== undefined ? { polkitDir: p.polkitDir } : {})
  }
}

function installOptsOf(p: ServiceCommandParams): InstallOpts {
  // Elevated, `process.env.PATH` is sudo's secure_path, not the operator's — the
  // snapshot taken before elevation is the one that belongs in the unit.
  const envPath = p.servicePath ?? process.env.PATH
  return {
    execPath: p.execPath ?? process.execPath,
    includeRootEnv: shouldBakeRootEnv(p.root),
    cliEntry: p.cliEntry,
    ...(envPath ? { envPath } : {})
  }
}

function needsElevation(p: ServiceCommandParams, scope: 'system' | 'user'): boolean {
  return (p.platform ?? process.platform) === 'linux' && scope === 'system' && !isElevated()
}

export async function performInstallService(p: ServiceCommandParams): Promise<ServiceCommandOutcome> {
  const log = p.log ?? ((m: string) => console.log(m))
  const platform = p.platform ?? process.platform
  if (platform === 'linux' && !isElevated()) {
    // Retire the legacy user unit FIRST and unelevated: `systemctl --user` only
    // reaches the caller's own manager, so root could not do it on their behalf,
    // and leaving it would give this root a second daemon at the next login.
    const legacy = findUserScopeUnit(targetOf(p))
    if (legacy) {
      await retireUserScopeUnit(legacy, targetOf(p))
      log(`agentconnect: retired the per-user unit ${legacy.label} (it could not survive logout)`)
    }
  }
  const account = serviceAccountFor(platform, { ...(p.serviceUser ? { serviceUser: p.serviceUser } : {}) })
  const opts = installOptsOf(p)
  if (account && needsElevation(p, 'system')) {
    log('agentconnect: installing a system unit needs root — re-running through sudo')
    const outcome = elevate(
      {
        command: 'install-service',
        root: p.root,
        ...(p.instance ? { instance: p.instance } : {}),
        account,
        ...(opts.envPath ? { envPath: opts.envPath } : {})
      },
      p.elevateDeps ?? defaultElevateDeps(p.execPath ?? process.execPath, p.cliEntry)
    )
    if (!outcome.elevated) return { kind: 'delegated', code: outcome.code }
  }
  const controller = await installService({ ...targetOf(p), ...(account ? { account } : {}) }, opts)
  // Elevated, everything written under <root> so far belongs to root — including
  // the root directory itself when this install created it.
  if (account && isElevated()) {
    const repaired = repairRootOwnership(p.root, account, p.ownershipDeps ?? {})
    if (repaired.length > 0)
      log(`agentconnect: handed ${repaired.length} path(s) under ${p.root} back to ${account.user}`)
  }
  return { kind: 'done', controller, unprivilegedControl: hasUnprivilegedControl(controller) }
}

export async function performUninstallService(p: ServiceCommandParams): Promise<ServiceCommandOutcome> {
  const log = p.log ?? ((m: string) => console.log(m))
  const platform = p.platform ?? process.platform
  // A legacy user unit is removable without root; only a system unit needs it.
  const installed = findInstanceUnit(p.instance, {
    ...(p.platform ? { platform: p.platform } : {}),
    ...(p.home !== undefined ? { home: p.home } : {}),
    ...(p.systemUnitDir !== undefined ? { systemUnitDir: p.systemUnitDir } : {})
  })
  const scope = installed?.scope ?? 'system'
  if (needsElevation(p, scope)) {
    log('agentconnect: removing a system unit needs root — re-running through sudo')
    const account = serviceAccountFor(platform, { ...(p.serviceUser ? { serviceUser: p.serviceUser } : {}) })
    if (account) {
      const outcome = elevate(
        {
          command: 'uninstall-service',
          root: p.root,
          ...(p.instance ? { instance: p.instance } : {}),
          account
        },
        p.elevateDeps ?? defaultElevateDeps(p.execPath ?? process.execPath, p.cliEntry)
      )
      if (!outcome.elevated) return { kind: 'delegated', code: outcome.code }
    }
  }
  const controller = await uninstallService(targetOf(p))
  return { kind: 'done', controller, unprivilegedControl: true }
}

/** Only the systemd controller has a polkit story; launchd agents are always the
 *  caller's own and need nothing. */
function hasUnprivilegedControl(controller: ServiceController): boolean {
  const c = controller as ServiceController & { hasUnprivilegedControl?: () => boolean }
  return c.hasUnprivilegedControl ? c.hasUnprivilegedControl() : true
}

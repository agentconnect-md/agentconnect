/** Platform dispatch for the OS-service layer. `pickController` chooses launchd
 *  vs systemd; `resolveController` builds one from runtime/process info;
 *  `installService`/`uninstallService` wrap install with the `<root>/service.json`
 *  pointer, and `listInstances` enumerates every instance installed on the host. */
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { isElevated, resolveServiceAccount, type ServiceAccount } from './account.js'
import { findInstanceUnit, listInstances } from './discover.js'
import { defaultExec } from './exec.js'
import { clearInstancePointer, commandSelector, resolveServiceTarget, writeInstancePointer } from './instance.js'
import { LaunchdController } from './launchd.js'
import { SystemdController } from './systemd.js'
import type { ControllerDeps, Exec, InstalledUnit, InstallOpts, ServiceController } from './types.js'

export type { ServiceController, ServiceStatus, InstallOpts, InstalledUnit, Exec } from './types.js'
export { findInstanceUnit, listInstances, type DiscoveryScope } from './discover.js'
export {
  assertInstanceName,
  commandSelector,
  instanceRoot,
  readInstancePointer,
  resolveServiceTarget,
  shouldBakeRootEnv
} from './instance.js'
export {
  currentAccount,
  isElevated,
  lookupAccount,
  repairRootOwnership,
  resolveServiceAccount,
  rootOwnershipPaths,
  sudoAccountName,
  type OwnershipDeps,
  type ServiceAccount
} from './account.js'
export { defaultElevateDeps, elevate, manualSudoCommand, type ElevateDeps, type ElevationRequest } from './elevate.js'
export { POLKIT_VERBS, polkitRulePath, polkitRulesSupported } from './polkit.js'
export { SystemdController, systemdUnitName, type SystemdScope } from './systemd.js'

export function pickController(platform: NodeJS.Platform, deps: ControllerDeps): ServiceController {
  if (platform === 'darwin') return new LaunchdController(deps)
  if (platform === 'linux') return new SystemdController(deps)
  throw new Error(`system service install is not supported on ${platform} yet — use \`agentconnect run\``)
}

/**
 * Which instance a command addresses. An explicit `instance` wins; otherwise the
 * instance recorded in the root is adopted, so a `--root`-only invocation — the
 * CP-commanded `upgrade --root <root>` the daemon spawns — finds the same unit.
 */
export interface ControllerTarget {
  root?: string
  instance?: string
  exec?: Exec
  platform?: NodeJS.Platform
  home?: string
  /** The account a new Linux system unit runs as. Resolved lazily (and only on
   *  Linux) so macOS and read-only commands never need a passwd lookup. */
  account?: ServiceAccount
  /** Force a systemd scope. Normally left unset so resolution follows what is
   *  installed, falling back to `system` for a fresh install. */
  scope?: 'system' | 'user'
  systemUnitDir?: string
  polkitDir?: string
}

function scopeOf(target: ControllerTarget): { home?: string; platform?: NodeJS.Platform; systemUnitDir?: string } {
  return {
    ...(target.home !== undefined ? { home: target.home } : {}),
    ...(target.platform !== undefined ? { platform: target.platform } : {}),
    ...(target.systemUnitDir !== undefined ? { systemUnitDir: target.systemUnitDir } : {})
  }
}

function resolved(target: ControllerTarget): { root: string; instance?: string } {
  return resolveServiceTarget({
    ...(target.root !== undefined ? { root: target.root } : {}),
    ...(target.instance !== undefined ? { instance: target.instance } : {}),
    ...scopeOf(target)
  })
}

function depsFor(
  target: ControllerTarget,
  unit: { root: string; instance?: string; scope?: 'system' | 'user' }
): ControllerDeps {
  return {
    root: unit.root,
    home: target.home ?? homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    exec: target.exec ?? defaultExec,
    ...(unit.instance ? { instance: unit.instance } : {}),
    ...(unit.scope ? { scope: unit.scope } : {}),
    ...(target.account ? { account: target.account } : {}),
    ...(target.systemUnitDir !== undefined ? { systemUnitDir: target.systemUnitDir } : {}),
    ...(target.polkitDir !== undefined ? { polkitDir: target.polkitDir } : {})
  }
}

/** A controller for the addressed instance. The scope comes from the unit that is
 *  actually installed — otherwise `up`/`status` on a host still running a legacy
 *  user unit would report "not installed" and offer to install a second one. */
export function resolveController(target: ControllerTarget = {}): ServiceController {
  const { root, instance } = resolved(target)
  const installed = target.scope ? undefined : findInstanceUnit(instance, scopeOf(target))
  const scope = target.scope ?? installed?.scope
  return pickController(
    target.platform ?? process.platform,
    depsFor(target, { root, ...(instance ? { instance } : {}), ...(scope ? { scope } : {}) })
  )
}

/** The legacy `~/.config/systemd/user` unit for this instance, if one is installed. */
export function findUserScopeUnit(target: ControllerTarget = {}): InstalledUnit | undefined {
  if ((target.platform ?? process.platform) !== 'linux') return undefined
  const { instance } = resolved(target)
  return listInstances(scopeOf(target)).find((u) => u.instance === instance && u.scope === 'user')
}

/**
 * Retire a legacy user unit before its system replacement goes in, so one root is
 * never driven by two enabled units. Runs UNELEVATED on purpose: `systemctl --user`
 * addresses the caller's own manager, which root cannot reach on its behalf.
 *
 * `systemctl --user` addresses a unit by LABEL, and the manager it reaches is the
 * one for this process's uid — unrelated to the home the unit file was scanned
 * from. So the manager is asked which file it actually loaded, and the stop is
 * issued only when that is this very file; otherwise the command would retire a
 * different account's live daemon and only the file is removed.
 */
export async function retireUserScopeUnit(unit: InstalledUnit, target: ControllerTarget = {}): Promise<void> {
  const exec = target.exec ?? defaultExec
  if (await managerLoadedThisFile(unit, exec)) {
    await exec('systemctl', ['--user', 'disable', '--now', unit.label])
    rmSync(unit.unitPath, { force: true })
    await exec('systemctl', ['--user', 'daemon-reload'])
    return
  }
  rmSync(unit.unitPath, { force: true })
}

/** Does this process's own user manager serve `unit.label` from `unit.unitPath`? */
async function managerLoadedThisFile(unit: InstalledUnit, exec: Exec): Promise<boolean> {
  if (isElevated()) return false // root cannot address another account's manager
  const shown = await exec('systemctl', ['--user', 'show', '-p', 'FragmentPath', '--value', unit.label])
  const fragment = shown.stdout.trim()
  return shown.code === 0 && fragment.length > 0 && resolve(fragment) === resolve(unit.unitPath)
}

/**
 * Install the unit AND record which unit owns the root, so later commands that
 * only know the root address this instance rather than the default one.
 *
 * One root, one service: two units pointing at the same root would fight over
 * that root's `daemon.lock`, sqlite and MCP socket, and the loser would just
 * crash-loop. Refuse before writing rather than after.
 */
export async function installService(target: ControllerTarget, opts: InstallOpts): Promise<ServiceController> {
  const { root, instance } = resolved(target)
  const scope = scopeOf(target)
  const conflict = listInstances(scope).find((unit) => unit.root === root && unit.instance !== instance)
  if (conflict) {
    throw new Error(
      `root ${root} already belongs to ${conflict.label} — uninstall that service first, or give this instance its own --root`
    )
  }
  // A leftover user unit would keep its own daemon on this root the moment the
  // operator logs in again. It can only be retired unelevated, so the command
  // layer does that before it asks for root; reaching here with one still
  // installed means someone ran `sudo agentconnect install-service` by hand.
  const legacy = findUserScopeUnit(target)
  if (legacy) {
    throw new Error(
      `${legacy.label} is still installed under ~/.config/systemd/user — run \`agentconnect${commandSelector({ root, ...(instance ? { instance } : {}) })} install-service\` WITHOUT sudo (it retires that unit, then asks for root itself)`
    )
  }
  // Moving an instance to another root is only safe while it is stopped:
  // rewriting the unit does not move the RUNNING process, so discovery would
  // report the new root while the live daemon still serves the old one. Refuse,
  // and name the command that makes the move safe.
  const previous = findInstanceUnit(instance, scope)
  if (previous && previous.root !== root) {
    const running = await controllerFor(previous, {
      ...scope,
      ...(target.exec !== undefined ? { exec: target.exec } : {}),
      ...(target.polkitDir !== undefined ? { polkitDir: target.polkitDir } : {})
    }).status()
    if (running.running) {
      throw new Error(
        `${previous.label} is running against ${previous.root} — run \`agentconnect${commandSelector({ root: previous.root, ...(instance ? { instance } : {}) })} down\` before moving this instance to ${root}`
      )
    }
    // The old root's pointer would otherwise keep claiming a unit that no longer
    // drives it, so a later `--root <old>` would address the wrong service.
    clearInstancePointer(previous.root)
  }
  const controller = resolveController({ ...target, scope: target.scope ?? defaultScope(target) })
  await controller.install(opts)
  writeInstancePointer(root, { ...(instance ? { instance } : {}), label: controller.label })
  return controller
}

/** New Linux installs are system-scoped; macOS has only the one scope. */
function defaultScope(target: ControllerTarget): 'system' | undefined {
  return (target.platform ?? process.platform) === 'linux' ? 'system' : undefined
}

export async function uninstallService(target: ControllerTarget): Promise<ServiceController> {
  const controller = resolveController(target)
  await controller.uninstall()
  clearInstancePointer(resolved(target).root)
  return controller
}

/** A controller for a unit the lister found. Takes the instance AND scope from the
 *  unit itself rather than from the root's pointer — the file on disk is the truth. */
export function controllerFor(
  unit: InstalledUnit,
  opts: Omit<ControllerTarget, 'root' | 'instance'> = {}
): ServiceController {
  return pickController(
    opts.platform ?? process.platform,
    depsFor(opts, { root: unit.root, ...(unit.instance ? { instance: unit.instance } : {}), scope: unit.scope })
  )
}

/** The account a Linux install should write into `User=`, resolved once per command. */
export function serviceAccountFor(
  platform: NodeJS.Platform,
  opts: { serviceUser?: string } = {}
): ServiceAccount | undefined {
  return platform === 'linux' ? resolveServiceAccount(opts) : undefined
}

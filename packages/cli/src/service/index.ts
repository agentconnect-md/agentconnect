/** Platform dispatch for the OS-service layer. `pickController` chooses launchd
 *  vs systemd; `resolveController` builds one from runtime/process info;
 *  `installService`/`uninstallService` wrap install with the `<root>/service.json`
 *  pointer, and `listInstances` enumerates every instance installed on the host. */
import { homedir } from 'node:os'
import { defaultExec } from './exec.js'
import { clearInstancePointer, resolveServiceTarget, writeInstancePointer } from './instance.js'
import { LaunchdController, scanLaunchAgents } from './launchd.js'
import { scanSystemdUnits, SystemdController } from './systemd.js'
import type { ControllerDeps, Exec, InstalledUnit, InstallOpts, ServiceController } from './types.js'

export type { ServiceController, ServiceStatus, InstallOpts, InstalledUnit } from './types.js'
export {
  assertInstanceName,
  commandSelector,
  instanceRoot,
  readInstancePointer,
  resolveServiceTarget,
  shouldBakeRootEnv
} from './instance.js'

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
}

function resolved(target: ControllerTarget): { root: string; instance?: string } {
  return resolveServiceTarget({
    ...(target.root !== undefined ? { root: target.root } : {}),
    ...(target.instance !== undefined ? { instance: target.instance } : {})
  })
}

export function resolveController(target: ControllerTarget = {}): ServiceController {
  const { root, instance } = resolved(target)
  return pickController(target.platform ?? process.platform, {
    root,
    home: target.home ?? homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    exec: target.exec ?? defaultExec,
    ...(instance ? { instance } : {})
  })
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
  const conflict = listInstances({
    ...(target.home ? { home: target.home } : {}),
    ...(target.platform ? { platform: target.platform } : {})
  }).find((unit) => unit.root === root && unit.instance !== instance)
  if (conflict) {
    throw new Error(
      `root ${root} already belongs to ${conflict.label} — uninstall that service first, or give this instance its own --root`
    )
  }
  const controller = resolveController(target)
  await controller.install(opts)
  writeInstancePointer(root, { ...(instance ? { instance } : {}), label: controller.label })
  return controller
}

export async function uninstallService(target: ControllerTarget): Promise<ServiceController> {
  const controller = resolveController(target)
  await controller.uninstall()
  clearInstancePointer(resolved(target).root)
  return controller
}

/** A controller for a unit the lister found. Takes the instance from the unit
 *  itself rather than from the root's pointer — the file on disk is the truth. */
export function controllerFor(
  unit: InstalledUnit,
  opts: { exec?: Exec; platform?: NodeJS.Platform; home?: string } = {}
): ServiceController {
  return pickController(opts.platform ?? process.platform, {
    root: unit.root,
    home: opts.home ?? homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    exec: opts.exec ?? defaultExec,
    ...(unit.instance ? { instance: unit.instance } : {})
  })
}

/** Every AgentConnect service installed for this user, one entry per instance. */
export function listInstances(opts: { home?: string; platform?: NodeJS.Platform } = {}): InstalledUnit[] {
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  if (platform === 'darwin') return scanLaunchAgents(home)
  if (platform === 'linux') return scanSystemdUnits(home)
  return []
}

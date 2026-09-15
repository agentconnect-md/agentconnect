/** What is installed on this host, read from the OS's own unit directory — the
 *  authority on which root a service actually drives, across every scope it can
 *  live in. Kept separate from `service/index.ts` so `instance.ts` can consult it
 *  without an import cycle. */
import { homedir } from 'node:os'
import { scanLaunchAgents } from './launchd.js'
import { scanSystemdUnits } from './systemd.js'
import type { InstalledUnit } from './types.js'

export interface DiscoveryScope {
  home?: string
  platform?: NodeJS.Platform
  /** Test seam: stand in for `/etc/systemd/system` when scanning system units. */
  systemUnitDir?: string
}

/** Every AgentConnect service installed on this host. Usually one entry per
 *  instance — a half-migrated Linux host briefly carries both scopes for one. */
export function listInstances(scope: DiscoveryScope = {}): InstalledUnit[] {
  const home = scope.home ?? homedir()
  const platform = scope.platform ?? process.platform
  if (platform === 'darwin') return scanLaunchAgents(home)
  if (platform === 'linux') return scanSystemdUnits(home, scope.systemUnitDir)
  return []
}

/** The installed unit for an instance name (undefined name = the default one). */
export function findInstanceUnit(instance: string | undefined, scope: DiscoveryScope = {}): InstalledUnit | undefined {
  return listInstances(scope).find((unit) => unit.instance === instance)
}

/** Platform dispatch for the OS-service layer. `pickController` chooses launchd
 *  vs systemd; `resolveController` builds one from runtime/process info. */
import { homedir } from 'node:os'
import { resolveRoot } from '../paths.js'
import { defaultExec } from './exec.js'
import { LaunchdController } from './launchd.js'
import { SystemdController } from './systemd.js'
import type { ControllerDeps, Exec, ServiceController } from './types.js'

export type { ServiceController, ServiceStatus, InstallOpts } from './types.js'

export function pickController(platform: NodeJS.Platform, deps: ControllerDeps): ServiceController {
  if (platform === 'darwin') return new LaunchdController(deps)
  if (platform === 'linux') return new SystemdController(deps)
  throw new Error(`system service install is not supported on ${platform} yet — use \`agentconnect run\``)
}

export function resolveController(
  opts: { root?: string; exec?: Exec; platform?: NodeJS.Platform } = {}
): ServiceController {
  const root = resolveRoot(opts.root)
  return pickController(opts.platform ?? process.platform, {
    root,
    home: homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    exec: opts.exec ?? defaultExec
  })
}

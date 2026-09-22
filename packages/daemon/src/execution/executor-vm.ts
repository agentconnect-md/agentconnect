// The `microsandbox` strategy on the executor facet (session-executors.md §5, §7): one VM per hosted session, its state in an executor-local mount, its shim reached over agentd's TCP stream.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MicrosandboxEnvironment, MicrosandboxManager } from '../microsandbox/driver.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../shim/sandbox-paths.js'
import { SESSIONS_DIR } from '../workspace/session-layout.js'
import type { SessionSeed, StrategyLauncher } from './strategies.js'

/** Hosted environments are keyed apart from every agent-owned one: this machine holds none of their agents. */
const HOSTED_PREFIX = 'executor/'

/** A hosted session's VM, whose durable state is an executor-local directory MOUNTED into it, never on its own disks (§7). */
// `replace()` retires and destroys a VM whenever its spec or image identity changes, with no dirty check, so work on those disks would go with it.
export function hostedEnvironment(
  daemonRoot: string,
  sessionLeaf: string,
  seed: SessionSeed = { env: {}, paths: [] }
): MicrosandboxEnvironment {
  const directory = join(daemonRoot, SESSIONS_DIR, sessionLeaf)
  return {
    id: `${HOSTED_PREFIX}${sessionLeaf}`,
    // At the same paths in the VM: the session, whose root a holder derives, and the sign-in its HOME points at, writable for a refresh as a local VM's is (§8).
    mounts: [directory, ...seed.paths].map((path) => ({ source: path, target: path, mode: 'writable' as const })),
    workspaceRoot: directory,
    hosted: { env: seed.env }
  }
}

/** The launcher the facet picks for a `microsandbox` prepare; the manager is this machine's one, so VM starts stay serialized with its own. */
export function microsandboxLauncher(deps: { manager: () => MicrosandboxManager | undefined }): StrategyLauncher {
  const required = (): MicrosandboxManager => {
    const manager = deps.manager()
    if (!manager) throw new Error('this machine runs no microsandbox backend')
    return manager
  }
  return {
    start: async ({ daemonRoot, sessionLeaf, seed }) => {
      const manager = required()
      const environment = hostedEnvironment(daemonRoot, sessionLeaf, seed)
      // The mount source must exist before the VM starts; the facet seeds this machine's sign-in into `home` first.
      for (const leaf of ['workspace', 'repos', 'home'])
        await mkdir(join(environment.workspaceRoot, leaf), { recursive: true, mode: 0o700 })
      await manager.prepareEnvironment(environment)
      const guest = manager.guestShim(environment.id)
      if (!guest) throw new Error(`the hosted VM of ${sessionLeaf} started no shim`)
      return {
        connect: () => guest.connect(),
        // The image's fixed layout, NOT a per-session root: in a VM the shim owns its filesystem namespace, which is why #2155's parameterization was needed for `host` alone (§5).
        runtimeRoot: DEFAULT_SHIM_RUNTIME_ROOT,
        // No helper root either, for the same reason: a holder derives the image's own entries from `shimPaths` defaults.
        missingHelpers: [],
        exited: guest.exited,
        // The VM stops and its disks stay, which is what an idle environment's stop must leave behind (§7).
        stop: () => manager.suspend(environment.id)
      }
    },
    // A release takes the VM and its disposable disks; the session's directory is the facet's own to remove.
    discard: async (sessionLeaf) => {
      await deps.manager()?.discard(`${HOSTED_PREFIX}${sessionLeaf}`)
    }
  }
}

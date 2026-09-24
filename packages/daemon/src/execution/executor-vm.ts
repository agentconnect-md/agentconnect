// The `microsandbox` strategy on the executor facet (session-executors.md §5, §7): one VM per hosted session, its state in an executor-local mount, its shim reached over agentd's TCP stream.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import type { MicrosandboxEnvironment, MicrosandboxManager } from '../microsandbox/driver.js'
import {
  definitionEnv,
  microsandboxCredentialStep,
  ownCredentialEnv,
  type MicrosandboxSecret
} from '../microsandbox/secrets.js'
import { canonicalPath, contains } from '../runtimes/read-roots.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../shim/sandbox-paths.js'
import { SESSIONS_DIR } from '../workspace/session-layout.js'
import type { SessionSeed, StrategyLauncher } from './strategies.js'

/** Hosted environments are keyed apart from every agent-owned one: this machine holds none of their agents. */
export const HOSTED_PREFIX = 'executor/'

/** A hosted VM's seed: what its HOME points at, and the placeholder substitutions the VM fixes when it starts (§8). */
export interface HostedSeed extends SessionSeed {
  secrets?: MicrosandboxSecret[]
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Seed a hosted VM's HOME with a local VM's credential step for every runtime this machine admits: the guest sees placeholders, the VM holds the values (§8). */
export function seedHostedHome(
  home: string,
  runtimes: Record<string, RuntimeDef>,
  log: Pick<Logger, 'warn'>,
  hostEnv: NodeJS.ProcessEnv = process.env
): Required<HostedSeed> {
  // Every preparer before any seed, so no runtime's plain seed copies a file another one projects.
  const steps = Object.entries(runtimes).flatMap(([runtimeId, runtime]) => {
    try {
      // The definition's env is explicit, as in a local launch, so a key configured there is protected too.
      const step = microsandboxCredentialStep(runtimeId, runtime, hostEnv, definitionEnv(runtime))
      return [{ runtimeId, runtime, step }]
    } catch (error) {
      // Refused, never downgraded to a plain seed: that runtime's sign-in stays off the guest and it answers authRequired.
      log.warn(`executor: a hosted VM gets no ${runtimeId} sign-in (${message(error)})`)
      return []
    }
  })
  const excluded = steps.flatMap(({ step }) => step.protectedCredentials?.seedExclusions ?? [])
  const protectedSources = steps.flatMap(({ step }) =>
    (step.protectedCredentials?.sources ?? []).map((path) => canonicalPath(path, hostEnv))
  )
  const env: Record<string, string> = {}
  const paths: string[] = []
  const secrets = new Map<string, MicrosandboxSecret>()
  const seeded: typeof steps = []
  for (const entry of steps) {
    const { runtimeId, runtime, step } = entry
    try {
      const own = step.protectedCredentials?.secrets ?? []
      // One preparer per binding name, reading this one machine, so a name never carries two values.
      if (own.some((secret) => secrets.has(secret.env) && secrets.get(secret.env)!.readValue() !== secret.readValue()))
        throw new Error('another runtime binds a different credential under the same name')
      step.seedHome(home, home, excluded)
      // Read after the seed, which can move a sign-in to its shared place; a mount must not reopen what is projected.
      const shared = step.credentials?.writablePaths ?? []
      if (shared.some((path) => protectedSources.some((source) => contains(canonicalPath(path, hostEnv), source))))
        throw new Error('its shared sign-in would expose a protected credential file')
      Object.assign(env, step.credentials?.env)
      // The keys a holder strips, from this machine's environment as a local VM here inherits them; `protectEnv` below swaps protected ones for placeholders.
      Object.assign(env, ownCredentialEnv(runtimeId, runtime, hostEnv))
      paths.push(...shared)
      for (const secret of own) if (!secrets.has(secret.env)) secrets.set(secret.env, secret)
      seeded.push(entry)
    } catch (error) {
      log.warn(`executor: a hosted VM gets no ${runtimeId} sign-in (${message(error)})`)
    }
  }
  for (const { step } of seeded) step.protectEnv(env)
  // Runtimes sharing one sign-in name the same place, which a VM may mount only once.
  return { env, paths: [...new Set(paths)], secrets: [...secrets.values()] }
}

/** A hosted session's VM, whose durable state is an executor-local directory MOUNTED into it, never on its own disks (§7). */
// `replace()` retires and destroys a VM whenever its spec or image identity changes, with no dirty check, so work on those disks would go with it.
export function hostedEnvironment(
  daemonRoot: string,
  sessionLeaf: string,
  seed: HostedSeed = { env: {}, paths: [] }
): MicrosandboxEnvironment {
  const directory = join(daemonRoot, SESSIONS_DIR, sessionLeaf)
  return {
    id: `${HOSTED_PREFIX}${sessionLeaf}`,
    // At the same paths in the VM: the session, whose root a holder derives, and the sign-in its HOME points at, writable for a refresh as a local VM's is (§8).
    mounts: [directory, ...seed.paths].map((path) => ({ source: path, target: path, mode: 'writable' as const })),
    workspaceRoot: directory,
    ...(seed.secrets?.length ? { secrets: seed.secrets } : {}),
    hosted: { env: seed.env }
  }
}

/** The launcher the facet picks for a `microsandbox` prepare; the manager is this machine's one, so VM starts stay serialized with its own. */
export function microsandboxLauncher(deps: {
  manager: () => MicrosandboxManager | undefined
  /** The runtimes this machine admits, whose sign-in each hosted HOME is seeded from. */
  runtimes?: () => Record<string, RuntimeDef>
  /** Test seam: this machine's environment, which the preparers read. */
  hostEnv?: NodeJS.ProcessEnv
}): StrategyLauncher {
  const required = (): MicrosandboxManager => {
    const manager = deps.manager()
    if (!manager) throw new Error('this machine runs no microsandbox backend')
    return manager
  }
  return {
    seedsHome: true,
    start: async ({ daemonRoot, sessionLeaf, log }) => {
      const manager = required()
      const directory = join(daemonRoot, SESSIONS_DIR, sessionLeaf)
      // The mount source must exist before the VM starts.
      for (const leaf of ['workspace', 'repos', 'home'])
        await mkdir(join(directory, leaf), { recursive: true, mode: 0o700 })
      const seed = seedHostedHome(join(directory, 'home'), deps.runtimes?.() ?? {}, log, deps.hostEnv)
      const environment = hostedEnvironment(daemonRoot, sessionLeaf, seed)
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

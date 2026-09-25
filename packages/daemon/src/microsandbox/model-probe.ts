// The VM strategy's model probe (session-executors.md §5): the host sweep's own runtime probe, for the image's runtimes, in one VM of this machine.
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpawnDriver } from '../acp/spawn-driver.js'
import type { RuntimeDef, SandboxMount } from '../config/config-schema.js'
import type { EnvironmentDescriptor } from '../execution/strategies.js'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import { sandboxSubjectAgentId } from '../remote/sandbox-subject.js'
import { canonicalPath, contains } from '../runtimes/read-roots.js'
import {
  probeRuntime,
  type ProbeHostFactory,
  type ProbeLaunchPlan,
  type RuntimeProbeResult
} from '../runtimes/runtime-prober.js'
import { prepareMicrosandboxLaunch } from './launch.js'
import { definitionEnv, microsandboxCredentialStep, type MicrosandboxSecret } from './secrets.js'

/** The probe VM's environment, in neither the agent-owned nor the hosted space; a run that dies holding it leaves it to the next probe. */
export const VM_PROBE_ENVIRONMENT_ID = 'probe/models'

export interface ImageModelProbeOptions {
  /** The image's runtimes, each as a VM session of it launches it. */
  runtimes: Record<string, RuntimeDef>
  /** A directory the probe owns outright: emptied first, one scope per runtime under it. */
  root: string
  daemonRoot: string
  agentsRoot?: string
  /** `sandbox.env`, beneath each runtime definition's own env, as a local VM launch takes them. */
  sandboxEnv?: Record<string, string>
  /** Start the VM and bind its shim with no runtime, so its boot counts against no runtime's budget. */
  start: (environment: EnvironmentDescriptor) => Promise<void>
  driverFor: (environment: EnvironmentDescriptor) => SpawnDriver
  /** Stop and remove a VM by its id, with its disks and binding. */
  discard: (id: string) => Promise<void>
  hostFactory: (driver: SpawnDriver) => ProbeHostFactory
  log: Logger
  signal?: AbortSignal
  onResult?: (result: RuntimeProbeResult) => void
  /** Test seam: this machine's environment, which each credential step reads. */
  hostEnv?: NodeJS.ProcessEnv
}

interface PreparedProbe {
  id: string
  runtime: RuntimeDef
  cwd: string
  launch: ProbeLaunchPlan
}

/** Probe every runtime of the image serially in one VM, each launched as its own local VM session would be, with this machine's credential step. */
export async function probeImageModels(opts: ImageModelProbeOptions): Promise<RuntimeProbeResult[]> {
  const hostEnv = opts.hostEnv ?? process.env
  const results: RuntimeProbeResult[] = []
  const report = (result: RuntimeProbeResult): void => {
    results.push(result)
    try {
      opts.onResult?.(result)
    } catch (error) {
      opts.log.warn(`probe: reporting ${result.runtime} from the VM failed: ${formatErr(error)}`)
    }
  }
  await opts.discard(VM_PROBE_ENVIRONMENT_ID)
  await rm(opts.root, { recursive: true, force: true })
  const mounts: SandboxMount[] = []
  const secrets = new Map<string, MicrosandboxSecret>()
  const guarded: string[] = []
  const prepared: PreparedProbe[] = []
  for (const [id, runtime] of Object.entries(opts.runtimes)) {
    // One scope per runtime, as the host sweep gives each: its own workspace and private HOME.
    const scopeDir = join(opts.root, Buffer.from(id).toString('base64url'))
    const cwd = join(scopeDir, 'workspace')
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      const explicitEnv = { ...opts.sandboxEnv, ...definitionEnv(runtime) }
      const launch = prepareMicrosandboxLaunch({
        runtimeId: id,
        runtime,
        scopeDir,
        cwd,
        daemonRoot: opts.daemonRoot,
        ...(opts.agentsRoot ? { agentsRoot: opts.agentsRoot } : {}),
        explicitEnv,
        stateSourceEnv: hostEnv,
        mounts: []
      })
      const own = microsandboxCredentialStep(id, runtime, hostEnv, explicitEnv).protectedCredentials
      const sources = (own?.sources ?? []).map((path) => canonicalPath(path, hostEnv))
      const { mounts: needed, secrets: bound = [] } = launch.microsandbox
      const refusal = sharingRefusal(needed, bound, sources, { mounts, secrets, guarded }, hostEnv)
      if (refusal) throw new Error(refusal)
      for (const mount of needed) if (!mounts.some((other) => other.target === mount.target)) mounts.push(mount)
      for (const secret of bound) secrets.set(secret.env, secret)
      guarded.push(...sources)
      // Every shim driver routes a launch by the agent its environment names.
      launch.env.AC_AGENT_ID = sandboxSubjectAgentId(VM_PROBE_ENVIRONMENT_ID)
      prepared.push({
        id,
        runtime,
        cwd,
        launch: { ...launch, redactValues: bound.map((secret) => secret.readValue()) }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      opts.log.warn(`probe: ${id} gets no VM probe — ${reason}`)
      report({ runtime: id, ok: false, models: [], error: reason })
    }
  }
  if (!prepared.length) return results
  const environment: EnvironmentDescriptor = {
    id: VM_PROBE_ENVIRONMENT_ID,
    workspaceRoot: opts.root,
    mounts,
    ...(secrets.size ? { secrets: [...secrets.values()] } : {})
  }
  try {
    await opts.start(environment)
    const hostFactory = opts.hostFactory(opts.driverFor(environment))
    // Serial, as the pool's probe is: one VM holds them all, and it asks the machine for no more than one runtime at a time.
    for (const { id, runtime, cwd, launch } of prepared) {
      if (opts.signal?.aborted) break
      report(
        await probeRuntime(id, runtime, cwd, {
          hostFactory,
          log: opts.log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          launchFor: () => launch
        })
      )
    }
  } finally {
    // A shutdown stops the VM with every other one; the next probe removes it.
    if (!opts.signal?.aborted)
      await opts
        .discard(VM_PROBE_ENVIRONMENT_ID)
        .catch((error: unknown) => opts.log.warn(`microsandbox: could not remove the probe VM — ${formatErr(error)}`))
    await rm(opts.root, { recursive: true, force: true }).catch(() => {})
  }
  return results
}

/** Why a runtime's launch cannot share the probe VM with those already in it: a binding name, a mount, or a protected file they disagree on. */
function sharingRefusal(
  needed: SandboxMount[],
  bound: MicrosandboxSecret[],
  sources: string[],
  joined: { mounts: SandboxMount[]; secrets: Map<string, MicrosandboxSecret>; guarded: string[] },
  hostEnv: NodeJS.ProcessEnv
): string | undefined {
  const known = (secret: MicrosandboxSecret) => joined.secrets.get(secret.env)
  if (bound.some((secret) => known(secret) && known(secret)!.readValue() !== secret.readValue()))
    return 'another runtime binds a different credential under the same name'
  for (const mount of needed) {
    const same = joined.mounts.find((other) => other.target === mount.target)
    if (
      same
        ? same.source !== mount.source || same.mode !== mount.mode
        : joined.mounts.some((other) => contains(other.target, mount.target) || contains(mount.target, other.target))
    )
      return `its mount ${mount.target} overlaps another runtime's`
  }
  const shared = [...joined.mounts, ...needed].map((mount) => canonicalPath(mount.source, hostEnv))
  if ([...joined.guarded, ...sources].some((file) => shared.some((source) => contains(source, file))))
    return 'a mount would expose another runtime’s protected credential file'
  return undefined
}

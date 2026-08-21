import type { Logger } from '../log.js'
import type { ProbeHostFactory } from '../runtimes/runtime-prober.js'
import { AcpHost } from './acp-host.js'
import type { SpawnDriver } from './spawn-driver.js'

/** The production {@link ProbeHostFactory}: a real AcpHost per probed runtime. */
export function defaultProbeHostFactory(opts: { log?: Logger; isolateAccountApps?: boolean } = {}): ProbeHostFactory {
  // A probe session produces no user-facing turns, so session/update is dropped.
  return (rt, id, _cwd, policy) =>
    new AcpHost(rt, {
      onUpdate: () => {},
      log: opts.log,
      runtimeId: id,
      isolateAccountApps: opts.isolateAccountApps,
      ...policy
    })
}

/**
 * The `--k8s` {@link ProbeHostFactory}: the same AcpHost, launched through the cluster driver so
 * the probed runtime runs in the sandbox pod that ships it. The daemon has no runtime binary to
 * spawn, and a probe is the one place where "which models does this runtime offer" can be asked of
 * the image itself rather than guessed from a build-time table with no credentials behind it.
 */
export function clusterProbeHostFactory(opts: {
  driver: SpawnDriver
  log?: Logger
  isolateAccountApps?: boolean
}): ProbeHostFactory {
  return (rt, id, _cwd, policy) =>
    new AcpHost(rt, {
      onUpdate: () => {},
      driver: opts.driver,
      log: opts.log,
      runtimeId: id,
      isolateAccountApps: opts.isolateAccountApps,
      ...policy
    })
}

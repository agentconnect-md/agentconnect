import type { Logger } from '../log.js'
import type { ProbeHostFactory } from '../runtimes/runtime-prober.js'
import { AcpHost } from './acp-host.js'

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

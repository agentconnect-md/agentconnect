/**
 * The boot-time daemon-version sweep: every enabled envelope is pointed at the newest
 * daemon image the deployment's release channel names.
 *
 * A release publishes the npm package and the container image together, so the dist-tag
 * this install pins (`DAEMON_DIST_TAG` — `rc` on a test control plane, `latest` in
 * production) already answers "which image should an envelope daemon run". A machine
 * daemon learns that answer from the console's upgrade hint and reinstalls itself; a pod
 * cannot, so the control plane moves it.
 *
 * It runs once per boot rather than on a timer, which is the whole design: the sweep is
 * the catch-up for a release that landed while this process was down, and an operator who
 * wants an envelope moved sooner has the console's upgrade control. A timer would also
 * fight an owner who just pinned an org deliberately — see `alignDaemonVersion` for the
 * two cases it refuses to touch.
 */
import type { ClusterExecutionService } from './service.js'
import type { DaemonRelease } from '../registry/daemonRelease.js'

export interface ClusterImageSyncLog {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Just enough of the resolver to await one channel lookup. */
export interface DaemonReleaseLookup {
  resolve(): Promise<DaemonRelease>
}

export class ClusterDaemonImageSync {
  constructor(
    private readonly cluster: ClusterExecutionService,
    private readonly release: DaemonReleaseLookup,
    private readonly log?: ClusterImageSyncLog
  ) {}

  /** One pass. Never throws — a control plane must boot whether or not npm answered. */
  async run(): Promise<void> {
    try {
      const { channel, latestVersion } = await this.release.resolve()
      // No answer from the registry ⇒ nothing is known to be newer, so nothing moves.
      // Doing anything else here would mean guessing a version onto every envelope.
      if (!latestVersion) {
        this.log?.warn({ channel }, 'cluster-execution: no published daemon version for the channel; skipping sweep')
        return
      }
      const sweep = await this.cluster.alignDaemonVersion(latestVersion)
      for (const failure of sweep.failed) {
        this.log?.warn(
          { orgId: failure.orgId, err: failure.err },
          'cluster-execution: could not move an envelope onto the current daemon image'
        )
      }
      this.log?.info(
        {
          channel,
          version: latestVersion,
          scanned: sweep.scanned,
          moved: sweep.moved.length,
          skipped: sweep.skipped,
          failed: sweep.failed.length
        },
        'cluster-execution: swept envelopes onto the current daemon image'
      )
    } catch (err) {
      this.log?.warn({ err }, 'cluster-execution: daemon image sweep failed')
    }
  }
}

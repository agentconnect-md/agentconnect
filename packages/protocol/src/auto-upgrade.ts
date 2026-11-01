// Daemon auto-upgrade contract shared by CP, daemon and CLI (docs/designs/daemon-auto-upgrade.md).
import { z } from 'zod'

/** Daemon-advertised: it can install and relaunch onto a CP-announced release unattended. */
export const DAEMON_AUTO_UPGRADE_FEATURE = 'daemon-auto-upgrade-v1'

/** CP-advertised in `register/ok.serverFeatures`: it accepts `daemon/lifecycle/begin`. */
export const DAEMON_LIFECYCLE_BEGIN_FEATURE = 'daemon-lifecycle-begin-v1'

/** `config/push` key carrying the console's auto-upgrade switch (boolean). */
export const CONFIG_KEY_UPGRADE_AUTO = 'upgrade.auto'

/** `config/push` key carrying the deployment's announced release ({@link DaemonRelease} or null). */
export const CONFIG_KEY_UPGRADE_LATEST = 'upgrade.latest'

/** `daemon/lifecycle/progress` failure reason for an upgrade put off because the daemon stayed busy. */
export const LIFECYCLE_DEFERRED_REASON = 'busy'

/** The deployment's daemon release: its pinned npm channel and the version behind it. */
export const DaemonRelease = z.object({
  channel: z.string().min(1).max(64),
  version: z.string().min(1).max(128)
})
export type DaemonRelease = z.infer<typeof DaemonRelease>

/** File under the AgentConnect root marking a version switch whose first boot has not reached READY yet. */
export const UPGRADE_TRIAL_FILE = 'upgrade-trial.json'

/** Consecutive failed starts of a trial version before the CLI run shell restores `from`. */
export const UPGRADE_TRIAL_MAX_FAILURES = 3

export const UpgradeTrialMarker = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  operationId: z.string().optional(),
  startedAt: z.string(),
  failures: z.number().int().min(0).default(0),
  // Set by whoever restored `from`; the old daemon reports it and deletes the marker.
  rolledBack: z.object({ reason: z.string().max(500), at: z.string() }).optional()
})
export type UpgradeTrialMarker = z.infer<typeof UpgradeTrialMarker>

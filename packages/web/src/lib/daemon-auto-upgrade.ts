import type { DaemonRow } from '@/lib/data'

/** One status line under the auto-upgrade switch (daemon-auto-upgrade.md §8). */
export type AutoUpgradeNote =
  | { kind: 'upgrading'; version: string | null }
  | { kind: 'upgraded'; version: string | null; settledAt: string | null }
  | { kind: 'failed'; version: string | null; outcome: string | null }
  | { kind: 'waiting'; version: string }
  | { kind: 'unavailable'; reason: AutoUpgradeBlockedKey }

type AutoUpgradeFacts = Pick<
  DaemonRow,
  | 'autoUpgrade'
  | 'autoUpgradeSupported'
  | 'autoUpgradeBlocked'
  | 'upgradeAvailable'
  | 'latestVersion'
  | 'lifecycleOp'
  | 'lastAutoUpgrade'
>

/** The message key for a daemon's reported reason; a code this console does not know reads as `unknown`. */
export type AutoUpgradeBlockedKey = 'cliNotFound' | 'noSupervisor' | 'imageManaged' | 'unknown'

const BLOCKED_KEYS: Record<string, AutoUpgradeBlockedKey> = {
  'cli-not-found': 'cliNotFound',
  'no-supervisor': 'noSupervisor',
  'image-managed': 'imageManaged'
}

/** Switched on with a newer release out, yet the daemon cannot carry the upgrade out: why, or null when nothing is stuck. */
export function autoUpgradeBlockedKey(
  d: Pick<AutoUpgradeFacts, 'autoUpgrade' | 'autoUpgradeSupported' | 'autoUpgradeBlocked' | 'upgradeAvailable'>
): AutoUpgradeBlockedKey | null {
  if (!d.autoUpgrade || d.autoUpgradeSupported || !d.upgradeAvailable) return null
  return (d.autoUpgradeBlocked && BLOCKED_KEYS[d.autoUpgradeBlocked]) || 'unknown'
}

/** The last automatic outcome, then whether a switched-on daemon is still waiting for an idle window. */
export function autoUpgradeNotes(d: AutoUpgradeFacts): AutoUpgradeNote[] {
  const notes: AutoUpgradeNote[] = []
  const last = d.lastAutoUpgrade
  const pendingOp = d.lifecycleOp?.status === 'pending' ? d.lifecycleOp : null
  const autoPending = last?.status === 'pending' || pendingOp?.trigger === 'auto'
  if (autoPending) {
    const version = last?.status === 'pending' ? last.targetVersion : (pendingOp?.targetVersion ?? null)
    notes.push({ kind: 'upgrading', version })
  } else if (last?.status === 'succeeded') {
    notes.push({ kind: 'upgraded', version: last.targetVersion, settledAt: last.settledAt })
  } else if (last?.status === 'failed') {
    notes.push({ kind: 'failed', version: last.targetVersion, outcome: last.outcome })
  }
  // A failed target is skipped by the daemon until a newer release supersedes it, so it is not waiting on it.
  const skipped = last?.status === 'failed' && last.targetVersion === d.latestVersion
  const blocked = autoUpgradeBlockedKey(d)
  // A daemon that cannot upgrade itself is not waiting for an idle window.
  if (blocked) notes.push({ kind: 'unavailable', reason: blocked })
  else if (d.autoUpgrade && d.upgradeAvailable && d.latestVersion && !pendingOp && !autoPending && !skipped) {
    notes.push({ kind: 'waiting', version: d.latestVersion })
  }
  return notes
}

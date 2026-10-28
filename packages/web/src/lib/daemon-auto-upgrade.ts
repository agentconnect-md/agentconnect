import type { DaemonRow } from '@/lib/data'

/** One status line under the auto-upgrade switch (daemon-auto-upgrade.md §8). */
export type AutoUpgradeNote =
  | { kind: 'upgrading'; version: string | null }
  | { kind: 'upgraded'; version: string | null; settledAt: string | null }
  | { kind: 'failed'; version: string | null; outcome: string | null }
  | { kind: 'waiting'; version: string }

type AutoUpgradeFacts = Pick<
  DaemonRow,
  'autoUpgrade' | 'upgradeAvailable' | 'latestVersion' | 'lifecycleOp' | 'lastAutoUpgrade'
>

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
  if (d.autoUpgrade && d.upgradeAvailable && d.latestVersion && !pendingOp && !autoPending && !skipped) {
    notes.push({ kind: 'waiting', version: d.latestVersion })
  }
  return notes
}

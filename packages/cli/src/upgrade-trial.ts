// Run-shell half of the auto-upgrade trial (daemon-auto-upgrade.md §7.2): count a trial version's failed starts and restore `from`.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RESERVED_RESTART_CODE,
  UPGRADE_TRIAL_FILE,
  UPGRADE_TRIAL_MAX_FAILURES,
  UpgradeTrialMarker
} from '@agentconnect.md/protocol'
import type { ChildResult } from './delegate.js'
import { STARTUP_FAILURE_WINDOW_MS } from './run-recovery.js'
import { withVersionLock } from './version-lock.js'
import { useVersion } from './version-ops.js'
import { currentVersion } from './version-store.js'

export function trialMarkerPath(root: string): string {
  return join(root, UPGRADE_TRIAL_FILE)
}

/** The marker on disk, or undefined when absent or unreadable (an unreadable marker is no trial). */
export function readTrialMarker(root: string): UpgradeTrialMarker | undefined {
  const file = trialMarkerPath(root)
  if (!existsSync(file)) return undefined
  try {
    const parsed = UpgradeTrialMarker.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function writeTrialMarker(root: string, marker: UpgradeTrialMarker): void {
  const file = trialMarkerPath(root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n')
  renameSync(tmp, file)
}

export interface TrialExitContext {
  stopRequested: boolean
  devEntry: boolean
  elapsedMs: number
}

export interface TrialDeps {
  /** Switch `current` back to `version` under the version lock. */
  restore: (root: string, version: string) => Promise<void>
  now: () => Date
  log: (message: string) => void
}

const realTrialDeps: TrialDeps = {
  restore: (root, version) => withVersionLock(root, 'rollback', () => useVersion(root, version), { wait: true }),
  now: () => new Date(),
  log: (message) => console.error(message)
}

/** 'respawn' when a trial absorbed this exit (retry the trial or run the restored `from`), 'none' to fall through. */
export async function handleTrialExit(
  root: string,
  result: ChildResult,
  ctx: TrialExitContext,
  partial: Partial<TrialDeps> = {}
): Promise<'respawn' | 'none'> {
  const deps = { ...realTrialDeps, ...partial }
  if (ctx.stopRequested || ctx.devEntry) return 'none'
  // Only a definite start failure counts: signals, clean exits and planned restarts are not crashes.
  if (result.signal !== null || !result.code || result.code === RESERVED_RESTART_CODE) return 'none'
  if (ctx.elapsedMs > STARTUP_FAILURE_WINDOW_MS) return 'none'
  const marker = readTrialMarker(root)
  if (!marker || marker.rolledBack) return 'none'
  // A marker for a version that is no longer current belongs to a trial that already ended some other way.
  if (currentVersion(root) !== marker.to) return 'none'
  const failures = marker.failures + 1
  if (failures < UPGRADE_TRIAL_MAX_FAILURES) {
    writeTrialMarker(root, { ...marker, failures })
    deps.log(
      `agentconnect: daemon ${marker.to} exited with code ${result.code} during its trial start (${failures}/${UPGRADE_TRIAL_MAX_FAILURES}) — retrying`
    )
    return 'respawn'
  }
  try {
    await deps.restore(root, marker.from)
  } catch (err) {
    writeTrialMarker(root, { ...marker, failures })
    deps.log(
      `agentconnect: could not restore daemon ${marker.from} after a failed trial of ${marker.to}: ${(err as Error).message}`
    )
    return 'none'
  }
  writeTrialMarker(root, {
    ...marker,
    failures,
    rolledBack: { reason: 'crashed on start', at: deps.now().toISOString() }
  })
  deps.log(`agentconnect: daemon ${marker.to} failed to start ${failures} times — rolled back to ${marker.from}`)
  return 'respawn'
}

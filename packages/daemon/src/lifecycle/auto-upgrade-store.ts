// Daemon-local auto-upgrade files under the root (daemon-auto-upgrade.md §3.1, §4.2, §7): the switch, announced target, skip list and trial marker.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { DaemonRelease, UPGRADE_TRIAL_FILE, UpgradeTrialMarker } from '@agentconnect.md/protocol'

export const AUTO_UPGRADE_FILE = 'auto-upgrade.json'

const SkippedVersion = z.object({ version: z.string().min(1), reason: z.string(), at: z.string() })
export type SkippedVersion = z.infer<typeof SkippedVersion>

const Candidate = z.object({ version: z.string().min(1), channel: z.string(), firstSeenAt: z.number() })
export type AutoUpgradeCandidate = z.infer<typeof Candidate>

const AutoUpgradeFile = z.object({
  // Absent until the CP first delivers the switch; treated as off.
  enabled: z.boolean().optional(),
  release: DaemonRelease.nullable().optional(),
  candidate: Candidate.optional(),
  skipped: z.array(SkippedVersion).default([])
})
export type AutoUpgradeState = z.infer<typeof AutoUpgradeFile>

export function autoUpgradeStatePath(root: string): string {
  return join(root, AUTO_UPGRADE_FILE)
}

export function trialMarkerPath(root: string): string {
  return join(root, UPGRADE_TRIAL_FILE)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/** The persisted state; a missing or corrupt file reads as the empty default rather than wedging the upgrader. */
export function readAutoUpgradeState(root: string): AutoUpgradeState {
  const parsed = AutoUpgradeFile.safeParse(readJson(autoUpgradeStatePath(root)) ?? {})
  return parsed.success ? parsed.data : { skipped: [] }
}

export function writeAutoUpgradeState(root: string, state: AutoUpgradeState): void {
  writeJsonAtomic(autoUpgradeStatePath(root), state)
}

export function readTrialMarker(root: string): UpgradeTrialMarker | undefined {
  const parsed = UpgradeTrialMarker.safeParse(readJson(trialMarkerPath(root)))
  return parsed.success ? parsed.data : undefined
}

export function writeTrialMarker(root: string, marker: UpgradeTrialMarker): void {
  writeJsonAtomic(trialMarkerPath(root), marker)
}

export function deleteTrialMarker(root: string): void {
  rmSync(trialMarkerPath(root), { force: true })
}

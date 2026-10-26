import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// TCC.db is unreadable without Full Disk Access, so the app records what it asked macOS for and what it has held.
export type Grant = 'accessibility' | 'screenRecording'

export interface GrantRecord {
  asked: Partial<Record<Grant, string>>
  held: Partial<Record<Grant, string>>
}

export const APP_ID = 'md.agentconnect.computer'
export const TCC_SERVICE: Record<Grant, string> = { accessibility: 'Accessibility', screenRecording: 'ScreenCapture' }
export const grantRecordPath = (dir: string): string => join(dir, 'macos-grants.json')

export function readGrantRecord(dir: string): GrantRecord {
  try {
    const record = JSON.parse(readFileSync(grantRecordPath(dir), 'utf8')) as Partial<GrantRecord>
    return { asked: record.asked ?? {}, held: record.held ?? {} }
  } catch {
    return { asked: {}, held: {} }
  }
}

// A prompt lists the app in Privacy & Security switched off; a held grant stays recorded after it is lost.
export function recordGrants(
  dir: string,
  state: Record<Grant, boolean>,
  asked: boolean,
  now: Date = new Date()
): GrantRecord {
  const record = readGrantRecord(dir)
  const at = now.toISOString()
  for (const grant of ['accessibility', 'screenRecording'] as const) {
    if (state[grant]) record.held[grant] ??= at
    else if (asked) record.asked[grant] ??= at
  }
  try {
    writeFileSync(grantRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A read-only data dir only costs doctor its "listed but off" detail.
  }
  return record
}

// Drops what was recorded for a grant, as `tccutil reset` drops it from macOS.
export function forgetGrant(dir: string, grant: Grant): void {
  const record = readGrantRecord(dir)
  delete record.asked[grant]
  delete record.held[grant]
  try {
    writeFileSync(grantRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Nothing recorded, nothing to forget.
  }
}

export type GrantLoss = 'never-asked' | 'listed-off' | 'lost'

// Why a missing grant is missing: never asked, asked but left off, or once held and now off or for an older signature.
export function grantLoss(record: GrantRecord, grant: Grant): GrantLoss {
  if (record.held[grant]) return 'lost'
  return record.asked[grant] ? 'listed-off' : 'never-asked'
}

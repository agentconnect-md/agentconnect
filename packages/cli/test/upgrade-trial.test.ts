import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESERVED_RESTART_CODE, UPGRADE_TRIAL_MAX_FAILURES } from '@agentconnect.md/protocol'
import { handleTrialExit, readTrialMarker, trialMarkerPath } from '../src/upgrade-trial.js'
import { STARTUP_FAILURE_WINDOW_MS } from '../src/run-recovery.js'
import { useVersion } from '../src/version-ops.js'
import { currentVersion } from '../src/version-store.js'

const ctx = { stopRequested: false, devEntry: false, elapsedMs: 1_000 }
const crashed = { code: 1, signal: null }
const quiet = { log: () => {}, now: () => new Date('2026-01-01T00:00:00.000Z') }

function trialRoot(marker: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-trial-'))
  for (const v of ['1.0.0', '1.1.0']) mkdirSync(join(root, 'versions', v), { recursive: true })
  useVersion(root, '1.0.0')
  useVersion(root, '1.1.0')
  writeFileSync(
    trialMarkerPath(root),
    JSON.stringify({ from: '1.0.0', to: '1.1.0', startedAt: '2026-01-01T00:00:00.000Z', failures: 0, ...marker })
  )
  return root
}

describe('handleTrialExit', () => {
  it('counts a failed start and respawns the same version below the threshold', async () => {
    const root = trialRoot()
    const restore = vi.fn()
    expect(await handleTrialExit(root, crashed, ctx, { ...quiet, restore })).toBe('respawn')
    expect(readTrialMarker(root)?.failures).toBe(1)
    expect(restore).not.toHaveBeenCalled()
    expect(currentVersion(root)).toBe('1.1.0')
  })

  it('restores `from` and marks the rollback at the threshold', async () => {
    const root = trialRoot({ failures: UPGRADE_TRIAL_MAX_FAILURES - 1 })
    const restore = vi.fn(async (r: string, v: string) => useVersion(r, v))
    expect(await handleTrialExit(root, crashed, ctx, { ...quiet, restore })).toBe('respawn')
    expect(restore).toHaveBeenCalledWith(root, '1.0.0')
    expect(currentVersion(root)).toBe('1.0.0')
    const marker = readTrialMarker(root)
    expect(marker?.failures).toBe(UPGRADE_TRIAL_MAX_FAILURES)
    expect(marker?.rolledBack).toEqual({ reason: 'crashed on start', at: '2026-01-01T00:00:00.000Z' })
  })

  it('three consecutive crashes roll back end to end', async () => {
    const root = trialRoot()
    const restore = async (r: string, v: string) => useVersion(r, v)
    for (let i = 0; i < UPGRADE_TRIAL_MAX_FAILURES; i++) {
      expect(await handleTrialExit(root, crashed, ctx, { ...quiet, restore })).toBe('respawn')
    }
    expect(currentVersion(root)).toBe('1.0.0')
    // The restored version crashing too is not a trial any more: it falls through to the ordinary exit path.
    expect(await handleTrialExit(root, crashed, ctx, { ...quiet, restore })).toBe('none')
  })

  it('does not count the reserved restart code, signals, or clean exits', async () => {
    const root = trialRoot()
    for (const result of [
      { code: RESERVED_RESTART_CODE, signal: null },
      { code: null, signal: 'SIGKILL' as const },
      { code: 0, signal: null }
    ]) {
      expect(await handleTrialExit(root, result, ctx, quiet)).toBe('none')
    }
    expect(readTrialMarker(root)?.failures).toBe(0)
  })

  it('ignores exits past the startup window, after a stop, and in dev-entry mode', async () => {
    const root = trialRoot()
    expect(await handleTrialExit(root, crashed, { ...ctx, elapsedMs: STARTUP_FAILURE_WINDOW_MS + 1 }, quiet)).toBe(
      'none'
    )
    expect(await handleTrialExit(root, crashed, { ...ctx, stopRequested: true }, quiet)).toBe('none')
    expect(await handleTrialExit(root, crashed, { ...ctx, devEntry: true }, quiet)).toBe('none')
    expect(readTrialMarker(root)?.failures).toBe(0)
  })

  it('ignores an already rolled-back marker and one whose target is no longer current', async () => {
    const rolled = trialRoot({ rolledBack: { reason: 'crashed on start', at: '2026-01-01T00:00:00.000Z' } })
    expect(await handleTrialExit(rolled, crashed, ctx, quiet)).toBe('none')
    const moved = trialRoot()
    useVersion(moved, '1.0.0')
    expect(await handleTrialExit(moved, crashed, ctx, quiet)).toBe('none')
    expect(readTrialMarker(moved)?.failures).toBe(0)
  })

  it('falls through without a marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-trial-'))
    expect(await handleTrialExit(root, crashed, ctx, quiet)).toBe('none')
    expect(existsSync(trialMarkerPath(root))).toBe(false)
  })

  it('keeps the count and propagates the exit when `from` cannot be restored', async () => {
    const root = trialRoot({ failures: UPGRADE_TRIAL_MAX_FAILURES - 1 })
    const restore = vi.fn(async () => {
      throw new Error('daemon 1.0.0 is not installed')
    })
    expect(await handleTrialExit(root, crashed, ctx, { ...quiet, restore })).toBe('none')
    const marker = readTrialMarker(root)
    expect(marker?.failures).toBe(UPGRADE_TRIAL_MAX_FAILURES)
    expect(marker?.rolledBack).toBeUndefined()
  })
})

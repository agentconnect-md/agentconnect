import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPUTER_QUOTAS,
  desktopRefusal,
  effectiveQuotas,
  emptyDesktopCounts,
  utcMonthStart,
  viewerRefusal,
  type ComputerQuotas
} from './computerQuotas.js'

const open: ComputerQuotas = {
  runningDesktops: null,
  desktops: null,
  storageGib: null,
  monthlyDesktopHours: null,
  modes: {},
  viewers: null,
  viewersPerComputer: null,
  monthlyViewerGib: null,
  screenshotStorageGib: null,
  screenshotRetentionDays: null
}

describe('managed computer quotas (computer-use.md §15.5)', () => {
  it('lays an override over the defaults, a mode key by key', () => {
    const defaults = { ...DEFAULT_COMPUTER_QUOTAS, modes: { manual: { runningDesktops: 1, desktops: 2 } } }
    const merged = effectiveQuotas(defaults, { runningDesktops: null, modes: { manual: { desktops: 5 } } })
    expect(merged.runningDesktops).toBeNull()
    expect(merged.desktops).toBe(DEFAULT_COMPUTER_QUOTAS.desktops)
    expect(merged.modes.manual).toEqual({ runningDesktops: 1, desktops: 5 })
    expect(effectiveQuotas(defaults, null)).toBe(defaults)
  })

  it('refuses a start past the running, held, per-mode, storage and hours limits', () => {
    const counts = emptyDesktopCounts()
    counts.running['per-agent'] = 2
    counts.held['per-agent'] = 3
    counts.held.manual = 1
    const start = { allocation: 'per-agent' as const, adding: true }
    expect(desktopRefusal(open, counts, start, 0, 5)).toBeNull()
    expect(desktopRefusal({ ...open, runningDesktops: 2 }, counts, start, 0, 5)?.quota).toBe('runningDesktops')
    expect(desktopRefusal({ ...open, desktops: 4 }, counts, start, 0, 5)?.quota).toBe('desktops')
    // A held desktop waking does not add one more.
    expect(desktopRefusal({ ...open, desktops: 4 }, counts, { ...start, adding: false }, 0, 5)).toBeNull()
    const perMode = { ...open, modes: { 'per-agent': { desktops: 3 } } }
    expect(desktopRefusal(perMode, counts, start, 0, 5)?.message).toMatch(/per-agent/)
    expect(desktopRefusal(perMode, counts, { allocation: 'manual', adding: true }, 0, 5)).toBeNull()
    expect(desktopRefusal({ ...open, storageGib: 20 }, counts, start, 0, 5)?.quota).toBe('storageGib')
    expect(desktopRefusal({ ...open, storageGib: 25 }, counts, start, 0, 5)).toBeNull()
    const hours = desktopRefusal({ ...open, monthlyDesktopHours: 10 }, counts, { ...start, adding: false }, 10.5, 5)
    expect(hours).toMatchObject({ quota: 'monthlyDesktopHours', limit: 10, used: 10 })
  })

  it('refuses a viewer past the per-Computer, organization and monthly media limits', () => {
    expect(viewerRefusal(open, { org: 50, computer: 9 }, 10 * 1024 ** 3)).toBeNull()
    expect(viewerRefusal({ ...open, viewersPerComputer: 2 }, { org: 2, computer: 2 }, 0)?.quota).toBe(
      'viewersPerComputer'
    )
    expect(viewerRefusal({ ...open, viewers: 2 }, { org: 2, computer: 0 }, 0)?.quota).toBe('viewers')
    expect(viewerRefusal({ ...open, monthlyViewerGib: 1 }, { org: 0, computer: 0 }, 1024 ** 3)?.quota).toBe(
      'monthlyViewerGib'
    )
  })

  it('starts the month at UTC midnight on the 1st', () => {
    expect(utcMonthStart(Date.parse('2026-10-22T23:59:59.000-05:00')).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})

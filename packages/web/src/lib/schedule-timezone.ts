'use client'

import { useCallback, useEffect, useState } from 'react'

// Which clock the schedule surfaces render instants in. A cron expression is authored IN a timezone
// and fires by it, so "next run" and a run's start are two readings of one instant; the viewer picks
// which. The expression's own reading is never converted — `0 2 * * MON` in one zone is a different
// weekday in another, and a DST zone has no fixed offset to convert by — so it always names its own.
export type ScheduleTimeZoneMode = 'browser' | 'schedule'

/** Per-device console preference, stored beside `ac-theme` and `ac.pinned-sessions` — a viewing choice, not CP state. */
export const SCHEDULE_TIME_ZONE_KEY = 'ac.schedule-timezone'

/** The viewer's IANA zone, falling back to UTC where the runtime will not name one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The stored mode — `'browser'` on the server, on blocked storage, and for anything unrecognized. */
export function readScheduleTimeZoneMode(): ScheduleTimeZoneMode {
  if (typeof window === 'undefined') return 'browser'
  try {
    return window.localStorage.getItem(SCHEDULE_TIME_ZONE_KEY) === 'schedule' ? 'schedule' : 'browser'
  } catch {
    return 'browser'
  }
}

/** Persist the mode. Silently no-ops when storage is blocked; the choice still applies for this page view. */
export function writeScheduleTimeZoneMode(mode: ScheduleTimeZoneMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SCHEDULE_TIME_ZONE_KEY, mode)
  } catch {
    /* private mode / storage disabled */
  }
}

/** The zone to render instants in. A schedule carrying no timezone leaves nothing to switch to. */
export function displayTimeZone(mode: ScheduleTimeZoneMode, scheduleTimeZone?: string | null): string {
  return mode === 'schedule' && scheduleTimeZone ? scheduleTimeZone : browserTimeZone()
}

/** Whether a schedule offers a second clock at all — same zone as the viewer means nothing to switch. */
export function hasDistinctScheduleZone(scheduleTimeZone?: string | null): boolean {
  return !!scheduleTimeZone && scheduleTimeZone !== browserTimeZone()
}

export interface ScheduleTimeZone {
  mode: ScheduleTimeZoneMode
  /** False on the server and the first client paint, so markup that depends on the viewer's zone waits for it. */
  ready: boolean
  setMode: (mode: ScheduleTimeZoneMode) => void
  zoneFor: (scheduleTimeZone?: string | null) => string
}

/** The viewer's schedule-clock choice. Renders as `'browser'` until mounted, so hydration never mismatches. */
export function useScheduleTimeZone(): ScheduleTimeZone {
  const [mode, setStoredMode] = useState<ScheduleTimeZoneMode>('browser')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setStoredMode(readScheduleTimeZoneMode())
    setReady(true)
  }, [])
  const setMode = useCallback((next: ScheduleTimeZoneMode) => {
    setStoredMode(next)
    writeScheduleTimeZoneMode(next)
  }, [])
  const zoneFor = useCallback((scheduleTimeZone?: string | null) => displayTimeZone(mode, scheduleTimeZone), [mode])
  return { mode, ready, setMode, zoneFor }
}

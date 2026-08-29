'use client'

import { Icon } from '@/components/ui'
import { browserTimeZone, hasDistinctScheduleZone, type ScheduleTimeZone } from '@/lib/schedule-timezone'

// Switches which clock a schedule surface reads its instants in. It renders nothing when the
// schedule is kept on the viewer's own zone, since both readings would then be the same text, and
// nothing until the hook is `ready`: the viewer's zone is unknown on the server, so deciding
// visibility before mount would mismatch hydration.
export function ZoneSwitch({ clock, scheduleZone }: { clock: ScheduleTimeZone; scheduleZone?: string | null }) {
  if (!clock.ready || !hasDistinctScheduleZone(scheduleZone)) return null
  const zone = clock.zoneFor(scheduleZone)
  const other = clock.mode === 'schedule' ? browserTimeZone() : (scheduleZone as string)
  return (
    <button
      type="button"
      onClick={() => clock.setMode(clock.mode === 'schedule' ? 'browser' : 'schedule')}
      className="inline-flex items-center gap-[6px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
      title={`Times shown in ${zone} — switch to ${other}`}
    >
      <Icon name="globe" size={13} color="var(--text-tertiary)" />
      {zone}
    </button>
  )
}

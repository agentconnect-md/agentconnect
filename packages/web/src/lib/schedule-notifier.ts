'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import type { CronDto } from '@/lib/api'
import { useNotifications, type NotificationSnapshotInput } from '@/lib/notifications'

/** Consecutive failed runs before the bell says so; one failure is noise, a third is a pattern. */
export const FAILING_SCHEDULE_STREAK = 3

type FailingCopy = (
  key: 'title' | 'message' | 'messageWithReason' | 'action' | 'resolvedTitle' | 'resolvedMessage',
  values?: { name: string; count?: number; reason?: string }
) => string

// One item per streak: `since` keys it, so a longer streak updates the item and the next streak mints a new one.
export function failingScheduleNotifications(
  crons: readonly CronDto[],
  orgPath: (path: string) => string,
  t: FailingCopy
): NotificationSnapshotInput[] {
  const items: NotificationSnapshotInput[] = []
  for (const cron of crons) {
    const failing = cron.failing
    // The bell is a "you can act" signal: a paused schedule has been acted on, and a viewer cannot fix one.
    if (!failing || failing.streak < FAILING_SCHEDULE_STREAK || !cron.enabled || !cron.canEdit) continue
    const name = cron.name?.trim() || cron.trigger
    items.push({
      category: 'schedule',
      severity: 'error',
      sourceKey: `schedule-failing:${cron.id}:${failing.since}`,
      title: t('title'),
      message: failing.reason
        ? t('messageWithReason', { name, count: failing.streak, reason: failing.reason })
        : t('message', { name, count: failing.streak }),
      action: { label: t('action'), href: orgPath(`/crons/${encodeURIComponent(cron.id)}`), external: false },
      resolution: {
        title: t('resolvedTitle'),
        message: t('resolvedMessage', { name }),
        severity: 'info',
        read: true
      }
    })
  }
  return items
}

/** Keep the bell's `schedules` scope equal to the schedules that keep failing, once the list has answered. */
export function useScheduleNotifier(
  crons: readonly CronDto[],
  loaded: boolean,
  orgPath: (path: string) => string
): void {
  const t = useTranslations('Crons.failingNotification')
  const { syncSourceSnapshot } = useNotifications()
  useEffect(() => {
    // Until the list has answered once, its empty default would resolve every item.
    if (!loaded) return
    syncSourceSnapshot('schedules', failingScheduleNotifications(crons, orgPath, t))
  }, [crons, loaded, orgPath, t, syncSourceSnapshot])
}

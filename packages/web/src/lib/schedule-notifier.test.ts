import { describe, expect, it } from 'vitest'
import type { CronDto } from '@/lib/api'
import { emptyNotificationState, syncNotificationSourceSnapshot } from '@/lib/notifications'
import { FAILING_SCHEDULE_STREAK, failingScheduleNotifications } from '@/lib/schedule-notifier'

const orgPath = (path: string) => `/acme${path}`
const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}:${JSON.stringify(values)}` : key)

function cron(over: Partial<CronDto> = {}): CronDto {
  return {
    id: 'cron/1',
    orgId: 'org-1',
    agentId: 'agent-1',
    name: 'Daily check',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    targetPlatform: 'slack',
    targetChannel: null,
    targetIntegrationId: null,
    trigger: 'check the dependency updates',
    enabled: true,
    lastRunAt: null,
    createdBy: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastModifiedBy: null,
    lastModifiedAt: '2026-07-01T00:00:00.000Z',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true,
    failing: { streak: FAILING_SCHEDULE_STREAK, since: '2026-07-03T09:00:00.000Z', reason: 'Authentication required' },
    ...over
  }
}

describe('failingScheduleNotifications', () => {
  it('raises one item for a schedule at the streak, with its reason and a link to it', () => {
    const [item, ...rest] = failingScheduleNotifications([cron()], orgPath, t)
    expect(rest).toEqual([])
    expect(item).toMatchObject({
      category: 'schedule',
      severity: 'error',
      sourceKey: 'schedule-failing:cron/1:2026-07-03T09:00:00.000Z',
      title: 'title',
      message: `messageWithReason:${JSON.stringify({ name: 'Daily check', count: 3, reason: 'Authentication required' })}`,
      action: { label: 'action', href: '/acme/crons/cron%2F1', external: false }
    })
  })

  it('leaves out the reason when the run reported none, and names an unnamed schedule by its task', () => {
    const [item] = failingScheduleNotifications(
      [cron({ name: null, failing: { streak: 5, since: '2026-07-03T09:00:00.000Z', reason: null } })],
      orgPath,
      t
    )
    expect(item!.message).toBe(`message:${JSON.stringify({ name: 'check the dependency updates', count: 5 })}`)
  })

  it('says nothing below the streak, for a healthy or paused schedule, or one the viewer cannot edit', () => {
    const quiet = [
      cron({ id: 'short', failing: { streak: FAILING_SCHEDULE_STREAK - 1, since: 'x', reason: null } }),
      cron({ id: 'healthy', failing: null }),
      cron({ id: 'older-server', failing: undefined }),
      cron({ id: 'paused', enabled: false }),
      cron({ id: 'read-only', canEdit: false })
    ]
    expect(failingScheduleNotifications(quiet, orgPath, t)).toEqual([])
  })

  it('keeps one item while the streak grows, resolves it on recovery, and raises a new one for the next streak', () => {
    const first = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'schedules',
      failingScheduleNotifications([cron()], orgPath, t)
    )
    expect(first.added).toHaveLength(1)

    const longer = cron({
      failing: { streak: 9, since: '2026-07-03T09:00:00.000Z', reason: 'Authentication required' }
    })
    const grown = syncNotificationSourceSnapshot(
      first.state,
      'schedules',
      failingScheduleNotifications([longer], orgPath, t)
    )
    expect(grown.added).toEqual([])

    const recovered = syncNotificationSourceSnapshot(
      grown.state,
      'schedules',
      failingScheduleNotifications([cron({ failing: null })], orgPath, t)
    )
    expect(recovered.state.notifications[0]).toMatchObject({ title: 'resolvedTitle', read: true })
    expect(recovered.state.notifications[0]!.resolvedAt).toBeDefined()

    const again = cron({ failing: { streak: 3, since: '2026-07-20T09:00:00.000Z', reason: null } })
    const second = syncNotificationSourceSnapshot(
      recovered.state,
      'schedules',
      failingScheduleNotifications([again], orgPath, t)
    )
    expect(second.added).toHaveLength(1)
  })
})

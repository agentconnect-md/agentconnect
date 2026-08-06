import { describe, expect, it } from 'vitest'
import type { SessionAccessNotificationInput } from '@/lib/session-access-notifications'
import {
  clearNotificationHistory,
  emptyNotificationState,
  loadNotificationState,
  saveNotificationState,
  syncNotificationSourceSnapshot,
  type NotificationStoreState
} from '@/lib/notifications'

const quotaItem: SessionAccessNotificationInput = {
  category: 'session_access',
  severity: 'warning',
  sourceKey: 'sessions:feishu:lark:quota',
  title: 'Lark API quota exhausted',
  message: 'Affected sessions are hidden.',
  action: {
    label: 'Open Lark Admin',
    href: 'https://www.larksuite.com/admin',
    external: true
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
}

describe('syncNotificationSourceSnapshot', () => {
  it('adds once, then updates the active row without changing read state or timestamp', () => {
    const first = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'notification-1'
    )
    expect(first.added).toHaveLength(1)

    const readState: NotificationStoreState = {
      ...first.state,
      notifications: first.state.notifications.map((item) => ({ ...item, read: true }))
    }
    const repeated = syncNotificationSourceSnapshot(
      readState,
      'sessions-access',
      [{ ...quotaItem, message: 'Updated impact copy.' }],
      '2026-08-06T02:00:00.000Z',
      () => 'notification-2'
    )

    expect(repeated.added).toEqual([])
    expect(repeated.state.notifications).toEqual([
      expect.objectContaining({
        id: 'notification-1',
        timestamp: '2026-08-06T01:00:00.000Z',
        read: true,
        message: 'Updated impact copy.'
      })
    ])
  })

  it('marks an absent source resolved and creates a new item only after recurrence', () => {
    const first = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'notification-1'
    )
    const resolved = syncNotificationSourceSnapshot(
      first.state,
      'sessions-access',
      [],
      '2026-08-06T02:00:00.000Z',
      () => 'unused'
    )

    expect(resolved.state.notifications[0]).toMatchObject({
      id: 'notification-1',
      resolvedAt: '2026-08-06T02:00:00.000Z'
    })
    expect(resolved.state.notifications[0]?.action).toBeUndefined()

    const recurrence = syncNotificationSourceSnapshot(
      resolved.state,
      'sessions-access',
      [quotaItem],
      '2026-08-06T03:00:00.000Z',
      () => 'notification-2'
    )
    expect(recurrence.added.map((item) => item.id)).toEqual(['notification-2'])
    expect(recurrence.state.notifications.map((item) => item.id)).toEqual(['notification-2', 'notification-1'])
  })

  it('resolves only keys owned by the synchronized scope', () => {
    const usageItem: SessionAccessNotificationInput = {
      ...quotaItem,
      sourceKey: 'usage:feishu:lark:quota',
      message: 'Usage is under-counted.'
    }
    const withSessions = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'sessions-1'
    ).state
    const withBoth = syncNotificationSourceSnapshot(
      withSessions,
      'usage-access',
      [usageItem],
      '2026-08-06T01:01:00.000Z',
      () => 'usage-1'
    ).state

    const sessionsResolved = syncNotificationSourceSnapshot(
      withBoth,
      'sessions-access',
      [],
      '2026-08-06T02:00:00.000Z',
      () => 'unused'
    ).state

    expect(sessionsResolved.notifications.find((item) => item.id === 'sessions-1')?.resolvedAt).toBeTruthy()
    expect(sessionsResolved.notifications.find((item) => item.id === 'usage-1')?.resolvedAt).toBeUndefined()
  })

  it('keeps an active tombstone across clear, reload, resolution, and recurrence', () => {
    const storage = memoryStorage()
    const first = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'notification-1'
    ).state
    saveNotificationState(clearNotificationHistory(first), 'org-1', storage)

    const reloaded = loadNotificationState('org-1', storage)
    const stillActive = syncNotificationSourceSnapshot(
      reloaded,
      'sessions-access',
      [quotaItem],
      '2026-08-06T02:00:00.000Z',
      () => 'must-not-be-used'
    )
    expect(stillActive.state.notifications).toEqual([])
    expect(stillActive.added).toEqual([])

    const resolved = syncNotificationSourceSnapshot(
      stillActive.state,
      'sessions-access',
      [],
      '2026-08-06T03:00:00.000Z',
      () => 'unused'
    ).state
    const recurrence = syncNotificationSourceSnapshot(
      resolved,
      'sessions-access',
      [quotaItem],
      '2026-08-06T04:00:00.000Z',
      () => 'notification-2'
    )
    expect(recurrence.added.map((item) => item.id)).toEqual(['notification-2'])
  })

  it('keeps an evicted active tombstone across reload', () => {
    const storage = memoryStorage()
    const active = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'active'
    ).state
    const crowded: NotificationStoreState = {
      ...active,
      notifications: [
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `other-${index}`,
          category: 'daemon_lifecycle' as const,
          severity: 'info' as const,
          title: `Other ${index}`,
          message: 'Other notification',
          timestamp: `2026-08-06T02:${String(index).padStart(2, '0')}:00.000Z`,
          read: false
        })),
        ...active.notifications
      ]
    }
    const evicted = syncNotificationSourceSnapshot(
      crowded,
      'sessions-access',
      [quotaItem],
      '2026-08-06T03:00:00.000Z',
      () => 'must-not-be-used'
    ).state
    expect(evicted.notifications).toHaveLength(50)
    expect(evicted.notifications.some((item) => item.id === 'active')).toBe(false)

    saveNotificationState(evicted, 'org-1', storage)
    const afterReload = syncNotificationSourceSnapshot(
      loadNotificationState('org-1', storage),
      'sessions-access',
      [quotaItem],
      '2026-08-06T04:00:00.000Z',
      () => 'must-not-be-used'
    )
    expect(afterReload.added).toEqual([])
    expect(afterReload.state.notifications.some((item) => item.sourceKey === quotaItem.sourceKey)).toBe(false)
  })

  it('falls back to empty in-memory state when storage reads or writes fail', () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }

    expect(loadNotificationState('org-1', brokenStorage)).toEqual(emptyNotificationState())
    expect(() => saveNotificationState(emptyNotificationState(), 'org-1', brokenStorage)).not.toThrow()
  })
})

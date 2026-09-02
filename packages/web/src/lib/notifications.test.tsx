// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { SessionAccessNotificationInput } from '@/lib/session-access-notifications'
import {
  clearNotificationHistory,
  emptyNotificationState,
  loadNotificationState,
  saveNotificationState,
  syncNotificationSourceSnapshot,
  type NotificationStoreState
} from '@/lib/notifications'
import { NotificationProvider, useNotifications } from '@/lib/notifications'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  it('applies the item’s own resolution text and read flip when its source vanishes', () => {
    const approval = {
      category: 'approval' as const,
      severity: 'warning' as const,
      sourceKey: 'approval:s1',
      title: 'Approval needed',
      message: 'Butler is waiting for permission.',
      action: { label: 'Open session', href: '/acme/sessions/s1', external: false },
      resolution: {
        title: 'Approval resolved',
        message: 'Butler is no longer waiting.',
        severity: 'info' as const,
        read: true
      }
    }
    const pending = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'approvals',
      [approval],
      '2026-08-06T01:00:00.000Z',
      () => 'approval-1'
    )
    expect(pending.added).toHaveLength(1)
    expect(pending.state.notifications[0]).toMatchObject({ read: false, title: 'Approval needed' })

    const resolved = syncNotificationSourceSnapshot(pending.state, 'approvals', [], '2026-08-06T02:00:00.000Z')
    expect(resolved.added).toEqual([])
    expect(resolved.state.notifications[0]).toMatchObject({
      id: 'approval-1',
      read: true,
      severity: 'info',
      title: 'Approval resolved',
      message: 'Butler is no longer waiting.',
      resolvedAt: '2026-08-06T02:00:00.000Z'
    })
    expect(resolved.state.notifications[0]?.action).toBeUndefined()
    expect(resolved.state.activeSources.approvals).toEqual([])
    // The other scopes keep the original behavior: a vanished source only gains `resolvedAt`.
    const access = syncNotificationSourceSnapshot(emptyNotificationState(), 'sessions-access', [quotaItem])
    const accessResolved = syncNotificationSourceSnapshot(access.state, 'sessions-access', [])
    expect(accessResolved.state.notifications[0]).toMatchObject({ read: false, title: quotaItem.title })
  })

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

function CaptureNotifications({
  onChange
}: {
  onChange: (notifications: ReturnType<typeof useNotifications>) => void
}) {
  const notifications = useNotifications()
  useEffect(() => onChange(notifications), [notifications, onChange])
  return null
}

describe('NotificationProvider', () => {
  it('does not render the previous organization during the first commit after a switch', async () => {
    localStorage.clear()
    const orgAState = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [{ ...quotaItem, title: 'Organization A notice' }],
      '2026-08-06T01:00:00.000Z',
      () => 'org-a-notification'
    ).state
    const orgBState = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'usage-access',
      [{ ...quotaItem, sourceKey: 'usage:feishu:lark:quota', title: 'Organization B notice' }],
      '2026-08-06T02:00:00.000Z',
      () => 'org-b-notification'
    ).state
    saveNotificationState(orgAState, 'org-a')
    saveNotificationState(orgBState, 'org-b')

    function VisibleTitles() {
      return (
        <div>
          {useNotifications()
            .notifications.map((item) => item.title)
            .join(',')}
        </div>
      )
    }

    const onMount = vi.fn()
    function MountSentinel() {
      useEffect(() => onMount(), [])
      return <VisibleTitles />
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <NotificationProvider orgId="org-a">
          <MountSentinel />
        </NotificationProvider>
      )
    })
    expect(host.textContent).toBe('Organization A notice')

    act(() => {
      flushSync(() => {
        root.render(
          <NotificationProvider orgId="org-b">
            <MountSentinel />
          </NotificationProvider>
        )
      })
      expect(host.textContent).toBe('Organization B notice')
    })
    expect(onMount).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    host.remove()
  })

  it('never writes the previous organization state under the next organization key', async () => {
    localStorage.clear()
    const orgAState = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'sessions-access',
      [quotaItem],
      '2026-08-06T01:00:00.000Z',
      () => 'org-a-notification'
    ).state
    const orgBState = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'usage-access',
      [{ ...quotaItem, sourceKey: 'usage:feishu:lark:quota' }],
      '2026-08-06T02:00:00.000Z',
      () => 'org-b-notification'
    ).state
    saveNotificationState(orgAState, 'org-a')
    saveNotificationState(orgBState, 'org-b')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onChange = () => {}
    await act(async () => {
      root.render(
        <NotificationProvider orgId="org-a">
          <CaptureNotifications onChange={onChange} />
        </NotificationProvider>
      )
    })

    const writes: Array<[string, string]> = []
    const originalSetItem = localStorage.setItem.bind(localStorage)
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      writes.push([key, value])
      originalSetItem(key, value)
    })
    await act(async () => {
      root.render(
        <NotificationProvider orgId="org-b">
          <CaptureNotifications onChange={onChange} />
        </NotificationProvider>
      )
    })

    expect(
      writes.some(
        ([key, value]) => key === 'agentconnect_notifications_v1_org-b' && value.includes('org-a-notification')
      )
    ).toBe(false)

    setItem.mockRestore()
    await act(async () => root.unmount())
    host.remove()
  })

  it('dismisses a live toast when its source resolves', async () => {
    localStorage.clear()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const latest: { current: ReturnType<typeof useNotifications> | null } = { current: null }
    const onChange = (notifications: ReturnType<typeof useNotifications>) => {
      latest.current = notifications
    }
    await act(async () => {
      root.render(
        <NotificationProvider orgId="org-a">
          <CaptureNotifications onChange={onChange} />
        </NotificationProvider>
      )
    })
    await act(async () => latest.current?.syncSourceSnapshot('sessions-access', [quotaItem]))
    expect(latest.current?.toasts).toEqual([expect.objectContaining({ sourceKey: quotaItem.sourceKey })])

    await act(async () => latest.current?.syncSourceSnapshot('sessions-access', []))
    expect(latest.current?.toasts).toEqual([])

    await act(async () => root.unmount())
    host.remove()
  })
})

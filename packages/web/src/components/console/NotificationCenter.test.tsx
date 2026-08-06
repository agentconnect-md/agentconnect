// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NotificationProvider, useNotifications, type NotificationItem } from '@/lib/notifications'
import {
  NotificationActionLink,
  NotificationBell,
  NotificationToastContainer,
  notificationBellLabel
} from '@/components/console/NotificationCenter'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const actionableItem: NotificationItem = {
  id: 'notification-1',
  category: 'session_access',
  severity: 'warning',
  sourceKey: 'sessions:feishu:lark:quota',
  title: 'Lark API quota exhausted',
  message: 'Affected sessions are hidden.',
  action: {
    label: 'Open Lark Admin',
    href: 'https://www.larksuite.com/admin',
    external: true
  },
  timestamp: '2026-08-06T01:00:00.000Z',
  read: false
}

describe('NotificationBell', () => {
  it('uses rail chrome without a light card or border', () => {
    const html = renderToStaticMarkup(
      <NotificationProvider>
        <NotificationBell variant="rail" />
      </NotificationProvider>
    )

    expect(html).toContain('railiconbtn')
    expect(html).not.toContain('bg-(--surface-card)')
    expect(html).not.toContain('border-(--border-subtle)')
  })

  it('uses mobile app-bar chrome', () => {
    const html = renderToStaticMarkup(
      <NotificationProvider>
        <NotificationBell variant="mobile" />
      </NotificationProvider>
    )
    expect(html).toContain('mappbtn')
  })

  it('uses the same accessible unread-count label for both variants', () => {
    expect(notificationBellLabel(0)).toBe('Notifications')
    expect(notificationBellLabel(4)).toBe('Notifications (4 unread)')
  })
})

describe('NotificationActionLink', () => {
  it('renders a safe external anchor and activates without bubbling to the row', () => {
    const onActivate = vi.fn()
    const element = NotificationActionLink({ item: actionableItem, onActivate })
    expect(element).not.toBeNull()
    if (!element) return

    expect(element.props.href).toBe('https://www.larksuite.com/admin')
    expect(element.props.target).toBe('_blank')
    expect(element.props.rel).toBe('noreferrer')

    const stopPropagation = vi.fn()
    element.props.onClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onActivate).toHaveBeenCalledWith('notification-1')
  })

  it('suppresses stale actions on resolved notifications', () => {
    expect(
      NotificationActionLink({
        item: { ...actionableItem, resolvedAt: '2026-08-06T02:00:00.000Z' },
        onActivate: vi.fn()
      })
    ).toBeNull()
  })

  it('marks panel actions read and dismisses toast actions in a mounted interaction', async () => {
    localStorage.clear()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const latest: { current: ReturnType<typeof useNotifications> | null } = { current: null }

    function Capture() {
      const notifications = useNotifications()
      useEffect(() => {
        latest.current = notifications
      }, [notifications])
      return null
    }

    await act(async () => {
      root.render(
        <NotificationProvider orgId="org-1">
          <Capture />
          <NotificationBell variant="rail" />
          <NotificationToastContainer />
        </NotificationProvider>
      )
    })
    await act(async () =>
      latest.current?.syncSourceSnapshot('sessions-access', [
        {
          category: 'session_access',
          severity: 'warning',
          sourceKey: actionableItem.sourceKey!,
          title: actionableItem.title,
          message: actionableItem.message,
          action: actionableItem.action
        }
      ])
    )

    await act(async () => (host.querySelector('button.railiconbtn') as HTMLButtonElement).click())
    const actions = host.querySelectorAll<HTMLAnchorElement>('a[href="https://www.larksuite.com/admin"]')
    expect(actions).toHaveLength(2)
    actions[0]!.focus()
    expect(document.activeElement).toBe(actions[0])
    await act(async () => actions[0]!.click())
    expect(latest.current?.notifications[0]?.read).toBe(true)
    expect(latest.current?.toasts).toHaveLength(1)

    await act(async () => actions[1]!.click())
    expect(latest.current?.toasts).toEqual([])

    await act(async () => root.unmount())
    host.remove()
  })
})

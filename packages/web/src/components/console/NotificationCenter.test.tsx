import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NotificationProvider, type NotificationItem } from '@/lib/notifications'
import {
  NotificationActionLink,
  NotificationBell,
  notificationBellLabel
} from '@/components/console/NotificationCenter'

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
})

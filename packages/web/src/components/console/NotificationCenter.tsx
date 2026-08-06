'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui'
import { useNotifications, type NotificationItem, type NotificationSeverity } from '@/lib/notifications'

function formatRelativeTime(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

function SeverityIcon({ severity }: { severity: NotificationSeverity }) {
  switch (severity) {
    case 'success':
      return <Icon name="circle-check" size={15} color="var(--status-online)" className="flex-none mt-[2px]" />
    case 'error':
      return <Icon name="circle-x" size={15} color="var(--magenta-600)" className="flex-none mt-[2px]" />
    case 'warning':
      return <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="flex-none mt-[2px]" />
    case 'info':
    default:
      return <Icon name="info" size={15} color="var(--brand)" className="flex-none mt-[2px]" />
  }
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllAsRead, clearAll, markAsRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const items = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications

  return (
    <div ref={menuRef} className="relative inline-block">
      <button
        type="button"
        className="iconbtn relative flex h-8 w-8 items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-card) text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary)"
        aria-label="Notifications"
        title="Notifications"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="bell" size={16} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-(--magenta-600) px-1 text-[10px] font-semibold leading-none text-white shadow-xs">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-[360px] max-w-[calc(100vw-32px)] rounded-lg border border-(--border-default) bg-(--surface-card) p-0 shadow-(--shadow-md)">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                Notifications
              </span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-(--magenta-100) px-2 py-[1px] font-sans text-[11px] font-semibold text-(--magenta-700)">
                  {unreadCount} unread
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="font-sans text-[12px] font-medium text-(--brand) cursor-pointer transition-opacity hover:opacity-80"
                  onClick={markAllAsRead}
                >
                  Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  className="font-sans text-[12px] font-medium text-(--text-tertiary) cursor-pointer transition-opacity hover:text-(--text-primary)"
                  onClick={clearAll}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="flex border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-1.5 gap-2">
            <button
              type="button"
              className={`rounded-xs px-2 py-1 text-[12px] font-medium ${
                filter === 'all'
                  ? 'bg-(--surface-card) text-(--text-primary) shadow-xs'
                  : 'text-(--text-tertiary) hover:text-(--text-primary)'
              }`}
              onClick={() => setFilter('all')}
            >
              All ({notifications.length})
            </button>
            <button
              type="button"
              className={`rounded-xs px-2 py-1 text-[12px] font-medium ${
                filter === 'unread'
                  ? 'bg-(--surface-card) text-(--text-primary) shadow-xs'
                  : 'text-(--text-tertiary) hover:text-(--text-primary)'
              }`}
              onClick={() => setFilter('unread')}
            >
              Unread ({unreadCount})
            </button>
          </div>

          {/* List */}
          <div className="max-h-[360px] overflow-y-auto divide-y divide-(--border-subtle)">
            {items.length === 0 ? (
              <div className="p-6 text-center text-[13px] text-(--text-tertiary)">
                {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 p-3.5 transition-colors cursor-pointer ${
                    item.read
                      ? 'bg-transparent hover:bg-(--surface-hover)'
                      : 'bg-(--status-paused-soft) hover:bg-(--surface-hover)'
                  }`}
                  onClick={() => markAsRead(item.id)}
                >
                  <SeverityIcon severity={item.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-sans text-[12.5px] font-semibold leading-snug text-(--text-primary)">
                        {item.title}
                      </span>
                      <span className="flex-none font-sans text-[11px] text-(--text-tertiary)">
                        {formatRelativeTime(item.timestamp)}
                      </span>
                    </div>
                    <p className="mt-0.5 font-sans text-[12px] font-normal leading-relaxed text-(--text-secondary) break-words">
                      {item.message}
                    </p>
                    {item.daemonName && (
                      <span className="mt-1 inline-block rounded-xs bg-(--surface-sunken) px-1.5 py-[1px] font-mono text-[10.5px] text-(--text-tertiary)">
                        Daemon: {item.daemonName}
                      </span>
                    )}
                  </div>
                  {!item.read && <span className="mt-1 h-2 w-2 flex-none rounded-full bg-(--brand)" title="Unread" />}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function NotificationToastContainer() {
  const { toasts, dismissToast } = useNotifications()

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: NotificationItem; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss()
    }, 6000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div
      role={toast.severity === 'error' || toast.severity === 'warning' ? 'alert' : 'status'}
      className="pointer-events-auto flex items-start gap-3 rounded-md border border-(--border-default) bg-(--surface-card) p-4 shadow-(--shadow-md) transition-all animate-in fade-in slide-in-from-top-2"
    >
      <SeverityIcon severity={toast.severity} />
      <div className="min-w-0 flex-1">
        <span className="block font-sans text-[12.5px] font-semibold leading-snug text-(--text-primary)">
          {toast.title}
        </span>
        <span className="mt-0.5 block font-sans text-[12px] font-normal leading-relaxed text-(--text-secondary) break-words">
          {toast.message}
        </span>
      </div>
      <button
        type="button"
        className="iconbtn -m-1 h-6 w-6 flex-none items-center justify-center rounded-xs text-(--text-tertiary) hover:text-(--text-primary)"
        aria-label="Dismiss toast"
        onClick={onDismiss}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

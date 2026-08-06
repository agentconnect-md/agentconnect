'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type NotificationCategory = 'daemon_lifecycle' | 'session_retention'

export interface NotificationItem {
  id: string
  category: NotificationCategory
  severity: NotificationSeverity
  title: string
  message: string
  daemonId?: string
  daemonName?: string
  timestamp: string // ISO string
  read: boolean
}

interface NotificationContextValue {
  notifications: NotificationItem[]
  unreadCount: number
  toasts: NotificationItem[]
  addNotification: (item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => void
  markAsRead: (id: string) => void
  markAllAsRead: () => void
  clearAll: () => void
  dismissToast: (id: string) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

const BASE_STORAGE_KEY = 'agentconnect_notifications_v1'
const MAX_NOTIFICATIONS = 50

function getStorageKey(orgId?: string | null): string {
  return orgId ? `${BASE_STORAGE_KEY}_${orgId}` : BASE_STORAGE_KEY
}

function loadStoredNotifications(orgId?: string | null): NotificationItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(getStorageKey(orgId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as NotificationItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveStoredNotifications(items: NotificationItem[], orgId?: string | null): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(getStorageKey(orgId), JSON.stringify(items.slice(0, MAX_NOTIFICATIONS)))
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function NotificationProvider({ orgId, children }: { orgId?: string | null; children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>(() => loadStoredNotifications(orgId))
  const [toasts, setToasts] = useState<NotificationItem[]>([])
  const activeOrgRef = useRef(orgId)

  useEffect(() => {
    activeOrgRef.current = orgId
    setNotifications(loadStoredNotifications(orgId))
    setToasts([])
  }, [orgId])

  useEffect(() => {
    if (activeOrgRef.current === orgId) {
      saveStoredNotifications(notifications, orgId)
    }
  }, [notifications, orgId])

  const addNotification = useCallback((item: Omit<NotificationItem, 'id' | 'timestamp' | 'read'>) => {
    const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const newNotif: NotificationItem = {
      ...item,
      id,
      timestamp: new Date().toISOString(),
      read: false
    }

    setNotifications((prev) => [newNotif, ...prev].slice(0, MAX_NOTIFICATIONS))
    setToasts((prev) => [newNotif, ...prev].slice(0, 5))
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((item) => (item.id === id ? { ...item, read: true } : item)))
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((item) => ({ ...item, read: true })))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
    setToasts([])
  }, [])

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications])

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      toasts,
      addNotification,
      markAsRead,
      markAllAsRead,
      clearAll,
      dismissToast
    }),
    [notifications, unreadCount, toasts, addNotification, markAsRead, markAllAsRead, clearAll, dismissToast]
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationProvider')
  }
  return ctx
}

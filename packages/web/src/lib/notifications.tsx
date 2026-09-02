'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionAccessNotificationAction } from '@/lib/session-access-notifications'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type NotificationCategory = 'daemon_lifecycle' | 'session_retention' | 'session_access' | 'approval'
export type NotificationSourceScope = 'sessions-access' | 'usage-access' | 'approvals'
const SOURCE_SCOPES: readonly NotificationSourceScope[] = ['sessions-access', 'usage-access', 'approvals']

/** What a snapshot item becomes once its source vanishes; absent ⇒ it keeps its text and read state and only gains `resolvedAt`. */
export interface NotificationResolution {
  title: string
  message: string
  severity?: NotificationSeverity
  /** Flip to read on resolution — for an item whose only job was to get someone to act. */
  read?: boolean
}

export interface NotificationItem {
  id: string
  category: NotificationCategory
  severity: NotificationSeverity
  title: string
  message: string
  daemonId?: string
  daemonName?: string
  sourceKey?: string
  action?: SessionAccessNotificationAction
  resolution?: NotificationResolution
  resolvedAt?: string
  timestamp: string
  read: boolean
}

/** One active condition in a snapshot scope, keyed by `sourceKey`; the reconciler mints the rest. */
export type NotificationSnapshotInput = Omit<NotificationItem, 'id' | 'timestamp' | 'read' | 'resolvedAt'> & {
  sourceKey: string
}

export interface NotificationStoreState {
  notifications: NotificationItem[]
  activeSources: Record<NotificationSourceScope, string[]>
}

type AddNotificationInput = Omit<NotificationItem, 'id' | 'timestamp' | 'read'>
type NotificationStorage = Pick<Storage, 'getItem' | 'setItem'>

interface NotificationContextValue {
  notifications: NotificationItem[]
  unreadCount: number
  toasts: NotificationItem[]
  addNotification: (item: AddNotificationInput) => void
  syncSourceSnapshot: (scope: NotificationSourceScope, items: NotificationSnapshotInput[]) => void
  markAsRead: (id: string) => void
  /** Mark every item of one snapshot source read — for a resolution the user made themselves. */
  markSourceRead: (sourceKey: string) => void
  markAllAsRead: () => void
  clearAll: () => void
  dismissToast: (id: string) => void
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

const BASE_STORAGE_KEY = 'agentconnect_notifications_v1'
const ACTIVE_STORAGE_KEY = 'agentconnect_notification_sources_v1'
const MAX_NOTIFICATIONS = 50

function getStorageKey(base: string, orgId?: string | null): string {
  return orgId ? `${base}_${orgId}` : base
}

function browserStorage(storage?: NotificationStorage): NotificationStorage | undefined {
  if (storage) return storage
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}

export function emptyNotificationState(): NotificationStoreState {
  return {
    notifications: [],
    activeSources: { 'sessions-access': [], 'usage-access': [], approvals: [] }
  }
}

export function loadNotificationState(orgId?: string | null, storage?: NotificationStorage): NotificationStoreState {
  const target = browserStorage(storage)
  if (!target) return emptyNotificationState()
  try {
    const historyRaw = target.getItem(getStorageKey(BASE_STORAGE_KEY, orgId))
    const activeRaw = target.getItem(getStorageKey(ACTIVE_STORAGE_KEY, orgId))
    const history = historyRaw ? (JSON.parse(historyRaw) as unknown) : []
    const active = activeRaw ? (JSON.parse(activeRaw) as unknown) : {}
    const activeRecord = active && typeof active === 'object' ? (active as Record<string, unknown>) : {}
    const activeSources = emptyNotificationState().activeSources
    for (const scope of SOURCE_SCOPES) {
      const keys = activeRecord[scope]
      if (Array.isArray(keys)) activeSources[scope] = keys.filter((key): key is string => typeof key === 'string')
    }
    return {
      notifications: Array.isArray(history) ? (history as NotificationItem[]).slice(0, MAX_NOTIFICATIONS) : [],
      activeSources
    }
  } catch {
    return emptyNotificationState()
  }
}

export function saveNotificationState(
  state: NotificationStoreState,
  orgId?: string | null,
  storage?: NotificationStorage
): void {
  const target = browserStorage(storage)
  if (!target) return
  try {
    target.setItem(
      getStorageKey(BASE_STORAGE_KEY, orgId),
      JSON.stringify(state.notifications.slice(0, MAX_NOTIFICATIONS))
    )
    target.setItem(getStorageKey(ACTIVE_STORAGE_KEY, orgId), JSON.stringify(state.activeSources))
  } catch {
    // Ignore storage quota / privacy mode errors; the provider keeps in-memory state.
  }
}

function defaultNotificationId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function syncNotificationSourceSnapshot(
  state: NotificationStoreState,
  scope: NotificationSourceScope,
  items: NotificationSnapshotInput[],
  now = new Date().toISOString(),
  makeId: () => string = defaultNotificationId
): { state: NotificationStoreState; added: NotificationItem[] } {
  const previousKeys = new Set(state.activeSources[scope])
  const nextItems = new Map(items.map((item) => [item.sourceKey, item]))
  const notifications = state.notifications.map((item) => ({ ...item }))
  const added: NotificationItem[] = []

  for (const [sourceKey, input] of nextItems) {
    if (previousKeys.has(sourceKey)) {
      const index = notifications.findIndex((item) => item.sourceKey === sourceKey && !item.resolvedAt)
      if (index >= 0) {
        const current = notifications[index]!
        notifications[index] = {
          ...current,
          ...input,
          id: current.id,
          timestamp: current.timestamp,
          read: current.read,
          resolvedAt: undefined
        }
      }
      continue
    }

    const notification: NotificationItem = {
      ...input,
      id: makeId(),
      timestamp: now,
      read: false
    }
    notifications.unshift(notification)
    added.push(notification)
  }

  for (const sourceKey of previousKeys) {
    if (nextItems.has(sourceKey)) continue
    const index = notifications.findIndex((item) => item.sourceKey === sourceKey && !item.resolvedAt)
    if (index >= 0) {
      const { action: _action, ...current } = notifications[index]!
      const resolution = current.resolution
      notifications[index] = {
        ...current,
        resolvedAt: now,
        ...(resolution
          ? {
              title: resolution.title,
              message: resolution.message,
              ...(resolution.severity ? { severity: resolution.severity } : {}),
              ...(resolution.read ? { read: true } : {})
            }
          : {})
      }
    }
  }

  return {
    state: {
      notifications: notifications.slice(0, MAX_NOTIFICATIONS),
      activeSources: {
        ...state.activeSources,
        [scope]: [...nextItems.keys()]
      }
    },
    added
  }
}

export function clearNotificationHistory(state: NotificationStoreState): NotificationStoreState {
  return { ...state, notifications: [] }
}

interface ProviderState {
  orgId: string | null
  store: NotificationStoreState
  toasts: NotificationItem[]
}

export function NotificationProvider({ orgId, children }: { orgId?: string | null; children: ReactNode }) {
  const normalizedOrgId = orgId ?? null
  const [providerState, setProviderState] = useState<ProviderState>(() => ({
    orgId: normalizedOrgId,
    store: loadNotificationState(normalizedOrgId),
    toasts: []
  }))

  if (providerState.orgId !== normalizedOrgId) {
    setProviderState({
      orgId: normalizedOrgId,
      store: loadNotificationState(normalizedOrgId),
      toasts: []
    })
  }

  useEffect(() => {
    saveNotificationState(providerState.store, providerState.orgId)
  }, [providerState.store, providerState.orgId])

  const addNotification = useCallback((item: AddNotificationInput) => {
    const notification: NotificationItem = {
      ...item,
      id: defaultNotificationId(),
      timestamp: new Date().toISOString(),
      read: false
    }
    setProviderState((prev) => ({
      ...prev,
      store: {
        ...prev.store,
        notifications: [notification, ...prev.store.notifications].slice(0, MAX_NOTIFICATIONS)
      },
      toasts: [notification, ...prev.toasts].slice(0, 5)
    }))
  }, [])

  const syncSourceSnapshot = useCallback((scope: NotificationSourceScope, items: NotificationSnapshotInput[]) => {
    setProviderState((prev) => {
      const nextKeys = new Set(items.map((item) => item.sourceKey))
      const resolvedKeys = new Set(prev.store.activeSources[scope].filter((key) => !nextKeys.has(key)))
      const result = syncNotificationSourceSnapshot(prev.store, scope, items)
      return {
        ...prev,
        store: result.state,
        toasts: [
          ...result.added,
          ...prev.toasts.filter((toast) => !toast.sourceKey || !resolvedKeys.has(toast.sourceKey))
        ].slice(0, 5)
      }
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    setProviderState((prev) => ({ ...prev, toasts: prev.toasts.filter((toast) => toast.id !== id) }))
  }, [])

  const markAsRead = useCallback((id: string) => {
    setProviderState((prev) => ({
      ...prev,
      store: {
        ...prev.store,
        notifications: prev.store.notifications.map((item) => (item.id === id ? { ...item, read: true } : item))
      }
    }))
  }, [])

  const markSourceRead = useCallback((sourceKey: string) => {
    setProviderState((prev) => ({
      ...prev,
      store: {
        ...prev.store,
        notifications: prev.store.notifications.map((item) =>
          item.sourceKey === sourceKey && !item.read ? { ...item, read: true } : item
        )
      },
      toasts: prev.toasts.filter((toast) => toast.sourceKey !== sourceKey)
    }))
  }, [])

  const markAllAsRead = useCallback(() => {
    setProviderState((prev) => ({
      ...prev,
      store: {
        ...prev.store,
        notifications: prev.store.notifications.map((item) => ({ ...item, read: true }))
      }
    }))
  }, [])

  const clearAll = useCallback(() => {
    setProviderState((prev) => ({ ...prev, store: clearNotificationHistory(prev.store), toasts: [] }))
  }, [])

  const notifications = providerState.store.notifications
  const unreadCount = useMemo(() => notifications.filter((notification) => !notification.read).length, [notifications])

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      toasts: providerState.toasts,
      addNotification,
      syncSourceSnapshot,
      markAsRead,
      markSourceRead,
      markAllAsRead,
      clearAll,
      dismissToast
    }),
    [
      notifications,
      unreadCount,
      providerState.toasts,
      addNotification,
      syncSourceSnapshot,
      markAsRead,
      markSourceRead,
      markAllAsRead,
      clearAll,
      dismissToast
    ]
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

/** The notification center if one is mounted — for a component that also renders without the shell. */
export function useOptionalNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext)
}

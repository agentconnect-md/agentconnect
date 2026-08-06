'use client'

import { useEffect } from 'react'
import type { AccessNotificationSnapshot } from '@/lib/access-notification-snapshot'
import { sessionAccessNotifications, type SessionAccessNotificationInput } from '@/lib/session-access-notifications'
import { useNotifications, type NotificationSourceScope } from '@/lib/notifications'

interface SessionAccessNotificationSnapshots {
  sessionAccessSnapshot: AccessNotificationSnapshot | null
  usageAccessSnapshot: AccessNotificationSnapshot | null
  orgPath: (path: string) => string
}

type SyncSourceSnapshot = (scope: NotificationSourceScope, items: SessionAccessNotificationInput[]) => void

export function syncSessionAccessNotificationSnapshots(
  snapshots: SessionAccessNotificationSnapshots,
  syncSourceSnapshot: SyncSourceSnapshot
): void {
  if (snapshots.sessionAccessSnapshot) {
    syncSourceSnapshot(
      'sessions-access',
      sessionAccessNotifications(
        'sessions',
        snapshots.sessionAccessSnapshot.degraded,
        snapshots.sessionAccessSnapshot.issues,
        snapshots.orgPath
      )
    )
  }
  if (snapshots.usageAccessSnapshot) {
    syncSourceSnapshot(
      'usage-access',
      sessionAccessNotifications(
        'usage',
        snapshots.usageAccessSnapshot.degraded,
        snapshots.usageAccessSnapshot.issues,
        snapshots.orgPath
      )
    )
  }
}

export function useSessionAccessNotifier(snapshots: SessionAccessNotificationSnapshots): void {
  const { syncSourceSnapshot } = useNotifications()
  const { sessionAccessSnapshot, usageAccessSnapshot, orgPath } = snapshots

  useEffect(() => {
    syncSessionAccessNotificationSnapshots({ sessionAccessSnapshot, usageAccessSnapshot, orgPath }, syncSourceSnapshot)
  }, [sessionAccessSnapshot, usageAccessSnapshot, orgPath, syncSourceSnapshot])
}

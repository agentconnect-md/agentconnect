import { useEffect, useRef } from 'react'
import type { DaemonRow } from '@/lib/data'
import { useNotifications } from '@/lib/notifications'

/**
 * Monitors daemon state updates (polling / SWR refreshes) and automatically
 * triggers notification toasts and history entries for:
 * 1. Daemon Upgrade / Restart success or failure (lifecycleOp status transitions)
 * 2. Daemon session retention cleanup success
 * 3. Daemon session retention cleanup failure
 */
export function useDaemonNotifier(daemons: DaemonRow[]) {
  const { addNotification } = useNotifications()
  // Track previous lifecycle op status by op id: opId -> status
  const prevOpStatuses = useRef<Map<string, string>>(new Map())
  // Track initial load to avoid notifying on past already-settled ops when mounting
  const isInitialLoad = useRef(true)

  useEffect(() => {
    if (!daemons || daemons.length === 0) return

    const currentStatuses = new Map<string, string>()

    for (const daemon of daemons) {
      const op = daemon.lifecycleOp
      if (!op) continue

      currentStatuses.set(op.id, op.status)

      const prevStatus = prevOpStatuses.current.get(op.id)
      const daemonName = daemon.name || daemon.host || daemon.daemonId

      // On initial load, populate map without firing notifications for historic settled ops,
      // UNLESS the op was pending when first seen and now settled.
      if (isInitialLoad.current) {
        continue
      }

      if (prevStatus === 'pending') {
        if (op.status === 'succeeded') {
          const opLabel = op.op === 'upgrade' ? 'Upgrade' : 'Restart'
          const targetStr = op.targetVersion ? ` to ${op.targetVersion}` : ''
          addNotification({
            category: 'daemon_lifecycle',
            severity: 'success',
            title: `Daemon ${opLabel} Succeeded`,
            message: `Daemon "${daemonName}" successfully completed ${op.op}${targetStr}.`,
            daemonId: daemon.daemonId,
            daemonName
          })
        } else if (op.status === 'failed') {
          const opLabel = op.op === 'upgrade' ? 'Upgrade' : 'Restart'
          const detail = op.outcome ? `: ${op.outcome}` : ''
          addNotification({
            category: 'daemon_lifecycle',
            severity: 'error',
            title: `Daemon ${opLabel} Failed`,
            message: `Daemon "${daemonName}" ${op.op} failed${detail}.`,
            daemonId: daemon.daemonId,
            daemonName
          })
        }
      }
    }

    prevOpStatuses.current = currentStatuses
    if (isInitialLoad.current) {
      isInitialLoad.current = false
    }
  }, [daemons, addNotification])
}

/**
 * Helper to emit a session retention cleanup notification manually or from WebSocket/HTTP events.
 */
export function notifySessionRetentionResult(
  addNotification: ReturnType<typeof useNotifications>['addNotification'],
  params: {
    daemonId: string
    daemonName: string
    success: boolean
    purgedCount?: number
    error?: string
  }
) {
  if (params.success) {
    const countText =
      params.purgedCount !== undefined
        ? `cleaned up ${params.purgedCount} expired session(s)`
        : 'completed session retention cleanup'
    addNotification({
      category: 'session_retention',
      severity: 'info',
      title: 'Session Cleanup Completed',
      message: `Daemon "${params.daemonName}" ${countText}.`,
      daemonId: params.daemonId,
      daemonName: params.daemonName
    })
  } else {
    const errorText = params.error ? `: ${params.error}` : ''
    addNotification({
      category: 'session_retention',
      severity: 'warning',
      title: 'Session Cleanup Failed',
      message: `Daemon "${params.daemonName}" failed to clean up sessions${errorText}.`,
      daemonId: params.daemonId,
      daemonName: params.daemonName
    })
  }
}

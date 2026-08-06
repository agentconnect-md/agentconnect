import { useEffect, useRef } from 'react'
import type { DaemonRow } from '@/lib/data'
import { useNotifications } from '@/lib/notifications'

// Global set of lifecycle op IDs that have already triggered a notification in this session
const notifiedLifecycleOpIds = new Set<string>()

// Set of op IDs commanded locally in the current browser session
const commandedLifecycleOpIds = new Set<string>()

export function registerCommandedLifecycleOpId(id: string) {
  if (id) {
    commandedLifecycleOpIds.add(id)
  }
}

/**
 * Monitors daemon state updates (polling / SWR refreshes) and automatically
 * triggers notification toasts and history entries for:
 * 1. Daemon Upgrade / Restart success or failure (live pending -> succeeded/failed
 *    transitions or fast locally-commanded operations).
 * 2. Daemon session retention cleanup outcomes.
 */
export function useDaemonNotifier(daemons: DaemonRow[]) {
  const { addNotification } = useNotifications()
  // Track previous lifecycle op status by op id: opId -> status
  const prevOpStatuses = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (!daemons || daemons.length === 0) return

    const currentStatuses = new Map<string, string>()

    for (const daemon of daemons) {
      const op = daemon.lifecycleOp
      if (!op) continue

      currentStatuses.set(op.id, op.status)

      const prevStatus = prevOpStatuses.current.get(op.id)
      const daemonName = daemon.name || daemon.host || daemon.daemonId

      // Notify if:
      // 1) Op was observed as 'pending' and now transitioned to terminal ('succeeded'/'failed'), OR
      // 2) Op was commanded locally in this browser session (even if first observed as terminal).
      const isLiveTransition = prevStatus === 'pending'
      const isCommandedLocally = commandedLifecycleOpIds.has(op.id)

      if (op.status !== 'pending' && (isLiveTransition || isCommandedLocally)) {
        if (!notifiedLifecycleOpIds.has(op.id)) {
          notifiedLifecycleOpIds.add(op.id)

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
    }

    prevOpStatuses.current = currentStatuses
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
      params.purgedCount !== undefined && params.purgedCount > 0
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

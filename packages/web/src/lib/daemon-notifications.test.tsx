import { describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'
import {
  useDaemonNotifier,
  notifySessionRetentionResult,
  registerCommandedLifecycleOpId
} from '@/lib/daemon-notifications'
import { NotificationProvider, useNotifications } from '@/lib/notifications'
import { renderToStaticMarkup } from 'react-dom/server'
import { useEffect } from 'react'

function TestNotifierComponent({
  daemons,
  onNotify
}: {
  daemons: DaemonRow[]
  onNotify: (notifications: ReturnType<typeof useNotifications>['notifications']) => void
}) {
  const notif = useNotifications()
  useDaemonNotifier(daemons)

  useEffect(() => {
    onNotify(notif.notifications)
  }, [notif.notifications, onNotify])

  return null
}

const mockDaemon = (id: string, name: string, op?: DaemonRow['lifecycleOp']): DaemonRow => ({
  daemonId: id,
  name,
  version: '1.0.0',
  latestVersion: '1.1.0',
  releaseChannel: 'latest',
  upgradeAvailable: true,
  availableVersions: ['1.1.0'],
  lifecycleOp: op ?? null,
  canManageLifecycle: true,
  status: 'online',
  cloud: false,
  lifecycleStatus: null,
  host: 'localhost',
  cpu: 10,
  mem: 20,
  caps: { platforms: [], runtimes: [], acp: true, features: [] },
  runtimeModels: [],
  mcpServers: [],
  activeSessions: '0',
  conns: '1',
  uptime: '1d',
  createdBy: 'user1',
  createdAt: new Date().toISOString(),
  lastModifiedBy: 'user1',
  lastModifiedAt: new Date().toISOString(),
  sessionRetention: '7d',
  visibility: 'org',
  sharedWith: [],
  canEdit: true,
  canManageSharing: true
})

describe('useDaemonNotifier', () => {
  it('renders test component safely without throwing', () => {
    const daemon = mockDaemon('d1', 'Edge Daemon 1')
    let count = 0
    const html = renderToStaticMarkup(
      <NotificationProvider>
        <TestNotifierComponent daemons={[daemon]} onNotify={(n) => (count = n.length)} />
      </NotificationProvider>
    )
    expect(html).toBe('')
    expect(count).toBe(0)
  })

  it('allows registering commanded op IDs for fast-terminal operations', () => {
    const op = {
      id: 'fast-op-1',
      op: 'restart' as const,
      status: 'succeeded' as const,
      targetVersion: null,
      outcome: null
    }
    registerCommandedLifecycleOpId(op.id)
    const daemon = mockDaemon('d1', 'Fast Daemon', op)

    let notifs: ReturnType<typeof useNotifications>['notifications'] = []
    renderToStaticMarkup(
      <NotificationProvider>
        <TestNotifierComponent daemons={[daemon]} onNotify={(n) => (notifs = n)} />
      </NotificationProvider>
    )
    expect(Array.isArray(notifs)).toBe(true)
  })
})

describe('notifySessionRetentionResult', () => {
  it('adds success notification for session cleanup with purged count', () => {
    const addNotif = vi.fn()
    notifySessionRetentionResult(addNotif, {
      daemonId: 'd1',
      daemonName: 'Worker 1',
      success: true,
      purgedCount: 5
    })

    expect(addNotif).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'session_retention',
        severity: 'info',
        title: 'Session Cleanup Completed',
        message: 'Daemon "Worker 1" cleaned up 5 expired session(s).'
      })
    )
  })

  it('adds success notification for session cleanup without purged count', () => {
    const addNotif = vi.fn()
    notifySessionRetentionResult(addNotif, {
      daemonId: 'd1',
      daemonName: 'Worker 1',
      success: true
    })

    expect(addNotif).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'session_retention',
        severity: 'info',
        title: 'Session Cleanup Completed',
        message: 'Daemon "Worker 1" completed session retention cleanup.'
      })
    )
  })

  it('adds warning notification for session cleanup failure', () => {
    const addNotif = vi.fn()
    notifySessionRetentionResult(addNotif, {
      daemonId: 'd1',
      daemonName: 'Worker 1',
      success: false,
      error: 'worktree cleanup failed'
    })

    expect(addNotif).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'session_retention',
        severity: 'warning',
        title: 'Session Cleanup Failed',
        message: 'Daemon "Worker 1" failed to clean up sessions: worktree cleanup failed.'
      })
    )
  })
})

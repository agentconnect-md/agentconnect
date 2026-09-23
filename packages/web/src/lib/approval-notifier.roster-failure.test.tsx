// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingApprovalSession } from '@/lib/api'
import { approvalNotifications } from '@/lib/approval-notifications'
import { useApprovalNotifier } from '@/lib/approval-notifier'
import type { Agent } from '@/lib/data'
import { ConsoleDataProvider, useConsoleData } from '@/lib/data-context'
import {
  emptyNotificationState,
  NotificationProvider,
  saveNotificationState,
  syncNotificationSourceSnapshot,
  useNotifications
} from '@/lib/notifications'

const api = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchPendingApprovalSessions: vi.fn(),
  sessionEvents: { onState: undefined as (() => void) | undefined }
}))
const orgs = vi.hoisted(() => {
  const org = { id: 'org-1', name: 'Acme', slug: 'acme' }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})

vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgents: api.fetchAgents,
  fetchPendingApprovalSessions: api.fetchPendingApprovalSessions,
  subscribeSessionEvents: (_orgId: string, handlers: { onState?: () => void }) => {
    api.sessionEvents.onState = handlers.onState
    return () => {}
  }
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const orgPath = (path: string) => `/acme${path}`
const agent = { id: 'agent-a', name: 'Butler', canEdit: true } as Agent
const waiting: PendingApprovalSession = { sessionId: 's-1', agentId: 'agent-a', agentName: 'Butler', title: null }

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('approval notifications over the live console data', () => {
  it('keeps an open item through a failed first roster pull and neither resolves nor duplicates it on retry', async () => {
    // Every read this test does not script fails fast instead of reaching a network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    )
    const seeded = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'approvals',
      approvalNotifications([waiting], [agent], orgPath),
      '2026-09-23T01:00:00.000Z',
      () => 'approval-1'
    ).state
    saveNotificationState(seeded, 'org-1')
    api.fetchAgents.mockRejectedValueOnce(new Error('agents unavailable'))
    api.fetchPendingApprovalSessions.mockResolvedValue([waiting])

    const latest: {
      data: ReturnType<typeof useConsoleData> | null
      notifications: ReturnType<typeof useNotifications>['notifications']
    } = { data: null, notifications: [] }
    function Harness() {
      const data = useConsoleData()
      useApprovalNotifier({
        pendingApprovalSessions: data.pendingApprovalSessions,
        agents: data.agents,
        agentsLoaded: data.agentsLoaded,
        orgPath
      })
      const { notifications } = useNotifications()
      useEffect(() => {
        latest.data = data
        latest.notifications = notifications
      }, [data, notifications])
      return null
    }
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 50 && !done(); i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
      expect(done()).toBe(true)
    }
    const items = () => latest.notifications.map((n) => [n.id, n.title, n.resolvedAt !== undefined])

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
          <ConsoleDataProvider>
            <NotificationProvider orgId="org-1">
              <Harness />
            </NotificationProvider>
          </ConsoleDataProvider>
        </SWRConfig>
      )
    )

    await settle(() => Boolean(latest.data?.pendingApprovalSessions && !latest.data.agentsLoading))
    expect(api.fetchAgents).toHaveBeenCalledTimes(1)
    expect(latest.data?.agentsLoaded).toBe(false)
    expect(items()).toEqual([['approval-1', 'Approval needed', false]])

    api.fetchAgents.mockResolvedValue([agent])
    await act(async () => latest.data?.refresh())
    await settle(() => Boolean(latest.data?.agentsLoaded))
    expect(latest.data?.agents.map((a) => a.id)).toEqual(['agent-a'])
    expect(items()).toEqual([['approval-1', 'Approval needed', false]])

    // With the roster live, the scope syncs again: a decided approval resolves the same item.
    api.fetchPendingApprovalSessions.mockResolvedValue([])
    await act(async () => api.sessionEvents.onState?.())
    await settle(() => latest.notifications.some((n) => n.resolvedAt !== undefined))
    expect(items()).toEqual([['approval-1', 'Approval resolved', true]])

    await act(async () => root.unmount())
    host.remove()
  })
})

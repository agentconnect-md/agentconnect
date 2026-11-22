// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CronDto } from '@/lib/api'
import { ConsoleDataProvider, useConsoleData } from '@/lib/data-context'
import {
  emptyNotificationState,
  NotificationProvider,
  saveNotificationState,
  syncNotificationSourceSnapshot,
  useNotifications
} from '@/lib/notifications'
import { failingScheduleNotifications, useScheduleNotifier } from '@/lib/schedule-notifier'

const api = vi.hoisted(() => ({ fetchCrons: vi.fn() }))
const orgs = vi.hoisted(() => {
  const org = { id: 'org-1', name: 'Acme', slug: 'acme' }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})
// The saved item's copy; the live notifier writes the real strings over it once it syncs.
const seedCopy = (key: string) => key

vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchCrons: api.fetchCrons,
  subscribeSessionEvents: () => () => {}
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const orgPath = (path: string) => `/acme${path}`
const failing = { streak: 3, since: '2026-07-03T09:00:00.000Z', reason: 'Authentication required' }
const cron = {
  id: 'cron-1',
  name: 'Daily check',
  trigger: 'check the dependency updates',
  enabled: true,
  canEdit: true,
  failing
} as CronDto

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('failing-schedule notifications over the live console data', () => {
  it('keeps an open item through a failed first schedules pull, and resolves it only once a run succeeds', async () => {
    // Every read this test does not script fails fast instead of reaching a network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    )
    const seeded = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'schedules',
      failingScheduleNotifications([cron], orgPath, seedCopy),
      '2026-07-06T01:00:00.000Z',
      () => 'failing-1'
    ).state
    saveNotificationState(seeded, 'org-1')
    api.fetchCrons.mockRejectedValueOnce(new Error('schedules unavailable'))

    const latest: {
      data: ReturnType<typeof useConsoleData> | null
      notifications: ReturnType<typeof useNotifications>['notifications']
    } = { data: null, notifications: [] }
    function Harness() {
      const data = useConsoleData()
      useScheduleNotifier(data.crons, data.cronsLoaded, orgPath)
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

    // The request has answered with an error: nothing is loading, and nothing was loaded either.
    await settle(() => api.fetchCrons.mock.calls.length === 1 && latest.data?.cronsLoading === false)
    expect(items()).toEqual([['failing-1', 'title', false]])
    expect(latest.data?.cronsLoaded).toBe(false)

    api.fetchCrons.mockResolvedValue([cron])
    await act(async () => latest.data?.refresh())
    await settle(() => latest.notifications[0]?.title === 'Schedule keeps failing')
    expect(latest.data?.cronsLoaded).toBe(true)
    expect(items()).toEqual([['failing-1', 'Schedule keeps failing', false]])

    api.fetchCrons.mockResolvedValue([{ ...cron, failing: null }])
    await act(async () => latest.data?.refresh())
    await settle(() => latest.notifications.some((n) => n.resolvedAt !== undefined))
    expect(items()).toEqual([['failing-1', 'Schedule failure cleared', true]])

    await act(async () => root.unmount())
    host.remove()
  })
})

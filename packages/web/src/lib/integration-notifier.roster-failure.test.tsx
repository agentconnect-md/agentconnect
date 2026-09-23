// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import { ConsoleDataProvider, integrationRowFromDto, useConsoleData } from '@/lib/data-context'
import { revokedIntegrationNotifications } from '@/lib/integration-notifications'
import { useIntegrationNotifier } from '@/lib/integration-notifier'
import {
  emptyNotificationState,
  NotificationProvider,
  saveNotificationState,
  syncNotificationSourceSnapshot,
  useNotifications
} from '@/lib/notifications'

const api = vi.hoisted(() => ({ fetchAgents: vi.fn(), fetchIntegrations: vi.fn() }))
const orgs = vi.hoisted(() => {
  const org = { id: 'org-1', name: 'Acme', slug: 'acme' }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})

vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgents: api.fetchAgents,
  fetchIntegrations: api.fetchIntegrations,
  subscribeSessionEvents: () => () => {}
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const orgPath = (path: string) => `/acme${path}`
const agent = { id: 'agent-a', name: 'Butler', canEdit: true } as Agent
const revokedDto: IntegrationDto = {
  id: 'int-1',
  name: 'acme-bot',
  platform: 'slack',
  agentId: 'agent-a',
  botId: 'bot-1',
  status: 'revoked',
  createdAt: '2026-09-23T00:00:00.000Z',
  channels: []
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('revoked integration notifications over the live console data', () => {
  it('keeps an open item through a failed first roster pull and neither resolves nor duplicates it on retry', async () => {
    // Every read this test does not script fails fast instead of reaching a network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    )
    const seeded = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'integrations',
      revokedIntegrationNotifications([integrationRowFromDto(revokedDto, new Map(), new Map())], [agent], orgPath),
      '2026-09-23T01:00:00.000Z',
      () => 'revoked-1'
    ).state
    saveNotificationState(seeded, 'org-1')
    api.fetchAgents.mockRejectedValueOnce(new Error('agents unavailable'))
    api.fetchIntegrations.mockResolvedValue([revokedDto])

    const latest: {
      data: ReturnType<typeof useConsoleData> | null
      notifications: ReturnType<typeof useNotifications>['notifications']
    } = { data: null, notifications: [] }
    function Harness() {
      const data = useConsoleData()
      useIntegrationNotifier({
        integrations: data.integrations,
        integrationsLoaded: data.integrationsLoaded,
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

    await settle(() => Boolean(latest.data?.integrationsLoaded && !latest.data.agentsLoading))
    expect(api.fetchAgents).toHaveBeenCalledTimes(1)
    expect(latest.data?.agentsLoaded).toBe(false)
    expect(items()).toEqual([['revoked-1', 'Integration revoked', false]])

    api.fetchAgents.mockResolvedValue([agent])
    await act(async () => latest.data?.refresh())
    await settle(() => Boolean(latest.data?.agentsLoaded))
    expect(latest.data?.agents.map((a) => a.id)).toEqual(['agent-a'])
    expect(items()).toEqual([['revoked-1', 'Integration revoked', false]])

    // With both reads live, the scope syncs again: a reconnect resolves the same item.
    api.fetchIntegrations.mockResolvedValue([{ ...revokedDto, status: 'active' }])
    await act(async () => latest.data?.refresh())
    await settle(() => latest.notifications.some((n) => n.resolvedAt !== undefined))
    expect(items()).toEqual([['revoked-1', 'Revocation resolved', true]])

    await act(async () => root.unmount())
    host.remove()
  })
})

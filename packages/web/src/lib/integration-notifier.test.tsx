// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationRow } from '@/lib/data'
import { revokedIntegrationSourceKey } from '@/lib/integration-notifications'
import { syncIntegrationNotifications, useIntegrationNotifier } from '@/lib/integration-notifier'
import { NotificationProvider, useNotifications } from '@/lib/notifications'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const orgPath = (path: string) => `/acme${path}`
const agents = [{ id: 'agent-a', name: 'Butler', canEdit: true }]
const revokedRow: IntegrationRow = {
  id: 'int-1',
  agentId: 'agent-a',
  name: 'acme-bot',
  platform: 'slack',
  kind: 'Custom app',
  workspace: '—',
  daemon: 'edge-1',
  status: 'offline',
  revoked: true,
  channels: []
}

describe('syncIntegrationNotifications', () => {
  it('syncs nothing until integrations have loaded and the roster is ready', () => {
    const sync = vi.fn()
    syncIntegrationNotifications(
      { integrations: [], integrationsLoaded: false, agents, agentsLoading: false, orgPath },
      sync
    )
    syncIntegrationNotifications(
      { integrations: [revokedRow], integrationsLoaded: true, agents: [], agentsLoading: true, orgPath },
      sync
    )
    expect(sync).not.toHaveBeenCalled()

    syncIntegrationNotifications(
      { integrations: [revokedRow], integrationsLoaded: true, agents, agentsLoading: false, orgPath },
      sync
    )
    expect(sync).toHaveBeenCalledWith('integrations', [
      expect.objectContaining({ sourceKey: revokedIntegrationSourceKey('int-1') })
    ])
  })
})

describe('useIntegrationNotifier', () => {
  it('leaves a revoked item open while either read is loading, and resolves it once the loaded list clears', async () => {
    localStorage.clear()
    const latest: { current: ReturnType<typeof useNotifications> | null } = { current: null }
    function Harness(props: { integrations: IntegrationRow[]; integrationsLoaded: boolean; agentsLoading: boolean }) {
      useIntegrationNotifier({ ...props, agents, orgPath })
      const notifications = useNotifications()
      useEffect(() => {
        latest.current = notifications
      }, [notifications])
      return null
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (props: Parameters<typeof Harness>[0]) =>
      act(async () =>
        root.render(
          <NotificationProvider orgId="org-a">
            <Harness {...props} />
          </NotificationProvider>
        )
      )

    const items = () => latest.current?.notifications.map((n) => [n.title, n.read, n.resolvedAt !== undefined])

    await render({ integrations: [revokedRow], integrationsLoaded: true, agentsLoading: false })
    expect(items()).toEqual([['Integration revoked', false, false]])
    expect(latest.current?.toasts).toHaveLength(1)

    await render({ integrations: [], integrationsLoaded: false, agentsLoading: false })
    await render({ integrations: [], integrationsLoaded: true, agentsLoading: true })
    expect(items()).toEqual([['Integration revoked', false, false]])

    await render({ integrations: [{ ...revokedRow, revoked: false }], integrationsLoaded: true, agentsLoading: false })
    expect(items()).toEqual([['Revocation resolved', true, true]])
    expect(latest.current?.toasts).toEqual([])

    await act(async () => root.unmount())
    host.remove()
  })
})

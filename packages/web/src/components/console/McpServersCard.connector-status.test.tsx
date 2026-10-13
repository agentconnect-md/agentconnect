// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpProviderDto } from '@/lib/api'
import { NotificationProvider, useNotifications } from '@/lib/notifications'
import { useConnectorNotifier } from '@/lib/connector-notifier'
import { McpServersCard } from './McpServersCard'

const mocks = vi.hoisted(() => ({ providers: [] as McpProviderDto[], loaded: true, reconnect: vi.fn() }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    mcpProviders: mocks.providers,
    mcpProvidersLoading: false,
    connectorsEnabled: true,
    reconnectConnectorConnection: mocks.reconnect,
    members: [],
    saveSharing: vi.fn()
  })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'member' } }) }))
vi.mock('swr', () => ({
  default: () => ({
    data: {
      providers: [
        {
          service: 'googledrive',
          displayName: 'Google Drive',
          auth: [{ type: 'oauth2' }]
        }
      ]
    }
  })
}))

const provider: McpProviderDto = {
  id: 'drive',
  name: 'Team Drive',
  service: 'googledrive',
  kind: 'open_connector',
  transport: 'http',
  url: 'https://connectors.example.test/mcp',
  visibility: 'org',
  sharedWith: [],
  createdBy: 'member',
  canEdit: true,
  canManageSharing: true,
  ui: false,
  auth: 'headers',
  headerNames: [],
  createdAt: '2026-10-01T00:00:00Z',
  connectorStatus: 'reauth_required'
}
const orgPath = (path: string) => `/example${path}`
function Screen() {
  useConnectorNotifier(mocks.providers, mocks.loaded, orgPath)
  const { notifications } = useNotifications()
  return (
    <>
      <output>{JSON.stringify(notifications)}</output>
      <McpServersCard canWrite={mocks.providers[0]?.canEdit ?? false} />
    </>
  )
}

let host: HTMLDivElement
let root: Root
const render = async () => {
  await act(async () =>
    root.render(
      <NotificationProvider orgId="example">
        <Screen />
      </NotificationProvider>
    )
  )
}
const activeNotices = () =>
  (JSON.parse(host.querySelector('output')!.textContent!) as { resolvedAt?: string; message: string }[]).filter(
    (n) => !n.resolvedAt
  )

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  mocks.providers = [{ ...provider }]
  mocks.loaded = true
  mocks.reconnect.mockReset().mockResolvedValue({ authorizationUrl: 'https://accounts.example.test/authorize' })
  vi.spyOn(window, 'open').mockReturnValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('connector authorization recovery', () => {
  it('shows the warning, opens the existing reconnect flow, and clears only after completed authorization', async () => {
    await render()
    expect(host.textContent).toContain('Reconnect needed')
    expect(activeNotices()).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Reconnect"]')!.click())
    const reconnect = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Reconnect Google Drive')
    )!
    await act(async () => reconnect.click())
    expect(mocks.reconnect).toHaveBeenCalledWith('drive', { authType: 'oauth2' })
    expect(host.textContent).toContain('Reconnect needed')
    expect(activeNotices()).toHaveLength(1)

    mocks.providers = [{ ...provider, connectorStatus: 'unknown' }]
    await render()
    expect(host.textContent).toContain('Status unavailable')
    expect(activeNotices()).toHaveLength(1)
    mocks.providers = [{ ...provider }]
    await render()
    expect(activeNotices()).toHaveLength(1)
    mocks.providers = [{ ...provider, connectorStatus: 'connected' }]
    await render()
    expect(host.textContent).not.toContain('Reconnect needed')
    expect(activeNotices()).toHaveLength(0)
  })

  it('waits for a successful provider list and notifies only people who can reconnect', async () => {
    mocks.loaded = false
    await render()
    expect(activeNotices()).toHaveLength(0)
    mocks.loaded = true
    mocks.providers = [{ ...provider, canEdit: false }]
    await render()
    expect(host.textContent).toContain('Reconnect needed')
    expect(host.querySelector('button[title="Reconnect"]')).toBeNull()
    expect(activeNotices()).toHaveLength(0)
  })
})

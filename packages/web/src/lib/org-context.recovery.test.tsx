// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrgGate } from '@/components/console/OrgGate'
import { OrgProvider, useOrgs } from './org-context'
import { CONSOLE_SWR_CONFIG } from './console-swr'
import type { OrgDto } from './api'

const api = vi.hoisted(() => ({ fetchOrgs: vi.fn(), setApiOrgId: vi.fn(), selectOrg: vi.fn() }))
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), ...api }))
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  usePathname: () => '/example/agents',
  useParams: () => ({ slug: 'example' })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const org = { id: 'example-org', slug: 'example', name: 'Example', role: 'owner' } as OrgDto
let root: Root
let host: HTMLDivElement
let state: ReturnType<typeof useOrgs>

function Observer() {
  state = useOrgs()
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  api.fetchOrgs.mockReset()
  api.setApiOrgId.mockReset()
  api.selectOrg.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mount(errorRetryInterval = 100_000) {
  await act(async () =>
    root.render(
      <SWRConfig
        value={{
          ...CONSOLE_SWR_CONFIG,
          provider: () => new Map(),
          dedupingInterval: 0,
          focusThrottleInterval: 0,
          errorRetryInterval
        }}
      >
        <OrgProvider>
          <Observer />
          <OrgGate>
            <div data-testid="content">Organization content</div>
          </OrgGate>
        </OrgProvider>
      </SWRConfig>
    )
  )
}

it.each(['retry', 'focus', 'online', 'backoff'])(
  'recovers a failed initial load through %s without remounting',
  async (action) => {
    api.fetchOrgs.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([org])
    await mount(action === 'backoff' ? 100 : undefined)

    expect(state.activeOrg).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t load your organizations')
    expect(host.querySelector('[data-testid="content"]')).toBeNull()
    expect(api.setApiOrgId).toHaveBeenLastCalledWith(null)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
      if (action === 'retry') host.querySelector('button')!.click()
      else if (action !== 'backoff') window.dispatchEvent(new Event(action))
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(api.fetchOrgs).toHaveBeenCalledTimes(2)
    expect(state.activeOrg?.id).toBe(org.id)
    expect(state.error).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-testid="content"]')).not.toBeNull()
    expect(api.setApiOrgId).toHaveBeenLastCalledWith(org.id)
  }
)

it('keeps a loaded organization usable during a failed background refresh', async () => {
  api.fetchOrgs.mockResolvedValueOnce([org]).mockRejectedValue(new Error('offline'))
  await mount()

  await act(async () => state.refreshOrgs())

  expect(state.activeOrg?.id).toBe(org.id)
  expect(state.error).toBe('offline')
  expect(host.querySelector('[data-testid="content"]')).not.toBeNull()
  expect(api.setApiOrgId).toHaveBeenLastCalledWith(org.id)
})

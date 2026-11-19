// @vitest-environment happy-dom
// An organization that asks this session for an SSO sign-in refuses every request, so the console asks it nothing.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => [] as unknown[])
const streams = vi.hoisted(() => [] as string[])
const orgs = vi.hoisted(() => {
  const org = {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    ssoSignIn: null as { connectorId: string; name: string } | null
  }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})

vi.mock('swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('swr')>()
  const useRecordedSWR = ((key: unknown, fetcher: unknown, options?: unknown) => {
    reads.push(key)
    return (actual.default as (...args: unknown[]) => unknown)(key, fetcher, options)
  }) as typeof actual.default
  return { ...actual, default: useRecordedSWR }
})
vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  subscribeSessionEvents: (orgId: string) => {
    streams.push(orgId)
    return () => {}
  }
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SWRConfig } = await import('swr')
const { ConsoleDataProvider } = await import('@/lib/data-context')

afterEach(() => {
  vi.unstubAllGlobals()
  reads.length = 0
  streams.length = 0
})

async function mount() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline')))
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <ConsoleDataProvider>{null}</ConsoleDataProvider>
      </SWRConfig>
    )
  )
  return async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}

const keyedToOrg = () => reads.filter((key) => JSON.stringify(key ?? null).includes('org-1'))

describe('the console’s data for an organization asking for an SSO sign-in', () => {
  it('opens no event stream and keys no read to the organization', async () => {
    orgs.activeOrg.ssoSignIn = { connectorId: 'connector-acme', name: 'Acme IdP' }
    const unmount = await mount()
    expect(streams).toEqual([])
    expect(keyedToOrg()).toEqual([])
    await unmount()

    orgs.activeOrg.ssoSignIn = null
    const again = await mount()
    expect(streams).toEqual(['org-1'])
    expect(keyedToOrg().length).toBeGreaterThan(0)
    await again()
  })
})

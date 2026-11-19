// @vitest-environment happy-dom
// An organization that asks this session for an SSO sign-in refuses every read, so Decisions asks it nothing.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => [] as unknown[])
const orgs = vi.hoisted(() => ({
  activeOrg: { id: 'org-1', name: 'Acme', slug: 'acme', ssoSignIn: null as { connectorId: string } | null }
}))

vi.mock('swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('swr')>()
  const useRecordedSWR = ((key: unknown, fetcher: unknown, options?: unknown) => {
    reads.push(key)
    return (actual.default as (...args: unknown[]) => unknown)(key, fetcher, options)
  }) as typeof actual.default
  return { ...actual, default: useRecordedSWR }
})
vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SWRConfig } = await import('swr')
const { DecisionsPrototypeProvider } = await import('./provider')

afterEach(() => {
  vi.unstubAllGlobals()
  reads.length = 0
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
        <DecisionsPrototypeProvider>{null}</DecisionsPrototypeProvider>
      </SWRConfig>
    )
  )
  return async () => {
    await act(async () => root.unmount())
    host.remove()
  }
}

const keyedToOrg = () => reads.filter((key) => JSON.stringify(key ?? null).includes('org-1'))

describe('Decisions for an organization asking for an SSO sign-in', () => {
  it('keys no read to the organization until the session gets in', async () => {
    orgs.activeOrg.ssoSignIn = { connectorId: 'connector-acme' }
    const unmount = await mount()
    expect(keyedToOrg()).toEqual([])
    await unmount()

    orgs.activeOrg.ssoSignIn = null
    const again = await mount()
    expect(keyedToOrg()).not.toEqual([])
    await again()
  })
})

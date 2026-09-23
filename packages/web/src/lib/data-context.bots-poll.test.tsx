// @vitest-environment happy-dom
// A bot's rejected mark changes while its integrations stay active, so the bot list must poll as integrations do.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleKeys } from '@/lib/swr-keys'

const reads = vi.hoisted(() => [] as Array<{ key: unknown; refreshInterval: unknown }>)
const orgs = vi.hoisted(() => {
  const org = { id: 'org-1', name: 'Acme', slug: 'acme' }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})

// The real hook, with every read's key and refresh option recorded.
vi.mock('swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('swr')>()
  const useRecordedSWR = ((key: unknown, fetcher: unknown, options?: { refreshInterval?: unknown }) => {
    reads.push({ key, refreshInterval: options?.refreshInterval })
    return (actual.default as (...args: unknown[]) => unknown)(key, fetcher, options)
  }) as typeof actual.default
  return { ...actual, default: useRecordedSWR }
})
vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  subscribeSessionEvents: () => () => {}
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SWRConfig } = await import('swr')
const { ConsoleDataProvider } = await import('@/lib/data-context')

afterEach(() => {
  vi.unstubAllGlobals()
  reads.length = 0
})

/** The refresh option the provider gave the read under `key`. */
function refreshOf(key: readonly unknown[] | null): unknown {
  const read = reads.find((r) => JSON.stringify(r.key) === JSON.stringify(key))
  if (!read) throw new Error(`no read for ${JSON.stringify(key)}`)
  return read.refreshInterval
}

describe('the console’s bot list', () => {
  it('refreshes on the integration list’s cadence', async () => {
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

    const integrations = refreshOf(consoleKeys.integrations('org-1'))
    expect(typeof integrations).toBe('number')
    expect(integrations as number).toBeGreaterThan(0)
    expect(refreshOf(consoleKeys.bots('org-1'))).toBe(integrations)

    await act(async () => root.unmount())
    host.remove()
  })
})

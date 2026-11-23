// @vitest-environment happy-dom
// After a session-stream gap (a Control Plane restart), agent and daemon presence is re-read while daemons re-register.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventHandlers } from '@/lib/api'

const sse = vi.hoisted(() => ({ handlers: null as SessionEventHandlers | null }))
const orgs = vi.hoisted(() => {
  const org = { id: 'org-1', name: 'Acme', slug: 'acme' }
  return { activeOrg: org, orgs: [org], loading: false, error: null }
})

vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  subscribeSessionEvents: (_orgId: string, handlers: SessionEventHandlers) => {
    sse.handlers = handlers
    return () => {
      sse.handlers = null
    }
  }
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SWRConfig } = await import('swr')
const { ConsoleDataProvider } = await import('@/lib/data-context')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Counts agent and daemon list reads; both answer empty, every other read fails. */
function stubPresenceReads() {
  const reads = { agents: 0, daemons: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input, 'http://cp.example.test').pathname
      if (path.endsWith('/orgs/org-1/agents')) reads.agents++
      else if (path.endsWith('/orgs/org-1/daemons')) reads.daemons++
      else return Promise.reject(new Error('offline'))
      return Promise.resolve(Response.json([]))
    })
  )
  return reads
}

describe('console presence after the session stream recovers', () => {
  it('re-reads agents and daemons a few seconds after a reconnect, but not after the first connect', async () => {
    const reads = stubPresenceReads()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
          <ConsoleDataProvider>{null}</ConsoleDataProvider>
        </SWRConfig>
      )
    )
    await act(() => vi.waitFor(() => expect(reads).toEqual({ agents: 1, daemons: 1 })))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      sse.handlers?.onConnect()
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads).toEqual({ agents: 1, daemons: 1 })

    await act(async () => {
      sse.handlers?.onConnect()
      await vi.advanceTimersByTimeAsync(2_999)
    })
    expect(reads).toEqual({ agents: 1, daemons: 1 })
    await act(() => vi.advanceTimersByTimeAsync(1))
    await act(() => vi.waitFor(() => expect(reads).toEqual({ agents: 2, daemons: 2 })))
    await act(() => vi.advanceTimersByTimeAsync(7_000))
    await act(() => vi.waitFor(() => expect(reads).toEqual({ agents: 3, daemons: 3 })))

    await act(async () => root.unmount())
    host.remove()
  })
})

// @vitest-environment happy-dom
// SWR's filtered mutate skips useSWRInfinite keys, so a session event must reach each mounted list through its own mutate.
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
const { useSessionList } = await import('@/lib/use-session-list')

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stubs the CP: every session-list page is empty, every other read fails. */
function stubListReads() {
  const reads = { orgWide: 0, agent: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://cp.example.test')
      // The pending-approvals read shares the path; only list pages are counted.
      const listPage = url.pathname.endsWith('/orgs/org-1/sessions') && !url.searchParams.has('activityState')
      if (!listPage) return Promise.reject(new Error('offline'))
      if (url.searchParams.get('agentId') === 'agent-1') reads.agent++
      else reads.orgWide++
      return Promise.resolve(Response.json({ conversations: [], total: 0, nextCursor: null }))
    })
  )
  return reads
}

function AgentSessions() {
  useSessionList('org-1', { agentId: 'agent-1' })
  return null
}

// The unfiltered Sessions view reads the same list the provider already holds.
function AllSessions() {
  useSessionList('org-1')
  return null
}

describe('the console’s session lists', () => {
  it('refetch every mounted list, once each, on a session event', async () => {
    const reads = stubListReads()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
          <ConsoleDataProvider>
            <AllSessions />
            <AgentSessions />
          </ConsoleDataProvider>
        </SWRConfig>
      )
    )
    await act(() => vi.waitFor(() => expect(reads).toEqual({ orgWide: 1, agent: 1 })))

    await act(async () => {
      sse.handlers?.onSession()
      await vi.waitFor(() => expect(reads.orgWide + reads.agent).toBeGreaterThanOrEqual(4), { timeout: 3000 })
    })
    expect(reads).toEqual({ orgWide: 2, agent: 2 })

    await act(async () => root.unmount())
    host.remove()
  })
})

// @vitest-environment happy-dom
// An agent's open capability requests are listed on its page only where the deployment turned the feature on.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ flags: new Set<string>(), fetch: vi.fn() }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => mocks.flags.has(id) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchCapabilityRequests: mocks.fetch
}))

const { AgentCapabilityRequestsCard } = await import('./AgentCapabilityRequestsCard')

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentCapabilityRequestsCard agentId="agent-1" />
      </SWRConfig>
    )
  )
  return host
}

beforeEach(() => {
  mocks.flags = new Set()
  mocks.fetch.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the agent page’s capability requests', () => {
  it('neither reads nor shows anything with the flag off', async () => {
    const scope = await render()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(scope.querySelector('[data-capability-requests]')).toBeNull()
  })

  it('lists the open requests, each linking to its page', async () => {
    mocks.flags.add('capability-requests')
    mocks.fetch.mockResolvedValue([
      { id: 'req-1', summary: 'add the MCP server "Linear"', createdAt: '2026-10-26T09:00:00.000Z' }
    ])
    const scope = await render()
    expect(mocks.fetch).toHaveBeenCalledWith({ agentId: 'agent-1', status: 'open' }, 'org-1')
    const link = scope.querySelector('a[href="/acme/requests/req-1"]')
    expect(link?.textContent).toContain('add the MCP server "Linear"')
    expect(scope.textContent).toContain('1 open request')
  })

  it('shows no card when nothing is open', async () => {
    mocks.flags.add('capability-requests')
    mocks.fetch.mockResolvedValue([])
    const scope = await render()
    expect(scope.querySelector('[data-capability-requests]')).toBeNull()
  })
})

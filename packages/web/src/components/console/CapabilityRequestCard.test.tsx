// @vitest-environment happy-dom
// A capability request card in a conversation: someone with authority completes it inline, anyone else gets the link and who can.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRequestDto } from '@/lib/api'
import type { CapabilityCardBody } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchCapabilityRequest: mocks.fetch
}))
vi.mock('@/components/console/CapabilityRequestCompletion', () => ({
  CapabilityRequestCompletion: ({ request }: { request: CapabilityRequestDto }) => <div data-completion={request.id} />
}))

const { CapabilityRequestCard } = await import('./CapabilityRequestCard')

const BODY: CapabilityCardBody = {
  requestId: 'req-1',
  generation: 1,
  summary: 'add the MCP server "Linear"',
  reason: 'filing the bug needs Linear',
  link: 'https://console.example.test/acme/requests/req-1'
}

const dto = (viewer: Partial<CapabilityRequestDto['viewer']>, status: CapabilityRequestDto['status'] = 'open') =>
  ({
    id: 'req-1',
    orgId: 'org-1',
    status,
    summary: BODY.summary,
    reason: BODY.reason,
    settledBy: null,
    viewer: {
      canComplete: false,
      canDecline: false,
      canReopen: false,
      canForward: true,
      missing: null,
      whoCan: [],
      ...viewer
    }
  }) as unknown as CapabilityRequestDto

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(body: CapabilityCardBody): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CapabilityRequestCard body={body} />
      </SWRConfig>
    )
  )
  await act(async () => await Promise.resolve())
  return host
}

beforeEach(() => mocks.fetch.mockReset())
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('a capability request card', () => {
  it('lets someone with authority complete it inline', async () => {
    mocks.fetch.mockResolvedValue(dto({ canComplete: true }))
    const scope = await render(BODY)
    expect(mocks.fetch).toHaveBeenCalledWith('req-1', 'org-1')
    expect(scope.querySelector('[data-completion="req-1"]')).not.toBeNull()
  })

  it('shows anyone else who can, and the link', async () => {
    mocks.fetch.mockResolvedValue(dto({ whoCan: [{ userId: 'u-1', name: 'Ana' }] }))
    const scope = await render(BODY)
    expect(scope.querySelector('[data-completion]')).toBeNull()
    expect(scope.textContent).toContain('People who can complete it: Ana')
    expect(scope.querySelector('a[href="/acme/requests/req-1"]')).not.toBeNull()
  })

  it('shows a settled card as its text without reading the request', async () => {
    const scope = await render({ ...BODY, resolved: { status: 'completed', text: 'Completed by Ana' } })
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(scope.textContent).toContain('Completed by Ana')
    expect(scope.querySelector('a')).toBeNull()
  })
})

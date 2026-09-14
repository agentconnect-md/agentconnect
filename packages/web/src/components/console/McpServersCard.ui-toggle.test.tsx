// @vitest-environment happy-dom

/**
 * The daemon-hosting toggle has to be reachable from BOTH modals. It shipped on the create form
 * alone, which left every provider that already existed — the only ones anyone wants to turn it on
 * for — with no way to do it, while the API happily accepted the field.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpProviderDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ updates: [] as unknown[], creates: [] as unknown[] }))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    createMcpProvider: vi.fn(async (input: unknown) => {
      mocks.creates.push(input)
      return { id: 'p1' }
    }),
    updateMcpProvider: vi.fn(async (_id: string, patch: unknown) => {
      mocks.updates.push(patch)
    }),
    saveSharing: vi.fn(async () => undefined),
    members: []
  })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'u1' } }) }))

const { CreateMcpProviderModal, EditMcpProviderModal } = await import('./McpServersCard')

const PROVIDER: McpProviderDto = {
  id: 'p1',
  name: 'Get-Time',
  kind: 'custom',
  transport: 'http',
  url: 'https://mcp.example.test/get-time',
  visibility: 'org',
  sharedWith: [],
  createdBy: 'u1',
  canEdit: true,
  canManageSharing: true,
  ui: false,
  headerNames: [],
  createdAt: '2026-09-14T00:00:00Z'
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  mocks.updates.length = 0
  mocks.creates.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The toggle, found the way a reader finds it — by its label, not by a test id. */
function toggle(): HTMLElement | null {
  return host.querySelector('[aria-label^="Interactive interfaces"]')
}

describe('the daemon-hosting toggle', () => {
  it('is offered when CREATING a server', () => {
    act(() => root.render(<CreateMcpProviderModal onClose={() => {}} />))
    expect(host.textContent).toContain('Interactive interfaces')
    expect(toggle()).not.toBeNull()
  })

  it('is offered when EDITING one, which is the only way to turn it on for a provider that exists', () => {
    act(() => root.render(<EditMcpProviderModal provider={PROVIDER} onClose={() => {}} />))
    expect(host.textContent).toContain('Interactive interfaces')
    expect(toggle()).not.toBeNull()
  })

  it('shows an already-hosted provider as on', () => {
    act(() => root.render(<EditMcpProviderModal provider={{ ...PROVIDER, ui: true }} onClose={() => {}} />))
    expect(host.textContent).toContain('Rendered in chat')
  })

  it('sends `ui` only when it actually changed, so an unrelated edit does not re-home the server', async () => {
    act(() => root.render(<EditMcpProviderModal provider={PROVIDER} onClose={() => {}} />))
    act(() => toggle()?.click())
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')
    await act(async () => save?.click())
    expect(mocks.updates).toEqual([{ ui: true }])
  })
})

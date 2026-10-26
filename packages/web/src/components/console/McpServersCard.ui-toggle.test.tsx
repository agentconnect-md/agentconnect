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
  auth: 'headers',
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

// A capability request's `mcp-header` secret is typed into this dialog (capability-requests.md §4.9.1).
describe('a header a capability request asks for', () => {
  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('opens on the header with the stored names to re-enter, saves only once it has a value, then reports it saved', async () => {
    const onSaved = vi.fn()
    act(() =>
      root.render(
        <EditMcpProviderModal
          provider={{ ...PROVIDER, headerNames: ['X-Org'] }}
          requestedHeader="X-Api-Key"
          onSaved={onSaved}
          onClose={() => {}}
        />
      )
    )
    expect(host.textContent).toContain('The agent never sees this value')
    expect(host.textContent).toContain('enter X-Org again')
    const names = [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')].map((i) => i.value)
    expect(names).toEqual(['X-Api-Key', 'X-Org'])
    const save = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!
    expect(save().className).toContain('pointer-events-none')

    const values = [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Header value"]')]
    act(() => typeInto(values[0]!, 'secret-1'))
    // A stored header left blank would be dropped by the replacing save, so it must be re-entered or its row removed.
    expect(save().className).toContain('pointer-events-none')
    act(() => typeInto(values[1]!, 'org-7'))
    await act(async () => save().click())
    expect(mocks.updates).toEqual([
      {
        headers: [
          { name: 'X-Api-Key', value: 'secret-1' },
          { name: 'X-Org', value: 'org-7' }
        ]
      }
    ])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('treats a stored header of another case as the requested one, never a second row', () => {
    act(() =>
      root.render(
        <EditMcpProviderModal
          provider={{ ...PROVIDER, headerNames: ['x-api-key', 'X-Org'] }}
          requestedHeader="X-Api-Key"
          onClose={() => {}}
        />
      )
    )
    const names = [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')].map((i) => i.value)
    expect(names).toEqual(['x-api-key', 'X-Org'])
  })
})

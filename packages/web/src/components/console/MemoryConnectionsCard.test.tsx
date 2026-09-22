// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type ExternalMemoryConnectionDto, type MemoryPluginInstallationDto } from '@/lib/api'
import { AGENTS, type Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({ agents: [] as Agent[] }))

vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ agents: mocks.agents }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('next/link', () => ({
  default: ({ children, href, className, ...rest }: { children: ReactElement; href: string; className?: string }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  )
}))

import { MemoryConnectionsCard } from './MemoryConnectionsCard'

const INSTALLATION: MemoryPluginInstallationDto = {
  id: 'inst-1',
  pluginId: 'mem0-cloud',
  transport: 'streamable-http',
  endpoint: 'https://memory.example.test/mcp',
  commandRef: null,
  pinnedProfileMajor: 1,
  expectedManifestDigest: null,
  secretHeaders: [],
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const SPARE_INSTALLATION: MemoryPluginInstallationDto = {
  ...INSTALLATION,
  id: 'inst-2',
  pluginId: 'ai.other.memory',
  endpoint: 'https://other.example.test/mcp',
  secretHeaders: [{ name: 'apiKey', header: 'Authorization', required: true }]
}

function connection(id: string): ExternalMemoryConnectionDto {
  return {
    id,
    installationId: INSTALLATION.id,
    config: {},
    secretKeys: [],
    status: 'ready',
    revision: 1,
    probedRevision: 1,
    pluginVersion: '1.0.0',
    profile: null,
    manifestDigest: null,
    capabilities: null,
    declaredEgressHosts: ['api.memory.example.test'],
    reasonCode: null,
    createdBy: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

function agent(id: string, name: string, memory: Partial<Agent>): Agent {
  return { ...AGENTS[0]!, id, name, builtin: false, memoryProvider: 'managed', ...memory }
}

const CONNECTION_A = connection('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const CONNECTION_B = connection('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

function row(connectionId: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-connection="${connectionId}"]`)
  if (!found) throw new Error(`no row for connection ${connectionId}`)
  return found
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label
  )
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

async function type(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

function input(scope: ParentNode, selector: string): HTMLInputElement {
  const found = scope.querySelector<HTMLInputElement>(selector)
  if (!found) throw new Error(`input not found: ${selector}`)
  return found
}

async function settle(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !done(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(canManage = false, installations = [INSTALLATION]): Promise<void> {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/memory-plugin-installations')) {
      const posted = JSON.parse(String(init.body)) as Partial<MemoryPluginInstallationDto>
      return new Response(JSON.stringify({ ...SPARE_INSTALLATION, ...posted, id: 'inst-new' }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (init?.method === 'POST' && url.includes('/external-memory-connections')) {
      return new Response(JSON.stringify({ ...connection('new-connection'), installationId: SPARE_INSTALLATION.id }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    }
    const body = url.includes('/memory-plugin-installations')
      ? installations
      : url.includes('/external-memory-connections')
        ? [CONNECTION_A, CONNECTION_B]
        : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryConnectionsCard canManage={canManage} />
      </SWRConfig>
    )
  })
  await settle(() => host.querySelector('[data-connection]') !== null)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('external-memory connection rows', () => {
  it('keeps each connection to one row until its details are opened', async () => {
    mocks.agents = []
    await render()

    const first = row(CONNECTION_A.id)
    expect(first.textContent).toContain('mem0-cloud')
    expect(first.textContent).toContain('Ready')
    expect(first.textContent).toContain('Remote · memory.example.test')
    expect(first.textContent).toContain('Not used by any agent yet')
    // Details, and the internal bookkeeping the old card printed, stay off the row.
    expect(first.textContent).not.toContain('Network access')
    expect(first.textContent).not.toContain(CONNECTION_A.id)
    expect(first.textContent).not.toContain('Revision')

    await act(async () => button(first, 'Show details').click())
    expect(first.textContent).toContain('https://memory.example.test/mcp')
    expect(first.textContent).toContain('None required')
    expect(first.textContent).toContain('api.memory.example.test')
    expect(first.textContent).not.toContain(CONNECTION_A.id)
    expect(row(CONNECTION_B.id).textContent).not.toContain('Network access')
  })

  it('lists the agents bound to a connection in its details and links each to its Memory tab', async () => {
    mocks.agents = [
      agent('a2', 'zeta-bot', { memoryProvider: 'external', memoryConnectionId: CONNECTION_A.id }),
      agent('a1', 'alpha-bot', {
        displayName: 'Alpha',
        memoryProvider: 'external',
        memoryConnectionId: CONNECTION_A.id
      }),
      agent('a3', 'managed-bot', { memoryProvider: 'managed' }),
      agent('a4', 'unbound-external', { memoryProvider: 'external' })
    ]
    await render()

    const first = row(CONNECTION_A.id)
    expect(first.textContent).toContain('Used by 2 agents')
    await act(async () => button(first, 'Show details').click())
    const links = [...first.querySelectorAll<HTMLAnchorElement>('a[href*="tab=memory"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/acme/agents/a1?tab=memory',
      '/acme/agents/a2?tab=memory'
    ])
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Open the memory of Alpha',
      'Open the memory of zeta-bot'
    ])
    expect(first.textContent).not.toContain('managed-bot')
    expect(first.textContent).not.toContain('unbound-external')
    expect(row(CONNECTION_B.id).textContent).toContain('Not used by any agent yet')
  })

  it('offers an installed plugin without a connection as one line, and connects it in two steps', async () => {
    mocks.agents = []
    await render(true, [INSTALLATION, SPARE_INSTALLATION])

    expect(host.textContent).toContain('ai.other.memory')
    expect(host.textContent).toContain('Ready to connect')
    await act(async () => button(host, 'Connect').click())

    // Step one carries the chosen plugin; nothing is posted yet.
    const dialog = host.querySelector('.modal')!
    expect(dialog.textContent).toContain('Step 1 · Plugin')
    expect((dialog.querySelector('select') as HTMLSelectElement).value).toBe(SPARE_INSTALLATION.id)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    await act(async () => button(dialog, 'Next').click())
    expect(dialog.textContent).toContain('Step 2 · Account')
    expect(dialog.textContent).toContain('apiKey')
    expect(dialog.textContent).not.toContain('Streamable HTTP')

    // The required credential gates creation with one line, not a request.
    await act(async () => button(dialog, 'Create connection').click())
    expect(dialog.textContent).toContain('Enter the required credential(s): apiKey.')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('sends credentials only for the fields that still exist after they were edited in step one', async () => {
    mocks.agents = []
    await render(true, [INSTALLATION])
    await act(async () => button(host, 'Add connection').click())
    const dialog = host.querySelector('.modal')!
    await type(dialog.querySelector('select')!, 'new')
    await type(input(dialog, 'input[placeholder="ai.mem0.memory"]'), 'ai.new.memory')
    await type(input(dialog, 'input[type="url"]'), 'https://new.example.test/mcp')
    await act(async () => button(dialog, '+ Add credential field').click())
    await type(input(dialog, 'input[aria-label="Name"]'), 'apiKey')
    await type(input(dialog, 'input[aria-label="Header"]'), 'Authorization')
    await act(async () => button(dialog, 'Next').click())
    await type(input(dialog, 'input[type="password"]'), 'first-secret')

    // Back, rename the field, forward again: the value entered under the old name must not travel.
    await act(async () => button(dialog, 'Back').click())
    await type(input(dialog, 'input[aria-label="Name"]'), 'token')
    await act(async () => button(dialog, 'Next').click())
    expect(dialog.textContent).toContain('token *')
    await type(input(dialog, 'input[type="password"]'), 'second-secret')
    await act(async () => button(dialog, 'Create connection').click())
    await settle(() =>
      fetchMock.mock.calls.some(
        ([request, init]) => init?.method === 'POST' && String(request).includes('/external-memory-connections')
      )
    )

    const posts = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([request, init]) => [String(request), JSON.parse(String(init?.body))] as const)
    const installation = posts.find(([url]) => url.includes('/memory-plugin-installations'))?.[1]
    const connection = posts.find(([url]) => url.includes('/external-memory-connections'))?.[1]
    expect(installation).toMatchObject({
      pluginId: 'ai.new.memory',
      secretHeaders: [{ name: 'token', header: 'Authorization', required: true }]
    })
    expect(connection).toMatchObject({ installationId: 'inst-new', secrets: { token: 'second-secret' } })
  })
})

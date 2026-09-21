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
    declaredEgressHosts: [],
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

function card(connectionId: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-connection="${connectionId}"]`)
  if (!found) throw new Error(`no card for connection ${connectionId}`)
  return found
}

async function render(): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/memory-plugin-installations')
        ? [INSTALLATION]
        : url.includes('/external-memory-connections')
          ? [CONNECTION_A, CONNECTION_B]
          : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  )
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryConnectionsCard canManage={false} />
      </SWRConfig>
    )
  })
  for (let attempt = 0; attempt < 20 && !host.querySelector('[data-connection]'); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
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

describe('external-memory connection usage', () => {
  it('lists the agents bound to each connection and links each to its Memory tab', async () => {
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

    const links = [...card(CONNECTION_A.id).querySelectorAll<HTMLAnchorElement>('a[href*="tab=memory"]')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/acme/agents/a1?tab=memory',
      '/acme/agents/a2?tab=memory'
    ])
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Open the memory of Alpha',
      'Open the memory of zeta-bot'
    ])
    expect(card(CONNECTION_A.id).textContent).toContain('Used by 2 agents')
    expect(card(CONNECTION_A.id).textContent).not.toContain('managed-bot')
    expect(card(CONNECTION_A.id).textContent).not.toContain('unbound-external')
  })

  it('states when no agent is bound to a connection', async () => {
    mocks.agents = [agent('a1', 'alpha-bot', { memoryProvider: 'external', memoryConnectionId: CONNECTION_A.id })]
    await render()

    const idle = card(CONNECTION_B.id)
    expect(idle.querySelectorAll('a[href*="tab=memory"]')).toHaveLength(0)
    expect(idle.textContent).toContain('No agent uses this connection yet')
    expect(idle.textContent).not.toContain('Used by 1 agent')
  })
})

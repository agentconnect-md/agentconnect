// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  mcpProviders: [
    { name: 'grafana', visibility: 'org' },
    { name: 'linear', visibility: 'org' }
  ] as unknown[]
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: vi.fn(async () => undefined),
    mcpProviders: mocks.mcpProviders,
    connectorsEnabled: false
  })
}))
vi.mock('@/lib/api', () => ({
  fetchAgentDto: vi.fn(async () => ({ mcpServers: [] })),
  fetchConnectorCatalog: vi.fn(async () => ({ providers: [] })),
  repoLabel: (r: unknown) => String(r),
  repoWebUrl: () => undefined
}))
vi.mock('@/components/marks', () => ({ GithubMark: () => null }))

import { AgentToolsCard } from './AgentToolsCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | undefined
let root: Root | undefined

async function render(daemon: DaemonRow | undefined): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<AgentToolsCard agentId="a1" runtime="claude" daemon={daemon} canEdit />)
  })
  return host.textContent ?? ''
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('AgentToolsCard', () => {
  // A pool- or group-placed agent carries a placement sentinel instead of a member id, so the
  // console resolves no owning daemon for it. Gating the whole candidate list on that lookup hid
  // every org-registry server such an agent could attach — and those are http-proxied, so they
  // never needed a daemon in the first place.
  it('lists the org registry servers for an agent with no resolved daemon', async () => {
    const text = await render(undefined)
    expect(text).toContain('grafana')
    expect(text).toContain('linear')
  })

  it('unions the daemon-reported servers with the registry when a daemon does resolve', async () => {
    const daemon = {
      mcpServers: [{ name: 'daemon-local', transport: 'stdio' }],
      runtimeModels: []
    } as unknown as DaemonRow
    const text = await render(daemon)
    expect(text).toContain('daemon-local')
    expect(text).toContain('grafana')
  })

  it('still shows the empty state when the org registry is empty too', async () => {
    const saved = mocks.mcpProviders
    mocks.mcpProviders = []
    try {
      expect(await render(undefined)).toContain('No MCP servers available to this agent.')
    } finally {
      mocks.mcpProviders = saved
    }
  })
})

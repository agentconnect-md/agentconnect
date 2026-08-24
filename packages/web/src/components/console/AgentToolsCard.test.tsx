// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  mcpProviders: [
    { name: 'grafana', visibility: 'org' },
    { name: 'linear', visibility: 'org' }
  ] as unknown[],
  saved: [] as string[]
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: vi.fn(async () => undefined),
    mcpProviders: mocks.mcpProviders,
    connectorsEnabled: false
  })
}))
vi.mock('@/lib/api', () => ({
  fetchAgentDto: vi.fn(async () => ({ mcpServers: mocks.saved })),
  fetchConnectorCatalog: vi.fn(async () => ({ providers: [] })),
  repoLabel: (r: unknown) => String(r),
  repoWebUrl: () => undefined
}))
vi.mock('@/components/marks', () => ({ GithubMark: () => null }))

import { AgentToolsCard } from './AgentToolsCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | undefined
let root: Root | undefined

async function render(daemon: DaemonRow | undefined, canEdit = true): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<AgentToolsCard agentId="a1" runtime="claude" daemon={daemon} canEdit={canEdit} />)
  })
  return host.textContent ?? ''
}

/** Open the header's Add menu and read what it offers. It portals to the body,
 *  so the attachable names are never in the card's own subtree. */
async function openAddMenu(): Promise<string> {
  const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Add'))
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger!.click()
  })
  return document.querySelector('[data-anchored-flyout]')?.textContent ?? ''
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.saved = []
})

describe('AgentToolsCard', () => {
  // A pool- or group-placed agent carries a placement sentinel instead of a member id, so the
  // console resolves no owning daemon for it. Gating the whole candidate list on that lookup hid
  // every org-registry server such an agent could attach — and those are http-proxied, so they
  // never needed a daemon in the first place.
  it('offers the org registry servers for an agent with no resolved daemon', async () => {
    await render(undefined)
    const menu = await openAddMenu()
    expect(menu).toContain('grafana')
    expect(menu).toContain('linear')
  })

  it('unions the daemon-reported servers with the registry when a daemon does resolve', async () => {
    const daemon = {
      name: 'mac-studio',
      mcpServers: [{ name: 'daemon-local', transport: 'stdio' }],
      runtimeModels: []
    } as unknown as DaemonRow
    await render(daemon)
    const menu = await openAddMenu()
    expect(menu).toContain('daemon-local')
    expect(menu).toContain('grafana')
  })

  // The rows are the saved allow-list, so an attached server leaves the Add menu.
  it('rows the attached servers and drops them from the Add menu', async () => {
    mocks.saved = ['grafana']
    const text = await render(undefined)
    expect(text).toContain('grafana')
    expect(text).not.toContain('linear')
    const menu = await openAddMenu()
    expect(menu).toContain('linear')
    expect(menu).not.toContain('grafana')
  })

  it('shows the empty state when the agent has nothing attached', async () => {
    expect(await render(undefined)).toContain('No MCP servers')
  })

  // A read-only agent is never asked for its spec, so the card must settle on the
  // empty state instead of sitting on its loading line forever.
  it('does not hang on the loading line for an agent the caller cannot edit', async () => {
    const text = await render(undefined, false)
    expect(text).toContain('No MCP servers')
    expect(text).not.toContain('Loading tools')
    expect(text).not.toContain('Add')
  })

  it('says so in the menu when the org registry is empty too', async () => {
    const saved = mocks.mcpProviders
    mocks.mcpProviders = []
    try {
      await render(undefined)
      expect(await openAddMenu()).toContain('already attached')
    } finally {
      mocks.mcpProviders = saved
    }
  })
})

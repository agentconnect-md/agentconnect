// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  keys: [] as unknown[],
  agents: [
    { id: 'a1', name: 'docs-bot', displayName: 'Docs Bot' },
    { id: 'a2', name: 'triage', displayName: undefined }
  ] as unknown[],
  createMyApiKey: vi.fn(async () => ({
    apiKeyId: 'k-new',
    apiKey: 'ac_user_secret',
    displayTail: '…cret',
    permission: 'full',
    allAgents: false,
    agentIds: []
  })),
  fetchAgents: vi.fn(async () => mocks.agents)
}))

vi.mock('@/lib/data', () => ({
  MOCK_MODE: false,
  agentLabel: (a: { name: string; displayName?: string }) => a.displayName || a.name
}))
vi.mock('@/lib/api', () => ({
  fetchMyApiKeys: vi.fn(async () => mocks.keys),
  createMyApiKey: mocks.createMyApiKey,
  revokeMyApiKey: vi.fn(async () => undefined),
  fetchAgents: mocks.fetchAgents,
  fmtDate: (d: unknown) => String(d)
}))

import ApiKeysCard from './ApiKeysCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ORGS = [{ id: 'o1', slug: 'acme', name: 'Acme' }] as never

function key(over: Record<string, unknown>) {
  return {
    id: 'k1',
    displayTail: '…a1b2',
    name: null,
    orgId: 'o1',
    orgSlug: 'acme',
    orgName: 'Acme',
    permission: 'full',
    allAgents: false,
    agentIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over
  }
}

let host: HTMLDivElement | undefined
let root: Root | undefined

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ApiKeysCard orgs={ORGS} defaultOrgId="o1" />)
  })
  // Let SWR settle the key list.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
}

async function choose(selectIndex: number, value: string): Promise<void> {
  const select = document.querySelectorAll('select')[selectIndex]!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.keys = []
  mocks.createMyApiKey.mockClear()
  mocks.fetchAgents.mockClear()
})

describe('ApiKeysCard permissions', () => {
  it('labels every non-full key with its permission and, for agent chat, its selection', async () => {
    mocks.keys = [
      key({ id: 'k-full' }),
      key({ id: 'k-read', displayTail: '…read', permission: 'read' }),
      key({ id: 'k-two', displayTail: '…two', permission: 'agent:chat', agentIds: ['a1', 'a2'] }),
      key({ id: 'k-all', displayTail: '…all', permission: 'agent:chat', allAgents: true })
    ]
    await render()
    const text = host!.textContent ?? ''
    expect(text).toContain('Read-only')
    expect(text).toContain('Agent chat · 2 agents')
    expect(text).toContain('Agent chat · All agents')
    // The default permission carries no badge, like an unexpired key.
    expect(text).not.toContain('Full access')
  })

  it('mints a full key without a selection', async () => {
    await render()
    await click('New key')
    await click('Create')
    expect(mocks.createMyApiKey).toHaveBeenCalledWith({ orgId: 'o1', expiresInDays: 90, permission: 'full' })
    expect(mocks.fetchAgents).not.toHaveBeenCalled()
  })

  it('offers the agent selection under Agent chat and sends the chosen agents of the chosen org', async () => {
    await render()
    await click('New key')
    // Selects: organization, permission, expiry — then the agents scope once Agent chat is chosen.
    await choose(1, 'agent:chat')
    expect(host!.textContent).toContain('All agents')
    await choose(2, 'selected')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.fetchAgents).toHaveBeenCalledWith('o1')
    expect(host!.textContent).toContain('Docs Bot')
    expect(host!.textContent).toContain('triage')
    // Nothing chosen yet: Create is inert.
    await click('Create')
    expect(mocks.createMyApiKey).not.toHaveBeenCalled()

    const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    await act(async () => {
      boxes[0]!.click()
    })
    await click('Create')
    expect(mocks.createMyApiKey).toHaveBeenCalledWith({
      orgId: 'o1',
      expiresInDays: 90,
      permission: 'agent:chat',
      agents: ['a1']
    })
  })

  it('sends every agent when the scope stays on All agents', async () => {
    await render()
    await click('New key')
    await choose(1, 'agent:chat')
    await click('Create')
    expect(mocks.createMyApiKey).toHaveBeenCalledWith({
      orgId: 'o1',
      expiresInDays: 90,
      permission: 'agent:chat',
      agents: 'all'
    })
  })
})

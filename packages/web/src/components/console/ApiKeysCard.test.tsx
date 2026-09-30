// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
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
  updateMyApiKey: vi.fn(async () => ({})),
  regenerateMyApiKey: vi.fn(async () => ({
    apiKeyId: 'k1',
    apiKey: 'ac_user_regenerated',
    displayTail: '…ated',
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
vi.mock('@/components/marks', () => ({ AgentIconView: () => null }))
vi.mock('@/lib/api', () => ({
  fetchMyApiKeys: vi.fn(async () => mocks.keys),
  createMyApiKey: mocks.createMyApiKey,
  updateMyApiKey: mocks.updateMyApiKey,
  regenerateMyApiKey: mocks.regenerateMyApiKey,
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
    agents: [],
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
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ApiKeysCard orgs={ORGS} defaultOrgId="o1" />
      </SWRConfig>
    )
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

/** The last button carrying `label`: a dialog's primary action, when a row link says the same word. */
async function clickLast(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(label)).at(-1)
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const field = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement

/** Open the field's dropdown and pick the option that reads `option`. */
async function choose(label: string, option: string): Promise<void> {
  await act(async () => {
    field(label).click()
  })
  const item = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent === option)
  expect(item, option).toBeTruthy()
  await act(async () => {
    ;(item as HTMLButtonElement).click()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.keys = []
  mocks.createMyApiKey.mockClear()
  mocks.updateMyApiKey.mockClear()
  mocks.regenerateMyApiKey.mockClear()
  mocks.fetchAgents.mockClear()
})

describe('ApiKeysCard permissions', () => {
  it('labels every non-full key with its permission and, for agent chat, its selection', async () => {
    mocks.keys = [
      key({ id: 'k-full' }),
      key({ id: 'k-read', displayTail: '…read', permission: 'read' }),
      key({
        id: 'k-two',
        displayTail: '…two',
        permission: 'agent:chat',
        agentIds: ['a1', 'a2'],
        agents: [
          { id: 'a1', name: 'docs-bot', displayName: 'Docs Bot' },
          { id: 'a2', name: 'triage', displayName: null }
        ]
      }),
      key({ id: 'k-all', displayTail: '…all', permission: 'agent:chat', allAgents: true }),
      key({ id: 'k-none', displayTail: '…none', permission: 'agent:chat' })
    ]
    await render()
    const text = host!.textContent ?? ''
    expect(text).toContain('Read-only')
    // The selection is named, not counted; an emptied one (every agent deleted) reaches no agent.
    expect(text).toContain('Agent chat · Docs Bot, triage')
    expect(text).toContain('Agent chat · All agents')
    expect(text).toContain('Agent chat · 0 agents')
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
    // The agents scope appears once Agent chat is chosen.
    await choose('Permission', 'Agent chat')
    expect(host!.textContent).toContain('All agents')
    await choose('Agents', 'Selected agents')
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
    await choose('Permission', 'Agent chat')
    await click('Create')
    expect(mocks.createMyApiKey).toHaveBeenCalledWith({
      orgId: 'o1',
      expiresInDays: 90,
      permission: 'agent:chat',
      agents: 'all'
    })
  })
})

describe('ApiKeysCard edit and regenerate', () => {
  it('edits name, expiry and permission in place and sends only what changed', async () => {
    mocks.keys = [key({ id: 'k1', name: 'before', expiresAt: '2026-12-01T00:00:00.000Z' })]
    await render()
    await click('Edit')
    // The dialog opens on the key's own values: org fixed, name filled, expiry kept, permission Full access.
    expect(field('Organization').disabled).toBe(true)
    expect(field('Organization').textContent).toBe('Acme')
    expect((document.querySelector('input.inp') as HTMLInputElement).value).toBe('before')
    expect(field('Expires').textContent).toBe('expires 2026-12-01T00:00:00.000Z')

    // Nothing changed: Save just closes, no request.
    await clickLast('Save')
    expect(mocks.updateMyApiKey).not.toHaveBeenCalled()
    expect(host!.textContent).not.toContain('Edit API key')

    await click('Edit')
    await type(document.querySelector('input.inp') as HTMLInputElement, 'after')
    await choose('Expires', '30 days')
    await choose('Permission', 'Read-only')
    await clickLast('Save')
    expect(mocks.updateMyApiKey).toHaveBeenCalledWith('k1', { name: 'after', expiresInDays: 30, permission: 'read' })
  })

  it('switches a key to Agent chat with a selection, and replaces the selection of an agent-chat key', async () => {
    mocks.keys = [key({ id: 'k1' })]
    await render()
    await click('Edit')
    await choose('Permission', 'Agent chat')
    await choose('Agents', 'Selected agents')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.fetchAgents).toHaveBeenCalledWith('o1')
    // No agent chosen yet: Save is inert.
    await clickLast('Save')
    expect(mocks.updateMyApiKey).not.toHaveBeenCalled()
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    await act(async () => {
      boxes[1]!.click()
    })
    await clickLast('Save')
    expect(mocks.updateMyApiKey).toHaveBeenCalledWith('k1', { permission: 'agent:chat', agents: ['a2'] })

    // An agent-chat key opens with its selection checked; widening it to All agents sends `agents: 'all'` alone.
    mocks.updateMyApiKey.mockClear()
    mocks.keys = [
      key({
        id: 'k2',
        permission: 'agent:chat',
        agentIds: ['a1'],
        agents: [{ id: 'a1', name: 'docs-bot', displayName: 'Docs Bot' }]
      })
    ]
    await act(async () => root?.unmount())
    await render()
    await click('Edit')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const checked = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(checked.map((b) => b.checked)).toEqual([true, false])
    await choose('Agents', 'All agents')
    await clickLast('Save')
    expect(mocks.updateMyApiKey).toHaveBeenCalledWith('k2', { agents: 'all' })
  })

  it('regenerates after a confirm step and shows the new key once', async () => {
    mocks.keys = [key({ id: 'k1', name: 'ci' })]
    await render()
    await click('Regenerate')
    expect(host!.textContent).toContain('Regenerate API key')
    expect(mocks.regenerateMyApiKey).not.toHaveBeenCalled()
    await clickLast('Regenerate')
    expect(mocks.regenerateMyApiKey).toHaveBeenCalledWith('k1')
    expect(host!.textContent).toContain('API key regenerated')
    expect(host!.textContent).toContain('ac_user_regenerated')
    expect(host!.textContent).toContain('shown only once')
  })
})

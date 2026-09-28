// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const key = (over: Record<string, unknown>) => ({
    id: 'k',
    displayTail: '…tail',
    name: null,
    orgId: 'o1',
    orgSlug: 'example',
    orgName: 'Example Org',
    permission: 'agent:chat',
    allAgents: false,
    agentIds: [],
    agents: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over
  })
  return {
    key,
    myKeys: [] as unknown[],
    accountKeys: [] as unknown[],
    removeAgentApi: vi.fn(async () => undefined),
    createMyApiKey: vi.fn(async () => ({ apiKeyId: 'k-new', apiKey: 'ac_secret', displayTail: '…cret' })),
    createAccountKey: vi.fn(async () => ({ apiKeyId: 'k-sa', apiKey: 'ac_sa_secret', displayTail: '…sa' }))
  }
})

vi.mock('@/lib/data', () => ({
  MOCK_MODE: false,
  agentLabel: (a: { name: string; displayName?: string }) => a.displayName || a.name
}))
vi.mock('@/components/marks', () => ({ AgentIconView: () => null }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'o1', slug: 'example', name: 'Example Org', role: 'owner' } })
}))
vi.mock('@/lib/agent-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-api')>()),
  agentApiRelayUrl: () => 'https://relay.example.test'
}))
vi.mock('@/lib/api', () => ({
  cpRestBase: () => 'https://api.example.test/api/v1',
  fetchMyApiKeys: vi.fn(async () => mocks.myKeys),
  fetchServiceAccounts: vi.fn(async () => [
    {
      userId: 'sa1',
      name: 'docs-relay',
      email: 'docs-relay@sa.example.test',
      displayName: 'docs-relay',
      role: 'collaborator',
      createdAt: '2026-09-01T00:00:00.000Z'
    }
  ]),
  serviceAccountKeysApi: () => ({
    list: vi.fn(async () => mocks.accountKeys),
    create: mocks.createAccountKey,
    update: vi.fn(),
    regenerate: vi.fn(),
    revoke: vi.fn()
  }),
  removeAgentApi: mocks.removeAgentApi,
  createMyApiKey: mocks.createMyApiKey,
  updateMyApiKey: vi.fn(),
  regenerateMyApiKey: vi.fn(),
  revokeMyApiKey: vi.fn(),
  fetchAgents: vi.fn(async () => [{ id: 'agent-1', name: 'docs' }]),
  fmtDate: (d: unknown) => String(d)
}))

import { AgentApiCard } from './AgentApiCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AGENT = { id: 'agent-1', name: 'docs' } as never
const onChanged = vi.fn()

let host: HTMLDivElement | undefined
let root: Root | undefined

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AgentApiCard
          agent={AGENT}
          entries={[{ protocol: 'ai-sdk-ui', createdBy: null, createdAt: '2026-09-01T00:00:00.000Z' }]}
          mobile={false}
          onChanged={onChanged}
        />
      </SWRConfig>
    )
  })
  await settle()
}

async function click(label: string, last = false): Promise<void> {
  const matches = [...document.querySelectorAll('button')].filter(
    (b) => b.textContent?.includes(label) || b.getAttribute('aria-label') === label
  )
  const button = last ? matches.at(-1) : matches[0]
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
  await settle()
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.myKeys = []
  mocks.accountKeys = []
  mocks.removeAgentApi.mockClear()
  mocks.createAccountKey.mockClear()
  onChanged.mockClear()
})

describe('AgentApiCard', () => {
  it('shows each added protocol with a Quickstart that names this deployment’s chat endpoint, with an example per tab', async () => {
    await render()
    expect(host!.textContent).toContain('AI SDK UI')
    await click('Quickstart')
    const text = document.body.textContent ?? ''
    expect(text).toContain('https://relay.example.test/ai-sdk/agents/agent-1/chat')
    expect(text).not.toContain('webchat/token')
    expect(text).toContain('$AGENTCONNECT_API_KEY')
    await click('Browser')
    const web = document.body.textContent ?? ''
    expect(web).toContain('app/api/chat/route.ts')
    expect(web).toContain('app/page.tsx')
    expect(web).toContain('process.env.AGENTCONNECT_API_KEY')
  })

  it('lists only live Agent chat keys that reach this agent, the caller’s and each service account’s', async () => {
    mocks.myKeys = [
      mocks.key({ id: 'mine', name: 'docs-site', agentIds: ['agent-1'] }),
      mocks.key({ id: 'full', name: 'full-key', permission: 'full' }),
      mocks.key({ id: 'other', name: 'other-agent', agentIds: ['agent-2'] }),
      mocks.key({ id: 'revoked', name: 'revoked-key', allAgents: true, revokedAt: '2026-09-02T00:00:00.000Z' })
    ]
    mocks.accountKeys = [mocks.key({ id: 'sa', name: 'support-widget', allAgents: true })]
    await render()
    await click('Quickstart')
    const text = document.body.textContent ?? ''
    expect(text).toContain('docs-site')
    expect(text).toContain('support-widget')
    expect(text).toContain('docs-relay · All agents')
    expect(text).not.toContain('full-key')
    expect(text).not.toContain('other-agent')
    expect(text).not.toContain('revoked-key')
  })

  it('creates a key for a chosen service account, preset to Agent chat on this agent', async () => {
    await render()
    await click('Quickstart')
    await click('Create key')
    await act(async () => {
      ;(document.querySelector('button[aria-label="Owner"]') as HTMLButtonElement).click()
    })
    const option = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) =>
      b.textContent?.includes('docs-relay')
    )
    await act(async () => {
      ;(option as HTMLButtonElement).click()
    })
    await click('Create', true)
    expect(mocks.createAccountKey).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'o1', permission: 'agent:chat', agents: ['agent-1'] })
    )
    expect(mocks.createMyApiKey).not.toHaveBeenCalled()
  })

  it('removes every protocol after a confirmation', async () => {
    await render()
    await click('Remove')
    expect(document.body.textContent).toContain('docs stops accepting API calls')
    await click('Remove', true)
    expect(mocks.removeAgentApi).toHaveBeenCalledWith('agent-1', 'ai-sdk-ui')
    expect(onChanged).toHaveBeenCalled()
  })
})

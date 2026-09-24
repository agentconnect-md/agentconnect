// @vitest-environment happy-dom

// The Routing page: entry states (flag off, unknown, unshared bot), header and readiness banners, Test routing, and history.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

const env = vi.hoisted(() => ({ botId: 'support-bot', role: 'owner' as 'owner' | 'viewer' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ botId: env.botId }),
  usePathname: () => `/integrations/bots/${env.botId}/routing`,
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: env.role, orgPath: (path: string) => `/o/acme${path}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    integrations: [],
    getAgent: () => undefined,
    botsLoaded: true,
    integrationsLoaded: true
  })
}))

import BotRoutingView from './BotRoutingView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Object.assign(env, { botId: 'support-bot', role: 'owner' })
  vi.restoreAllMocks()
})

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}
async function render(api: DecisionApi = decisionMock.createDecisionMockApi()) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <BotRoutingView />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await settle()
  return container
}
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

describe('BotRoutingView', () => {
  it('shows the bot identity, the Integrations breadcrumb, and its saved readiness', async () => {
    const view = await render()
    const crumbs = [...view.querySelectorAll('nav a')].map((link) => [link.textContent, link.getAttribute('href')])
    expect(crumbs).toEqual([
      ['Integrations', '/o/acme/integrations'],
      ['Support bot', '/o/acme/integrations?bot=support-bot']
    ])
    expect(view.querySelector('nav [aria-current="page"]')?.textContent).toBe('Routing')
    expect(view.querySelector('h1')?.textContent).toBe('Support bot')
    expect(view.textContent).toContain('Ready')
    expect(view.querySelector('[data-testid="routing-editor"]')).not.toBeNull()
  })

  it('opens Test routing and Recent evaluations from the page', async () => {
    const view = await render()
    await click(button(view, 'Test routing'))
    expect(view.querySelector('[data-testid="routing-try"]')).not.toBeNull()
    await click(button(view, 'Recent evaluations'))
    expect(view.querySelector('[data-testid="routing-evaluations"]')?.textContent).toContain('Partially routed')
  })

  it('distinguishes saved from applied while pending sync', async () => {
    const view = await render(decisionMock.createDecisionMockApi({ scenario: 'pending_sync' }))
    expect(view.textContent).toContain('Pending sync')
    expect(view.textContent).toContain('Saved, not yet applied.')
  })

  it('names the provider that lacks a key or credits and links to provider keys', async () => {
    const api = decisionMock.createDecisionMockApi()
    const detail = await api.getRouting('support-bot')
    const getRouting = vi
      .spyOn(api, 'getRouting')
      .mockResolvedValue({ ...detail, readiness: { status: 'missing_credentials' } })
    const missing = await render(api)
    expect(missing.textContent).toContain('TypeSafe has no organization key and no eligible Cloud support')
    expect(missing.querySelector('a[href="/o/acme/daemons"]')?.textContent).toBe('Open provider keys')
    if (root) await act(async () => root?.unmount())
    container?.remove()
    getRouting.mockResolvedValue({ ...detail, readiness: { status: 'insufficient_credits' } })
    const credits = await render(api)
    expect(credits.textContent).toContain(
      "TypeSafe has no organization key and the organization's AC credits are exhausted"
    )
  })

  it('explains an unshared or unknown bot instead of offering the editor', async () => {
    env.botId = 'moderator-bot'
    const unshared = await render()
    expect(unshared.textContent).toContain('only for a shared bot')
    expect(unshared.querySelector('[data-testid="routing-editor"]')).toBeNull()
    if (root) await act(async () => root?.unmount())
    container?.remove()
    env.botId = 'missing-bot'
    const missing = await render()
    expect(missing.textContent).toContain('This bot does not exist')
  })

  it('reads as a new, unsaved draft for a bot without routing', async () => {
    const api = decisionMock.createDecisionMockApi()
    vi.spyOn(api, 'getRouting').mockResolvedValue({
      botId: 'support-bot',
      config: null,
      channelIds: [],
      readiness: { status: 'ready' },
      evaluationHost: null,
      channels: [],
      updatedAt: null
    })
    const view = await render(api)
    expect(view.textContent).toContain('Unsaved draft')
    expect(view.textContent).toContain('No routing yet')
    expect(view.textContent).toContain('New configuration, not saved yet')
    expect(view.querySelector<HTMLSelectElement>('select[aria-label="Otherwise"]')?.value).toBe('skip')
  })
})

// @vitest-environment happy-dom

// A shared bot's expanded roster offers By decision in each channel's dispatch menu and opens its rules in place.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  integrations: [] as unknown[],
  refresh: vi.fn(),
  stopRouting: vi.fn(async () => undefined),
  gateEntries: [] as unknown[]
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    get integrations() {
      return mocks.integrations
    },
    agents: [],
    loading: false,
    getAgent: (id: string) => ({ id, name: id, runtime: 'claude' }),
    refresh: mocks.refresh,
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setBotJoinPublicChannels: vi.fn(),
    setChannelAgent: vi.fn()
  })
}))
vi.mock('@/lib/decisions/provider', () => {
  const store = { api: {}, dispatchRouting: vi.fn() }
  return { useOptionalDecisionsPrototype: () => store }
})
vi.mock('@/components/console/decisions/channel-gates', () => ({
  useChannelGates: () => ({
    offered: true,
    decisionTriggers: () => true,
    entry: (props: unknown) => {
      mocks.gateEntries.push(props)
      return <button type="button">Decision</button>
    },
    strip: () => null
  })
}))
vi.mock('@/components/console/decisions/routing/DecisionRoutingModal', () => ({
  stopRouting: mocks.stopRouting,
  DecisionRoutingModal: ({ channelName }: { channelName: string }) => (
    <div role="dialog" aria-label={`${channelName} · By decision rules`} />
  )
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => [])
}))

const IntegrationsView = (await import('./IntegrationsView')).default

function bot(over: Partial<BotDto>): BotDto {
  return {
    id: 'bot-1',
    name: 'support',
    platform: 'slack',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: true,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

let host: HTMLDivElement
let root: Root

// Render the view, pick the Slack tab, and expand that bot's roster.
async function expand(botId: string): Promise<void> {
  await act(async () => root.render(<IntegrationsView />))
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes('Slack'))
  await act(async () => (tab as HTMLButtonElement).click())
  const row = host.querySelector<HTMLElement>(`#integration-bot-${botId}`)
  if (!row) throw new Error(`no bot row for ${botId}`)
  await act(async () => row.click())
}

const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
async function click(node: Element | undefined) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

const installs = (routed: boolean) => [
  {
    id: 'i1',
    agentId: 'a1',
    botId: 'shared-1',
    channels: [
      routed
        ? {
            channelId: 'C1',
            name: 'help',
            trigger: 'decision',
            decisionBinding: { type: 'shared_bot_routing' },
            decision: { id: 'd1', name: 'Request type', enabled: true, readiness: { status: 'ready' } },
            agentId: 'a1'
          }
        : { channelId: 'C1', name: 'help', trigger: 'mention', agentId: 'a1' }
    ]
  },
  { id: 'i2', agentId: 'a2', botId: 'shared-1', channels: [] }
]

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = []
  mocks.integrations = []
  mocks.refresh.mockReset()
  mocks.stopRouting.mockReset().mockResolvedValue(undefined)
  mocks.gateEntries = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('a shared bot’s dispatch menu', () => {
  it('offers Or pick by decision and opens the channel’s rules in place', async () => {
    mocks.bots = [bot({ id: 'shared-1', agentIds: ['a1', 'a2'] })]
    mocks.integrations = installs(false)
    await expand('shared-1')
    expect(host.textContent).toContain('Dispatch')
    await click(buttons().find((b) => b.title === 'Default dispatch — a1'))
    expect(document.body.textContent).toContain('Send every message to')
    expect(document.body.textContent).toContain('Or pick by decision')
    await click(buttons().find((b) => b.textContent?.trim() === 'Decision'))
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('help · By decision rules')
  })

  it('names a routed channel’s Decision and stops routing it from the pill', async () => {
    mocks.bots = [bot({ id: 'shared-1', agentIds: ['a1', 'a2'] })]
    mocks.integrations = installs(true)
    await expand('shared-1')
    await click(buttons().find((b) => b.title === 'Dispatch by decision — Request type'))
    await click(buttons().find((b) => b.getAttribute('aria-label') === 'Stop using By decision in this channel'))
    expect(mocks.stopRouting).toHaveBeenCalledWith(expect.anything(), 'shared-1', 'C1')
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('gives a single-owner bot’s room the agent tab’s + Decision gate instead of routing', async () => {
    mocks.bots = [bot({ id: 'solo', shareable: false, transport: 'socket', agentIds: ['a1'] })]
    mocks.integrations = [
      { id: 'i1', agentId: 'a1', botId: 'solo', channels: [{ channelId: 'C1', name: 'help', trigger: 'mention' }] }
    ]
    await expand('solo')
    expect(document.body.textContent).not.toContain('Or pick by decision')
    expect(mocks.gateEntries).toEqual([expect.objectContaining({ botId: 'solo', integrationId: 'i1' })])
  })
})

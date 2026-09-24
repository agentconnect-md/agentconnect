// @vitest-environment happy-dom

// A shared bot's expanded row links to its Configuration → Routing page, with the routed-channel count.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[], integrations: [] as unknown[] }))

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
    getAgent: () => null,
    refresh: vi.fn(),
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setBotJoinPublicChannels: vi.fn(),
    setChannelAgent: vi.fn()
  })
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

// Render the view, pick the platform tab, and return that bot's row (scoped past the card header's own switch).
async function botRow(tabLabel: string, botId: string): Promise<HTMLElement> {
  await act(async () => root.render(<IntegrationsView />))
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes(tabLabel))
  if (!tab) throw new Error(`no Bots tab labeled "${tabLabel}"`)
  await act(async () => (tab as HTMLButtonElement).click())
  const row = host.querySelector<HTMLElement>(`#integration-bot-${botId}`)
  if (!row) throw new Error(`no bot row for ${botId} under the ${tabLabel} tab`)
  return row
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = []
  mocks.integrations = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the shared-bot Routing entry', () => {
  it('links an expanded shared bot to its Routing page with the routed channel count', async () => {
    mocks.bots = [bot({ id: 'shared-1', agentIds: ['a1', 'a2'] })]
    mocks.integrations = [
      {
        id: 'i1',
        agentId: 'a1',
        botId: 'shared-1',
        channels: [
          { channelId: 'C1', name: 'help', trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } },
          { channelId: 'C2', name: 'general', trigger: 'mention' }
        ]
      },
      {
        id: 'i2',
        agentId: 'a2',
        botId: 'shared-1',
        channels: [
          { channelId: 'C1', name: 'help', trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' } }
        ]
      }
    ]
    const row = await botRow('Slack', 'shared-1')
    expect(host.textContent).not.toContain('By decision · 1 channel')
    await act(async () => row.click())
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open routing')
    expect(link?.getAttribute('href')).toBe('/integrations/bots/shared-1/routing')
    expect(host.textContent).toContain('By decision · 1 channel')
  })

  it('offers no Routing entry for a bot that is not shared', async () => {
    mocks.bots = [bot({ id: 'solo', shareable: false, agentIds: ['a1'] })]
    const row = await botRow('Slack', 'solo')
    await act(async () => row.click())
    expect([...host.querySelectorAll('a')].some((a) => a.textContent?.includes('routing'))).toBe(false)
  })
})

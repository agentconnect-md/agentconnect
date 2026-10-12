// @vitest-environment happy-dom

// The org's Bots list Apply to all reaches only an assistant-mode agent's rooms already enabled, as its agent page does (assistant-mode.md §5.3).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import type { BotDto } from '@/lib/api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'

const mocks = vi.hoisted(() => ({
  integrations: [] as unknown[],
  assistantAgents: new Set<string>(),
  setChannelTrigger: vi.fn(async (..._args: unknown[]) => undefined),
  setChannelDecision: vi.fn(async (..._args: unknown[]) => undefined)
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/integrations',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [soloBot],
    get integrations() {
      return mocks.integrations
    },
    agents: [],
    loading: false,
    getAgent: (id: string) => ({
      id,
      name: id,
      runtime: 'claude',
      ...(mocks.assistantAgents.has(id) ? { assistantMode: { enabled: true } } : {})
    }),
    refresh: vi.fn(),
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setBotJoinPublicChannels: vi.fn(),
    setChannelAgent: vi.fn(),
    setChannelTrigger: mocks.setChannelTrigger,
    setChannelDecision: mocks.setChannelDecision
  })
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
const summaries: DecisionSummary[] = createDecisionMockSeed()
  .decisions.slice(0, 2)
  .map((entry) => ({ ...entry, usageCount: 0 }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const refuse = async (): Promise<never> => {
    throw new Error('not in this test')
  }
  const live: DecisionApi = {
    mode: 'live',
    listProviders: async () => [],
    listDecisions: async () => summaries,
    getDecision: refuse,
    createDecision: refuse,
    updateDecision: refuse,
    deleteDecision: refuse,
    listBots: refuse,
    listChannels: refuse,
    saveChannel: refuse,
    getRouting: refuse,
    saveRouting: refuse,
    preview: refuse,
    previewGate: refuse,
    listEvaluations: async () => ({ items: [], nextCursor: null }),
    getEvaluation: refuse,
    previewRouting: refuse,
    listRoutingEvaluations: refuse,
    getRoutingEvaluation: refuse
  }
  return {
    ...actual,
    createDecisionApi: () => live,
    fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
    fetchGithubInstallUrl: vi.fn(async () => null),
    syncGithubInstallations: vi.fn(async () => [])
  }
})

const IntegrationsView = (await import('./IntegrationsView')).default

const soloBot: BotDto = {
  id: 'solo',
  name: 'support',
  platform: 'slack',
  prebuilt: false,
  slackAppId: null,
  discordAppId: null,
  createdBy: null,
  transport: 'socket',
  shareable: false,
  inUseByAgentId: null,
  agentIds: ['a1'],
  lastUsedAt: null,
  freedFromAgent: null,
  createdAt: '2026-01-01T00:00:00.000Z'
}

const NAMES = ['help', 'ops', 'eng']

let host: HTMLDivElement
let root: Root

async function expand(): Promise<void> {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <IntegrationsView />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  )
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes('Slack'))
  await act(async () => (tab as HTMLButtonElement).click())
  await act(async () => host.querySelector<HTMLElement>('#integration-bot-solo')!.click())
  await act(async () => {})
}

/** The room's + Decision entry: the nearest ancestor naming one room is that room's row. */
function addDecisionFor(name: string): HTMLButtonElement {
  const entry = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Add decision"]')].find((button) => {
    for (let node = button.parentElement; node; node = node.parentElement) {
      const named = NAMES.filter((room) => node.textContent?.includes(room))
      if (named.length) return named.length === 1 && named[0] === name
    }
    return false
  })
  if (!entry) throw new Error(`no + Decision for ${name}`)
  return entry
}

async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

const applyAll = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Apply to all channels'
  )

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.integrations = [
    {
      id: 'i1',
      agentId: 'a1',
      botId: 'solo',
      channels: [
        { channelId: 'C1', name: 'help', kind: 'channel', trigger: 'off' },
        { channelId: 'C2', name: 'ops', kind: 'channel', trigger: 'mention' },
        { channelId: 'C3', name: 'eng', kind: 'channel', trigger: 'any' }
      ]
    }
  ]
  mocks.assistantAgents = new Set(['a1'])
  mocks.setChannelTrigger.mockReset().mockResolvedValue(undefined)
  mocks.setChannelDecision.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the Bots list Apply to all', () => {
  it('skips the Off rooms of an assistant-mode agent', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await expand()
    await click(addDecisionFor('ops'))
    await click(applyAll())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('all 2 channels'))
    expect(mocks.setChannelDecision.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['i1', 'C2'],
      ['i1', 'C3']
    ])
  })

  it('reaches every channel of an agent outside assistant mode, Off ones included', async () => {
    mocks.assistantAgents = new Set()
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await expand()
    await click(addDecisionFor('ops'))
    await click(applyAll())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('all 3 channels'))
    expect(mocks.setChannelDecision.mock.calls.map((call) => call[1]).sort()).toEqual(['C1', 'C2', 'C3'])
  })
})

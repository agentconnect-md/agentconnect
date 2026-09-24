// @vitest-environment happy-dom

// A shared bot's By decision routing from one conversation row: the dispatch menu opens its rules modal in place, saves the row into scope, and stops it.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi, DecisionRoutingDetail, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import type { IntegrationChannelRow } from '@/lib/data'
import { ApiError } from '@/lib/api'

const routing = vi.hoisted(() => ({
  getRouting: vi.fn(),
  saveRouting: vi.fn(),
  refresh: vi.fn(),
  setChannelTrigger: vi.fn(async () => undefined),
  integrations: [] as unknown[],
  lockedAgentIds: [] as string[]
}))

vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: false }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/agent-1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => {
  const agents = [
    { id: 'agent-1', name: 'deploy-bot', runtime: 'claude', status: 'online' },
    { id: 'agent-2', name: 'review-bot', runtime: 'codex', status: 'online' }
  ]
  return {
    useConsoleData: () => ({
      setChannelTrigger: routing.setChannelTrigger,
      setChannelDecision: vi.fn(),
      setChannelSessionMode: vi.fn(),
      setChannelAgent: vi.fn(),
      forgetChannel: vi.fn(),
      leaveConversation: vi.fn(),
      refresh: routing.refresh,
      bots: [
        {
          id: 'bot-shared',
          name: 'Shared bot',
          platform: 'slack',
          transport: 'http',
          shareable: true,
          agentIds: ['agent-1', 'agent-2']
        }
      ],
      botsLoaded: true,
      integrationsLoaded: true,
      agents,
      getAgent: (id: string) => {
        const agent = agents.find((entry) => entry.id === id)
        return agent && { ...agent, canEdit: !routing.lockedAgentIds.includes(id) }
      },
      get integrations() {
        return routing.integrations
      }
    })
  }
})
const seed = createDecisionMockSeed()
const summaries: DecisionSummary[] = seed.decisions.slice(0, 2).map((entry) => ({ ...entry, usageCount: 0 }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
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
    getRouting: routing.getRouting,
    saveRouting: routing.saveRouting,
    preview: refuse,
    previewGate: refuse,
    listEvaluations: refuse,
    getEvaluation: refuse,
    previewRouting: refuse,
    listRoutingEvaluations: refuse,
    getRoutingEvaluation: refuse
  }
  return { ...actual, createDecisionApi: () => live }
})

import { IntegrationChannelList } from './IntegrationChannelList'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const detail = (over: Partial<DecisionRoutingDetail> = {}): DecisionRoutingDetail => ({
  botId: 'bot-shared',
  config: null,
  channelIds: [],
  readiness: { status: 'ready' },
  evaluationHost: null,
  channels: [],
  updatedAt: null,
  ...over
})

const routed: DecisionRoutingDetail = detail({
  config: {
    enabled: true,
    decisionId: 'support-category',
    rules: [
      {
        id: 'r1',
        when: { type: 'choice', thresholds: { billing: 0.3 } },
        action: { type: 'agent', agentId: 'agent-1' }
      }
    ],
    otherwise: { type: 'skip' }
  },
  channelIds: ['C1', 'C9']
})

beforeEach(() => {
  routing.getRouting.mockReset()
  routing.saveRouting
    .mockReset()
    .mockImplementation(async (_bot, body) => detail({ config: body.config, channelIds: body.channelIds }))
  routing.refresh.mockReset()
  routing.integrations = []
  routing.setChannelTrigger.mockClear()
  routing.lockedAgentIds = []
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const row = (over: Partial<IntegrationChannelRow> = {}): IntegrationChannelRow => ({
  channelId: 'C1',
  name: 'deploys',
  kind: 'channel',
  trigger: 'mention',
  agentId: 'agent-1',
  ...over
})

// Hides and re-shows the list under one provider, as leaving for Create decision and coming back does.
let setShown: (shown: boolean) => void = () => {}
function Harness({ channels }: { channels: IntegrationChannelRow[] }) {
  const [shown, set] = useState(true)
  setShown = set
  return shown ? (
    <IntegrationChannelList
      integrationId="int-1"
      channels={channels}
      botId="bot-shared"
      agentId="agent-1"
      platform="slack"
      shareable
    />
  ) : null
}

async function render(channels: IntegrationChannelRow[]) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <Harness channels={channels} />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await flush()
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

describe('IntegrationChannelList shared-bot routing', () => {
  it('opens a routed row’s rules in place, one answer per row, naming the bot and its agents', async () => {
    routing.getRouting.mockResolvedValue(routed)
    await render([
      row({
        trigger: 'decision',
        decisionBinding: { type: 'shared_bot_routing' },
        decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
      })
    ])
    await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
    await click(all('button').find((node) => node.getAttribute('title') === 'Edit By decision rules'))
    expect(dialog()?.getAttribute('aria-label')).toBe('deploys · By decision rules')
    expect(dialog()?.textContent).toContain('Shared bot · picks among deploy-bot, review-bot')
    expect(all('[data-testid="routing-answer"]')).toHaveLength(3)
    expect(
      document.body.querySelector<HTMLInputElement>('input[aria-label="Minimum probability for billing"]')?.value
    ).toBe('30')
    expect(document.body.querySelector('button[aria-label="Target for billing"]')?.textContent).toContain('deploy-bot')
    expect(document.body.querySelector('button[aria-label="Target for sales"]')?.textContent).toContain('Use Otherwise')
    expect(dialog()?.textContent).toContain('also apply to C9')
  })

  it('adds an unrouted row from + Decision and saves it into the bot’s scope with the picked target', async () => {
    routing.getRouting.mockResolvedValue(detail())
    await render([row()])
    await click(document.body.querySelector('button[aria-label="Default dispatch — deploy-bot"]'))
    await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
    expect(dialog()?.textContent).toContain('Save to apply By decision rules in this channel.')
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Support category')))
    await click(document.body.querySelector('button[aria-label="Target for technical"]'))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('review-bot')))
    await click(all('button').find((node) => node.textContent?.trim() === 'Save'))
    expect(routing.saveRouting).toHaveBeenCalledTimes(1)
    const [, body] = routing.saveRouting.mock.calls[0]!
    expect(body.channelIds).toEqual(['C1'])
    expect(body.config.decisionId).toBe('support-category')
    expect(body.config.rules).toEqual([
      expect.objectContaining({
        when: { type: 'choice', thresholds: { technical: 0.5 } },
        action: { type: 'agent', agentId: 'agent-2' }
      })
    ])
    expect(dialog()).toBeNull()
  })

  it('starts a switch to another question type on its answer table instead of stranding the old rules', async () => {
    routing.getRouting.mockResolvedValue(routed)
    await render([
      row({
        trigger: 'decision',
        decisionBinding: { type: 'shared_bot_routing' },
        decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
      })
    ])
    await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
    await click(all('button').find((node) => node.getAttribute('title') === 'Edit By decision rules'))
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Support category')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Needs a response')))
    expect(all('[data-testid="routing-answer"]').map((node) => node.textContent)).toEqual([
      expect.stringContaining('Yes'),
      expect.stringContaining('No')
    ])
    expect(dialog()?.textContent).not.toContain('question type differs')
    expect(document.body.querySelector('button[aria-label="Target for Yes"]')?.textContent).toContain('Use Otherwise')
  })

  const offInstalls = () => [
    { id: 'int-1', agentId: 'agent-1', botId: 'bot-shared', channels: [row()] },
    { id: 'int-2', agentId: 'agent-2', botId: 'bot-shared', channels: [row({ trigger: 'off' })] }
  ]
  const pickTarget = async () => {
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Support category')))
    await click(document.body.querySelector('button[aria-label="Target for billing"]'))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('review-bot')))
  }
  const openAdd = async () => {
    await click(document.body.querySelector('button[aria-label="Default dispatch — deploy-bot"]'))
    await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
  }
  const saveButton = () => all('button').find((node) => node.textContent?.trim() === 'Save') as HTMLButtonElement

  it('turns an Off row on with one bot-scoped PATCH through an editable install, then routes it', async () => {
    routing.getRouting.mockResolvedValue(detail())
    routing.integrations = offInstalls()
    await render([row()])
    await openAdd()
    expect(dialog()?.textContent).toContain(
      'deploys is Off for review-bot. Saving turns it on (@-mention) first, then routes it by decision.'
    )
    await pickTarget()
    await click(saveButton())
    expect(routing.setChannelTrigger.mock.calls).toEqual([['int-1', 'C1', 'mention']])
    expect(routing.setChannelTrigger.mock.invocationCallOrder[0]).toBeLessThan(
      routing.saveRouting.mock.invocationCallOrder[0]!
    )
    expect(routing.saveRouting).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when an Off install belongs to an agent the editor cannot edit', async () => {
    routing.getRouting.mockResolvedValue(detail())
    routing.integrations = offInstalls()
    routing.lockedAgentIds = ['agent-2']
    await render([row()])
    await openAdd()
    await pickTarget()
    expect(dialog()?.textContent).toContain('deploys is Off for review-bot, which you cannot edit.')
    expect(saveButton().disabled).toBe(true)
    expect(routing.setChannelTrigger).not.toHaveBeenCalled()
  })

  it('says a failed routing save left the Off row turned on', async () => {
    routing.getRouting.mockResolvedValue(detail())
    routing.saveRouting.mockRejectedValue(new Error('network down'))
    routing.integrations = offInstalls()
    await render([row()])
    await openAdd()
    await pickTarget()
    await click(saveButton())
    expect(dialog()?.textContent).toContain('deploys was turned on (@-mention), but the routing was not saved.')
  })

  it.each(['the header ×', 'the scrim'])(
    'drops an abandoned rules edit closed by %s before the next row opens',
    async (how) => {
      routing.getRouting.mockImplementation(async () => structuredClone(routed))
      await render([
        row({
          trigger: 'decision',
          decisionBinding: { type: 'shared_bot_routing' },
          decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
        }),
        row({ channelId: 'C2', name: 'ops' })
      ])
      await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
      await click(all('button').find((node) => node.getAttribute('title') === 'Edit By decision rules'))
      await click(document.body.querySelector('button[aria-label="Target for billing"]'))
      await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('review-bot')))
      if (how === 'the scrim') await click(document.body.querySelector('.scrim'))
      else await click(dialog()?.querySelector('.modalhead button[aria-label="Cancel"]'))
      expect(dialog()).toBeNull()
      await click(all('button').filter((node) => node.title.startsWith('Default dispatch'))[0])
      await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
      expect(dialog()?.getAttribute('aria-label')).toBe('ops · By decision rules')
      expect(document.body.querySelector('button[aria-label="Target for billing"]')?.textContent).toContain(
        'deploy-bot'
      )
    }
  )

  it('opens each row on the saved routing, not an edit left from another row', async () => {
    routing.getRouting.mockResolvedValue(detail())
    await render([row(), row({ channelId: 'C2', name: 'ops' })])
    const openFrom = async (index: number) => {
      await click(all('button').filter((node) => node.title.startsWith('Default dispatch'))[index])
      await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
    }
    await openFrom(0)
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Support category')))
    await click(all('button').find((node) => node.textContent?.trim() === 'Cancel'))
    await openFrom(1)
    expect(dialog()?.getAttribute('aria-label')).toBe('ops · By decision rules')
    expect(dialog()?.textContent).not.toContain('also apply to')
    expect(dialog()?.textContent).toContain('Select a decision…')
  })

  it('offers no Retry for a refusal that would fail the same way again', async () => {
    routing.getRouting.mockResolvedValue(detail())
    routing.saveRouting.mockRejectedValue(new ApiError('Enable the channel before adding it to routing.', 400))
    await render([row()])
    await click(document.body.querySelector('button[aria-label="Default dispatch — deploy-bot"]'))
    await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Support category')))
    await click(document.body.querySelector('button[aria-label="Target for billing"]'))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('review-bot')))
    await click(all('button').find((node) => node.textContent?.trim() === 'Save'))
    expect(dialog()?.textContent).toContain("Couldn't save: Enable the channel before adding it to routing.")
    expect(all('button').find((node) => node.textContent?.trim() === 'Retry')).toBeUndefined()
  })

  it('resumes a paused bot from the modal, saving it enabled', async () => {
    routing.getRouting.mockResolvedValue({ ...routed, config: { ...routed.config!, enabled: false } })
    await render([
      row({
        trigger: 'decision',
        decisionBinding: { type: 'shared_bot_routing' },
        decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
      })
    ])
    await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
    await click(all('button').find((node) => node.getAttribute('title') === 'Edit By decision rules'))
    expect(dialog()?.textContent).toContain('Routing paused')
    await click(document.body.querySelector('[aria-label="Routing enabled"]'))
    await click(all('button').find((node) => node.textContent?.trim() === 'Save'))
    expect(routing.saveRouting.mock.calls[0]![1].config.enabled).toBe(true)
  })

  it('reopens the row on its kept draft after an inline Create decision returns', async () => {
    routing.getRouting.mockResolvedValue(detail())
    await render([row()])
    await click(document.body.querySelector('button[aria-label="Default dispatch — deploy-bot"]'))
    await click(all('button').find((node) => node.textContent?.trim() === 'Decision'))
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Support category')))
    await click(document.body.querySelector('button[aria-label="Target for billing"]'))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.includes('review-bot')))
    // Leaving for Create decision unmounts the page without closing the modal; the return URL names the row.
    await act(async () => setShown(false))
    window.history.replaceState(null, '', '/agents/agent-1?decisionRouting=bot-shared%7CC1')
    await act(async () => setShown(true))
    await flush()
    expect(dialog()?.getAttribute('aria-label')).toBe('deploys · By decision rules')
    expect(document.body.querySelector('button[aria-label="Target for billing"]')?.textContent).toContain('review-bot')
    expect(window.location.search).toBe('')
  })

  it('checks no agent while routed, and picking one saves the row out of routing to that agent', async () => {
    routing.getRouting.mockResolvedValue(routed)
    await render([
      row({
        trigger: 'decision',
        decisionBinding: { type: 'shared_bot_routing' },
        decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
      })
    ])
    await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
    expect(dialog()).toBeNull()
    expect(document.body.textContent).toContain('Send every message to')
    expect(all('button[aria-pressed="true"]')).toHaveLength(0)
    await click(all('button[aria-pressed]').find((node) => node.textContent?.includes('review-bot')))
    expect(routing.saveRouting).toHaveBeenCalledWith(
      'bot-shared',
      expect.objectContaining({
        channelIds: ['C9'],
        removals: [{ channelId: 'C1', settings: { trigger: 'mention' }, agentId: 'agent-2' }]
      })
    )
  })

  it('stops a routed row by saving the bot’s routing without it, handed back to @-mentions', async () => {
    routing.getRouting.mockResolvedValue(routed)
    await render([
      row({
        trigger: 'decision',
        decisionBinding: { type: 'shared_bot_routing' },
        decision: { id: 'support-category', name: 'Support category', enabled: true, readiness: { status: 'ready' } }
      })
    ])
    await click(document.body.querySelector('button[aria-label="Dispatch by decision — Support category"]'))
    await click(document.body.querySelector('button[aria-label="Stop using By decision in this channel"]'))
    expect(routing.saveRouting).toHaveBeenCalledWith(
      'bot-shared',
      expect.objectContaining({ channelIds: ['C9'], removals: [{ channelId: 'C1', settings: { trigger: 'mention' } }] })
    )
    expect(routing.refresh).toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })
})

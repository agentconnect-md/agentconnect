// @vitest-environment happy-dom

// The org's Bots list warns before + Decision enables an Off room of an assistant-mode agent, as its agent page does (assistant-mode.md §5.3).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  integrations: [] as unknown[],
  assistantAgents: new Set<string>(),
  gateEntries: [] as { row: { channelId: string }; beforeAdd?: (open: () => void) => void }[]
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
    rowTrigger: (_botId: string | undefined, row: { trigger: string }) => row.trigger,
    entry: (props: (typeof mocks.gateEntries)[number]) => {
      mocks.gateEntries.push(props)
      return <button type="button">Decision</button>
    },
    strip: () => null
  })
}))
vi.mock('@/components/console/decisions/routing/DecisionRoutingModal', () => ({
  stopRouting: vi.fn(),
  readRoutingResume: () => null,
  clearRoutingResume: () => {},
  DecisionRoutingModal: () => null
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => [])
}))

const IntegrationsView = (await import('./IntegrationsView')).default

const WARNING =
  'Everyone here will be able to get the content of this agent’s other places out of it. Enable only if everyone here is fully trusted.'

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

let host: HTMLDivElement
let root: Root

async function expand(): Promise<void> {
  await act(async () => root.render(<IntegrationsView />))
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes('Slack'))
  await act(async () => (tab as HTMLButtonElement).click())
  await act(async () => host.querySelector<HTMLElement>('#integration-bot-solo')!.click())
}

/** Press + Decision on a room: resolves whether its rules opened. */
async function addDecision(channelId: string): Promise<() => boolean> {
  let opened = false
  const entry = mocks.gateEntries.filter((props) => props.row.channelId === channelId).at(-1)!
  await act(async () => entry.beforeAdd!(() => void (opened = true)))
  return () => opened
}

const warning = () =>
  [...document.body.querySelectorAll('[role="dialog"][aria-modal="true"]')].find((node) =>
    node.textContent?.includes(WARNING)
  )
const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [soloBot]
  mocks.integrations = [
    {
      id: 'i1',
      agentId: 'a1',
      botId: 'solo',
      channels: [
        { channelId: 'C1', name: 'help', kind: 'channel', trigger: 'off' },
        { channelId: 'C2', name: 'ops', kind: 'channel', trigger: 'mention' }
      ]
    }
  ]
  mocks.assistantAgents = new Set(['a1'])
  mocks.gateEntries = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the Bots list + Decision on an assistant-mode agent’s room', () => {
  it('warns before enabling an Off room, and opens the rules only once confirmed', async () => {
    await expand()
    const opened = await addDecision('C1')
    expect(warning()?.textContent).toContain('Enable #help?')
    expect(opened()).toBe(false)
    await act(async () => button('Enable')!.click())
    expect(opened()).toBe(true)
    expect(warning()).toBeUndefined()
  })

  it('leaves the room Off when the warning is cancelled', async () => {
    await expand()
    const opened = await addDecision('C1')
    await act(async () => button('Cancel')!.click())
    expect(warning()).toBeUndefined()
    expect(opened()).toBe(false)
  })

  it('opens straight away for a room already on, and outside assistant mode', async () => {
    await expand()
    expect((await addDecision('C2'))()).toBe(true)
    expect(warning()).toBeUndefined()

    mocks.assistantAgents = new Set()
    mocks.gateEntries = []
    await act(async () => root.render(<IntegrationsView />))
    expect((await addDecision('C1'))()).toBe(true)
    expect(warning()).toBeUndefined()
  })
})

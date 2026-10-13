// @vitest-environment happy-dom

// An assistant-mode agent's conversations are enabled like any agent's, and its places keep one session (#2979 B7, assistant-mode.md §5.2).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { conversationGate, type IntegrationChannelRow } from '@/lib/data'

const data = vi.hoisted(() => ({
  setChannelTrigger: vi.fn(async (..._args: unknown[]) => undefined),
  setChannelDecision: vi.fn(async (..._args: unknown[]) => undefined)
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/agent-1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    ...data,
    setChannelSessionMode: vi.fn(),
    setChannelAgent: vi.fn(),
    forgetChannel: vi.fn(),
    leaveConversation: vi.fn(),
    bots: [{ id: 'bot-1', name: 'Support bot', agentIds: ['agent-1'] }],
    agents: [{ id: 'agent-1', name: 'helper', displayName: 'Helper', runtime: 'claude' }],
    integrations: []
  })
}))
const summaries: DecisionSummary[] = createDecisionMockSeed()
  .decisions.slice(0, 2)
  .map((entry) => ({ ...entry, usageCount: 0 }))
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
  return { ...actual, createDecisionApi: () => live }
})

import { IntegrationChannelList } from './IntegrationChannelList'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  data.setChannelTrigger.mockReset().mockResolvedValue(undefined)
  data.setChannelDecision.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

/** An Everyone agent in assistant mode, as the console reads it. */
const ASSISTANT = { visibility: 'org' as const, assistantMode: { enabled: true } }

const room = (over: Partial<IntegrationChannelRow> = {}): IntegrationChannelRow => ({
  channelId: 'C1',
  name: 'general',
  kind: 'channel',
  trigger: 'off',
  ...over
})

async function render(channels: IntegrationChannelRow[]) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <IntegrationChannelList
            integrationId="int-1"
            channels={channels}
            botId="bot-1"
            agentId="agent-1"
            platform="slack"
            gate={conversationGate(ASSISTANT)}
            assistantMode={ASSISTANT.assistantMode.enabled}
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  return container
}

const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

async function pick(name: string, label: string) {
  await click(all('button[aria-haspopup="menu"]').find((node) => node.getAttribute('aria-label')?.includes(name)))
  await click(all('[role="menuitemradio"]').find((node) => node.textContent?.trim() === label))
}

const dialog = () => document.body.querySelector('[role="dialog"][aria-modal="true"]')
const button = (label: string) => all('button').find((node) => node.textContent?.trim() === label)

describe('IntegrationChannelList for an assistant-mode agent', () => {
  it('shows no lock banner, and keeps a room and a Slack DM on one session', async () => {
    await render([room({ trigger: 'mention' }), room({ channelId: 'D1', name: '@alice', kind: 'im', trigger: 'any' })])
    expect(document.body.querySelector('[role="note"]')).toBeNull()
    expect(document.body.textContent).not.toContain('answers only where enabled')
    expect(document.body.querySelector('[aria-label="Settings for general: @-mentions, Single session"]')).toBeTruthy()
    expect(document.body.querySelector('[aria-label="Settings for alice: On, Single session"]')).toBeTruthy()
  })

  it('enables an Off room at once, with no warning', async () => {
    await render([room()])
    await pick('general', '@-mentions')
    expect(dialog()).toBeNull()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')
  })

  it('enables an Off group DM at once, with no warning', async () => {
    await render([room({ channelId: 'G1', name: '@alice, bob', kind: 'mpim' })])
    await pick('alice, bob', 'All messages')
    expect(dialog()).toBeNull()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'G1', 'any')
  })

  it('opens + Decision rules on an Off room at once', async () => {
    await render([room()])
    await click(document.body.querySelector('button[aria-label="Add decision"]'))
    expect(document.body.textContent).not.toContain('fully trusted')
    expect(document.body.querySelector('[aria-label="general · By decision rules"]')).toBeTruthy()
  })

  it('applies a decision to every channel, an Off one included', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await render([
      room({ trigger: 'mention' }),
      room({ channelId: 'C2', name: 'random' }),
      room({ channelId: 'C3', name: 'eng', trigger: 'any' })
    ])
    await click(all('button[aria-label="Add decision"]')[0])
    await click(button('Apply to all channels'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('all 3 channels'))
    expect(data.setChannelDecision.mock.calls.map((call) => call[1])).toEqual(['C1', 'C2', 'C3'])
    vi.unstubAllGlobals()
  })
})

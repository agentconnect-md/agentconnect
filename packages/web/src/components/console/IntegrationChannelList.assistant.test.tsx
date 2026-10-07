// @vitest-environment happy-dom

// Enabling a room or group DM of an assistant-mode agent trusts everyone in it, so it asks first (assistant-mode.md §1.8, §5.3).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import type { IntegrationChannelRow } from '@/lib/data'

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
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  const refuse = async (): Promise<never> => {
    throw new Error('not in this test')
  }
  const live: DecisionApi = {
    mode: 'live',
    listProviders: async () => [],
    listDecisions: async () => [],
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

const WARNING =
  'Everyone here will be able to get the content of this agent’s other places out of it. Enable only if everyone here is fully trusted.'

const room = (over: Partial<IntegrationChannelRow> = {}): IntegrationChannelRow => ({
  channelId: 'C1',
  name: 'general',
  kind: 'channel',
  trigger: 'off',
  ...over
})

async function render(channels: IntegrationChannelRow[], assistantMode = true) {
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
            gate={assistantMode ? 'assistant' : null}
            assistantMode={assistantMode}
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

const warning = () => all('[role="dialog"][aria-modal="true"]').find((node) => node.textContent?.includes(WARNING))
const button = (label: string) => all('button').find((node) => node.textContent?.trim() === label)

describe('IntegrationChannelList assistant-mode places', () => {
  it('asks before enabling an Off room, and writes only once confirmed', async () => {
    await render([room()])
    await pick('general', '@-mentions')
    expect(warning()?.textContent).toContain('Enable #general?')
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
    await click(button('Enable'))
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')
    expect(warning()).toBeUndefined()
  })

  it('keeps the room Off when the warning is cancelled', async () => {
    await render([room()])
    await pick('general', 'All messages')
    expect(warning()).toBeTruthy()
    await click(button('Cancel'))
    expect(warning()).toBeUndefined()
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
  })

  it('asks for a group DM, never for a 1:1 DM', async () => {
    await render([room({ channelId: 'G1', name: '@alice, bob', kind: 'mpim' })])
    await pick('alice, bob', '@-mentions')
    expect(warning()?.textContent).toContain('Enable alice, bob?')
    await click(button('Cancel'))

    await act(async () => root?.unmount())
    root = undefined
    await render([room({ channelId: 'D1', name: '@alice', kind: 'im' })])
    await pick('alice', 'On')
    expect(warning()).toBeUndefined()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'D1', 'any')
  })

  it('asks before + Decision opens its rules on an Off room', async () => {
    await render([room()])
    await click(document.body.querySelector('button[aria-label="Add decision"]'))
    expect(warning()).toBeTruthy()
    expect(document.body.querySelector('[aria-label="general · By decision rules"]')).toBeNull()
    await click(button('Enable'))
    expect(document.body.querySelector('[aria-label="general · By decision rules"]')).toBeTruthy()
  })

  it('enables straight away outside assistant mode, and when the room is already on', async () => {
    await render([room()], false)
    await pick('general', '@-mentions')
    expect(warning()).toBeUndefined()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')

    await act(async () => root?.unmount())
    root = undefined
    data.setChannelTrigger.mockClear()
    await render([room({ trigger: 'mention' })])
    await pick('general', 'All messages')
    expect(warning()).toBeUndefined()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'any')
  })
})

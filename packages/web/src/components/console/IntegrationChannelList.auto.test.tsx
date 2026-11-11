// @vitest-environment happy-dom

// Auto in a conversation's settings (auto-session-mode.md §3.3, §11): a session mode offered where the daemon reads it, under which only Off is asked.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_MODE_AUTO_V1_FEATURE } from '@agentconnect.md/protocol'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import type { IntegrationChannelRow } from '@/lib/data'
import { SESSION_MODE_AUTO_FEATURE } from '@/lib/session-mode'

const data = vi.hoisted(() => ({
  setChannelTrigger: vi.fn(async (..._args: unknown[]) => undefined),
  setChannelSessionMode: vi.fn(async (..._args: unknown[]) => undefined),
  features: [] as string[],
  coordinatorDisabled: false
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
    setChannelTrigger: data.setChannelTrigger,
    setChannelSessionMode: data.setChannelSessionMode,
    setChannelDecision: vi.fn(),
    setChannelAgent: vi.fn(),
    forgetChannel: vi.fn(),
    leaveConversation: vi.fn(),
    bots: [{ id: 'bot-1', name: 'Support bot', agentIds: ['agent-1'] }],
    agents: [
      {
        id: 'agent-1',
        name: 'helper',
        displayName: 'Helper',
        runtime: 'claude',
        daemon: 'daemon-1',
        coordinatorDisabled: data.coordinatorDisabled
      }
    ],
    daemons: [
      { daemonId: 'daemon-1', pool: false, status: 'online', caps: { features: data.features, platforms: ['slack'] } }
    ],
    memberSets: [],
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
  data.setChannelSessionMode.mockReset().mockResolvedValue(undefined)
  data.features.splice(0, data.features.length, SESSION_MODE_AUTO_FEATURE)
  data.coordinatorDisabled = false
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const room = (over: Partial<IntegrationChannelRow> = {}): IntegrationChannelRow => ({
  channelId: 'C1',
  name: 'general',
  kind: 'channel',
  trigger: 'mention',
  ...over
})

async function render(channels: IntegrationChannelRow[], assistantMode = false) {
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
            assistantMode={assistantMode}
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
}

const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

const settings = (label: string) => document.body.querySelector(`button[aria-label="${label}"]`)
const options = () => all('[role="menuitemradio"]').map((node) => node.textContent?.trim())
const option = (label: string) => all('[role="menuitemradio"]').find((node) => node.textContent?.trim() === label)

describe('Auto in a conversation’s settings', () => {
  it('names the same capability the daemon advertises', () => {
    expect(SESSION_MODE_AUTO_FEATURE).toBe(SESSION_MODE_AUTO_V1_FEATURE)
  })

  it('leads with the session mode, offers Auto beside Per thread and Single session where the daemon reads it, and saves it', async () => {
    await render([room()])
    await click(settings('Settings for general: Per thread, @-mentions'))
    expect(options()).toEqual(['Per thread', 'Single session', 'Auto', '@-mentions', 'All messages', 'Off'])
    await click(option('Auto'))
    expect(data.setChannelSessionMode).toHaveBeenCalledWith('int-1', 'C1', 'auto')
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
  })

  it('offers no Auto where the daemon does not read it', async () => {
    data.features.splice(0, data.features.length)
    await render([room()])
    await click(settings('Settings for general: Per thread, @-mentions'))
    expect(options()).not.toContain('Auto')
  })

  // auto-session-mode.md §3.6: with the coordinator off an Auto row reads as Single session and Auto is offered nowhere.
  it('shows an Auto row as Single session with the coordinator off, offers no Auto, and keeps its stored mode', async () => {
    data.coordinatorDisabled = true
    await render([room({ sessionMode: 'auto', trigger: 'mention' }), room({ channelId: 'C2', name: 'random' })])
    await click(settings('Settings for general: Single session, @-mentions'))
    expect(options()).toEqual(['Per thread', 'Single session', '@-mentions', 'All messages', 'Off'])
    await click(option('Single session'))
    expect(data.setChannelSessionMode).not.toHaveBeenCalled()
    await click(settings('Settings for random: Per thread, @-mentions'))
    expect(options()).not.toContain('Auto')
  })

  it('offers no Auto on a DM, whose only reply choice is On', async () => {
    await render([room({ channelId: 'D1', name: '@alice', kind: 'im', trigger: 'any' })])
    await click(settings('Settings for alice: Per thread'))
    expect(options()).toEqual(['Per thread', 'Single session', 'Off'])
  })

  it('asks nothing about replies under Auto, which decides them, and keeps Off', async () => {
    await render([room({ sessionMode: 'auto', trigger: 'any' })])
    await click(settings('Settings for general: Auto'))
    expect(options()).toEqual(['Per thread', 'Single session', 'Auto', 'Off'])
    expect(document.body.textContent).not.toContain('Respond to')
    await click(option('Off'))
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'off')
  })

  it('turns an Off Auto row back on by picking Auto, keeping its stored mode', async () => {
    await render([room({ sessionMode: 'auto', trigger: 'off' })])
    await click(settings('Settings for general: Off'))
    expect(options()).toEqual(['Per thread', 'Single session', 'Auto', 'Off'])
    await click(option('Auto'))
    expect(data.setChannelSessionMode).not.toHaveBeenCalled()
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')
  })

  it('turns an Off row on in the picked mode, the mode saved before replies resume', async () => {
    const order: string[] = []
    data.setChannelSessionMode.mockImplementation(async () => void order.push('session'))
    data.setChannelTrigger.mockImplementation(async () => void order.push('trigger'))
    await render([room({ trigger: 'off' })])
    await click(settings('Settings for general: Off'))
    await click(option('Single session'))
    expect(data.setChannelSessionMode).toHaveBeenCalledWith('int-1', 'C1', 'append')
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')
    expect(order).toEqual(['session', 'trigger'])
  })

  it('leaves Auto for Per thread with the session mode alone', async () => {
    await render([room({ sessionMode: 'auto', trigger: 'any' })])
    await click(settings('Settings for general: Auto'))
    await click(option('Per thread'))
    expect(data.setChannelSessionMode).toHaveBeenCalledWith('int-1', 'C1', 'createNew')
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
  })

  it('keeps an Auto row listed as Auto after its daemon stops reading it', async () => {
    data.features.splice(0, data.features.length)
    await render([room({ sessionMode: 'auto' })])
    expect(settings('Settings for general: Auto')).toBeTruthy()
  })

  it('starts no decision on an Auto row', async () => {
    await render([room({ sessionMode: 'auto' }), room({ channelId: 'C2', name: 'random' })])
    expect(all('button[aria-label="Add decision"]')).toHaveLength(1)
  })

  it('runs an assistant-mode place on its coordinator where the daemon reads Auto', async () => {
    await render([room({ sessionMode: 'createNew' })], true)
    await click(settings('Settings for general: Auto'))
    expect(options()).toEqual(['Auto', 'Off'])
  })

  it('keeps an assistant-mode place on one session where the daemon does not', async () => {
    data.features.splice(0, data.features.length)
    await render([room({ sessionMode: 'createNew' })], true)
    expect(settings('Settings for general: Single session, @-mentions')).toBeTruthy()
  })
})

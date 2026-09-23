// @vitest-environment happy-dom

// A conversation's By decision binding against the live channel DTO: offered where the CP accepts it, saved atomically, and its status shown.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionApi, DecisionSummary } from '@agentconnect.md/protocol/decision-api'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { ApiError, type ChannelDecisionView } from '@/lib/api'
import type { IntegrationChannelRow } from '@/lib/data'

const env = vi.hoisted(() => ({ mock: false, flag: true }))
const data = vi.hoisted(() => ({
  setChannelTrigger: vi.fn(async () => undefined),
  setChannelDecision: vi.fn(async () => undefined)
}))

vi.mock('@/lib/data', async (original) => ({
  ...(await original<object>()),
  get MOCK_MODE() {
    return env.mock
  }
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => env.flag }))
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
    bots: [
      { id: 'bot-1', name: 'Support bot', agentIds: ['agent-1'] },
      { id: 'bot-shared', name: 'Shared bot', agentIds: ['agent-1'] }
    ],
    agents: [
      { id: 'agent-1', name: 'billing', displayName: 'Billing', runtime: 'claude' },
      { id: 'agent-2', name: 'tech', displayName: 'Technical', runtime: 'codex' }
    ],
    integrations: []
  })
}))
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
    getRouting: refuse,
    saveRouting: refuse,
    preview: refuse
  }
  return { ...actual, createDecisionApi: () => live }
})

import { IntegrationChannelList } from './IntegrationChannelList'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  env.mock = false
  env.flag = true
  data.setChannelTrigger.mockReset().mockResolvedValue(undefined)
  data.setChannelDecision.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const CHOICE_WHEN = { type: 'choice' as const, thresholds: { billing: 0.5, technical: 0.5, sales: 0.5 } }
const CHOICE_SUMMARY = 'billing ≥ 50%, technical ≥ 50%, sales ≥ 50%'

const group = (over: Partial<IntegrationChannelRow> = {}): IntegrationChannelRow => ({
  channelId: 'C1',
  name: 'general',
  kind: 'channel',
  trigger: 'mention',
  ...over
})

const gated = (decision: Partial<ChannelDecisionView> = {}): IntegrationChannelRow =>
  group({
    trigger: 'decision',
    decisionBinding: { type: 'gate', decisionId: 'support-category', when: CHOICE_WHEN },
    decision: {
      id: 'support-category',
      name: 'Support category',
      enabled: true,
      readiness: { status: 'ready' },
      ...decision
    }
  })

async function render(
  channels: IntegrationChannelRow[],
  props: { platform?: string; shareable?: boolean; botId?: string } = {}
) {
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
            botId={props.botId ?? 'bot-1'}
            agentId="agent-1"
            platform={props.platform ?? 'slack'}
            shareable={props.shareable}
          />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const byText = (text: string) => all('button, span, a, b, label, p').find((node) => node.textContent?.trim() === text)

async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** Open the row's settings popover and read (or pick) its trigger options. */
async function openSettings(name = 'general') {
  await click(all('button[aria-haspopup="menu"]').find((node) => node.getAttribute('aria-label')?.includes(name)))
  return all('[role="menuitemradio"]').map((node) => node.textContent?.trim())
}

async function pick(label: string) {
  await click(all('[role="menuitemradio"]').find((node) => node.textContent?.trim() === label))
  await act(async () => {})
}

describe('IntegrationChannelList By decision', () => {
  it('offers By decision on a single-owner group row only where the flag and platform allow it', async () => {
    await render([group()])
    expect(await openSettings()).toContain('By decision')
  })

  it.each([
    ['a direct conversation', [group({ kind: 'im', name: '@Alice', trigger: 'any' })], {}, 'Alice'],
    ['a shared bot', [group()], { shareable: true, botId: 'bot-shared' }, 'general'],
    ['a platform whose triggers omit it', [group()], { platform: 'linear' }, 'general']
  ])('withholds By decision on %s', async (_, channels, props, name) => {
    await render(channels, props)
    expect(await openSettings(name)).not.toContain('By decision')
  })

  it('withholds By decision while the flag is off', async () => {
    env.flag = false
    await render([group()])
    expect(await openSettings()).not.toContain('By decision')
  })

  it('renders a saved DTO gate collapsed, naming its decision, condition and target, with no banner when ready', async () => {
    await render([gated()])
    expect(byText('Support category')).toBeTruthy()
    expect(byText(CHOICE_SUMMARY)).toBeTruthy()
    expect(byText('Activates Billing')).toBeTruthy()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
    expect(byText('Trigger when')).toBeUndefined()
  })

  it.each([
    [{ readiness: { status: 'pending_sync' as const } }, 'Pending sync', 'Saved, not applied yet.'],
    [
      { readiness: { status: 'daemon_offline' as const } },
      'Daemon offline',
      'No daemon serving this agent is connected.'
    ],
    [
      { readiness: { status: 'unsupported' as const } },
      'Unsupported',
      'The daemon or relay serving this conversation is too old'
    ],
    [
      { enabled: false, disabledReason: 'access_revoked' as const, readiness: { status: 'ready' as const } },
      'Access revoked',
      'This agent can no longer use the saved decision'
    ]
  ])('shows the %o status with its message', async (decision, badge, body) => {
    await render([gated(decision)])
    expect(byText(badge)).toBeTruthy()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(body)
  })

  it('links a Needs review gate to its decision and reopens the saved condition for repair', async () => {
    await render([gated({ enabled: false, disabledReason: 'needs_review', readiness: { status: 'needs_review' } })])
    expect(byText('Needs review')).toBeTruthy()
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Support category changed')
    expect(byText('Open decision')?.getAttribute('href')).toBe('/decisions/support-category')
    await click(byText('Repair condition'))
    expect(byText('Trigger when')).toBeTruthy()
    expect(data.setChannelDecision).not.toHaveBeenCalled()
  })

  it('restarts a Needs review condition of another question type from the decision default', async () => {
    const row = gated({ enabled: false, disabledReason: 'needs_review', readiness: { status: 'needs_review' } })
    await render([
      {
        ...row,
        decisionBinding: { type: 'gate', decisionId: 'support-category', when: { type: 'boolean', values: [true] } }
      }
    ])
    await click(byText('Repair condition'))
    expect(document.body.querySelector('input[aria-label="Minimum probability for billing"]')).toBeTruthy()
    expect(byText('Condition type must match the question.')).toBeUndefined()
    await click(byText('Save'))
    expect(data.setChannelDecision).toHaveBeenCalledWith('int-1', 'C1', {
      type: 'gate',
      decisionId: 'support-category',
      when: CHOICE_WHEN
    })
  })

  it('lets a revoked gate choose another decision without picking one for the user', async () => {
    await render([gated({ enabled: false, disabledReason: 'access_revoked' })])
    await click(all('button').find((node) => node.textContent?.trim() === 'Choose another decision'))
    await act(async () => {})
    // The editor waits on the placeholder with Save off until a decision is chosen.
    expect(byText('Select a decision…')).toBeTruthy()
    expect(byText('Trigger when')).toBeUndefined()
    expect(byText('Save')?.closest('button')?.disabled).toBe(true)
    await click(all('button[aria-haspopup="menu"]').find((node) => node.textContent?.includes('Select a decision…')))
    await click(all('[role="menuitemradio"]').find((node) => node.textContent?.startsWith('Needs a response')))
    expect(byText('Trigger when')).toBeTruthy()
    expect(byText('Save')?.closest('button')?.disabled).toBe(false)
    expect(data.setChannelDecision).not.toHaveBeenCalled()
  })

  it('returns focus to the collapsed strip Edit after Cancel', async () => {
    await render([gated()])
    await click(byText('Edit'))
    await click(byText('Cancel'))
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(document.activeElement).toBe(byText('Edit'))
  })

  it('saves the pick as one trigger-and-gate PATCH and refuses a second submission while it runs', async () => {
    let finish: () => void = () => undefined
    data.setChannelDecision.mockImplementation(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined)))
    )
    await render([group()])
    await openSettings()
    await pick('By decision')
    expect(byText('Support category')).toBeTruthy()
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
    await click(byText('Save'))
    expect(byText('Saving…')).toBeTruthy()
    await click(byText('Saving…'))
    expect(data.setChannelDecision).toHaveBeenCalledTimes(1)
    expect(data.setChannelDecision).toHaveBeenCalledWith('int-1', 'C1', {
      type: 'gate',
      decisionId: 'support-category',
      when: CHOICE_WHEN
    })
    await act(async () => finish())
    expect(byText('Trigger when')).toBeUndefined()
  })

  it('keeps the draft and shows the server field issue when the condition is refused', async () => {
    data.setChannelDecision.mockRejectedValue(
      new ApiError('The condition does not match the Decision question', 400, undefined, {
        issues: [{ path: ['thresholds', 'billing'], message: 'Server rejects billing.' }]
      })
    )
    await render([group()])
    await openSettings()
    await pick('By decision')
    await click(byText('Save'))
    expect(byText("The condition doesn't fit this decision. Fix the highlighted field and save again.")).toBeTruthy()
    expect(byText('Server rejects billing.')).toBeTruthy()
    expect(byText('Trigger when')).toBeTruthy()
    expect(byText('Retry')).toBeUndefined()
  })

  it('says the decision is not available when it vanished', async () => {
    data.setChannelDecision.mockRejectedValue(new ApiError('decision not found', 404, 'DECISION_NOT_FOUND'))
    await render([group()])
    await openSettings()
    await pick('By decision')
    await click(byText('Save'))
    expect(
      byText('Decision not available. It was deleted or is no longer shared with you — choose another.')
    ).toBeTruthy()
    expect(byText('Trigger when')).toBeTruthy()
  })

  it('explains an unsupported consumer and retries the identical gate', async () => {
    data.setChannelDecision.mockRejectedValueOnce(new ApiError('upgrade', 409, 'DECISION_UNSUPPORTED_CONSUMER'))
    await render([group()])
    await openSettings()
    await pick('By decision')
    await click(byText('Save'))
    expect(
      byText("The daemon or relay serving this conversation doesn't support By decision yet. Upgrade it, then retry.")
    ).toBeTruthy()
    await click(byText('Retry'))
    expect(data.setChannelDecision).toHaveBeenCalledTimes(2)
    expect(data.setChannelDecision.mock.calls[1]).toEqual(data.setChannelDecision.mock.calls[0])
    expect(byText('Trigger when')).toBeUndefined()
  })

  it('cancels a fresh pick without a PATCH and an edit back to the saved summary', async () => {
    await render([group()])
    await openSettings()
    await pick('By decision')
    await click(byText('Cancel'))
    expect(byText('Trigger when')).toBeUndefined()
    expect(byText('Support category')).toBeUndefined()
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
    expect(data.setChannelDecision).not.toHaveBeenCalled()
    await act(async () => root?.unmount())
    root = undefined

    await render([gated()])
    await click(byText('Edit'))
    expect(byText('Trigger when')).toBeTruthy()
    await click(byText('Cancel'))
    expect(byText(CHOICE_SUMMARY)).toBeTruthy()
    expect(byText('Trigger when')).toBeUndefined()
  })

  it('switches a saved gate back to @-mentions with the ordinary trigger PATCH', async () => {
    await render([gated()])
    await openSettings()
    await pick('@-mentions')
    expect(data.setChannelTrigger).toHaveBeenCalledWith('int-1', 'C1', 'mention')
    expect(data.setChannelDecision).not.toHaveBeenCalled()
  })

  it('points a shared-bot routed conversation at its bot routing instead of an editor', async () => {
    await render([group({ trigger: 'decision', decisionBinding: { type: 'shared_bot_routing' }, decision: null })], {
      shareable: true,
      botId: 'bot-shared'
    })
    const link = byText('Managed by Shared bot routing')
    expect(link?.getAttribute('href')).toBe('/integrations?bot=bot-shared')
    expect(byText('Trigger when')).toBeUndefined()
  })

  it('keeps mock mode on local prototype gates', async () => {
    env.mock = true
    await render([group()])
    await openSettings()
    await pick('By decision')
    await click(byText('Save'))
    expect(byText(CHOICE_SUMMARY)).toBeTruthy()
    expect(data.setChannelDecision).not.toHaveBeenCalled()
    expect(data.setChannelTrigger).not.toHaveBeenCalled()
  })
})

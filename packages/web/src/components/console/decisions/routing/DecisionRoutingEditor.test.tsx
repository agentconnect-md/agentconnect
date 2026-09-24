// @vitest-environment happy-dom

// The Routing editor on its page: saved state, rule edits with inline errors, scope changes, Save/Cancel/Retry, and cards.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider, useDecisionsPrototype } from '@/lib/decisions/provider'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

const role = vi.hoisted(() => ({ current: 'owner' as 'owner' | 'viewer' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ botId: 'support-bot' }),
  usePathname: () => '/integrations/bots/support-bot/routing',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: role.current, orgPath: (path: string) => path })
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

import BotRoutingView from '../../views/BotRoutingView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  role.current = 'owner'
  vi.restoreAllMocks()
})

let probe: ReturnType<typeof useDecisionsPrototype> | null = null
function Probe() {
  probe = useDecisionsPrototype()
  return null
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}

async function render(api: DecisionApi, extra?: ReactNode) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <Probe />
          <BotRoutingView />
          {extra}
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await settle()
  return container
}

async function remount(api: DecisionApi) {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  return render(api)
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text
  )
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}
async function choose(select: HTMLSelectElement | null, value: string) {
  if (!select) throw new Error('no select')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
const rules = (view: ParentNode) => [...view.querySelectorAll<HTMLElement>('[data-testid="routing-rule"]')]
const checkbox = (view: ParentNode, name: string) =>
  [...view.querySelectorAll<HTMLLabelElement>('label')]
    .find((label) => label.textContent?.includes(name))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
const save = (view: ParentNode) => button(view, 'Save') as HTMLButtonElement | undefined

describe('DecisionRoutingEditor', () => {
  it('opens the saved configuration with its rules, scope, and Off channel', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    expect(view.textContent).toContain('Support bot')
    expect(view.textContent).toContain('Support category')
    expect(rules(view)).toHaveLength(3)
    expect(checkbox(view, '#help')?.checked).toBe(true)
    const off = checkbox(view, '#announcements')!
    expect(off.disabled).toBe(true)
    expect(view.textContent).toContain('Enable in channel settings')
    expect(view.querySelector<HTMLSelectElement>('select[aria-label="Otherwise"]')?.value).toBe('skip')
    expect(save(view)?.disabled).toBe(true)
  })

  it('saves the complete configuration with its scope change and reopens the saved state', async () => {
    const api = decisionMock.createDecisionMockApi()
    const saveRouting = vi.spyOn(api, 'saveRouting')
    const view = await render(api)
    await click(checkbox(view, '#questions'))
    await choose(view.querySelector('select[aria-label="Otherwise"]'), 'default_agent')
    expect(view.querySelector('[data-testid="routing-otherwise-defaults"]')?.textContent).toContain('#help: Billing')
    expect(view.textContent).toContain('Unsaved changes')
    await click(save(view))
    expect(saveRouting).toHaveBeenCalledWith('support-bot', {
      config: expect.objectContaining({ otherwise: { type: 'default_agent' }, rules: expect.any(Array) }),
      channelIds: ['help-channel', 'new-channel'],
      removals: []
    })
    expect(saveRouting.mock.calls[0]![1].config.rules).toHaveLength(3)
    expect(view.textContent).toContain('Saved')
    const reopened = await remount(api)
    expect(checkbox(reopened, '#questions')?.checked).toBe(true)
    expect(reopened.querySelector<HTMLSelectElement>('select[aria-label="Otherwise"]')?.value).toBe('default_agent')
  })

  it('Cancel restores the saved configuration', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    await click(button(view, 'Remove rule 1'))
    expect(rules(view)).toHaveLength(2)
    await click(button(view, 'Cancel'))
    expect(rules(view)).toHaveLength(3)
    expect(save(view)?.disabled).toBe(true)
  })

  it('requires replacement settings inline before a channel can leave routing', async () => {
    const api = decisionMock.createDecisionMockApi()
    const saveRouting = vi.spyOn(api, 'saveRouting')
    const view = await render(api)
    await click(checkbox(view, '#help'))
    const removal = view.querySelector('[data-testid="routing-removal"]')!
    expect(removal.textContent).toContain('Replace routing in #help')
    expect(view.textContent).toContain('Choose what #help uses instead.')
    expect(save(view)?.disabled).toBe(true)
    await choose(removal.querySelectorAll('select')[0] as HTMLSelectElement, 'mention')
    expect(save(view)?.disabled).toBe(false)
    await click(save(view))
    expect(saveRouting.mock.calls[0]![1]).toMatchObject({
      channelIds: [],
      removals: [{ channelId: 'help-channel', settings: { trigger: 'mention' } }]
    })
  })

  it('keeps a failed save and retries the same configuration', async () => {
    let fail = true
    const api = decisionMock.createDecisionMockApi({
      beforeSave: () => {
        if (fail) throw new decisionMock.DecisionMockApiError(500, { error: 'unavailable', message: 'Database busy' })
      }
    })
    const saveRouting = vi.spyOn(api, 'saveRouting')
    const view = await render(api)
    await click(button(view, 'Remove rule 3'))
    await click(save(view))
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Database busy')
    expect(rules(view)).toHaveLength(2)
    fail = false
    await click(button(view, 'Retry'))
    expect(saveRouting).toHaveBeenCalledTimes(2)
    expect(saveRouting.mock.calls[1]![1]).toEqual(saveRouting.mock.calls[0]![1])
    expect(view.textContent).toContain('Saved')
  })

  it('returns an inline-created Decision to the routing draft', async () => {
    const api = decisionMock.createDecisionMockApi()
    const view = await render(api)
    const created = await api.createDecision({
      name: 'Tone',
      providerId: 'typesafe',
      model: 'jev-1.13.0',
      question: { type: 'boolean', instructions: 'Angry?', criteria: { true: 'Yes', false: 'No' } }
    })
    await act(async () => probe!.beginInlineCreate({ kind: 'routing', botId: 'support-bot' }))
    await act(async () => probe!.completeInlineCreate(created))
    await settle()
    const state = probe!.routingDrafts[probe!.routingKeyFor('support-bot')]!
    expect(state.draft!.decisionId).toBe(created.id)
    // The Choice rules stay for repair against the new Boolean question; nothing is reselected.
    expect(state.draft!.rules).toHaveLength(3)
    expect(view.textContent).toContain("The Decision's question type differs")
  })

  it('marks both overlapping Score rows, shows gaps, and disables Save', async () => {
    const seed = createDecisionMockSeed()
    seed.routings[0]!.config = {
      enabled: true,
      decisionId: 'frustration',
      rules: [
        { id: 'high', when: { type: 'score', min: 2, max: 3 }, action: { type: 'agent', agentId: 'sales-agent' } },
        { id: 'low', when: { type: 'score', min: 0, max: 1 }, action: { type: 'skip' } }
      ],
      otherwise: { type: 'skip' }
    }
    const view = await render(decisionMock.createDecisionMockApi({ seed }))
    // Sorted by lower bound: the [0, 1) row reads first.
    expect(rules(view)[0]!.textContent).toContain('0 ≤ score < 1')
    expect(view.textContent).toContain('1 ≤ score < 2 uses Otherwise')
    await click(button(view, 'Add rule'))
    expect(save(view)?.disabled).toBe(true)
    const inputs = rules(view)[1]!.querySelectorAll<HTMLInputElement>('input[aria-label="Interval end"]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(inputs[0]!, '2.5')
      inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    const overlapping = rules(view).filter((row) => row.textContent?.includes('Score intervals must not overlap.'))
    expect(overlapping).toHaveLength(2)
    expect(save(view)?.disabled).toBe(true)
  })

  it('keeps a removed target as Target removed and requires a replacement', async () => {
    const seed = createDecisionMockSeed()
    seed.routings[0]!.config.rules[2]!.action = { type: 'agent', agentId: 'departed-agent' }
    const view = await render(decisionMock.createDecisionMockApi({ seed }))
    const row = rules(view)[2]!
    expect(row.textContent).toContain('Target removed')
    expect(row.textContent).toContain('no longer connected to the bot')
    await click(button(view, 'Remove rule 1'))
    expect(save(view)?.disabled).toBe(true)
  })

  it('keeps an unavailable target selected and refreshes the roster on Refresh', async () => {
    const seed = createDecisionMockSeed()
    seed.bots[0]!.agents[0]!.available = false
    const api = decisionMock.createDecisionMockApi({ seed })
    const view = await render(api)
    const row = rules(view)[0]!
    expect(row.textContent).toContain('Target unavailable')
    const listBots = vi.spyOn(api, 'listBots')
    await click(button(row, 'Refresh'))
    expect(listBots).toHaveBeenCalled()
    expect(save(view)?.disabled).toBe(true)
  })

  it('renders rules as one responsive tree: cards below the desktop breakpoint, a grid above it', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    const row = rules(view)[0]!
    expect(row.className).toContain('grid-cols-1')
    expect(row.className).toContain('desktop:grid-cols-[36px_minmax(0,1.3fr)_minmax(0,1fr)_32px]')
    const removes = [...row.querySelectorAll('button[aria-label="Remove rule 1"]')]
    expect(
      removes.map(
        (node) => node.className.includes('desktop:hidden') || node.parentElement!.className.includes('desktop:flex')
      )
    ).toEqual([true, true])
  })

  it('reads without editing controls for a viewer', async () => {
    role.current = 'viewer'
    const view = await render(decisionMock.createDecisionMockApi())
    expect(view.textContent).toContain('your role cannot change it')
    expect(save(view)).toBeUndefined()
    expect(button(view, 'Test routing')).toBeUndefined()
    expect(checkbox(view, '#help')?.disabled).toBe(true)
  })
})

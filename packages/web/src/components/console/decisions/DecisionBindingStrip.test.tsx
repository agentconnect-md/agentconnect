// @vitest-environment happy-dom

// The `By decision` strip in mock mode: it opens a picked row on a usable draft and collapses to a summary once saved.

import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionProvider from '@/lib/decisions/provider'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'

const { DecisionsPrototypeProvider, useDecisionsPrototype } = decisionProvider
let store: ReturnType<typeof useDecisionsPrototype>

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import { DecisionBindingStrip } from './DecisionBindingStrip'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

/** The row's side of the contract in mock mode: a pick opens a draft, and the provider's gate is the saved state. */
function MockStrip({
  bindingKey,
  canWrite = true,
  agentName = 'Billing'
}: {
  bindingKey: string
  canWrite?: boolean
  agentName?: string
}) {
  store = useDecisionsPrototype()
  const { gates, bindingDrafts, setBindingDraft, setGate } = store
  useEffect(() => {
    setBindingDraft(bindingKey, (current) => current ?? { decisionId: null, when: null, phase: 'editing' })
  }, [bindingKey, setBindingDraft])
  const gate = gates[bindingKey]
  if (!bindingDrafts[bindingKey] && !gate) return <span>reverted</span>
  return (
    <DecisionBindingStrip
      bindingKey={bindingKey}
      canWrite={canWrite}
      agentName={agentName}
      padX={18}
      saved={gate ? { decisionId: gate.decisionId, when: gate.when } : null}
      status={gate ? (gate.needsReview ? 'needs_review' : 'ready') : null}
      onSave={async (next) =>
        setGate(bindingKey, { decisionId: next.decisionId, when: next.when, channelName: '#help', needsReview: false })
      }
    />
  )
}

async function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>{node}</DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  // The mock's reads are promises: one more flush lands the decision list.
  await act(async () => {})
  return container
}

const findByText = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button, span, a, b, label')].find((node) => node.textContent?.trim() === text)

/** React tracks a controlled field's value, so a bare assignment is swallowed; set it natively. */
async function typeInto(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error('no field to type into')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickText = async (scope: HTMLElement, text: string) => {
  const node = findByText(scope, text)
  if (!node) throw new Error(`nothing reading "${text}"`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const CHOICE_SUMMARY = 'billing ≥ 50%, technical ≥ 50%, sales ≥ 50%'

describe('DecisionBindingStrip', () => {
  it('opens the editor on the first decision with its answer keys enabled', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    expect(findByText(view, 'Support category')).toBeTruthy()
    expect(findByText(view, 'Trigger when')).toBeTruthy()
    expect(findByText(view, 'Activates')).toBeTruthy()
    expect(view.querySelector('input[aria-label="Minimum probability for billing"]')).toBeTruthy()
    expect(view.querySelector('input[aria-label="Minimum probability for technical"]')).toBeTruthy()
  })

  it('saves the gate and collapses to a summary that names the decision, its condition, and its target', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    await clickText(view, 'Save')
    expect(findByText(view, 'Support category')).toBeTruthy()
    expect(findByText(view, CHOICE_SUMMARY)).toBeTruthy()
    expect(findByText(view, 'Activates Billing')).toBeTruthy()
    expect(findByText(view, 'Edit')).toBeTruthy()
    // The editor is gone: no minimum-probability control survives the save.
    expect(view.querySelector('input[aria-label="Minimum probability for billing"]')).toBeNull()
  })

  it('lands keyboard focus on the collapsed Edit once a save closes the editor', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    await clickText(view, 'Save')
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(document.activeElement).toBe(findByText(view, 'Edit'))
  })

  it('reverts the row when a fresh gate is abandoned, and keeps the saved one when an edit is', async () => {
    const view = await render(
      <>
        <MockStrip bindingKey="org-test|support-bot|#help" />
        <div id="saved">
          <MockStrip bindingKey="org-test|support-bot|#ops" />
        </div>
      </>
    )
    const fresh = view.firstElementChild as HTMLElement
    await clickText(fresh, 'Cancel')
    expect(findByText(view, 'reverted')).toBeTruthy()

    const saved = view.querySelector<HTMLElement>('#saved')!
    await clickText(saved, 'Save')
    await clickText(saved, 'Edit')
    expect(findByText(saved, 'Trigger when')).toBeTruthy()
    await clickText(saved, 'Cancel')
    expect(findByText(saved, CHOICE_SUMMARY)).toBeTruthy()
    expect(findByText(saved, 'reverted')).toBeUndefined()
  })

  it('offers no editor controls without write permission', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" canWrite={false} />)
    expect(findByText(view, 'Save')).toBeUndefined()
    expect(findByText(view, 'Cancel')).toBeUndefined()
  })

  // Two bots can share one Slack channel id: saving A's gate must not reach B's row.
  it('keeps two bots’ gates in one conversation apart', async () => {
    const view = await render(
      <>
        <MockStrip bindingKey="org-test|bot-a|C123" />
        <MockStrip bindingKey="org-test|bot-b|C123" agentName="Technical" />
      </>
    )
    const saves = () => [...view.querySelectorAll('button')].filter((node) => node.textContent?.trim() === 'Save')
    expect(saves()).toHaveLength(2)

    await act(async () => {
      saves()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Bot A collapsed to its summary; bot B's editor is untouched.
    expect(saves()).toHaveLength(1)
    expect(
      [...view.querySelectorAll('span')].filter((node) => node.textContent?.trim() === CHOICE_SUMMARY)
    ).toHaveLength(1)
    expect(view.querySelectorAll('input[aria-label="Minimum probability for billing"]')).toHaveLength(1)
  })

  // The verdict is its own block, so a reader who collapses the disclosure keeps the result.
  it('keeps the preview verdict after collapsing Try a message', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    // The daemon catalog is a second read; wait for it or Try stays inert.
    await act(async () => {})
    await act(async () => {})

    await clickText(view, 'Try a message')
    await typeInto(view.querySelector('input[aria-label="Try a message"]'), 'Can someone ship the hotfix?')
    await clickText(view, 'Try')
    await act(async () => {})

    // Every fixture probability (0.4/0.4/0.2) sits below the canonical 50% minimum.
    expect(findByText(view, 'Skipped')).toBeTruthy()

    await clickText(view, 'Try a message')
    expect(view.querySelector('input[aria-label="Try a message"]')).toBeNull()
    expect(findByText(view, 'Skipped')).toBeTruthy()
  })

  // Inline Create returns to this draft with the new Decision selected.
  it('hands an inline-created decision back to the draft that opened Add decision', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    await act(async () => {
      document.body
        .querySelector('button[aria-haspopup="menu"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const create = [...document.body.querySelectorAll('a')].find((node) => node.textContent?.trim() === 'Add decision')
    expect(create?.getAttribute('href')).toBe('/decisions/new?returnTo=%2Fagents%2Fa1')
    create?.addEventListener('click', (event) => event.preventDefault())
    await act(async () => {
      create?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const created = await store.api.createDecision({
      name: 'Escalation',
      providerId: 'typesafe',
      model: 'jev-1.13.0',
      question: {
        type: 'boolean',
        instructions: 'Does this need a human?',
        criteria: { true: 'A human should answer.', false: 'The agent can answer.' }
      }
    })
    await act(async () => {
      store.completeInlineCreate(created)
      await store.reload()
    })
    expect(findByText(view, 'Escalation')).toBeTruthy()
    expect(view.querySelector('input[aria-label="Minimum probability for billing"]')).toBeNull()
  })

  it('says there are no decisions yet when the list is empty', async () => {
    const api = decisionMock.createDecisionMockApi({ seed: { ...createDecisionMockSeed(), decisions: [] } })
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    expect(findByText(view, 'No decisions yet. Create one to judge messages here.')).toBeTruthy()
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })
})

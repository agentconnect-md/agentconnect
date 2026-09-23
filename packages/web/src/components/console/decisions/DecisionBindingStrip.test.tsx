// @vitest-environment happy-dom

// The `By decision` strip in mock mode: it opens a picked row on a usable draft and collapses to a summary once saved.

import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionProvider from '@/lib/decisions/provider'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import type { SavedGate } from '@/lib/decisions/binding'
import type { ChannelDecisionGate } from '@agentconnect.md/protocol/decision'

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
      conversation={{ integrationId: 'int-mock', channelId: 'help-channel' }}
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

/** A row whose gate is already saved and flagged, so Repair opens the editor on that saved condition. */
function SavedStrip({ saved, onSave }: { saved: SavedGate; onSave: (gate: ChannelDecisionGate) => Promise<void> }) {
  return (
    <DecisionBindingStrip
      bindingKey="org-test|support-bot|#saved"
      conversation={null}
      canWrite
      agentName="Billing"
      padX={18}
      saved={saved}
      status="needs_review"
      onSave={onSave}
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
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error('no field to type into')
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
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
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(false)
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
  it('runs the gate Try on the conversation without a daemon pick and keeps the verdict after collapsing', async () => {
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    await clickText(view, 'Try a message')
    await typeInto(view.querySelector('textarea[aria-label="Current message"]'), 'Can someone ship the hotfix?')
    await clickText(view, 'Try')
    await act(async () => {})

    // Every fixture probability (0.4/0.4/0.2) sits below the canonical 50% minimum.
    expect(findByText(view, 'Would skip')).toBeTruthy()
    expect(findByText(view, 'Would trigger')).toBeUndefined()

    await clickText(view, 'Try a message')
    expect(view.querySelector('textarea[aria-label="Current message"]')).toBeNull()
    expect(view.querySelector('[data-testid="gate-try-result"]')).toBeTruthy()
  })

  it('opens Recent evaluations from a saved gate even without write permission', async () => {
    const key = 'org-test|support-bot|#help'
    const view = await render(<MockStrip bindingKey={key} canWrite={false} />)
    await act(async () => {
      store.setGate(key, {
        decisionId: 'needs-response',
        when: { type: 'boolean', values: [true] },
        channelName: '#help'
      })
      store.setBindingDraft(key, null)
    })
    expect(findByText(view, 'Edit')).toBeUndefined()
    await clickText(view, 'Recent evaluations')
    await act(async () => {})
    expect(view.querySelectorAll('li button').length).toBeGreaterThan(0)
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

  // A type change strands the saved condition; Repair must not reseed a match-everything default.
  it('opens a type-change repair with nothing selected and saves only the answer the operator picks', async () => {
    const onSave = vi.fn(async () => {})
    const view = await render(
      <SavedStrip
        saved={{ decisionId: 'needs-response', when: { type: 'choice', thresholds: { billing: 0.5 } } }}
        onSave={onSave}
      />
    )
    await clickText(view, 'Repair condition')
    const chip = (label: string) => findByText(view, label) as HTMLButtonElement | undefined
    const save = () => findByText(view, 'Save') as HTMLButtonElement | undefined
    expect(chip('Yes')?.getAttribute('aria-pressed')).toBe('false')
    expect(chip('No')?.getAttribute('aria-pressed')).toBe('false')
    expect(save()?.disabled).toBe(true)

    await clickText(view, 'Yes')
    expect(save()?.disabled).toBe(false)
    await clickText(view, 'Save')
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      type: 'gate',
      decisionId: 'needs-response',
      when: { type: 'boolean', values: [true] }
    })
  })

  it('disables a type-change repair Save again once the operator un-toggles every answer', async () => {
    const view = await render(
      <SavedStrip
        saved={{ decisionId: 'needs-response', when: { type: 'choice', thresholds: { billing: 0.5 } } }}
        onSave={vi.fn()}
      />
    )
    await clickText(view, 'Repair condition')
    const save = () => findByText(view, 'Save') as HTMLButtonElement | undefined
    await clickText(view, 'Yes')
    expect(save()?.disabled).toBe(false)
    await clickText(view, 'Yes')
    expect((findByText(view, 'Yes') as HTMLButtonElement | undefined)?.getAttribute('aria-pressed')).toBe('false')
    expect(save()?.disabled).toBe(true)
  })

  it('makes a Score repair set its interval deliberately before Save', async () => {
    const onSave = vi.fn(async () => {})
    const view = await render(
      <SavedStrip saved={{ decisionId: 'frustration', when: { type: 'boolean', values: [true] } }} onSave={onSave} />
    )
    await clickText(view, 'Repair condition')
    expect(view.querySelector('input[aria-label="Interval start"]')).toBeNull()
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)

    await clickText(view, 'Set an interval')
    expect(view.querySelector('input[aria-label="Interval start"]')).toBeTruthy()
    await clickText(view, 'Save')
    expect(onSave).toHaveBeenCalledWith({
      type: 'gate',
      decisionId: 'frustration',
      when: { type: 'score', min: 0, max: 3 }
    })
  })

  it('keeps re-picking the same decision during a repair from reseeding defaults', async () => {
    const view = await render(
      <SavedStrip saved={{ decisionId: 'needs-response', when: { type: 'score', min: 0, max: 1 } }} onSave={vi.fn()} />
    )
    await clickText(view, 'Repair condition')
    await act(async () => {
      view.querySelector('button[aria-haspopup="menu"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const current = document.body.querySelector<HTMLButtonElement>('button[role="menuitemradio"][aria-checked="true"]')
    await act(async () => {
      current?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect((findByText(view, 'Yes') as HTMLButtonElement | undefined)?.getAttribute('aria-pressed')).toBe('false')
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })

  // A same-type change keeps the saved values for editing: an out-of-range interval stays visible and blocks Save.
  it('keeps a stranded Score interval unclamped and invalid until the operator fixes it', async () => {
    const onSave = vi.fn(async () => {})
    const view = await render(
      <SavedStrip saved={{ decisionId: 'frustration', when: { type: 'score', min: 1, max: 5 } }} onSave={onSave} />
    )
    await clickText(view, 'Repair condition')
    const end = view.querySelector<HTMLInputElement>('input[type="number"][aria-label="Interval end"]')
    expect(end?.value).toBe('5')
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)

    await typeInto(end, '2')
    await clickText(view, 'Save')
    expect(onSave).toHaveBeenCalledWith({
      type: 'gate',
      decisionId: 'frustration',
      when: { type: 'score', min: 1, max: 2 }
    })
  })

  it('lets a Choice repair remove a key the question no longer has', async () => {
    const onSave = vi.fn(async () => {})
    const view = await render(
      <SavedStrip
        saved={{ decisionId: 'support-category', when: { type: 'choice', thresholds: { removed: 0.5, billing: 0.4 } } }}
        onSave={onSave}
      />
    )
    await clickText(view, 'Repair condition')
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)
    await clickText(view, 'removed')
    await clickText(view, 'Save')
    expect(onSave).toHaveBeenCalledWith({
      type: 'gate',
      decisionId: 'support-category',
      when: { type: 'choice', thresholds: { billing: 0.4 } }
    })
  })

  it('says there are no decisions yet when the list is empty', async () => {
    const api = decisionMock.createDecisionMockApi({ seed: { ...createDecisionMockSeed(), decisions: [] } })
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    const view = await render(<MockStrip bindingKey="org-test|support-bot|#help" />)
    expect(findByText(view, 'No decisions yet. Create one to judge messages here.')).toBeTruthy()
    expect((findByText(view, 'Save') as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })
})

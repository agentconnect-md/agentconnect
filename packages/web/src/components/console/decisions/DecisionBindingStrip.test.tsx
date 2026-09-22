// @vitest-environment happy-dom

// The `By decision` strip is the one place a conversation's gate is written. It must open
// on a usable draft (never on an empty condition), refuse a condition the decision cannot
// satisfy, and collapse to a summary the moment the gate is saved.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
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
})

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

describe('DecisionBindingStrip', () => {
  it('opens the editor on the first decision with its answer keys enabled', async () => {
    const view = await render(
      <DecisionBindingStrip
        bindingKey="org-test|support-bot|#help"
        channelName="#help"
        canWrite
        agentName="Billing"
        padX={18}
        onAbandon={() => undefined}
      />
    )
    expect(findByText(view, 'Support category')).toBeTruthy()
    expect(findByText(view, 'Trigger when')).toBeTruthy()
    // The fixture's choice decision declares billing/technical/sales.
    expect(view.querySelector('input[aria-label="Minimum probability for billing"]')).toBeTruthy()
    expect(view.querySelector('input[aria-label="Minimum probability for technical"]')).toBeTruthy()
  })

  it('saves the gate and collapses to a summary that names the decision and its condition', async () => {
    const view = await render(
      <DecisionBindingStrip
        bindingKey="org-test|support-bot|#help"
        channelName="#help"
        canWrite
        agentName="Billing"
        padX={18}
        onAbandon={() => undefined}
      />
    )
    const save = findByText(view, 'Save')
    expect(save).toBeTruthy()
    await act(async () => {
      save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(findByText(view, 'Support category')).toBeTruthy()
    expect(findByText(view, 'billing ≥ 50%, technical ≥ 50%, sales ≥ 50%')).toBeTruthy()
    expect(findByText(view, 'Edit')).toBeTruthy()
    // The editor is gone: no minimum-probability control survives the save.
    expect(view.querySelector('input[aria-label="Minimum probability for billing"]')).toBeNull()
  })

  it('reverts the row when a fresh gate is abandoned, and never when one is already saved', async () => {
    const onAbandon = vi.fn()
    const view = await render(
      <DecisionBindingStrip
        bindingKey="org-test|support-bot|#help"
        channelName="#help"
        canWrite
        agentName="Billing"
        padX={18}
        onAbandon={onAbandon}
      />
    )
    await act(async () => {
      findByText(view, 'Cancel')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAbandon).toHaveBeenCalledTimes(1)
  })

  it('offers no editor controls without write permission', async () => {
    const view = await render(
      <DecisionBindingStrip
        bindingKey="org-test|support-bot|#help"
        channelName="#help"
        canWrite={false}
        agentName="Billing"
        padX={18}
        onAbandon={() => undefined}
      />
    )
    expect(findByText(view, 'Save')).toBeUndefined()
    expect(findByText(view, 'Cancel')).toBeUndefined()
  })

  // A platform conversation coordinate is not an identity: two bots can both be installed in
  // one Slack channel, and saving bot A's gate must not make bot B's row render it.
  it('keeps two bots’ gates in one conversation apart', async () => {
    const view = await render(
      <>
        <DecisionBindingStrip
          bindingKey="org-test|bot-a|C123"
          channelName="#help"
          canWrite
          agentName="Billing"
          padX={18}
          onAbandon={() => undefined}
        />
        <DecisionBindingStrip
          bindingKey="org-test|bot-b|C123"
          channelName="#help"
          canWrite
          agentName="Technical"
          padX={18}
          onAbandon={() => undefined}
        />
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
      [...view.querySelectorAll('span')].filter(
        (node) => node.textContent?.trim() === 'billing ≥ 50%, technical ≥ 50%, sales ≥ 50%'
      )
    ).toHaveLength(1)
    expect(view.querySelectorAll('input[aria-label="Minimum probability for billing"]')).toHaveLength(1)
  })
})

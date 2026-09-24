// @vitest-environment happy-dom

// Gate Try: the sample reaches the conversation's preview, each outcome renders, and an edit makes the result stale.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { ApiError } from '@/lib/api'
import type { DecisionCondition, DecisionDefinition } from '@agentconnect.md/protocol/decision'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import { DecisionGateTry } from './DecisionGateTry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

const seed = createDecisionMockSeed()
const boolean = seed.decisions.find((entry) => entry.id === 'needs-response')!
const conversation = { integrationId: 'int-1', channelId: 'moderation-channel' }

function useApi(api: DecisionApi) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  return api
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
  await act(async () => {})
  return container
}

function Try({ when, decision = boolean }: { when: DecisionCondition; decision?: DecisionDefinition }) {
  return <DecisionGateTry conversation={conversation} decision={decision} when={when} agentName="Moderator" open />
}

async function type(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('no field')
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
async function click(node: Element | undefined) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('DecisionGateTry', () => {
  it('sends the history lines with sender ids and answers Would trigger the target', async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    const previewGate = vi.spyOn(api, 'previewGate')
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await click(button(view, 'Add message'))
    await type(view.querySelector('input[aria-label="Sender of history message 1"]'), 'U-customer')
    await type(view.querySelector('input[aria-label="History message 1"]'), 'Is anyone around?')
    await click(button(view, 'Add message'))
    await type(view.querySelector('textarea[aria-label="Current message"]'), ' Please help ')
    await click(button(view, 'Try'))
    expect(previewGate).toHaveBeenCalledWith(conversation, {
      decisionBinding: { type: 'gate', decisionId: 'needs-response', when: { type: 'boolean', values: [true] } },
      // The blank second line is dropped rather than sent as an empty message.
      state: {
        history: [{ sender: 'U-customer', text: 'Is anyone around?' }],
        currentMessage: { text: 'Please help' }
      }
    })
    const result = view.querySelector('[data-testid="gate-try-result"]')!
    expect(result.textContent).toContain('Would trigger')
    expect(result.textContent).toContain('Would trigger Moderator')
    expect(result.textContent).toContain('Yes')
  })

  it('marks the result stale once the sample or condition changes', async () => {
    useApi(decisionMock.createDecisionMockApi())
    const view = await render(<Try when={{ type: 'boolean', values: [false] }} />)
    const current = view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Current message"]')
    await type(current, 'Spam spam')
    await click(button(view, 'Try'))
    expect(view.querySelector('[data-testid="gate-try-result"]')?.textContent).toContain('Would skip')
    expect(view.textContent).not.toContain('The draft changed after this run.')
    await type(current, 'Spam spam spam')
    expect(view.textContent).toContain('The draft changed after this run. Run again.')
    expect(view.querySelector('[data-testid="gate-try-result"]')?.className).toContain('opacity-60')
  })

  it('marks the result stale once the saved Decision changes under it', async () => {
    useApi(decisionMock.createDecisionMockApi())
    const when: DecisionCondition = { type: 'boolean', values: [false] }
    const view = await render(<Try when={when} />)
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Spam spam')
    await click(button(view, 'Try'))
    expect(view.textContent).not.toContain('The draft changed after this run.')
    const edited = { ...boolean, model: 'jev-other', updatedAt: '2030-01-01T00:00:00.000Z' }
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <Try when={when} decision={edited} />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    expect(view.textContent).toContain('The draft changed after this run. Run again.')
  })

  it('shows a preview failure from a connected daemon as a failure, not as offline', async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    vi.spyOn(api, 'previewGate').mockRejectedValue(new ApiError('Decision preview is unavailable. Try again.', 503))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Hello?')
    await click(button(view, 'Try'))
    const alert = view.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Decision preview is unavailable. Try again.')
    expect(alert).not.toContain('No daemon serving this conversation')
  })

  it('shows a provider failure as unavailable, continuing to the target, never as a skip', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'provider_unavailable' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Hello?')
    await click(button(view, 'Try'))
    const result = view.querySelector('[data-testid="gate-try-result"]')!
    expect(result.textContent).toContain('Evaluation unavailable')
    expect(result.textContent).toContain('continue to Moderator')
    expect(result.textContent).not.toContain('Would skip')
  })

  it('says Not applied for a stranded condition without an evaluation', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'needs_review' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Hello?')
    await click(button(view, 'Try'))
    const result = view.querySelector('[data-testid="gate-try-result"]')!
    expect(result.textContent).toContain('Not applied')
    expect(result.textContent).toContain('needs review')
    expect(result.textContent).not.toContain('Would skip')
  })

  it('says the daemon is offline instead of showing a result', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector('textarea[aria-label="Current message"]'), 'Hello?')
    await click(button(view, 'Try'))
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('No daemon serving this conversation')
    expect(view.querySelector('[data-testid="gate-try-result"]')).toBeNull()
  })
})

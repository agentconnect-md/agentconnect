// @vitest-environment happy-dom

// Gate Try: the sample state reaches the conversation's preview, each outcome renders, and an edit makes the result stale.

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
import { apiGateTry, conversationGateTry } from '@/lib/decisions/try-source'

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

function Try({
  when,
  decision = boolean,
  lane = 'conversation'
}: {
  when: DecisionCondition
  decision?: DecisionDefinition
  lane?: 'conversation' | 'api'
}) {
  const api = decisionMock.createDecisionMockApi()
  const source =
    lane === 'api' ? apiGateTry(api, 'org-test', 'agent-1', 'ai-sdk-ui') : conversationGateTry(api, conversation)
  return <DecisionGateTry source={source} decision={decision} when={when} agentName="Moderator" open />
}

async function type(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!field) throw new Error('no field')
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const CURRENT = 'textarea[aria-label="Current message"]'
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
  it('sends the edited state as the preview sample and answers Would trigger the target', async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    const previewGate = vi.spyOn(api, 'previewGate')
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    // Bound fields fold into one line; the sender id stays a quiet field.
    expect(view.querySelector('[title^="Filled in here"]')?.getAttribute('title')).toContain('agent')
    await click(view.querySelector('button[aria-label="Add a history message"]') ?? undefined)
    await type(view.querySelector('textarea[aria-label="History message 1"]'), 'Is anyone around?')
    await type(view.querySelector(CURRENT), ' Please help ')
    await click(button(view, 'Try'))
    expect(previewGate).toHaveBeenCalledWith(conversation, {
      decisionBinding: { type: 'gate', decisionId: 'needs-response', when: { type: 'boolean', values: [true] } },
      state: {
        history: [{ sender: 'U0456EFGH', text: 'Is anyone around?' }],
        currentMessage: { sender: 'U0123ABCD', text: 'Please help' }
      }
    })
    const result = view.querySelector('[data-testid="try-result"]')!
    expect(result.textContent).toContain('Would trigger')
    expect(result.textContent).toContain('Would trigger Moderator')
    expect(result.textContent).toContain('Yes')
    await click(view.querySelector('button[aria-label="Remove history message 1"]') ?? undefined)
    expect(view.querySelector('textarea[aria-label="History message 1"]')).toBeNull()
  })

  it('round-trips Raw JSON and refuses a field the gate fills in itself', async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    const previewGate = vi.spyOn(api, 'previewGate')
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Hello')
    await click(button(view, 'Raw JSON'))
    const raw = view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Sample state as JSON"]')!
    expect(JSON.parse(raw.value)).toEqual({
      currentMessage: { sender: { id: 'U0123ABCD' }, text: 'Hello' },
      history: []
    })
    await type(raw, JSON.stringify({ agent: { name: 'x' }, currentMessage: { text: 'Hi' } }))
    await click(button(view, 'Try'))
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('"agent" is filled in here')
    expect(previewGate).not.toHaveBeenCalled()
    await type(raw, '{ "currentMessage": { "text": "Hi there", "threadId": "t" } }')
    await click(button(view, 'Fields'))
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('"currentMessage.threadId" is filled in here')
    await type(raw, '{ "currentMessage": { "text": "Hi there" } }')
    await click(button(view, 'Fields'))
    expect(view.querySelector<HTMLTextAreaElement>(CURRENT)?.value).toBe('Hi there')
    await click(button(view, 'Try'))
    expect(previewGate).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        state: { history: [], currentMessage: { text: 'Hi there' } }
      })
    )
  })

  it("tries an API gate's one call with no history", async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    const previewGate = vi.spyOn(api, 'previewGate')
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} lane="api" />)
    expect(view.querySelector('button[aria-label="Add a history message"]')).toBeNull()
    await type(view.querySelector(CURRENT), 'What is 4 * 100?')
    await click(button(view, 'Try'))
    expect(previewGate).toHaveBeenCalledWith(
      { integrationId: 'api:agent-1:ai-sdk-ui', channelId: 'api:agent-1:ai-sdk-ui' },
      expect.objectContaining({ state: { history: [], currentMessage: { text: 'What is 4 * 100?' } } })
    )
    expect(view.querySelector('[data-testid="try-result"]')?.textContent).toMatch(/would answer the call/)
  })

  it("opens the run's detail from Details as a Recent evaluations detail, with its raw JSON", async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    vi.spyOn(api, 'previewGate').mockResolvedValue({
      mode: 'live',
      readiness: { status: 'ready' },
      evaluation: {
        status: 'answered',
        model: 'jev-1.13.0',
        answer: { type: 'boolean', value: true, probability: 0.8 },
        usage: { inputTokens: 12, outputTokens: 1 }
      },
      consumer: {
        type: 'gate',
        outcome: 'trigger',
        matched: true,
        matchedKeys: [],
        target: { agentId: 'a', name: 'Moderator' }
      },
      detail: {
        seq: 0,
        at: '2026-09-29T10:00:00.000Z',
        messageId: null,
        title: 'Please help',
        decisionId: 'needs-response',
        outcome: 'triggered',
        reason: null,
        answer: { type: 'boolean', value: true, probability: 0.8 },
        matchedKeys: [],
        latencyMs: 420,
        requestedModel: 'jev-1.13.0',
        actualModel: 'jev-1.13.0',
        usage: { inputTokens: 12, outputTokens: 1 },
        detailsExpired: false,
        snapshot: {
          decisionId: 'needs-response',
          providerId: 'typesafe',
          model: 'jev-1.13.0',
          question: boolean.question,
          condition: { type: 'boolean', values: [true] },
          sessionMode: 'createNew'
        },
        input: {
          agent: { name: 'Moderator', description: 'Keeps the channel on topic' },
          currentMessage: { id: 'preview-1', sender: { id: 'U0123ABCD' }, text: 'Please help', threadId: null },
          history: [],
          historyOmitted: 0,
          context: { partial: false, reasons: [], omittedMessages: 0 }
        },
        fullAnswer: { type: 'boolean', value: true, probability: 0.8 },
        rawRequest: { text: '{"model":"jev-1.13.0","state":{}}', truncated: false },
        rawResponse: { text: '{"decision":true}', truncated: false },
        evidence: null
      }
    })
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Please help')
    await click(button(view, 'Try'))
    await click(button(view, 'Details'))
    const drawer = document.body.querySelector('[data-testid="try-details"]')!
    expect(drawer.textContent).toContain('Try details')
    const detail = drawer.querySelector('[data-testid="evaluation-detail"]')!
    expect(detail.textContent).toContain('Please help')
    expect(detail.textContent).toContain('Keeps the channel on topic')
    // No list to go back to: the drawer holds this one run.
    expect(button(detail as HTMLElement, 'All evaluations')).toBeUndefined()
    expect(drawer.innerHTML).toContain('jev-1.13.0')
  })

  it('marks the result stale once the sample or condition changes', async () => {
    useApi(decisionMock.createDecisionMockApi())
    const view = await render(<Try when={{ type: 'boolean', values: [false] }} />)
    const current = view.querySelector<HTMLTextAreaElement>(CURRENT)
    await type(current, 'Spam spam')
    await click(button(view, 'Try'))
    expect(view.querySelector('[data-testid="try-result"]')?.textContent).toContain('Would skip')
    expect(view.textContent).not.toContain('changed after this run.')
    await type(current, 'Spam spam spam')
    expect(view.textContent).toContain('The draft or sample changed after this run. Run again.')
    expect(view.querySelector('[data-testid="try-result"]')?.className).toContain('opacity-60')
  })

  it('marks the result stale once the saved Decision changes under it', async () => {
    useApi(decisionMock.createDecisionMockApi())
    const when: DecisionCondition = { type: 'boolean', values: [false] }
    const view = await render(<Try when={when} />)
    await type(view.querySelector(CURRENT), 'Spam spam')
    await click(button(view, 'Try'))
    expect(view.textContent).not.toContain('changed after this run.')
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
    expect(view.textContent).toContain('The draft or sample changed after this run. Run again.')
  })

  it('shows a preview failure from a connected daemon as a failure, not as offline', async () => {
    const api = useApi(decisionMock.createDecisionMockApi())
    vi.spyOn(api, 'previewGate').mockRejectedValue(new ApiError('Decision preview is unavailable. Try again.', 503))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Hello?')
    await click(button(view, 'Try'))
    const alert = view.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Decision preview is unavailable. Try again.')
    expect(alert).not.toContain('No daemon serving this conversation')
  })

  it('shows a provider failure as unavailable, continuing to the target, never as a skip', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'provider_unavailable' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Hello?')
    await click(button(view, 'Try'))
    const result = view.querySelector('[data-testid="try-result"]')!
    expect(result.textContent).toContain('Evaluation unavailable')
    expect(result.textContent).toContain('continue to Moderator')
    expect(result.textContent).not.toContain('Would skip')
  })

  it('says Not applied for a stranded condition without an evaluation', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'needs_review' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Hello?')
    await click(button(view, 'Try'))
    const result = view.querySelector('[data-testid="try-result"]')!
    expect(result.textContent).toContain('Not applied')
    expect(result.textContent).toContain('needs review')
    expect(result.textContent).not.toContain('Would skip')
  })

  it('says the daemon is offline instead of showing a result', async () => {
    useApi(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    const view = await render(<Try when={{ type: 'boolean', values: [true] }} />)
    await type(view.querySelector(CURRENT), 'Hello?')
    await click(button(view, 'Try'))
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('No daemon serving this conversation')
    expect(view.querySelector('[data-testid="try-result"]')).toBeNull()
  })
})

// @vitest-environment happy-dom

// Recent evaluations drawer: rows, Load more, the detail with model result and raw JSON, Details expired, and offline/upgrade states.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { ApiError } from '@/lib/api'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'
import type { DecisionEvaluationSource } from '@/lib/decisions/evaluation-source'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'viewer', orgPath: (path: string) => path })
}))

import { DecisionEvaluationsDrawer } from './DecisionEvaluationsDrawer'

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

const conversation = { integrationId: 'int-1', channelId: 'C1' }

function tree(onClose: () => void, initialSeq?: number, source?: DecisionEvaluationSource) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DecisionsPrototypeProvider>
        {source ? (
          <DecisionEvaluationsDrawer
            source={source}
            channelName="acme/api · Issues"
            initialSeq={initialSeq}
            onClose={onClose}
          />
        ) : (
          <DecisionEvaluationsDrawer
            conversation={conversation}
            channelName="#help"
            agentName="Support"
            initialSeq={initialSeq}
            onClose={onClose}
          />
        )}
      </DecisionsPrototypeProvider>
    </SWRConfig>
  )
}

async function render(
  api: DecisionApi,
  onClose: () => void = () => {},
  initialSeq?: number,
  source?: DecisionEvaluationSource
) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(tree(onClose, initialSeq, source))
  })
  await act(async () => {})
  await act(async () => {})
  return document.body
}

const drawer = () => document.body.querySelector<HTMLElement>('[data-testid="decision-evaluations"]')!
const detail = () => document.body.querySelector<HTMLElement>('[data-testid="evaluation-detail"]')
const rows = () => [...drawer().querySelectorAll<HTMLButtonElement>('li button')]
async function settle() {
  await act(async () => {})
  await act(async () => {})
}
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}
async function escape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  await settle()
}

describe('DecisionEvaluationsDrawer', () => {
  it('lists each outcome with its answer, decision, model and latency, and keeps Unavailable apart from Skipped', async () => {
    await render(decisionMock.createDecisionMockApi())
    expect(drawer().getAttribute('role')).toBe('dialog')
    expect(drawer().textContent).toContain('#help · Support')
    const list = rows()
    expect(list).toHaveLength(6)
    expect(list[0]!.textContent).toContain('Yes · 86%')
    expect(list[0]!.textContent).toContain('Triggered')
    expect(list[0]!.textContent).toContain('jev-1.13.0')
    expect(list[0]!.textContent).toContain('640 ms')
    expect(list[1]!.textContent).toContain('sales · 62%')
    expect(list[1]!.textContent).toContain('Skipped')
    expect(list[2]!.textContent).toContain('Unavailable · Timed out')
    expect(list[2]!.textContent).not.toContain('Skipped')
    expect(list[3]!.textContent).toContain('Canceled · Stopped')
    expect(list[4]!.textContent).toContain('Pending')
    expect(list[5]!.textContent).toContain('Expired')
  })

  it('opens a detail in place, steps back with Escape to the row that opened it, then closes', async () => {
    const onClose = vi.fn()
    await render(decisionMock.createDecisionMockApi(), onClose)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close recent evaluations')
    await click(rows()[1])
    expect(detail()).toBeTruthy()
    expect(document.activeElement?.textContent).toContain('All evaluations')
    await escape()
    expect(detail()).toBeNull()
    expect(document.activeElement).toBe(rows()[1])
    expect(onClose).not.toHaveBeenCalled()
    await escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens straight on the evaluation a session marker names, and Back lands on the list', async () => {
    const api = decisionMock.createDecisionMockApi()
    const [, second] = (await api.listEvaluations(conversation)).items
    await render(api, () => {}, second!.seq)
    expect(detail()).toBeTruthy()
    expect(detail()!.textContent).toContain('Skipped')
    await escape()
    expect(detail()).toBeNull()
    expect(rows()).toHaveLength(6)
  })

  it('loads the next page by cursor', async () => {
    const seed = createDecisionMockSeed()
    const template = seed.evaluations[1]!
    seed.evaluations = Array.from({ length: 25 }, (_, index) => ({ ...template, seq: 200 - index }))
    const api = decisionMock.createDecisionMockApi({ seed })
    const listEvaluations = vi.spyOn(api, 'listEvaluations')
    await render(api)
    expect(rows()).toHaveLength(20)
    await click([...drawer().querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Load more'))
    expect(listEvaluations).toHaveBeenLastCalledWith(conversation, { cursor: 181, limit: 20 })
    expect(rows()).toHaveLength(25)
    expect([...drawer().querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Load more')).toBe(
      false
    )
  })

  it('shows the frozen detail with the model result and the raw Jev request and response', async () => {
    await render(decisionMock.createDecisionMockApi())
    await click(rows()[0])
    const view = detail()!
    expect(view.textContent).toContain('Our invoice charged us twice this month.')
    expect(view.textContent).toContain('U-customer')
    expect(view.textContent).toContain('Someone from billing will reply shortly.')
    expect(view.textContent).toContain('Does currentMessage need a response')
    expect(view.textContent).toContain('Trigger when (at the time)')
    expect(view.textContent).not.toContain('Details expired')
    const result = view.querySelector('[data-testid="model-result"]')!
    const bars = [...result.querySelectorAll('li')]
    expect(bars.map((bar) => bar.textContent)).toEqual([expect.stringContaining('86%'), expect.stringContaining('14%')])
    expect(bars[0]!.textContent).toContain('✓ triggers')
    expect(bars[1]!.textContent).not.toContain('✓ triggers')
    expect(result.textContent).toContain('412 in · 3 out tokens')
    const raw = [...result.querySelectorAll('details')]
    expect(raw.map((block) => block.querySelector('summary')?.textContent)).toEqual([
      expect.stringContaining('Raw request'),
      expect.stringContaining('Raw response')
    ])
    expect(raw[0]!.querySelector('pre')?.textContent).toContain('"type": "noul"')
    expect(raw[0]!.querySelector('pre')?.textContent).toContain('Our invoice charged us twice this month.')
    expect(raw[1]!.querySelector('pre')?.textContent).toContain('"noul": 0.86')
  })

  it('draws choice thresholds and marks nothing as triggering for a skipped answer', async () => {
    await render(decisionMock.createDecisionMockApi())
    await click(rows()[1])
    const result = detail()!.querySelector('[data-testid="model-result"]')!
    const bars = [...result.querySelectorAll('li')]
    expect(bars.map((bar) => bar.querySelector('div > span')?.textContent)).toEqual(['billing', 'technical', 'sales'])
    expect(bars[0]!.textContent).toContain('≥ 50%')
    expect(result.textContent).not.toContain('✓ triggers')
    expect(bars[2]!.getAttribute('data-chosen')).toBe('true')
  })

  it('explains an unavailable evaluation and says Details expired once bodies are gone', async () => {
    await render(decisionMock.createDecisionMockApi())
    await click(rows()[2])
    expect(detail()!.textContent).toContain('Evaluation unavailable')
    expect(detail()!.textContent).toContain('Not recorded')
    await escape()

    await click(rows()[5])
    const expired = detail()!
    expect(expired.textContent).toContain('Details expired')
    expect(expired.textContent).toContain('Triggered')
    expect(expired.textContent).not.toContain('Evaluated message')
    expect(expired.querySelectorAll('details')).toHaveLength(0)
  })

  it('distinguishes an offline daemon from one that must be upgraded', async () => {
    await render(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    expect(drawer().textContent).toContain('No daemon serving this conversation is connected')
    await act(async () => root?.unmount())
    container?.remove()

    const api = decisionMock.createDecisionMockApi()
    vi.spyOn(api, 'listEvaluations').mockRejectedValue(
      new ApiError('upgrade the daemon to read recent evaluations', 503, 'DAEMON_UPGRADE_REQUIRED')
    )
    await render(api)
    expect(drawer().textContent).toContain('Upgrade the daemon serving this conversation')
    expect(rows()).toHaveLength(0)
  })

  it('reads a code-host routing lane through the given source and words its states for a repository', async () => {
    const api = decisionMock.createDecisionMockApi()
    const scopeRef = { integrationId: 'github:1:issues', channelId: 'github:1:issues' }
    const source: DecisionEvaluationSource = {
      lane: 'code_host',
      key: ['test', 'org-test', 'code_host', '1'],
      list: vi.fn((page) => api.listEvaluations(scopeRef, page)),
      get: vi.fn((seq) => api.getEvaluation(scopeRef, seq))
    }
    await render(api, () => {}, undefined, source)
    expect(drawer().textContent).toContain('acme/api · Issues')
    expect(source.list).toHaveBeenCalledWith({ limit: 20 })
    expect(rows()).toHaveLength(6)
    const seq = Number(rows()[0]!.dataset.seq)
    await click(rows()[0])
    expect(source.get).toHaveBeenCalledWith(seq)
    expect(detail()!.textContent).toContain('Our invoice charged us twice this month.')
    await act(async () => root?.unmount())
    container?.remove()

    const empty: DecisionEvaluationSource = {
      ...source,
      key: ['test', 'org-test', 'code_host', '2'],
      list: async () => ({ items: [], nextCursor: null })
    }
    await render(api, () => {}, undefined, empty)
    expect(drawer().textContent).toContain('judged for this repository appear here')
    await act(async () => root?.unmount())
    container?.remove()

    const offline: DecisionEvaluationSource = {
      ...source,
      key: ['test', 'org-test', 'code_host', '3'],
      list: async () => {
        throw new ApiError('daemon offline', 503, 'DAEMON_OFFLINE')
      }
    }
    await render(api, () => {}, undefined, offline)
    expect(drawer().textContent).toContain("evaluates this repository's routing is not connected")
  })
})

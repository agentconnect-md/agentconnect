// @vitest-environment happy-dom

// Recent evaluations: rows, Load more, the detail sheet with Details expired, and the offline/upgrade states.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { ApiError } from '@/lib/api'
import type { DecisionApi } from '@agentconnect.md/protocol/decision-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/a1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'viewer', orgPath: (path: string) => path })
}))

import { DecisionEvaluationsPanel } from './DecisionEvaluationsPanel'

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

async function render(api: DecisionApi) {
  vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionEvaluationsPanel conversation={conversation} />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  await act(async () => {})
  return container
}

const rows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>('li button')]
async function click(node: Element | undefined | null) {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
  await act(async () => {})
}

describe('DecisionEvaluationsPanel', () => {
  it('lists each outcome with its answer, matched keys and latency, and keeps Unavailable apart from Skipped', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    const list = rows(view)
    expect(list).toHaveLength(6)
    expect(list[0]!.textContent).toContain('Yes · 86%')
    expect(list[0]!.textContent).toContain('Triggered')
    expect(list[0]!.textContent).toContain('640 ms')
    expect(list[1]!.textContent).toContain('sales · 62%')
    expect(list[1]!.textContent).toContain('Skipped')
    expect(list[2]!.textContent).toContain('Unavailable · Timed out')
    expect(list[2]!.textContent).not.toContain('Skipped')
    expect(list[3]!.textContent).toContain('Canceled · Stopped')
    expect(list[4]!.textContent).toContain('Pending')
    expect(list[5]!.textContent).toContain('Expired')
  })

  it('names each row by its visible cells, keeps focus put across renders, and refocuses the row on close', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    const list = rows(view)
    expect(list.every((row) => !row.hasAttribute('aria-label'))).toBe(true)
    list[1]!.focus()
    await click(list[1])
    const close = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close evaluation details"]')!
    expect(document.activeElement).toBe(close)
    list[2]!.focus()
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <DecisionEvaluationsPanel conversation={conversation} />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    expect(document.activeElement).toBe(list[2])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(rows(view)[1])
  })

  it('loads the next page by cursor', async () => {
    const seed = createDecisionMockSeed()
    const template = seed.evaluations[1]!
    seed.evaluations = Array.from({ length: 25 }, (_, index) => ({ ...template, seq: 200 - index }))
    const api = decisionMock.createDecisionMockApi({ seed })
    const listEvaluations = vi.spyOn(api, 'listEvaluations')
    const view = await render(api)
    expect(rows(view)).toHaveLength(20)
    await click([...view.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Load more'))
    expect(listEvaluations).toHaveBeenLastCalledWith(conversation, { cursor: 181, limit: 20 })
    expect(rows(view)).toHaveLength(25)
    expect([...view.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Load more')).toBe(false)
  })

  it('opens the frozen detail in a dialog and says Details expired once bodies are gone', async () => {
    const view = await render(decisionMock.createDecisionMockApi())
    await click(rows(view)[0])
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Evaluation details')
    expect(dialog.textContent).toContain('Our invoice charged us twice this month.')
    expect(dialog.textContent).toContain('U-customer')
    expect(dialog.textContent).toContain('Someone from billing will reply shortly.')
    expect(dialog.textContent).toContain('Does currentMessage need a response')
    expect(dialog.textContent).toContain('412 in · 3 out')
    expect(dialog.textContent).not.toContain('Details expired')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await click(rows(view)[5])
    const expired = document.body.querySelector('[role="dialog"]')!
    expect(expired.textContent).toContain('Details expired')
    expect(expired.textContent).toContain('Triggered')
    expect(expired.textContent).not.toContain('Evaluated message')
    await click(expired.querySelector('button[aria-label="Close evaluation details"]'))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('distinguishes an offline daemon from one that must be upgraded', async () => {
    const offline = await render(decisionMock.createDecisionMockApi({ scenario: 'daemon_offline' }))
    expect(offline.textContent).toContain('No daemon serving this conversation is connected')
    await act(async () => root?.unmount())
    container?.remove()

    const api = decisionMock.createDecisionMockApi()
    vi.spyOn(api, 'listEvaluations').mockRejectedValue(
      new ApiError('upgrade the daemon to read recent evaluations', 503, 'DAEMON_UPGRADE_REQUIRED')
    )
    const old = await render(api)
    expect(old.textContent).toContain('Upgrade the daemon serving this conversation')
    expect(rows(old)).toHaveLength(0)
  })
})

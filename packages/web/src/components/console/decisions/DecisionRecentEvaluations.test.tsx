// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import { DecisionRecentEvaluations } from './DecisionRecentEvaluations'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/decisions/support-category',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'example-org' }, myRole: 'viewer', orgPath: (path: string) => path })
}))

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

describe('DecisionRecentEvaluations', () => {
  it('keeps conversation and routing evaluations in separate Decision-filtered sources', async () => {
    const seed = createDecisionMockSeed()
    const api = decisionMock.createDecisionMockApi({ seed })
    const gate = vi.spyOn(api, 'listEvaluations')
    const routing = vi.spyOn(api, 'listRoutingEvaluations')
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <DecisionRecentEvaluations
              decisionId={seed.decisions[0]!.id}
              question={seed.decisions[0]!.question}
              usages={[
                { kind: 'gate', id: 'gate-1', label: '#help', integrationId: 'int-1', channelId: 'C1' },
                { kind: 'shared_bot_routing', id: seed.bots[0]!.id, label: 'Support bot' }
              ]}
            />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    await act(async () => {})
    expect(gate).toHaveBeenCalledWith(
      { integrationId: 'int-1', channelId: 'C1' },
      { decisionId: seed.decisions[0]!.id, limit: 10 }
    )
    expect(routing).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('Support bot')
    )!
    await act(async () => button.click())
    await act(async () => {})
    expect(routing).toHaveBeenCalledWith(seed.bots[0]!.id, { decisionId: seed.decisions[0]!.id, limit: 10 })
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})

// @vitest-environment happy-dom
// An API row takes a Decision gate the way a channel does: `+ Decision` opens the rules, Save writes the gate, and the chip's remove clears it.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'

const mocks = vi.hoisted(() => ({ setAgentApiGate: vi.fn(async () => ({})) }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/agents/agent-1',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test', role: 'owner' }, myRole: 'owner', orgPath: (p: string) => p })
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<object>()),
  setAgentApiGate: mocks.setAgentApiGate
}))

import { AgentApiCard } from './AgentApiCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AGENT = { id: 'agent-1', name: 'docs', canEdit: true } as never
const onChanged = vi.fn()

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.setAgentApiGate.mockClear()
  onChanged.mockClear()
})

async function render(gate: unknown): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const node: ReactNode = (
    <AgentApiCard
      agent={AGENT}
      entries={[{ protocol: 'ai-sdk-ui', createdBy: null, createdAt: '2026-09-01T00:00:00.000Z', gate } as never]}
      mobile={false}
      onChanged={onChanged}
    />
  )
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>{node}</DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const button = (match: (b: HTMLButtonElement) => boolean) => [...document.querySelectorAll('button')].find(match)
const click = async (b: HTMLButtonElement | undefined) => {
  expect(b).toBeTruthy()
  await act(async () => {
    b!.click()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('API row Decision gate', () => {
  it('opens the rules for this API and saves the gate', async () => {
    await render(null)
    await click(button((b) => b.getAttribute('aria-label') === 'Add decision'))
    const dialog = document.body.textContent ?? ''
    expect(dialog).toContain('answers a call over this API')
    expect(dialog).not.toContain('A mention does not skip the decision')
    await click(button((b) => b.textContent === 'Save'))
    expect(mocks.setAgentApiGate).toHaveBeenCalledWith(
      'agent-1',
      'ai-sdk-ui',
      expect.objectContaining({ type: 'gate', decisionId: expect.any(String), when: expect.any(Object) })
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('names a saved gate on its chip and clears it from there', async () => {
    // The mock store's first Decision, so the chip names a Decision the viewer can see.
    await render({
      type: 'gate',
      decisionId: 'support-category',
      when: { type: 'choice', thresholds: { billing: 0.5 } }
    })
    expect(document.body.textContent).toContain('Support category')
    await click(button((b) => b.getAttribute('aria-label') === 'Stop using By decision'))
    expect(mocks.setAgentApiGate).toHaveBeenCalledWith('agent-1', 'ai-sdk-ui', null)
  })
})

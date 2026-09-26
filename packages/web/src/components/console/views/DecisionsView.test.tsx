// @vitest-environment happy-dom

// Visible decisions link directly to their editor.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import { DECISION_EXAMPLES } from '@/lib/decisions/examples'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/decisions',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import DecisionsView from './DecisionsView'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  push.mockClear()
  vi.restoreAllMocks()
})

async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionsView />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  return container
}

const click = async (node: Element | undefined | null) => {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Menus are portalled to the body, so every query reads the whole document, not the root div.
const byText = (text: string) =>
  [...document.body.querySelectorAll('button, a, span, div')].find((node) => node.textContent?.trim() === text)

describe('DecisionsView', () => {
  it('lists every visible decision with its question type', async () => {
    await render()
    expect(byText('Support category')).toBeTruthy()
    expect(byText('Needs a response')).toBeTruthy()
    expect(byText('Customer frustration')).toBeTruthy()
    // The type badge comes from the summary, not a second read.
    expect(byText('Choice')).toBeTruthy()
  })

  it('makes the entire row a link without nested actions or a separate search field', async () => {
    await render()
    const row = document.body.querySelector('a.row.click[href="/decisions/support-category"]')!
    expect(row.textContent).toContain('Support category')
    expect(row.textContent).toContain('Choice')
    expect(row.textContent).toContain('jev-1.13.0')
    expect(row.querySelector('button, a')).toBeNull()
    expect(document.body.querySelector('input')).toBeNull()
  })

  it('sends Add decision to the editor route', async () => {
    await render()
    await click(byText('Add decision'))
    expect(push).toHaveBeenCalledWith('/decisions/new')
  })
})

describe('DecisionsView examples', () => {
  const renderEmpty = async () => {
    const api = decisionMock.createDecisionMockApi({ seed: { ...createDecisionMockSeed(), decisions: [] } })
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    await render()
    return api
  }

  it('offers every example with its answers and usage hint on an empty page', async () => {
    await renderEmpty()
    for (const example of DECISION_EXAMPLES) expect(byText(example.name)).toBeTruthy()
    expect(byText('claude · codex · grok · unknown')).toBeTruthy()
    expect(byText('Yes · No')).toBeTruthy()
    expect(byText('Use as a gate: let the agent reply only on Yes.')).toBeTruthy()
  })

  it('opens the editor prefilled from one example without saving', async () => {
    const api = await renderEmpty()
    const create = vi.spyOn(api, 'createDecision')
    await click(document.body.querySelector('button[aria-label="Add PR author"]'))
    expect(push).toHaveBeenCalledWith('/decisions/new?example=prAuthor')
    expect(create).not.toHaveBeenCalled()
  })

  it('creates every example at once and then lists them', async () => {
    const api = await renderEmpty()
    const create = vi.spyOn(api, 'createDecision')
    await click(byText('Add all examples'))
    await act(async () => {})
    expect(create).toHaveBeenCalledTimes(DECISION_EXAMPLES.length)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Needs reply', providerId: 'typesafe', visibility: 'org' })
    )
    expect(document.body.querySelectorAll('a.row.click')).toHaveLength(DECISION_EXAMPLES.length)
  })
})

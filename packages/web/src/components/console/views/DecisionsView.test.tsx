// @vitest-environment happy-dom

// The Decisions list is the resource's only management surface: it reads the visible
// definitions, filters them, and refuses to delete one a channel still evaluates.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'

const push = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/decisions',
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
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

const field = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

/** React tracks a controlled input's value, so a bare assignment is swallowed; set it natively. */
const type = async (input: HTMLInputElement | null, value: string) => {
  if (!input) throw new Error('no field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('DecisionsView', () => {
  it('lists every visible decision with its question type', async () => {
    await render()
    expect(byText('Support category')).toBeTruthy()
    expect(byText('Needs a response')).toBeTruthy()
    expect(byText('Customer frustration')).toBeTruthy()
    // The type badge comes from the summary, not a second read.
    expect(byText('Choice')).toBeTruthy()
  })

  it('filters by name and reports a query that matches nothing', async () => {
    await render()
    await type(field('Search decisions…'), 'frustration')
    expect(byText('Support category')).toBeUndefined()
    expect(byText('Customer frustration')).toBeTruthy()

    await type(field('Search decisions…'), 'nothing here')
    expect(byText('No decisions match “nothing here”.')).toBeTruthy()
  })

  it('sends Create decision to the editor route', async () => {
    await render()
    await click(byText('Create decision'))
    expect(push).toHaveBeenCalledWith('/decisions/new')
  })

  // A decision a channel still evaluates cannot be deleted: the row menu reaches the
  // confirmation, and the workspace's refusal is what the dialog shows.
  it('refuses to delete a decision a consumer still uses', async () => {
    await render()
    await click(document.body.querySelector('button[aria-label="Actions for Support category"]'))
    await click(byText('Delete'))
    expect(byText('Delete Support category')).toBeTruthy()
    await click(byText('Delete'))
    await act(async () => {})
    expect(byText('This Decision is still used. Remove its bindings before deleting it.')).toBeTruthy()
    expect(byText('Support category')).toBeTruthy()
  })
})

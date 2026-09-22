// @vitest-environment happy-dom

// The editor owns the answer domain: it validates the resource before any write, and a
// question-type switch replaces the criteria wholesale rather than leaving a mixed draft.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider } from '@/lib/decisions/provider'

const push = vi.fn()
/** Per-test query string, so the `returnTo` guard can be exercised. */
let searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/decisions/new',
  useSearchParams: () => searchParams
}))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import DecisionEditorView from './DecisionEditorView'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  push.mockClear()
  searchParams = new URLSearchParams()
})

async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <DecisionEditorView />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
}

const click = async (node: Element | undefined | null) => {
  if (!node) throw new Error('nothing to click')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byText = (text: string) =>
  [...document.body.querySelectorAll('button, span, div, a, p')].find((node) => node.textContent?.trim() === text)

/** React tracks a controlled field's value, so a bare assignment is swallowed; set it natively. */
async function type(selector: string, index: number, value: string) {
  const nodes = [...document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector)]
  const node = nodes[index]
  if (!node) throw new Error(`no field for ${selector}[${index}]`)
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A complete, saveable choice decision — the two keys and both descriptions a save needs. */
async function fillValidChoice() {
  await type('input[placeholder="Request type"]', 0, 'Request type')
  await type('textarea[placeholder="Ask one question about currentMessage."]', 0, 'Which request is this?')
  await type('input[placeholder="key"]', 0, 'deploy')
  await type('input[placeholder="key"]', 1, 'review')
  await type('input[placeholder="What this answer means"]', 0, 'Shipping and rollbacks')
  await type('input[placeholder="What this answer means"]', 1, 'Code review')
}

describe('DecisionEditorView', () => {
  it('starts a new decision on a choice question with two empty answers', async () => {
    await render()
    expect(byText('New decision')).toBeTruthy()
    expect(document.body.querySelectorAll('input[placeholder="key"]')).toHaveLength(2)
    expect(document.body.querySelectorAll('input[placeholder="What this answer means"]')).toHaveLength(2)
    expect(byText('Create')).toBeTruthy()
  })

  it('refuses to save without a question to ask', async () => {
    await render()
    await click(byText('Create'))
    expect(byText('Give the decision a name before saving.')).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })

  // A preview parses the draft, so an unfinished question must not even offer to run — and a
  // rejection must never escape as an unhandled promise.
  it('only offers to run once the question can be evaluated', async () => {
    await render()
    const run = () => [...document.body.querySelectorAll('button')].find((node) => node.textContent?.includes('Run'))
    expect(run()?.disabled).toBe(true)

    await type('textarea[placeholder="Ask one question about currentMessage."]', 0, 'Which request is this?')
    await type('input[placeholder="key"]', 0, 'deploy')
    await type('input[placeholder="key"]', 1, 'review')
    await type('input[placeholder="What this answer means"]', 0, 'Shipping')
    await type('input[placeholder="What this answer means"]', 1, 'Review')
    expect(run()?.disabled).toBe(false)

    // Back to an unfinished question: the control returns to inert rather than rejecting.
    await type('input[placeholder="key"]', 1, '')
    expect(run()?.disabled).toBe(true)
  })

  it('creates a valid choice decision and returns to the list', async () => {
    await render()
    await fillValidChoice()
    await click(byText('Create'))
    await act(async () => {})
    expect(push).toHaveBeenCalledWith('/decisions')
  })

  it('replaces the criteria wholesale when the question type changes', async () => {
    await render()
    await click(byText('Score'))
    // Four ordered levels, re-keyed from position, and no free-text answer key field.
    expect(document.body.querySelectorAll('input[placeholder="What this level means"]')).toHaveLength(4)
    expect(document.body.querySelectorAll('input[placeholder="key"]')).toHaveLength(0)
    await click(byText('Boolean'))
    expect(document.body.querySelectorAll('input[placeholder="When this answer applies"]')).toHaveLength(2)
  })

  // `returnTo` is attacker-controllable, so only a console-relative target is honoured.
  it('never follows an absolute returnTo', async () => {
    searchParams = new URLSearchParams('returnTo=https://example.test/phish')
    await render()
    await fillValidChoice()
    await click(byText('Create'))
    await act(async () => {})
    expect(push).toHaveBeenCalledWith('/decisions')
  })
})

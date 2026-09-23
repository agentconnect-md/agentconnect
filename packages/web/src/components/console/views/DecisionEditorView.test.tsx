// @vitest-environment happy-dom

// The editor validates writes and preserves sharing that the user did not change.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as decisionProvider from '@/lib/decisions/provider'
import * as decisionMock from '@/lib/decisions/mock-api'
import { createDecisionMockSeed } from '@/lib/decisions/fixtures'
import type { MemberSetRow } from '@/lib/data'

const { DecisionsPrototypeProvider, useDecisionsPrototype } = decisionProvider
const push = vi.fn()
/** Per-test query string, so the `returnTo` guard can be exercised. */
let searchParams = new URLSearchParams()
let params: { id?: string } = {}
let store: ReturnType<typeof useDecisionsPrototype>
let memberSets: MemberSetRow[] = []
function StoreProbe() {
  store = useDecisionsPrototype()
  return null
}

vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ members: [], memberSets }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => params,
  usePathname: () => '/decisions/new',
  useSearchParams: () => searchParams
}))
vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
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
  params = {}
  memberSets = []
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
          <StoreProbe />
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
  it('offers Cloud, named groups, and machines and submits the selected scope', async () => {
    params = { id: 'support-category' }
    const seed = createDecisionMockSeed()
    const provider = seed.providers[0]!
    const providers = [
      { ...provider, daemonName: 'Example machine' },
      {
        ...provider,
        daemonId: 'pool-member-a',
        daemonName: 'Example pool node A',
        pool: true,
        readiness: { status: 'pending_sync' as const }
      },
      { ...provider, daemonId: 'pool-member-b', daemonName: 'Example pool node B', pool: true },
      { ...provider, daemonId: 'group-member', daemonName: 'Build machine', memberSetId: 'example-group' }
    ]
    const api = decisionMock.createDecisionMockApi({ seed: { ...seed, providers } })
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(api)
    memberSets = [
      {
        setId: 'example-group',
        name: 'Build group',
        memberDaemonIds: ['group-member'],
        agentCount: 1,
        spreadSessions: false
      },
      { setId: 'empty-group', name: 'Empty group', memberDaemonIds: [], agentCount: 0, spreadSessions: false }
    ]
    const catalog = vi.spyOn(decisionProvider, 'useDecisionProviders').mockReturnValue({
      providers,
      daemonId: provider.daemonId,
      error: null
    })
    await render()
    const picker = () => document.body.querySelector('button[aria-label="Runs on"]')
    const run = () => [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Run')!
    const preview = vi.spyOn(store.api, 'preview')
    expect(picker()?.textContent).toContain('AgentConnect Cloud')
    await click(run())
    expect(preview.mock.lastCall?.[0].target).toEqual({ kind: 'pool' })
    expect(preview.mock.lastCall?.[0]).not.toHaveProperty('daemonId')

    await click(picker())
    await click(document.body.querySelector('.fscrim'))
    expect(picker()?.getAttribute('aria-expanded')).toBe('false')
    await click(picker())
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options.filter((option) => option.dataset.pool)).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Example pool node')
    expect(options.find((option) => option.textContent?.includes('Empty group'))?.disabled).toBe(true)
    expect(options.find((option) => option.textContent?.includes('Example machine'))).toBeTruthy()
    await click(options.find((option) => option.textContent?.includes('Build group')))
    await click(run())
    expect(preview.mock.lastCall?.[0].target).toEqual({ kind: 'set', setId: 'example-group' })

    catalog.mockReturnValue({
      providers: providers.filter((entry) => entry.daemonId !== 'group-member'),
      daemonId: provider.daemonId,
      error: null
    })
    await type('input[placeholder="Request type"]', 0, 'Updated category')
    expect(picker()?.textContent).toContain('Build group')
    expect(run().disabled).toBe(true)

    await click(picker())
    await click(
      [...document.body.querySelectorAll('[role="option"]')].find((option) =>
        option.textContent?.includes('Example machine')
      )
    )
    await click(run())
    expect(preview.mock.lastCall?.[0].target).toEqual({ kind: 'daemon', daemonId: provider.daemonId })
  })

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

  // A preview parses the draft: an unfinished question must not offer to run at all.
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

  it('saves the combined provider and model selection with a valid choice decision', async () => {
    const seed = createDecisionMockSeed()
    seed.providers[0]!.models.push({ id: 'jev-latest', label: 'Jev latest', questionTypes: ['choice'] })
    vi.spyOn(decisionMock, 'createDecisionMockApi').mockReturnValue(decisionMock.createDecisionMockApi({ seed }))
    await render()
    await fillValidChoice()
    const create = vi.spyOn(store.api, 'createDecision')
    const picker = document.body.querySelector('button[aria-label="Provider · model"]')!
    await click(picker)
    await click(byText('Jev latest'))
    expect(picker.textContent).toContain('TypeSafe · Jev latest')
    await click(byText('Create'))
    await act(async () => {})
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'typesafe', model: 'jev-latest' }))
    expect(push).toHaveBeenCalledWith('/decisions')
  })

  it('refuses to delete a decision a consumer still uses from the editor', async () => {
    params = { id: 'support-category' }
    await render()
    await click(byText('Delete'))
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Delete Support category')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Delete'))
    expect(dialog.textContent).toContain('This Decision is still used. Remove its bindings before deleting it.')
    expect(push).not.toHaveBeenCalled()
  })

  it('duplicates the saved decision and opens the copy', async () => {
    params = { id: 'support-category' }
    await render()
    await click(byText('Duplicate'))
    const copy = store.decisions.find((entry) => entry.name === 'Support category copy')!
    expect(copy.question).toEqual(store.decisions.find((entry) => entry.id === params.id)!.question)
    expect(push).toHaveBeenCalledWith(`/decisions/${copy.id}`)
  })

  it('preserves sharing changed elsewhere while the user edits only the question', async () => {
    params = { id: 'support-category' }
    await render()
    const { name, providerId, model, question } = store.decisions.find((entry) => entry.id === params.id)!
    await act(async () => {
      await store.api.updateDecision(params.id!, {
        name,
        providerId,
        model,
        question,
        visibility: 'restricted',
        sharedWith: ['example-user']
      })
      await store.reload()
    })
    const update = vi.spyOn(store.api, 'updateDecision')
    await type('input[placeholder="Request type"]', 0, 'Edited category')
    await click(byText('Save'))
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty('visibility')
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty('sharedWith')
    expect((await store.api.getDecision(params.id!)).decision).toMatchObject({
      name: 'Edited category',
      visibility: 'restricted',
      sharedWith: ['example-user']
    })
  })

  it('warns before saving changed answers used by agents', async () => {
    params = { id: 'support-category' }
    await render()
    const getDecision = store.api.getDecision.bind(store.api)
    vi.spyOn(store.api, 'getDecision').mockImplementation(async (id) => {
      const detail = await getDecision(id)
      return {
        ...detail,
        usages: [...detail.usages, { kind: 'agent_tool', id: 'example-agent', label: 'Example agent' }]
      }
    })
    const update = vi.spyOn(store.api, 'updateDecision')
    await type('input[placeholder="What this answer means"]', 0, 'Updated answer')
    await click(byText('Save'))
    expect(byText('Review agents using this decision')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    await click(byText('Save changes'))
    expect(update).toHaveBeenCalledOnce()
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

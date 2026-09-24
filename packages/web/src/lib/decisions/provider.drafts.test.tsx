// @vitest-environment happy-dom

// Binding drafts live in the provider, so both mounted copies of a row and an inline create agree on one draft.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider, useDecisionsPrototype, type DecisionBindingDraft } from './provider'
import type { DecisionDefinition } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
const org = vi.hoisted(() => ({ id: 'org-a' }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: org.id } }) }))

let root: Root | undefined
let container: HTMLDivElement | undefined
let store: ReturnType<typeof useDecisionsPrototype>

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  org.id = 'org-a'
})

function Probe() {
  store = useDecisionsPrototype()
  return null
}

async function mount() {
  container = document.createElement('div')
  root = createRoot(container)
  const tree = () => (
    <SWRConfig value={{ provider: () => new Map() }}>
      <DecisionsPrototypeProvider>
        <Probe />
      </DecisionsPrototypeProvider>
    </SWRConfig>
  )
  await act(async () => root?.render(tree()))
  return async () => act(async () => root?.render(tree()))
}

const fresh: DecisionBindingDraft = { decisionId: null, when: null, phase: 'editing' }
const created = {
  id: 'dec-new',
  question: { type: 'boolean', instructions: 'q', criteria: { true: 'y', false: 'n' } }
} as DecisionDefinition

describe('binding drafts', () => {
  it('applies a functional pick once however many copies run it', async () => {
    await mount()
    const key = store.gateKeyFor('bot', 'C1')
    await act(async () => store.setBindingDraft(key, fresh))
    const pick = (current: DecisionBindingDraft | undefined) =>
      current && current.decisionId === null
        ? { ...current, decisionId: 'first', when: { type: 'boolean' as const, values: [true] } }
        : (current ?? null)
    await act(async () => {
      store.setBindingDraft(key, pick)
      store.setBindingDraft(key, (current) =>
        current?.decisionId === null ? { ...current, decisionId: 'second' } : (current ?? null)
      )
    })
    expect(store.bindingDrafts[key]?.decisionId).toBe('first')
    await act(async () => store.setBindingDraft(key, null))
    expect(store.bindingDrafts[key]).toBeUndefined()
  })

  it('keys drafts by organization, so another org’s row never sees them', async () => {
    const rerender = await mount()
    const keyA = store.gateKeyFor('bot', 'C1')
    await act(async () => store.setBindingDraft(keyA, fresh))
    org.id = 'org-b'
    await rerender()
    expect(store.gateKeyFor('bot', 'C1')).not.toBe(keyA)
    expect(store.bindingDrafts[store.gateKeyFor('bot', 'C1')]).toBeUndefined()
  })

  it('seeds only the draft that began an inline create, once', async () => {
    await mount()
    const key = store.gateKeyFor('bot', 'C1')
    const other = store.gateKeyFor('bot', 'C2')
    await act(async () => store.completeInlineCreate(created))
    expect(store.bindingDrafts).toEqual({})
    await act(async () => {
      store.setBindingDraft(other, fresh)
      store.beginInlineCreate(key)
    })
    await act(async () => store.completeInlineCreate(created))
    expect(store.bindingDrafts[key]).toEqual({
      decisionId: 'dec-new',
      when: { type: 'boolean', values: [true, false] },
      phase: 'editing'
    })
    expect(store.bindingDrafts[other]).toEqual(fresh)
    await act(async () => store.setBindingDraft(key, null))
    await act(async () => store.completeInlineCreate(created))
    expect(store.bindingDrafts[key]).toBeUndefined()
  })
})

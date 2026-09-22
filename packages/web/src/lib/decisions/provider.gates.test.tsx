// @vitest-environment happy-dom

// The prototype gates are the one invalidation the mock service cannot record, so the
// provider has to: an edit that strands a saved condition must leave that gate flagged for
// review — including a Score rubric-length change, whose old interval still fits but no
// longer means the same thing (docs/designs/decisions.md §6.1).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider, useDecisionsPrototype } from './provider'
import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'

vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: () => true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-a' }, myRole: 'owner', orgPath: (path: string) => path })
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const fourLevels: DecisionQuestion = {
  type: 'score',
  instructions: 'How severe?',
  criteria: ['Calm', 'Concerned', 'Dissatisfied', 'Leaving']
}
const fiveLevels: DecisionQuestion = { ...fourLevels, criteria: [...fourLevels.criteria, 'Escalated'] }

/** Drives the provider exactly as the editor does, and reports what a usage row would read. */
function Probe({ previous, next }: { previous: DecisionQuestion; next: DecisionQuestion }) {
  const { gates, setGate, markGatesForReview, decisions } = useDecisionsPrototype()
  const decision = decisions[0]
  if (!decision) return <span>loading</span>
  return (
    <button
      type="button"
      onClick={() => {
        setGate('org-a|bot-a|C1', {
          decisionId: decision.id,
          when: { type: 'score', min: 2.5, max: 3 },
          channelName: '#help'
        })
        markGatesForReview(decision.id, previous, next)
      }}
    >
      {String(gates['org-a|bot-a|C1']?.needsReview === true)}
    </button>
  )
}

async function render(previous: DecisionQuestion, next: DecisionQuestion) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <DecisionsPrototypeProvider>
          <Probe previous={previous} next={next} />
        </DecisionsPrototypeProvider>
      </SWRConfig>
    )
  })
  await act(async () => {})
  await act(async () => {
    container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return container?.querySelector('button')?.textContent
}

/** The store owns the tenant half of a binding's identity, so a row never asks the org context. */
function KeyProbe() {
  const { gateKeyFor } = useDecisionsPrototype()
  return <span>{gateKeyFor('bot-a', 'C123')}</span>
}

describe('gateKeyFor', () => {
  it('composes the active organization, the owning bot, and the conversation', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <DecisionsPrototypeProvider>
            <KeyProbe />
          </DecisionsPrototypeProvider>
        </SWRConfig>
      )
    })
    expect(container.querySelector('span')?.textContent).toBe('org-a|bot-a|C123')
  })
})

describe('markGatesForReview', () => {
  it('flags a gate whose interval survives a rubric-length change but no longer means the same', async () => {
    expect(await render(fourLevels, fiveLevels)).toBe('true')
  })

  it('flags a gate the edited question genuinely invalidates', async () => {
    const booleanNext: DecisionQuestion = {
      type: 'boolean',
      instructions: 'Same?',
      criteria: { true: 'y', false: 'n' }
    }
    expect(await render(fourLevels, booleanNext)).toBe('true')
  })

  it('leaves a gate alone when the edit does not touch its condition', async () => {
    expect(await render(fourLevels, { ...fourLevels })).toBe('false')
  })
})

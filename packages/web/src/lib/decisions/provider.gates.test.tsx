// @vitest-environment happy-dom

// The store outlives a route change AND an organization switch, so the organization is part
// of its state: no tenant's decisions or gates may reach another's Used by, review warning,
// or delete guard. It also records the gate invalidation the mock service cannot see.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecisionsPrototypeProvider, useDecisionsPrototype } from './provider'
import type { DecisionQuestion } from '@agentconnect.md/protocol/decision'

const mocks = vi.hoisted(() => ({ orgId: 'org-a' }))

vi.mock('@/lib/data', async (original) => ({ ...(await original<object>()), MOCK_MODE: true }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: mocks.orgId }, myRole: 'owner', orgPath: (path: string) => path })
}))

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  mocks.orgId = 'org-a'
})

const fourLevels: DecisionQuestion = {
  type: 'score',
  instructions: 'How severe?',
  criteria: ['Calm', 'Concerned', 'Dissatisfied', 'Leaving']
}
const fiveLevels: DecisionQuestion = { ...fourLevels, criteria: [...fourLevels.criteria, 'Escalated'] }

const read = (testId: string) => container?.querySelector(`[data-testid="${testId}"]`)?.textContent
const press = async (label: string) => {
  const node = [...(container?.querySelectorAll('button') ?? [])].find((button) => button.textContent === label)
  if (!node) throw new Error(`no button reading "${label}"`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function tree(node: ReactNode) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DecisionsPrototypeProvider>{node}</DecisionsPrototypeProvider>
    </SWRConfig>
  )
}

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(tree(node))
  })
  await act(async () => {})
}

/** Re-renders the SAME provider instance, which is what an organization switch does. */
async function rerender(node: ReactNode) {
  await act(async () => {
    root?.render(tree(node))
  })
  await act(async () => {})
}

/** Drives the provider the way the views do, and reports what they would read. */
function TenantProbe({ tick }: { tick: number }) {
  const { decisions, setGate, gateUsages, gateKeyFor, api, reload } = useDecisionsPrototype()
  const first = decisions[0]
  return (
    <div data-tick={tick}>
      <span data-testid="org-key">{gateKeyFor('bot-a', 'C123')}</span>
      <span data-testid="usages">{first ? gateUsages(first.id).length : 'no decision'}</span>
      <span data-testid="decisions">{decisions.length}</span>
      <button
        type="button"
        onClick={() => {
          if (!first) return
          setGate(gateKeyFor('bot-a', 'C123'), {
            decisionId: first.id,
            when: { type: 'boolean', values: [true, false] },
            channelName: '#help'
          })
        }}
      >
        gate
      </button>
      <button
        type="button"
        onClick={() => {
          void api
            .createDecision({
              name: 'Tenant-local',
              providerId: 'typesafe',
              model: 'jev-1.13.0',
              question: { type: 'boolean', instructions: 'Tenant local?', criteria: { true: 'y', false: 'n' } }
            })
            .then(() => reload())
        }}
      >
        create
      </button>
    </div>
  )
}

describe('organization partition', () => {
  it('composes the active organization, the owning bot, and the conversation', async () => {
    await mount(<TenantProbe tick={0} />)
    expect(read('org-key')).toBe('org-a|bot-a|C123')
  })

  // A decision id is unique only inside its tenant, and one mount serves every tenant.
  it('keeps each organization’s decisions and gate usages in its own partition', async () => {
    await mount(<TenantProbe tick={0} />)
    const seeded = Number(read('decisions'))
    await press('gate')
    await press('create')
    expect(read('usages')).toBe('1')
    expect(read('decisions')).toBe(String(seeded + 1))

    mocks.orgId = 'org-b'
    await rerender(<TenantProbe tick={1} />)
    expect(read('org-key')).toBe('org-b|bot-a|C123')
    // Neither the other tenant's gate nor its decision may surface here.
    expect(read('usages')).toBe('0')
    expect(read('decisions')).toBe(String(seeded))

    // Switching back finds the first tenant's partition intact, not reset.
    mocks.orgId = 'org-a'
    await rerender(<TenantProbe tick={2} />)
    expect(read('usages')).toBe('1')
    expect(read('decisions')).toBe(String(seeded + 1))
  })
})

/** Drives the provider exactly as the editor does, and reports what a usage row would read. */
function ReviewProbe({ previous, next }: { previous: DecisionQuestion; next: DecisionQuestion }) {
  const { decisions, setGate, gateKeyFor, markGatesForReview, gateUsages } = useDecisionsPrototype()
  const decision = decisions[0]
  if (!decision) return <span>loading</span>
  return (
    <button
      type="button"
      onClick={() => {
        setGate(gateKeyFor('bot-a', 'C1'), {
          decisionId: decision.id,
          when: { type: 'score', min: 2.5, max: 3 },
          channelName: '#help'
        })
        markGatesForReview(decision.id, previous, next)
      }}
    >
      {String(gateUsages(decision.id)[0]?.needsReview === true)}
    </button>
  )
}

describe('markGatesForReview', () => {
  it('flags a gate whose interval survives a rubric-length change but no longer means the same', async () => {
    await mount(<ReviewProbe previous={fourLevels} next={fiveLevels} />)
    await press('false')
    expect(container?.querySelector('button')?.textContent).toBe('true')
  })

  it('flags a gate the edited question genuinely invalidates', async () => {
    const booleanNext: DecisionQuestion = {
      type: 'boolean',
      instructions: 'Same?',
      criteria: { true: 'y', false: 'n' }
    }
    await mount(<ReviewProbe previous={fourLevels} next={booleanNext} />)
    await press('false')
    expect(container?.querySelector('button')?.textContent).toBe('true')
  })

  it('leaves a gate alone when the edit does not touch its condition', async () => {
    await mount(<ReviewProbe previous={fourLevels} next={{ ...fourLevels }} />)
    await press('false')
    expect(container?.querySelector('button')?.textContent).toBe('false')
  })
})

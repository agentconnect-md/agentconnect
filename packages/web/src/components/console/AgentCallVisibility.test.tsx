// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS, agentLabel } from '@/lib/data'

vi.mock('@/components/marks', () => ({
  AgentIconView: () => <span data-testid="agent-icon" />
}))

import { AgentCallVisibility } from './AgentCallVisibility'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('AgentCallVisibility', () => {
  it('consolidates effective all-agent reachability into the main summary', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const peers = AGENTS.slice(0, 3)

    await act(async () => {
      root?.render(
        <>
          <AgentCallVisibility
            variant="section"
            direction="inbound"
            mode="all"
            selectedIds={[]}
            effectivePeerIds={peers.map((peer) => peer.id)}
            peers={peers}
            daemons={[]}
            target="review-bot"
            onChange={() => undefined}
          />
          <AgentCallVisibility
            variant="section"
            direction="outbound"
            mode="all"
            selectedIds={[]}
            effectivePeerIds={peers.slice(0, 2).map((peer) => peer.id)}
            peers={peers}
            daemons={[]}
            target="review-bot"
            onChange={() => undefined}
          />
        </>
      )
    })

    expect(container.textContent).toContain('review-bot accepts calls from all agents.')
    expect(container.textContent).toContain('review-bot can call 2 of 3 agents.')
    expect(container.textContent).not.toContain('Controls incoming direct tasks.')
    expect(container.textContent).not.toContain('Controls outgoing direct tasks.')
    expect(container.textContent).not.toContain('Can call this agent')
    expect(container.textContent).not.toContain('This agent can call')
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      `${agentLabel(peers[2]!)} can't accept this agent's call.`
    )
  })

  it('lets the selected-agent menu extend beyond a section card', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <AgentCallVisibility
          variant="section"
          direction="inbound"
          mode="selected"
          selectedIds={[]}
          effectivePeerIds={[]}
          peers={AGENTS.slice(0, 2)}
          daemons={[]}
          target="this agent"
          onChange={() => undefined}
        />
      )
    })

    const section = container.firstElementChild
    const input = container.querySelector('input')

    expect(section?.classList.contains('overflow-visible')).toBe(true)
    expect(section?.classList.contains('overflow-hidden')).toBe(false)

    await act(async () => input?.focus())

    expect(input?.parentElement?.nextElementSibling?.classList.contains('absolute')).toBe(true)
  })

  // `/agents` hides restricted peers from non-owners while the CP keeps their
  // grants (resolvePolicyAgentIds retains hidden ids). Resolving the allow-list
  // through the viewer's peer list therefore under-reports it, and the read-only
  // Access card must not claim an active grant is empty.
  const renderReadOnly = async (props: { selectedIds: string[]; peers: typeof AGENTS }) => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <AgentCallVisibility
          variant="section"
          direction="inbound"
          mode="selected"
          selectedIds={props.selectedIds}
          effectivePeerIds={[]}
          peers={props.peers}
          daemons={[]}
          target="review-bot"
          editable={false}
          onChange={() => undefined}
        />
      )
    })
    return container
  }

  it('reports a selection of only hidden peers as hidden, not empty', async () => {
    const el = await renderReadOnly({ selectedIds: ['restricted-peer-id'], peers: AGENTS.slice(0, 2) })

    expect(el.textContent).not.toContain('No agents selected.')
    expect(el.textContent).not.toContain('No peers selected')
    expect(el.textContent).toContain('1 not visible')
    // The count reflects the whole grant, not just the resolvable half.
    expect(el.textContent).toContain('0 of 1')
  })

  it('counts hidden peers alongside visible ones', async () => {
    const peers = AGENTS.slice(0, 2)
    const el = await renderReadOnly({ selectedIds: [peers[0]!.id, 'restricted-peer-id'], peers })

    expect(el.textContent).toContain(agentLabel(peers[0]!))
    expect(el.textContent).toContain('1 not visible')
    expect(el.textContent).toContain('0 of 2')
  })

  it('still reports a genuinely empty allow-list as empty', async () => {
    const el = await renderReadOnly({ selectedIds: [], peers: AGENTS.slice(0, 2) })

    expect(el.textContent).toContain('No agents selected.')
    expect(el.textContent).toContain('No peers selected')
    expect(el.textContent).not.toContain('not visible')
  })

  it('renders no editing affordances when read-only', async () => {
    const el = await renderReadOnly({ selectedIds: [AGENTS[0]!.id], peers: AGENTS.slice(0, 2) })

    expect(el.querySelector('input')).toBeNull() // no "Search agents…" field
    expect(el.querySelector('[role="group"]')).toBeNull() // no All agents/Selected toggle
    expect(el.querySelectorAll('button')).toHaveLength(0) // no mode or remove buttons
    expect(el.textContent).toContain('Selected agents') // the read-only state line instead
  })
})

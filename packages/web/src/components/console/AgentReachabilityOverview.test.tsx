// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS } from '@/lib/data'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path })
}))

vi.mock('@/components/marks', () => ({
  AgentIconView: () => <span data-testid="agent-icon" />,
  LoadingState: () => <span>Loading</span>
}))

import { AgentReachabilityOverview, layoutGraph } from './AgentReachabilityOverview'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('layoutGraph', () => {
  const policy = (id: string) => ({
    id,
    callPolicy: 'selected' as const,
    allowedCallerAgentIds: [] as string[],
    outboundPolicy: 'selected' as const,
    allowedTargetAgentIds: [] as string[]
  })

  it('wraps a crowded layer into sub-columns instead of one tall stack', () => {
    const isolated = Array.from({ length: 12 }, (_, index) => policy(`agent-${index}`))
    const layout = layoutGraph(buildAgentReachabilityGraph(isolated))

    const xs = new Set([...layout.nodes.values()].map((node) => node.x))
    expect(xs.size).toBeGreaterThan(1)
    // Far below the ~1,000px a single 12-node column would need.
    expect(layout.height).toBeLessThan(500)
  })

  it('keeps a small layer as a single column', () => {
    const isolated = Array.from({ length: 3 }, (_, index) => policy(`agent-${index}`))
    const layout = layoutGraph(buildAgentReachabilityGraph(isolated))

    const xs = new Set([...layout.nodes.values()].map((node) => node.x))
    expect(xs.size).toBe(1)
  })
})

describe('AgentReachabilityOverview cycle groups', () => {
  it('highlights a selected group without repeating cycle badges on its agents', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<AgentReachabilityOverview agents={AGENTS} daemons={[]} loading={false} />)
    })

    const graph = buildAgentReachabilityGraph(AGENTS)
    const cycle = graph.components.find((component) => component.cyclic)!
    const groupButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Group 1')
    )!
    const agentLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href^="/agents/"]'))
    const graphCanvas = container.querySelector('svg')?.parentElement

    expect(graphCanvas?.classList.contains('mx-auto')).toBe(true)
    expect(groupButton.getAttribute('aria-pressed')).toBe('false')
    expect(agentLinks.every((link) => !link.textContent?.toLowerCase().includes('cycle'))).toBe(true)

    await act(async () => groupButton.click())

    expect(groupButton.getAttribute('aria-pressed')).toBe('true')
    for (const link of agentLinks) {
      const agentId = link.getAttribute('href')?.split('/').pop()
      expect(link.classList.contains('opacity-30')).toBe(!cycle.agentIds.includes(agentId ?? ''))
      expect(link.classList.contains('opacity-100')).toBe(cycle.agentIds.includes(agentId ?? ''))
    }

    await act(async () => groupButton.click())
    expect(groupButton.getAttribute('aria-pressed')).toBe('false')
    expect(agentLinks.every((link) => link.classList.contains('opacity-100'))).toBe(true)
  })
})

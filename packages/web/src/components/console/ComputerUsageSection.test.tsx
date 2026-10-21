// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerUsageDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ fetchComputerUsage: vi.fn() }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' } }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchComputerUsage: mocks.fetchComputerUsage
}))

const { default: ComputerUsageSection, hasComputerUsage } = await import('./ComputerUsageSection')

const row = { runningSeconds: 0, sleepingSeconds: 0, volumeGibSeconds: 0, relayedBytes: 0 }
const usage = (over: Partial<ComputerUsageDto> = {}): ComputerUsageDto => ({
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-22T00:00:00.000Z',
  totals: row,
  allocations: [],
  days: [],
  computers: [],
  screenshots: { written: { count: 0, bytes: 0 }, stored: { count: 0, bytes: 0 } },
  ...over
})

async function render(): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ComputerUsageSection range="d30" />
      </SWRConfig>
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return host
}

describe('ComputerUsageSection', () => {
  it('shows desktop hours, kept storage, viewer video and screenshots per Computer', async () => {
    const metered = { runningSeconds: 7200, sleepingSeconds: 36_000, volumeGibSeconds: 5 * 43_200, relayedBytes: 3e9 }
    mocks.fetchComputerUsage.mockResolvedValue(
      usage({
        totals: metered,
        computers: [{ ...metered, computerId: 'c1', name: 'Ops desktop', kind: 'managed', allocation: 'per-agent' }],
        screenshots: { written: { count: 4, bytes: 2e6 }, stored: { count: 3, bytes: 1.5e6 } }
      })
    )
    const el = await render()
    expect(el.querySelector('[data-computer-usage-tile="running"]')?.textContent).toContain('2')
    expect(el.querySelector('[data-computer-usage-tile="running"]')?.textContent).toContain('10 h sleeping')
    expect(el.querySelector('[data-computer-usage-tile="storage"]')?.textContent).toContain('60')
    expect(el.querySelector('[data-computer-usage-tile="media"]')?.textContent).toContain('3')
    expect(el.querySelector('[data-computer-usage-row="c1"]')?.textContent).toContain('Ops desktop')
    expect(el.querySelector('[data-computer-usage-row="c1"]')?.textContent).toContain('Per agent')
  })

  it('stays out of the way for an organization that metered nothing', async () => {
    mocks.fetchComputerUsage.mockResolvedValue(usage())
    const el = await render()
    expect(el.querySelector('[data-computer-usage]')).toBeNull()
    expect(
      hasComputerUsage(usage({ screenshots: { written: { count: 1, bytes: 1 }, stored: { count: 0, bytes: 0 } } }))
    ).toBe(true)
  })
})

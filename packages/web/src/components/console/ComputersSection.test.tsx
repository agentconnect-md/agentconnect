// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  computers: undefined as unknown,
  pool: { enabled: false, available: false },
  flags: new Set<string>(),
  openModal: vi.fn(),
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { userId: 'u1' } }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: 'a1', name: 'ops', displayName: 'Ops bot' }],
    members: [{ userId: 'u2', name: 'Dana', email: null }]
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputers: () => ({ data: mocks.computers, error: undefined, isLoading: mocks.computers === undefined }),
  useComputerPool: () => ({ data: mocks.pool })
}))
vi.mock('@/lib/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags')>()),
  featureFlagEnabled: (id: string) => mocks.flags.has(id)
}))

const { ComputersSection } = await import('./ComputersSection')

let host: HTMLDivElement
let root: Root

function render(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ComputersSection />))
  return host
}

beforeEach(() => {
  mocks.computers = []
  mocks.pool = { enabled: false, available: false }
  mocks.flags = new Set()
  mocks.openModal.mockClear()
  mocks.push.mockClear()
  document.body.innerHTML = ''
})

describe('ComputersSection', () => {
  it('offers Add computer from the empty state', () => {
    const el = render()
    expect(el.textContent).toContain('Add a computer to let agents')
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add computer'))!
    act(() => add.click())
    expect(mocks.openModal).toHaveBeenCalledWith('computer')
  })

  it('lists status, platform, granted agents and doctor failures, and opens the detail', () => {
    mocks.computers = [
      computer({
        agentAccess: { mode: 'selected', agents: ['a1'] },
        doctor: {
          checkedAt: '2026-10-21T00:00:00.000Z',
          checks: [{ name: 'driver', status: 'fail', detail: 'missing', fix: 'run setup' }]
        }
      }),
      computer({
        id: 'c2',
        name: 'mac',
        os: 'macos',
        session: 'aqua',
        ownerUserId: 'u2',
        status: 'revoked',
        agentAccess: { mode: 'all', agents: [] }
      })
    ]
    const el = render()
    const first = el.querySelector('[data-computer-row="c1"]')!
    expect(first.textContent).toContain('Online')
    expect(first.textContent).toContain('Linux · X11 · Ops bot')
    expect(first.textContent).toContain('1 check failing')
    const second = el.querySelector('[data-computer-row="c2"]')!
    expect(second.textContent).toContain('Revoked')
    expect(second.textContent).toContain('macOS · Aqua · All agents')
    expect(second.textContent).toContain('Checks not reported')
    act(() => (first as HTMLElement).click())
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/c1')
  })

  it('heads the section with its count as an anchor the old route lands on', () => {
    mocks.computers = [computer(), computer({ id: 'c2', status: 'offline' })]
    const el = render()
    const heading = el.querySelector('#computers')!
    expect(heading.textContent).toBe('Computers')
    expect(heading.parentElement!.textContent).toContain('2')
    expect(el.textContent).toContain('Desktops your agents can see and operate')
  })

  it('shows the managed pool as one entry, named for a self-hosted cluster, and lists only self-hosted computers', () => {
    mocks.pool = { enabled: true, available: true }
    mocks.computers = [
      computer(),
      computer({ id: 'p1', name: 'Shared browser', kind: 'managed', allocation: 'manual' }),
      computer({ id: 'p2', name: 'ops desktop', kind: 'managed', allocation: 'per-agent', status: 'sleeping' })
    ]
    const el = render()
    const entry = el.querySelector('[data-computer-pool]')!
    expect(entry.textContent).toContain('Computer pool')
    expect(entry.textContent).toContain('1 running · 1 asleep')
    expect(entry.textContent).toContain('Available')
    expect(el.querySelector('[data-computer-row="c1"]')).not.toBeNull()
    expect(el.querySelector('[data-computer-row="p1"]')).toBeNull()
    act(() => (entry as HTMLElement).click())
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/pool')
  })

  it('names the pool AgentConnect Computers on the managed install, and shows it before the first managed computer', () => {
    mocks.flags = new Set(['managed'])
    mocks.pool = { enabled: true, available: false }
    const el = render()
    const entry = el.querySelector('[data-computer-pool]')!
    expect(entry.textContent).toContain('AgentConnect Computers')
    expect(entry.textContent).toContain('No managed computers yet')
    expect(entry.textContent).toContain('Unavailable')
    expect(el.textContent).not.toContain('Add a computer to let agents')
  })

  it('keeps the entry while managed computers remain on a deployment that turned the pool off', () => {
    mocks.computers = [computer({ id: 'p1', kind: 'managed', allocation: 'manual' })]
    expect(render().querySelector('[data-computer-pool]')).not.toBeNull()
  })
})

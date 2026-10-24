// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  computers: [] as unknown[],
  pool: { enabled: true, available: true },
  flags: new Set<string>(['computer-use']),
  openModal: vi.fn(),
  registerCrumb: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [{ id: 'a1', name: 'ops', displayName: 'Ops bot' }], members: [] })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/components/console/Shell', () => ({ useCrumbSlot: () => ({ register: mocks.registerCrumb }) }))
vi.mock('@/components/console/NotFound', () => ({
  NotFound: ({ title }: { title: string }) => <div data-not-found>{title}</div>
}))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputers: () => ({ data: mocks.computers, error: undefined, isLoading: false }),
  useComputerPool: () => ({ data: mocks.pool })
}))
vi.mock('@/lib/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feature-flags')>()),
  featureFlagEnabled: (id: string) => mocks.flags.has(id)
}))

const ComputerPoolView = (await import('./ComputerPoolView')).default

let root: Root
function render(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ComputerPoolView />))
  return host
}

beforeEach(() => {
  mocks.computers = []
  mocks.pool = { enabled: true, available: true }
  mocks.flags = new Set(['computer-use'])
  mocks.openModal.mockClear()
  mocks.registerCrumb.mockClear()
  document.body.innerHTML = ''
})

describe('ComputerPoolView', () => {
  it('lists the managed computers only, marking each allocation and who has control', () => {
    mocks.computers = [
      computer({ id: 'c1', name: 'my desk' }),
      computer({
        id: 'p1',
        name: 'Shared browser',
        kind: 'managed',
        allocation: 'manual',
        poolPhase: 'awake',
        agentAccess: { mode: 'selected', agents: ['a1'] },
        lease: { sessionId: 's1', agentId: 'a1', agentName: 'ops', acquiredAt: new Date().toISOString() },
        waiting: [{ sessionId: 's2', agentId: 'a9', since: new Date().toISOString() }]
      }),
      computer({
        id: 'p2',
        name: 'ops desktop',
        kind: 'managed',
        allocation: 'per-agent',
        ownerAgentId: 'a1',
        status: 'sleeping',
        poolPhase: 'sleeping'
      }),
      computer({ id: 'p3', name: 'starting', kind: 'managed', allocation: 'manual', poolPhase: 'resetting' })
    ]
    const el = render()
    expect(el.querySelector('h1')!.textContent).toBe('Computer pool')
    expect(el.textContent).toContain('2 running · 1 asleep')
    expect(el.querySelector('[data-computer-row="c1"]')).toBeNull()
    const shared = el.querySelector('[data-computer-row="p1"]')!
    expect(shared.textContent).toContain('Pool')
    expect(shared.querySelector('[data-lease-holder="a1"]')!.textContent).toBe('In use by Ops bot · 1 waiting')
    const own = el.querySelector('[data-computer-row="p2"]')!
    expect(own.textContent).toContain('Asleep')
    expect(own.textContent).toContain("Agent's own")
    expect(own.textContent).toContain('for Ops bot')
    expect(el.querySelector('[data-computer-row="p3"]')!.textContent).toContain('Resetting')
    expect(mocks.registerCrumb).toHaveBeenCalledWith(expect.objectContaining({ id: 'pool', title: 'Computer pool' }))
  })

  it('opens Add computer on the managed source, under the managed install’s name', () => {
    mocks.flags = new Set(['computer-use', 'managed'])
    const el = render()
    expect(el.querySelector('h1')!.textContent).toBe('AgentConnect Computers')
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add managed computer'))!
    act(() => add.click())
    expect(mocks.openModal).toHaveBeenCalledWith('computer', undefined, { computerSource: 'pool' })
  })

  it('reads as not found where the deployment runs no pool and the organization has no managed computer', () => {
    mocks.pool = { enabled: false, available: false }
    expect(render().querySelector('[data-not-found]')!.textContent).toBe('This deployment runs no managed computers')
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture as computer } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  computers: undefined as unknown,
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
  useComputers: () => ({ data: mocks.computers, error: undefined, isLoading: mocks.computers === undefined })
}))

const ComputersView = (await import('./ComputersView')).default

let host: HTMLDivElement
let root: Root

function render(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ComputersView />))
  return host
}

beforeEach(() => {
  mocks.computers = []
  mocks.openModal.mockClear()
  mocks.push.mockClear()
  document.body.innerHTML = ''
})

describe('ComputersView', () => {
  it('offers Add computer from the empty state', () => {
    const el = render()
    expect(el.textContent).toContain('No computers yet')
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Add computer'))!
    act(() => add.click())
    expect(mocks.openModal).toHaveBeenCalledWith('computer')
  })

  it('lists status, platform, owner, granted agents and doctor failures, and opens the detail', () => {
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
    expect(first.textContent).toContain('Linux · X11 · owned by You')
    expect(first.textContent).toContain('Ops bot')
    expect(first.textContent).toContain('1 check failing')
    const second = el.querySelector('[data-computer-row="c2"]')!
    expect(second.textContent).toContain('Revoked')
    expect(second.textContent).toContain('owned by Dana')
    expect(second.textContent).toContain('All agents')
    expect(second.textContent).toContain('Checks not reported')
    act(() => (first as HTMLElement).click())
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/c1')
  })

  it('renders the mobile summary strip and keeps the desktop header out of the mobile layout', () => {
    mocks.computers = [computer(), computer({ id: 'c2', status: 'offline' })]
    const el = render()
    const strip = [...el.querySelectorAll('div')].find((d) => d.className.includes('desktop:hidden'))!
    expect(strip.textContent).toContain('1 connected')
    expect(strip.textContent).toContain('1 disconnected')
    // The Shell app bar's "+" opens the dialog on mobile, so the in-page header is desktop-only.
    const header = [...el.querySelectorAll('div')].find((d) => d.className.includes('hidden min-h-[34px]'))!
    expect(header.className).toContain('desktop:flex')
  })
})

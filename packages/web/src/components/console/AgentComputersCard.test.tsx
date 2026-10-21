// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: undefined as unknown,
  computers: [] as unknown[],
  addComputerAgent: vi.fn(),
  removeComputerAgent: vi.fn(),
  refresh: vi.fn(),
  mutate: vi.fn(),
  updateAgent: vi.fn(),
  pool: { enabled: false, available: false },
  mobile: false
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ getAgent: () => mocks.agent, refresh: mocks.refresh })
}))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputers: () => ({ data: mocks.computers, error: undefined, mutate: mocks.mutate }),
  useComputerPool: () => ({ data: mocks.pool })
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  addComputerAgent: mocks.addComputerAgent,
  removeComputerAgent: mocks.removeComputerAgent,
  updateAgent: mocks.updateAgent
}))

const { AgentComputersCard } = await import('./AgentComputersCard')

function render(canEdit = true, canEditAgent = true): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(<AgentComputersCard agentId="a1" canEdit={canEdit} canEditAgent={canEditAgent} />))
  return host
}

const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const openMenu = (el: HTMLElement) =>
  act(() => [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-haspopup') === 'menu')!.click())

beforeEach(() => {
  mocks.addComputerAgent.mockReset().mockResolvedValue(undefined)
  mocks.removeComputerAgent.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
  mocks.mutate.mockReset().mockResolvedValue(undefined)
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.pool = { enabled: false, available: false }
  mocks.mobile = false
  mocks.agent = { id: 'a1' }
  mocks.computers = [computerFixture()]
  document.body.innerHTML = ''
})

describe('AgentComputersCard', () => {
  it('lists no computer until one gives the agent access, and adds one the caller can edit', async () => {
    mocks.computers = [computerFixture(), computerFixture({ id: 'c2', name: 'not-mine', canEditAgentAccess: false })]
    const el = render()
    expect(el.textContent).toContain('No computers yet')
    openMenu(el)
    expect(menuItems().map((b) => b.textContent)).toEqual([expect.stringContaining('ubuntu-desk')])
    await act(async () => menuItems()[0]!.click())
    expect(mocks.addComputerAgent).toHaveBeenCalledWith('c1', 'a1')
    expect(mocks.mutate).toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('shows the computers that grant the agent and takes away a Selected one', async () => {
    mocks.computers = [computerFixture({ agentAccess: { mode: 'selected', agents: ['a1'] } })]
    const el = render()
    expect(el.textContent).toContain('ubuntu-desk')
    expect(el.textContent).toContain('selected agents')
    await act(async () =>
      el.querySelector<HTMLButtonElement>('button[title="Take away this agent\'s access"]')!.click()
    )
    expect(mocks.removeComputerAgent).toHaveBeenCalledWith('c1', 'a1')
  })

  it('shows a computer granted to all agents without a remove, and never offers it', () => {
    mocks.computers = [
      computerFixture({ agentAccess: { mode: 'all', agents: [] } }),
      computerFixture({ id: 'c2', name: 'shared-all', agentAccess: { mode: 'all', agents: [] } })
    ]
    const el = render()
    expect(el.textContent).toContain('all agents')
    expect(el.querySelector('button[title="Take away this agent\'s access"]')).toBeNull()
    openMenu(el)
    expect(document.body.textContent).toContain('No more computers you can give it')
  })

  it('offers no change on a computer the caller cannot edit, and names one they cannot see', () => {
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: ['c1', 'c9'] } }
    mocks.computers = [
      computerFixture({ agentAccess: { mode: 'selected', agents: ['a1'] }, canEditAgentAccess: false })
    ]
    const el = render()
    expect(el.querySelector('button[title="Take away this agent\'s access"]')).toBeNull()
    expect(el.textContent).toContain("A computer you can't see")
    expect(el.textContent).toContain('c9')
  })

  it('hides the managed mode where no pool runs and the agent has none', () => {
    const el = render()
    expect(el.querySelector('[data-managed-mode]')).toBeNull()
  })

  it('switches the agent to its own managed computer', async () => {
    mocks.pool = { enabled: true, available: true }
    const el = render()
    const tile = (title: string) =>
      [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((t) => t.textContent?.includes(title))!
    expect(tile('Off').getAttribute('aria-checked')).toBe('true')
    await act(async () => tile('One for this agent').click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('a1', { computerUse: { managed: { mode: 'per-agent' } } })
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('shows a per-agent agent’s one computer, asleep, apart from the computers that grant it', () => {
    mocks.pool = { enabled: true, available: true }
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: ['m1'], managed: { mode: 'per-agent' } } }
    mocks.computers = [
      computerFixture({
        id: 'm1',
        name: 'ops desktop',
        kind: 'managed',
        allocation: 'per-agent',
        ownerAgentId: 'a1',
        status: 'sleeping',
        poolPhase: 'sleeping',
        agentAccess: { mode: 'selected', agents: ['a1'] }
      })
    ]
    const el = render()
    const desktop = el.querySelector<HTMLElement>('[data-agent-desktop="m1"]')!
    expect(desktop.textContent).toContain('ops desktop')
    expect(desktop.textContent).toContain('Asleep')
    // Not repeated as a granted computer.
    expect(el.textContent).toContain('No computers yet')
  })

  it('says the per-agent computer comes with the first use, on a phone too, and is read-only without agent rights', async () => {
    mocks.pool = { enabled: true, available: true }
    mocks.mobile = true
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: [], managed: { mode: 'per-agent' } } }
    const el = render(true, false)
    expect(el.textContent).toContain('Created on its first use')
    expect(el.textContent).toContain('Only editors of this agent can change this')
    const pills = [...el.querySelectorAll<HTMLButtonElement>('[data-managed-mode] button[aria-pressed]')]
    expect(pills.map((b) => b.textContent)).toEqual(['Off', 'New each session', 'One for this agent'])
    expect(pills.every((b) => b.disabled)).toBe(true)
    await act(async () => pills[1]!.click())
    expect(mocks.updateAgent).not.toHaveBeenCalled()
  })

  it('still shows a per-agent desktop the agent keeps after its mode is turned off, even without a pool', () => {
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: ['m1'] } }
    mocks.computers = [
      computerFixture({
        id: 'm1',
        name: 'ops desktop',
        kind: 'managed',
        allocation: 'per-agent',
        ownerAgentId: 'a1',
        status: 'sleeping',
        poolPhase: 'sleeping',
        agentAccess: { mode: 'selected', agents: ['a1'] }
      })
    ]
    const el = render()
    expect(el.querySelector('[data-managed-mode]')?.getAttribute('data-managed-mode')).toBe('off')
    const desktop = el.querySelector<HTMLElement>('[data-agent-desktop="m1"]')!
    expect(desktop.textContent).toContain('ops desktop')
    expect(desktop.textContent).toContain('still usable by it')
  })
})

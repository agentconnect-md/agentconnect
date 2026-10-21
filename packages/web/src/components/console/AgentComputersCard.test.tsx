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
  mutate: vi.fn()
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
  useComputers: () => ({ data: mocks.computers, error: undefined, mutate: mocks.mutate })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  addComputerAgent: mocks.addComputerAgent,
  removeComputerAgent: mocks.removeComputerAgent
}))

const { AgentComputersCard } = await import('./AgentComputersCard')

function render(canEdit = true): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(<AgentComputersCard agentId="a1" canEdit={canEdit} />))
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
})

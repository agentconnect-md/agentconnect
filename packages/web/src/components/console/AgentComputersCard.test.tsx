// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: undefined as unknown,
  computers: [] as unknown[],
  updateAgent: vi.fn(),
  setComputerPolicy: vi.fn(),
  mutate: vi.fn()
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ getAgent: () => mocks.agent, updateAgent: mocks.updateAgent })
}))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputers: () => ({ data: mocks.computers, error: undefined, mutate: mocks.mutate })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  setComputerPolicy: mocks.setComputerPolicy
}))

const { AgentComputersCard } = await import('./AgentComputersCard')

function render(canEdit = true): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(<AgentComputersCard agentId="a1" canEdit={canEdit} />))
  return host
}

beforeEach(() => {
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.setComputerPolicy.mockReset().mockResolvedValue(undefined)
  mocks.mutate.mockReset()
  mocks.agent = { id: 'a1' }
  mocks.computers = [computerFixture()]
  document.body.innerHTML = ''
})

describe('AgentComputersCard', () => {
  it('turns computer use on for the agent', async () => {
    const el = render()
    expect(el.textContent).toContain('Computer use is off')
    await act(async () => el.querySelector<HTMLButtonElement>('button[role="switch"]')!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('a1', { computerUse: { enabled: true, computers: [] } })
    expect(el.textContent).toContain('No computers picked')
  })

  it('shows whether each picked computer grants the agent, and lets its owner grant it', async () => {
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: ['c1'] } }
    const el = render()
    expect(el.textContent).toContain('waiting for its owner to grant this agent')
    const grant = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Grant')!
    await act(async () => grant.click())
    expect(mocks.setComputerPolicy).toHaveBeenCalledWith('c1', expect.objectContaining({ allowedAgents: ['a1'] }))
    expect(mocks.mutate).toHaveBeenCalled()
  })

  it('offers no grant to someone who is not the computer’s owner, and no edits without rights', () => {
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: ['c1'] } }
    mocks.computers = [computerFixture({ canEditPolicy: false })]
    const el = render(false)
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Grant')).toBe(false)
    expect(el.querySelector<HTMLButtonElement>('button[role="switch"]')!.disabled).toBe(true)
    expect(el.querySelector('button[title="Remove from agent"]')).toBeNull()
  })

  it('shows a change made elsewhere once the saved value has caught up', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const draw = () => act(() => root.render(<AgentComputersCard agentId="a1" canEdit />))
    draw()
    await act(async () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!.click())
    expect(host.textContent).toContain('No computers picked')
    mocks.agent = { id: 'a1', computerUse: { enabled: true, computers: [] } }
    draw()
    mocks.agent = { id: 'a1', computerUse: { enabled: false, computers: [] } }
    draw()
    expect(host.textContent).toContain('Computer use is off')
  })
})

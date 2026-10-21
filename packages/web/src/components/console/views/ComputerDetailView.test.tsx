// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerDto } from '@/lib/api'
import { computerFixture as computer } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  computer: undefined as unknown,
  mutate: vi.fn(),
  push: vi.fn(),
  stopComputer: vi.fn(),
  resumeComputer: vi.fn(),
  revokeComputer: vi.fn(),
  deleteComputer: vi.fn(),
  setComputerPolicy: vi.fn(),
  setComputerAgentAccess: vi.fn(),
  refresh: vi.fn(),
  fetchComputerAudit: vi.fn(),
  wakeComputer: vi.fn(),
  sleepComputer: vi.fn(),
  resetComputer: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useParams: () => ({ id: 'c1' }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { userId: 'u1' } }) }))
// A glyph icon keeps happy-dom from fetching a runtime mark image.
const GLYPH = { kind: 'glyph', glyph: 'agentconnect' }
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [
      {
        id: 'a1',
        name: 'ops',
        runtime: 'claude',
        icon: GLYPH,
        createdBy: 'u1'
      },
      { id: 'a2', name: 'peer', runtime: 'claude', icon: GLYPH, createdBy: 'u2' }
    ],
    members: [{ userId: 'u2', name: 'Dana', email: null }],
    refresh: mocks.refresh
  })
}))
vi.mock('@/components/console/Shell', () => ({ useCrumbSlot: () => ({ register: () => {} }) }))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputer: () => ({ data: mocks.computer, error: undefined, isLoading: false, mutate: mocks.mutate })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  stopComputer: mocks.stopComputer,
  resumeComputer: mocks.resumeComputer,
  revokeComputer: mocks.revokeComputer,
  deleteComputer: mocks.deleteComputer,
  setComputerPolicy: mocks.setComputerPolicy,
  setComputerAgentAccess: mocks.setComputerAgentAccess,
  fetchComputerAudit: mocks.fetchComputerAudit,
  wakeComputer: mocks.wakeComputer,
  sleepComputer: mocks.sleepComputer,
  resetComputer: mocks.resetComputer
}))

const ComputerDetailView = (await import('./ComputerDetailView')).default

let root: Root

function render(c: ComputerDto): HTMLDivElement {
  mocks.computer = c
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ComputerDetailView />))
  return host
}

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label)

beforeEach(() => {
  for (const fn of [
    mocks.mutate,
    mocks.push,
    mocks.stopComputer,
    mocks.resumeComputer,
    mocks.revokeComputer,
    mocks.deleteComputer,
    mocks.setComputerPolicy,
    mocks.setComputerAgentAccess,
    mocks.refresh,
    mocks.fetchComputerAudit,
    mocks.wakeComputer,
    mocks.sleepComputer,
    mocks.resetComputer
  ])
    fn.mockReset()
  mocks.fetchComputerAudit.mockResolvedValue({ entries: [], nextCursor: null })
  document.body.innerHTML = ''
})

describe('ComputerDetailView', () => {
  it('shows each doctor failure with its fix, failures first', () => {
    const el = render(
      computer({
        doctor: {
          checkedAt: new Date().toISOString(),
          checks: [
            { name: 'config', status: 'ok', detail: 'fine' },
            { name: 'driver', status: 'fail', detail: 'cua-driver missing', fix: 'agentconnect desktop setup' }
          ]
        }
      })
    )
    const checks = [...el.querySelectorAll('[data-doctor-check]')].map((n) => n.getAttribute('data-doctor-check'))
    expect(checks).toEqual(['driver', 'config'])
    expect(el.querySelector('[data-doctor-check="driver"]')!.textContent).toContain('agentconnect desktop setup')
  })

  it('stops from the console on both layouts and applies the returned row', async () => {
    const stopped = computer({ stoppedAt: new Date().toISOString(), stoppedByUserId: 'u1', status: 'paused' })
    mocks.stopComputer.mockResolvedValue(stopped)
    const el = render(computer())
    // One for the desktop header, one full-width in the mobile body.
    const stops = button(el, 'Stop')
    expect(stops).toHaveLength(2)
    expect(stops[0]!.parentElement!.className).toContain('hidden desktop:inline-flex')
    expect(stops[1]!.parentElement!.className).toContain('desktop:hidden')
    await act(async () => stops[1]!.click())
    await settle()
    expect(mocks.stopComputer).toHaveBeenCalledWith('c1')
    expect(mocks.mutate).toHaveBeenCalledWith(stopped, { revalidate: false })
  })

  it('lets only the owner resume a stopped computer', () => {
    const stopped = { stoppedAt: new Date().toISOString(), stoppedByUserId: 'u2', status: 'paused' as const }
    const owner = render(computer(stopped))
    expect(owner.textContent).toContain('Stopped by Dana')
    expect(button(owner, 'Resume')).toHaveLength(2)
    act(() => root.unmount())
    const peer = render(computer({ ...stopped, canEditPolicy: false }))
    expect(button(peer, 'Resume')).toHaveLength(0)
    expect(peer.textContent).toContain('Only its owner can resume it.')
  })

  it('revokes after confirmation', async () => {
    mocks.revokeComputer.mockResolvedValue(computer({ status: 'revoked' }))
    const el = render(computer())
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Computer actions"]')!.click())
    act(() => button(el, 'Revoke')[0]!.click())
    expect(document.body.textContent).toContain('Revoke computer')
    const confirm = button(document.body, 'Revoke').at(-1)!
    await act(async () => confirm.click())
    await settle()
    expect(mocks.revokeComputer).toHaveBeenCalledWith('c1')
  })

  it('starts with no agents, then selects agents, warns about another member’s agent, and saves the access', async () => {
    mocks.setComputerAgentAccess.mockImplementation(async (_id: string, agentAccess: unknown) =>
      computer({ agentAccess } as never)
    )
    const el = render(computer())
    const tile = (title: string) =>
      [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((t) => t.textContent?.includes(title))!
    expect(tile('No agents').getAttribute('aria-checked')).toBe('true')
    act(() => tile('Selected agents').click())
    expect(el.textContent).toContain('Pick at least one agent')
    // An empty selection cannot be saved.
    expect(button(el, 'Save')[0]!.disabled).toBe(true)
    const add = [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-haspopup') === 'menu')!
    act(() => add.click())
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((b) => b.textContent?.includes('peer'))!
        .click()
    )
    expect(el.textContent).toContain('Not your agent')
    await act(async () => button(el, 'Save')[0]!.click())
    await settle()
    expect(mocks.setComputerAgentAccess).toHaveBeenCalledWith('c1', { mode: 'selected', agents: ['a2'] })
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('switches to All agents and keeps a per-agent computer read-only', async () => {
    mocks.setComputerAgentAccess.mockImplementation(async (_id: string, agentAccess: unknown) =>
      computer({ agentAccess } as never)
    )
    const el = render(computer())
    const all = [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((t) =>
      t.textContent?.includes('All agents')
    )!
    act(() => all.click())
    expect(el.textContent).toContain('no isolation')
    await act(async () => button(el, 'Save')[0]!.click())
    await settle()
    expect(mocks.setComputerAgentAccess).toHaveBeenCalledWith('c1', { mode: 'all', agents: [] })

    const fixed = render(
      computer({
        kind: 'managed',
        allocation: 'per-agent',
        agentAccess: { mode: 'selected', agents: ['a1'] },
        canEditAgentAccess: false
      })
    )
    expect(fixed.textContent).toContain('Used only by the agent it was made for')
  })

  it('edits the usage policy and saves', async () => {
    mocks.setComputerPolicy.mockImplementation(async (_id: string, policy: unknown) => computer({ policy } as never))
    const el = render(computer())
    const idle = el.querySelector<HTMLInputElement>('input[aria-label="Idle release (seconds)"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(idle, '60')
      idle.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(el, 'Save').at(-1)!.click())
    await settle()
    expect(mocks.setComputerPolicy).toHaveBeenCalledWith('c1', expect.objectContaining({ leaseIdleSeconds: 60 }))
  })

  it('keeps the policy read-only for someone who is not the owner and hides the audit', () => {
    const el = render(computer({ canEditPolicy: false, canEditAgentAccess: false }))
    expect(el.textContent).toContain('Only the owner can change this')
    expect(el.textContent).toContain('Only editors of this computer can change this')
    expect(button(el, 'Save')).toHaveLength(0)
    expect(el.textContent).not.toContain('Recent activity')
  })

  it('shows a shared pool computer’s holder and line, and puts it to sleep', async () => {
    const shared = computer({
      kind: 'managed',
      isolation: 'container',
      allocation: 'manual',
      poolPhase: 'awake',
      agentAccess: { mode: 'selected', agents: ['a1', 'a2'] },
      poolActions: { wake: false, sleep: true, reset: true },
      lease: { sessionId: 's1', agentId: 'a1', agentName: 'ops', acquiredAt: new Date().toISOString() },
      waiting: [{ sessionId: 's2', agentId: 'a2', since: new Date().toISOString() }]
    })
    mocks.sleepComputer.mockResolvedValue(
      computer({ ...shared, status: 'sleeping', poolPhase: 'sleeping', lease: null, waiting: [] })
    )
    const el = render(shared)
    expect(el.querySelector('[data-lease-holder="a1"]')!.textContent).toContain('ops')
    expect(el.querySelector('[data-lease-waiter="a2"]')!.textContent).toContain('peer')
    expect(el.querySelector('[data-lease-holder="a1"] a')!.getAttribute('href')).toBe('/acme/sessions/s1')
    const card = el.querySelector<HTMLElement>('[data-pool-card]')!
    expect(card.textContent).toContain('Pool computer, shared')
    expect(button(card, 'Wake')).toHaveLength(0)
    // On a phone the actions fill the row and are thumb-sized.
    expect(button(card, 'Sleep')[0]!.parentElement!.className).toContain('max-desktop:[&>button]:flex-1')
    await act(async () => button(card, 'Sleep')[0]!.click())
    await settle()
    expect(mocks.sleepComputer).toHaveBeenCalledWith('c1')
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ poolPhase: 'sleeping' }), {
      revalidate: false
    })
  })

  it('wakes an agent’s sleeping desktop and resets it only after confirmation', async () => {
    const asleep = computer({
      kind: 'managed',
      allocation: 'per-agent',
      ownerAgentId: 'a1',
      status: 'sleeping',
      poolPhase: 'sleeping',
      agentAccess: { mode: 'selected', agents: ['a1'] },
      canEditAgentAccess: false,
      poolActions: { wake: true, sleep: false, reset: true },
      lease: null,
      waiting: []
    })
    mocks.wakeComputer.mockResolvedValue(computer({ ...asleep, poolPhase: 'waking' }))
    mocks.resetComputer.mockResolvedValue(computer({ ...asleep, poolPhase: 'resetting' }))
    const el = render(asleep)
    expect(el.textContent).toContain('Asleep')
    expect(el.textContent).toContain('No agent has control')
    const card = el.querySelector<HTMLElement>('[data-pool-card]')!
    expect(card.textContent).toContain('ops')
    await act(async () => button(card, 'Wake')[0]!.click())
    await settle()
    expect(mocks.wakeComputer).toHaveBeenCalledWith('c1')

    act(() => button(card, 'Reset desktop')[0]!.click())
    expect(mocks.resetComputer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('files, browser profile and sign-ins are deleted')
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => button(dialog, 'Reset')[0]!.click())
    await settle()
    expect(mocks.resetComputer).toHaveBeenCalledWith('c1')
  })

  it('offers no pool actions for a self-hosted computer or an ephemeral one', () => {
    const own = render(computer())
    expect(own.querySelector('[data-pool-card]')).toBeNull()
    expect(own.querySelector('[data-lease-card]')).not.toBeNull()
    act(() => root.unmount())
    const session = render(
      computer({
        kind: 'managed',
        allocation: 'ephemeral',
        ownerAgentId: 'a1',
        poolPhase: 'awake',
        poolActions: { wake: false, sleep: false, reset: false }
      })
    )
    const card = session.querySelector<HTMLElement>('[data-pool-card]')!
    expect(card.textContent).toContain('New for each session')
    expect(card.querySelectorAll('button')).toHaveLength(0)
  })
})

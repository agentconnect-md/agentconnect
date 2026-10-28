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
  setComputerSharing: vi.fn(),
  refresh: vi.fn(),
  fetchComputerAudit: vi.fn(),
  wakeComputer: vi.fn(),
  sleepComputer: vi.fn(),
  resetComputer: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ id: 'c1' }),
  useSearchParams: () => new URLSearchParams()
}))
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
  useComputer: (id: string | undefined) => ({
    data: id ? mocks.computer : undefined,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  stopComputer: mocks.stopComputer,
  resumeComputer: mocks.resumeComputer,
  revokeComputer: mocks.revokeComputer,
  deleteComputer: mocks.deleteComputer,
  setComputerPolicy: mocks.setComputerPolicy,
  setComputerSharing: mocks.setComputerSharing,
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
const openTab = (el: HTMLElement, label: string) =>
  act(() => [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label)!.click())
const openMenu = (el: HTMLElement) =>
  act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Computer actions"]')!.click())

beforeEach(() => {
  for (const fn of [
    mocks.mutate,
    mocks.push,
    mocks.stopComputer,
    mocks.resumeComputer,
    mocks.revokeComputer,
    mocks.deleteComputer,
    mocks.setComputerPolicy,
    mocks.setComputerSharing,
    mocks.refresh,
    mocks.fetchComputerAudit,
    mocks.wakeComputer,
    mocks.sleepComputer,
    mocks.resetComputer
  ])
    fn.mockReset()
  mocks.fetchComputerAudit.mockResolvedValue({ entries: [], nextCursor: null })
  window.__AC_ENV = { FEATURE_FLAGS: 'computer-use' }
  document.body.innerHTML = ''
})

describe('ComputerDetailView', () => {
  it('reads as not found without the computer-use flag, without asking for the Computer', () => {
    window.__AC_ENV = { FEATURE_FLAGS: '' }
    const el = render(computer())
    expect(el.textContent).toContain('Computer not found')
    expect(el.querySelector('[data-doctor-check]')).toBeNull()
  })

  it('shows each doctor failure with its fix, failures first, and passing checks on request', () => {
    const el = render(
      computer({
        doctor: {
          checkedAt: new Date().toISOString(),
          checks: [
            { name: 'config', status: 'ok', detail: 'fine' },
            { name: 'driver', status: 'fail', detail: 'cua-driver missing', fix: 'agentconnect computer setup' }
          ]
        }
      })
    )
    const checks = () => [...el.querySelectorAll('[data-doctor-check]')].map((n) => n.getAttribute('data-doctor-check'))
    expect(checks()).toEqual(['driver'])
    expect(el.textContent).toContain('1 failing')
    act(() => button(el, 'Show 1 passing check')[0]!.click())
    expect(checks()).toEqual(['driver', 'config'])
    expect(el.querySelector('[data-doctor-check="driver"]')!.textContent).toContain('agentconnect computer setup')
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
    openMenu(el)
    act(() => button(el, 'Revoke')[0]!.click())
    expect(document.body.textContent).toContain('Revoke computer')
    const confirm = button(document.body, 'Revoke').at(-1)!
    await act(async () => confirm.click())
    await settle()
    expect(mocks.revokeComputer).toHaveBeenCalledWith('c1')
  })

  it('shows which agents may use it without changing it, and points to each agent’s Tools tab', () => {
    const el = render(computer({ agentAccess: { mode: 'selected', agents: ['a2'] } }))
    expect(el.textContent).toContain('Not your agent')
    const tools = el.querySelector<HTMLAnchorElement>('a[aria-label="Open the agent’s tools"]')!
    expect(tools.getAttribute('href')).toBe('/acme/agents/a2?tab=tools')
    expect(el.textContent).toContain('Granted per agent, under Tools › Computers.')
    expect(el.textContent).toContain('View and control')
    expect([...el.querySelectorAll('[role="radio"]')].some((r) => r.textContent?.includes('All agents'))).toBe(false)
    expect(button(el, 'Save')).toHaveLength(0) // the policy form lives on its own tab

    const all = render(computer({ agentAccess: { mode: 'all', agents: [] } }))
    expect(all.textContent).toContain('Every agent in the organization can use it.')
    expect(all.textContent).toContain('no isolation')

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

  it('changes who sees the computer from its details', async () => {
    mocks.setComputerSharing.mockImplementation(async (_id: string, sharing: object) => computer(sharing as never))
    const el = render(computer())
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Change visibility"]')!.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const everyone = [...dialog.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) =>
      r.textContent?.includes('Everyone')
    )!
    act(() => everyone.click())
    await act(async () => button(dialog, 'Save')[0]!.click())
    await settle()
    expect(mocks.setComputerSharing).toHaveBeenCalledWith('c1', { visibility: 'org', sharedWith: ['u1'] })
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    // A viewer cannot change it.
    const viewer = render(computer({ canEdit: false }))
    expect(viewer.querySelector('button[aria-label="Change visibility"]')).toBeNull()
  })

  it('edits the usage policy and saves', async () => {
    mocks.setComputerPolicy.mockImplementation(async (_id: string, policy: unknown) => computer({ policy } as never))
    const el = render(computer())
    openTab(el, 'Usage policy')
    expect(el.textContent).toContain('Applies to every agent with access.')
    const idle = el.querySelector<HTMLInputElement>('input[aria-label="Idle release"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(idle, '60')
      idle.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(el.textContent).toContain('1 unsaved change')
    await act(async () => button(el, 'Save').at(-1)!.click())
    await settle()
    expect(mocks.setComputerPolicy).toHaveBeenCalledWith('c1', expect.objectContaining({ leaseIdleSeconds: 60 }))
  })

  it('keeps the policy read-only for someone who is not the owner and hides the audit', () => {
    const el = render(computer({ canEditPolicy: false, canEditAgentAccess: false }))
    const tabs = [...el.querySelectorAll('[role="tab"]')].map((b) => b.textContent)
    expect(tabs).toEqual(['Overview', 'Usage policy'])
    openTab(el, 'Usage policy')
    expect(el.textContent).toContain('Only the owner can change this')
    expect(button(el, 'Save')).toHaveLength(0)
  })

  it('lists activity by day and filters viewers from agents', async () => {
    const at = new Date().toISOString()
    const entry = {
      at,
      outcome: 'ok',
      code: null,
      approval: null,
      args: {},
      textLength: null,
      ms: 12,
      screenshotRef: null
    }
    mocks.fetchComputerAudit.mockResolvedValue({
      entries: [
        { ...entry, id: 'e1', tool: 'viewer_click', client: 'console:u2', agentId: null, sessionId: null },
        { ...entry, id: 'e2', tool: 'computer_screenshot', client: 'daemon', agentId: 'a1', sessionId: 's1' }
      ],
      nextCursor: null
    })
    const el = render(computer())
    openTab(el, 'Activity')
    await settle()
    const shown = () => [...el.querySelectorAll('[data-audit-entry]')].map((n) => n.getAttribute('data-audit-entry'))
    expect(shown()).toEqual(['e1', 'e2'])
    expect(el.textContent).toContain('Today')
    expect(el.querySelector('[data-audit-entry="e1"]')!.textContent).toContain('Dana')
    act(() => button(el, 'Agents')[0]!.click())
    expect(shown()).toEqual(['e2'])
    act(() => button(el, 'Viewers')[0]!.click())
    expect(shown()).toEqual(['e1'])
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
    expect(el.querySelector('[data-lease-holder="a1"]')!.textContent).toContain('ops has control')
    expect(el.querySelector('[data-lease-holder="a1"] a')!.getAttribute('href')).toBe('/acme/sessions/s1')
    const line = el.querySelector<HTMLElement>('[data-lease-waiting]')!
    expect(line.textContent).toBe('1 waiting')
    expect(line.title).toContain('peer')
    expect(el.querySelector('[data-pool-chip]')!.textContent).toBe('Pool · Awake')
    expect(el.textContent).toContain('Pool computer, shared')
    openMenu(el)
    expect(button(el, 'Wake')).toHaveLength(0)
    await act(async () => button(el, 'Sleep')[0]!.click())
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
    expect(el.textContent).toContain('Made forops')
    openMenu(el)
    await act(async () => button(el, 'Wake')[0]!.click())
    await settle()
    expect(mocks.wakeComputer).toHaveBeenCalledWith('c1')

    openMenu(el)
    act(() => button(el, 'Reset desktop')[0]!.click())
    expect(mocks.resetComputer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('files, browser profile and sign-ins are deleted')
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => button(dialog, 'Reset')[0]!.click())
    await settle()
    expect(mocks.resetComputer).toHaveBeenCalledWith('c1')
  })

  it('offers no pool actions for a self-hosted computer or an ephemeral one', () => {
    const own = render(computer())
    expect(own.querySelector('[data-pool-chip]')).toBeNull()
    openMenu(own)
    expect(button(own, 'Sleep')).toHaveLength(0)
    expect(button(own, 'Reset desktop')).toHaveLength(0)
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
    expect(session.textContent).toContain('New for each session')
    openMenu(session)
    expect([...session.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['Revoke', 'Delete'])
  })
})

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
  fetchComputerAudit: vi.fn()
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
        createdBy: 'u1',
        computerUse: { enabled: true, computers: ['c1'] }
      },
      { id: 'a2', name: 'peer', runtime: 'claude', icon: GLYPH, createdBy: 'u2' }
    ],
    members: [{ userId: 'u2', name: 'Dana', email: null }]
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
  fetchComputerAudit: mocks.fetchComputerAudit
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
    mocks.fetchComputerAudit
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

  it('edits the policy: grants an agent, warns about another member’s agent, and saves', async () => {
    mocks.setComputerPolicy.mockImplementation(async (_id: string, policy: unknown) => computer({ policy } as never))
    const el = render(computer({ policy: { ...computer().policy, allowedAgents: ['a1', 'a2'] } }))
    expect(el.textContent).toContain('Uses this computer')
    expect(el.textContent).toContain('Not your agent')
    const idle = el.querySelector<HTMLInputElement>('input[aria-label="Idle release (seconds)"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(idle, '60')
      idle.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(el, 'Save')[0]!.click())
    await settle()
    expect(mocks.setComputerPolicy).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ allowedAgents: ['a1', 'a2'], leaseIdleSeconds: 60 })
    )
  })

  it('keeps the policy read-only for someone who is not the owner and hides the audit', () => {
    const el = render(computer({ canEditPolicy: false }))
    expect(el.textContent).toContain('Only the owner can change this')
    expect(button(el, 'Save')).toHaveLength(0)
    expect(el.textContent).not.toContain('Recent activity')
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createPoolComputer: vi.fn(),
  pool: undefined as { enabled: boolean; available: boolean } | undefined
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  createPoolComputer: mocks.createPoolComputer
}))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputerPool: () => ({ data: mocks.pool })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    members: [{ userId: 'u-me', name: 'Me', email: 'me@example.test', role: 'owner', isCurrentUser: true }]
  })
}))

const { default: AddPoolComputer } = await import('./AddPoolComputer')

beforeEach(() => {
  mocks.push.mockReset()
  mocks.createPoolComputer.mockReset()
  document.body.innerHTML = ''
})

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

const render = (onClose = vi.fn()): HTMLElement => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(<AddPoolComputer onClose={onClose} />))
  return host
}

describe('AddPoolComputer', () => {
  it('creates a pool computer everyone can see and opens it', async () => {
    mocks.pool = { enabled: true, available: true }
    mocks.createPoolComputer.mockResolvedValue(computerFixture({ id: 'p1', kind: 'managed', allocation: 'manual' }))
    const onClose = vi.fn()
    const host = render(onClose)
    expect(host.textContent).toContain('Add managed computer')
    expect(host.textContent).toContain('isolated in its own container')
    // A name is needed; agents get it on their own Tools tab.
    expect(button('Create computer').disabled).toBe(true)
    const input = host.querySelector<HTMLInputElement>('input.inp')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Shared browser')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Create computer').click())
    expect(mocks.createPoolComputer).toHaveBeenCalledWith({ name: 'Shared browser', visibility: 'org', sharedWith: [] })
    expect(onClose).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/p1')
  })

  it('says when no pool member can start one', () => {
    mocks.pool = { enabled: true, available: false }
    const host = render()
    expect(host.textContent).toContain('No pool member is connected right now')
    expect(button('Create computer').disabled).toBe(true)
  })
})

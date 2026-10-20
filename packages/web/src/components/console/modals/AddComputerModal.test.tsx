// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computerFixture } from '@/lib/computer-fixtures'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  createComputerRegistration: vi.fn(),
  fetchComputerRegistration: vi.fn(),
  fetchComputer: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  createComputerRegistration: mocks.createComputerRegistration,
  fetchComputerRegistration: mocks.fetchComputerRegistration,
  fetchComputer: mocks.fetchComputer
}))

const { default: AddComputerModal, REGISTRATION_POLL_MS } = await import('./AddComputerModal')

const registration = {
  registrationId: 'r1',
  token: 'ac_secret',
  displayTail: '…cret',
  name: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  exchangeUrl: 'https://cp.example.com/v1/computers/register'
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const fn of Object.values(mocks)) fn.mockReset()
  document.body.innerHTML = ''
})
afterEach(() => vi.useRealTimers())

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

describe('AddComputerModal', () => {
  it('mints a token only when asked, shows the command, and follows the desktop until it is online', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValueOnce({ registrationId: 'r1', computerId: null })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: 'c1' })
    mocks.fetchComputer.mockResolvedValueOnce(computerFixture({ status: 'offline' }))
    mocks.fetchComputer.mockResolvedValue(computerFixture())
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={onClose} />))
    expect(mocks.createComputerRegistration).not.toHaveBeenCalled()

    await act(async () => button('Create command').click())
    expect(mocks.createComputerRegistration).toHaveBeenCalledWith({})
    const command = host.querySelector('[data-install-command]')!.textContent!
    expect(command).toContain(
      "npx -y @agentconnect.md/cli desktop setup --register 'ac_secret' --cp-url 'https://cp.example.com/v1/computers/register'"
    )
    expect(host.textContent).toContain('Waiting for the computer to register')

    for (let i = 0; i < 4 && !host.textContent?.includes('Computer connected'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTRATION_POLL_MS)
      })
    }
    expect(host.textContent).toContain('Computer connected')
    act(() => button('Open computer').click())
    expect(onClose).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/c1')
  })

  it('quotes the command for PowerShell on Windows', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    act(() => button('Windows').click())
    await act(async () => button('Create command').click())
    expect(host.querySelector('[data-install-command]')!.textContent).toContain('--register "ac_secret"')
    expect(host.textContent).toContain('PowerShell')
  })

  it('stops waiting once the token expires and offers a new command', async () => {
    mocks.createComputerRegistration.mockResolvedValue({
      ...registration,
      expiresAt: new Date(Date.now() + REGISTRATION_POLL_MS * 1.5).toISOString()
    })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    await act(async () => button('Create command').click())
    expect(host.textContent).toContain('Waiting for the computer to register')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTRATION_POLL_MS * 2)
    })
    expect(host.textContent).toContain('The command expired')
    const polls = mocks.fetchComputerRegistration.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REGISTRATION_POLL_MS * 3)
    })
    expect(mocks.fetchComputerRegistration).toHaveBeenCalledTimes(polls)
    act(() => button('Create new command').click())
    expect(button('Create command')).toBeTruthy()
  })

  it('treats a reaped registration as expired', async () => {
    const { ApiError } = await import('@/lib/api')
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockRejectedValue(new ApiError('registration not found', 404))
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    await act(async () => button('Create command').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.textContent).toContain('The command expired')
  })
})

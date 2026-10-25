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
  fetchComputer: vi.fn(),
  setComputerSharing: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  createComputerRegistration: mocks.createComputerRegistration,
  fetchComputerRegistration: mocks.fetchComputerRegistration,
  fetchComputer: mocks.fetchComputer,
  setComputerSharing: mocks.setComputerSharing
}))
// A glyph icon keeps happy-dom from fetching a runtime mark image.
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [
      { id: 'a1', name: 'ops', runtime: 'claude', icon: { kind: 'glyph', glyph: 'agentconnect' } },
      { id: 'a2', name: 'review', runtime: 'claude', icon: { kind: 'glyph', glyph: 'agentconnect' } }
    ],
    members: [
      { userId: 'u-me', name: 'Me', email: 'me@example.test', role: 'owner', isCurrentUser: true },
      { userId: 'u-dana', name: 'Dana', email: 'dana@example.test', role: 'collaborator', isCurrentUser: false }
    ],
    refresh: mocks.refresh
  })
}))

const { default: AddComputerModal, REGISTRATION_POLL_MS } = await import('./AddComputerModal')

const registration = {
  registrationId: 'r1',
  token: 'ac_secret',
  displayTail: '…cret',
  name: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  exchangeUrl: 'https://cp.example.com/v1/computers/register',
  cliChannel: 'rc' as const
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const fn of [
    mocks.push,
    mocks.createComputerRegistration,
    mocks.fetchComputerRegistration,
    mocks.fetchComputer,
    mocks.setComputerSharing,
    mocks.refresh
  ])
    fn.mockReset()
  document.body.innerHTML = ''
})
afterEach(() => vi.useRealTimers())

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

const render = async (): Promise<HTMLElement> => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => createRoot(host).render(<AddComputerModal onClose={onClose} />))
  return host
}
const onClose = vi.fn()
const commandText = (host: HTMLElement) => host.querySelector('[data-install-command]')!.textContent!

describe('AddComputerModal', () => {
  beforeEach(() => onClose.mockReset())

  it('mints the command on open and follows the desktop until it is online', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValueOnce({ registrationId: 'r1', computerId: null })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: 'c1' })
    mocks.fetchComputer.mockResolvedValueOnce(computerFixture({ status: 'offline' }))
    mocks.fetchComputer.mockResolvedValue(computerFixture())
    const host = await render()
    // One token, with the CP's default audience: the registrant alone.
    expect(mocks.createComputerRegistration).toHaveBeenCalledTimes(1)
    expect(mocks.createComputerRegistration).toHaveBeenCalledWith({})
    // No platform or source to pick: one command for every desktop OS.
    expect(host.textContent).not.toContain('Where it runs')
    expect(host.textContent).not.toContain('Platform')
    expect(commandText(host)).toContain(
      'npx -y @agentconnect.md/cli@rc computer install --channel rc --register "ac_secret" --cp-url "https://cp.example.com/v1/computers/register"'
    )
    expect(host.textContent).toContain('Waiting for the computer to register')

    for (let i = 0; i < 4 && !host.textContent?.includes('Computer connected'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTRATION_POLL_MS)
      })
    }
    expect(host.textContent).toContain('Computer connected')
    await act(async () => button('Open computer').click())
    // An untouched visibility is the one the token registered with, so nothing is written.
    expect(mocks.setComputerSharing).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/c1')
  })

  it('pins the latest CLI, with no rc channel, for a stable Control Plane', async () => {
    mocks.createComputerRegistration.mockResolvedValue({ ...registration, cliChannel: 'stable' })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = await render()
    expect(commandText(host)).toContain(
      'npx -y @agentconnect.md/cli@latest computer install --register "ac_secret" --cp-url'
    )
  })

  it('puts the typed name into the command until the desktop registers', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = await render()
    const input = host.querySelector<HTMLInputElement>('input.inp')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'lab desk')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(commandText(host)).toMatch(/ --name "lab desk"$/)
    expect(mocks.createComputerRegistration).toHaveBeenCalledTimes(1)
  })

  it('offers the desktop container for a server with Docker on the same token', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = await render()
    act(() => button('Docker').click())
    expect(host.textContent).toContain('On a server with Docker')
    const command = commandText(host)
    expect(command).toContain('-e AGENTCONNECT_CP_URL="https://cp.example.com/v1/computers/register"')
    expect(command).toContain('-e AGENTCONNECT_REGISTER_TOKEN="ac_secret" ghcr.io/agentconnect-md/computer:latest')
    expect(mocks.createComputerRegistration).toHaveBeenCalledTimes(1)
  })

  it('writes a changed visibility to the computer once it connects', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: 'c1' })
    mocks.fetchComputer.mockResolvedValue(computerFixture())
    mocks.setComputerSharing.mockResolvedValue(computerFixture())
    const host = await render()
    const everyone = [...host.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Everyone'))!
    act(() => (everyone as HTMLElement).click())
    for (let i = 0; i < 4 && !host.textContent?.includes('Computer connected'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REGISTRATION_POLL_MS)
      })
    }
    await act(async () => button('Open computer').click())
    expect(mocks.setComputerSharing).toHaveBeenCalledWith('c1', { visibility: 'org', sharedWith: ['u-me'] })
    expect(mocks.push).toHaveBeenCalledWith('/acme/computers/c1')
  })

  it('stops waiting once the token expires and mints a new command', async () => {
    mocks.createComputerRegistration.mockResolvedValueOnce({
      ...registration,
      expiresAt: new Date(Date.now() + REGISTRATION_POLL_MS * 1.5).toISOString()
    })
    mocks.createComputerRegistration.mockResolvedValue({ ...registration, token: 'ac_fresh' })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = await render()
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
    await act(async () => button('Create new command').click())
    expect(commandText(host)).toContain('--register "ac_fresh"')
  })

  it('treats a reaped registration as expired', async () => {
    const { ApiError } = await import('@/lib/api')
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockRejectedValue(new ApiError('registration not found', 404))
    const host = await render()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(host.textContent).toContain('The command expired')
  })

  it('says when the command cannot be created and offers another try', async () => {
    mocks.createComputerRegistration.mockRejectedValueOnce(new Error('boom'))
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = await render()
    expect(commandText(host)).toContain('Could not create the command: boom')
    await act(async () => button('Create new command').click())
    expect(commandText(host)).toContain('--register "ac_secret"')
  })
})

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
  createPoolComputer: vi.fn(),
  refresh: vi.fn(),
  pool: undefined as { enabled: boolean; available: boolean } | undefined
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  createComputerRegistration: mocks.createComputerRegistration,
  fetchComputerRegistration: mocks.fetchComputerRegistration,
  fetchComputer: mocks.fetchComputer,
  createPoolComputer: mocks.createPoolComputer
}))
vi.mock('@/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/computers')>()),
  useComputerPool: () => ({ data: mocks.pool })
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
    mocks.createPoolComputer,
    mocks.refresh
  ])
    fn.mockReset()
  mocks.pool = undefined
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
    // Someone's desktop starts seen by its registrant alone.
    expect(mocks.createComputerRegistration).toHaveBeenCalledWith({ visibility: 'restricted', sharedWith: ['u-me'] })
    const command = host.querySelector('[data-install-command]')!.textContent!
    expect(command).toContain(
      "npx -y @agentconnect.md/cli@rc computer install --channel rc --register 'ac_secret' --cp-url 'https://cp.example.com/v1/computers/register'"
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

  it('pins the latest CLI, with no rc channel, for a stable Control Plane', async () => {
    mocks.createComputerRegistration.mockResolvedValue({ ...registration, cliChannel: 'stable' })
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    await act(async () => button('Create command').click())
    expect(host.querySelector('[data-install-command]')!.textContent).toContain(
      "npx -y @agentconnect.md/cli@latest computer install --register 'ac_secret' --cp-url"
    )
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

  it('offers the desktop container for a server with Docker', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    act(() => button('Docker').click())
    expect(host.textContent).toContain('Run one command on a server with Docker')
    await act(async () => button('Create command').click())
    const command = host.querySelector('[data-install-command]')!.textContent!
    expect(command).toContain("-e AGENTCONNECT_CP_URL='https://cp.example.com/v1/computers/register'")
    expect(command).toContain("-e AGENTCONNECT_REGISTER_TOKEN='ac_secret' ghcr.io/agentconnect-md/computer:latest")
    expect(host.textContent).toContain('Run on the server')
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

  it('offers no managed option where the deployment runs no pool', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    expect(host.textContent).not.toContain('Where it runs')
  })

  it('registers the desktop with the visibility picked before minting', async () => {
    mocks.createComputerRegistration.mockResolvedValue(registration)
    mocks.fetchComputerRegistration.mockResolvedValue({ registrationId: 'r1', computerId: null })
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    const everyone = [...host.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes('Everyone'))!
    act(() => (everyone as HTMLElement).click())
    await act(async () => button('Create command').click())
    expect(mocks.createComputerRegistration).toHaveBeenCalledWith({ visibility: 'org', sharedWith: ['u-me'] })
  })

  it('creates a pool computer everyone can see and opens it', async () => {
    mocks.pool = { enabled: true, available: true }
    mocks.createPoolComputer.mockResolvedValue(computerFixture({ id: 'p1', kind: 'managed', allocation: 'manual' }))
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={onClose} />))
    act(() => button('Managed').click())
    expect(host.textContent).toContain('isolated in its own container')
    // A name is needed; agents get it on their own Tools tab.
    expect(button('Create computer').disabled).toBe(true)
    expect(host.querySelector('[data-pool-agent]')).toBeNull()
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
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} />))
    act(() => button('Managed').click())
    expect(host.textContent).toContain('No pool member is connected right now')
    expect(button('Create computer').disabled).toBe(true)
  })

  it('opens on the managed source when the pool page asks for one', () => {
    mocks.pool = { enabled: true, available: true }
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => createRoot(host).render(<AddComputerModal onClose={() => {}} source="pool" />))
    expect(host.textContent).toContain('isolated in its own container')
    expect(button('Managed').getAttribute('aria-checked')).toBe('true')
  })
})

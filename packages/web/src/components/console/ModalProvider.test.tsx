// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daemons: [] as Array<Record<string, unknown>>,
  provisionDaemon: vi.fn(),
  deleteDaemon: vi.fn(),
  renameDaemon: vi.fn(),
  saveSharing: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    members: [
      {
        userId: 'user-current',
        email: 'current@example.test',
        name: 'Current User',
        picture: null,
        profilePictureUpdatedAt: null,
        role: 'owner',
        isCurrentUser: true,
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    provisionDaemon: mocks.provisionDaemon,
    deleteDaemon: mocks.deleteDaemon,
    renameDaemon: mocks.renameDaemon,
    saveSharing: mocks.saveSharing,
    refresh: mocks.refresh
  })
}))

// The real hook fetches /me on mount, which would reach for the CP from a unit test.
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: null, me: null }) }))

import { ModalProvider, useModal } from './ModalProvider'
import AddDaemonModal from './modals/AddDaemonModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

function Harness() {
  const { openModal } = useModal()
  return (
    <button type="button" onClick={() => openModal('daemon')}>
      Add daemon
    </button>
  )
}

beforeEach(() => {
  mocks.daemons = []
  mocks.provisionDaemon.mockReset()
  mocks.deleteDaemon.mockReset().mockResolvedValue(undefined)
  mocks.renameDaemon.mockReset().mockResolvedValue(undefined)
  mocks.saveSharing.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ModalProvider dismissal', () => {
  it('routes Escape through daemon cancellation, including an in-flight provision', async () => {
    let resolveProvision!: (value: { daemonId: string; command: string }) => void
    mocks.provisionDaemon.mockReturnValue(
      new Promise((resolve) => {
        resolveProvision = resolve
      })
    )

    await act(async () =>
      root.render(
        <ModalProvider>
          <Harness />
        </ModalProvider>
      )
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.textContent).toContain('Cancelling…')

    await act(async () => {
      resolveProvision({
        daemonId: 'dmn_pending',
        command: 'npx -y @agentconnect.md/daemon run --api-url https://example.test --api-key test'
      })
      await Promise.resolve()
    })

    expect(mocks.deleteDaemon).toHaveBeenCalledWith('dmn_pending')
    expect(host.textContent).not.toContain('Cancelling…')
  })

  // Once the daemon is connected, Done writes the optional name / visibility. Escape
  // must not dismiss out from under that write: the dialog owes the operator either
  // its error banner or the chained follow-up, and a dismissed dialog can deliver
  // neither.
  it('ignores Escape while the connected daemon’s name and visibility are being saved', async () => {
    mocks.provisionDaemon.mockResolvedValue({
      daemonId: 'dmn_live',
      command: 'npx -y @agentconnect.md/daemon run --api-url https://example.test --api-key test'
    })
    mocks.daemons = [{ daemonId: 'dmn_live', name: 'edge-1', status: 'online' }]
    // Defer the SECOND write, so the dialog is mid-save with one request already
    // settled — the state a dismissal used to tear down.
    let settleSharing!: () => void
    mocks.saveSharing.mockReturnValue(
      new Promise<void>((resolve) => {
        settleSharing = () => resolve()
      })
    )

    await act(async () =>
      root.render(
        <ModalProvider>
          <Harness />
        </ModalProvider>
      )
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
    expect(host.textContent).toContain('Daemon connected')

    // Rename it — React tracks the input's value, so set it through the native
    // setter and let the synthetic onChange see the new value.
    const nameInput = host.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'edge-2')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // …and restrict it, so Done issues both writes.
    await act(async () => host.querySelectorAll<HTMLElement>('.ptile')[1]?.click())
    const done = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Done')!
    await act(async () => done.click())
    expect(mocks.renameDaemon).toHaveBeenCalledWith('dmn_live', 'edge-2')
    expect(mocks.saveSharing).toHaveBeenCalledWith('daemons', 'dmn_live', {
      visibility: 'restricted',
      sharedWith: ['user-current']
    })

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.textContent).toContain('Saving…')
    expect(mocks.deleteDaemon).not.toHaveBeenCalled()

    // Settling the write is what closes the dialog (the Harness trigger stays).
    await act(async () => {
      settleSharing()
      await Promise.resolve()
    })
    expect(host.textContent).not.toContain('Daemon connected')
  })
})

// The chained Edit-agent dialog preselects the machine the operator just connected, so
// Continue has to name it — closing alone would drop the operator back on the old placement.
describe('AddDaemonModal chaining', () => {
  it('hands Continue’s chain the daemon that just connected', async () => {
    mocks.provisionDaemon.mockResolvedValue({
      daemonId: 'dmn_live',
      command: 'npx -y @agentconnect.md/daemon run --api-url https://example.test --api-key test'
    })
    mocks.daemons = [{ daemonId: 'dmn_live', name: 'edge-1', status: 'online' }]
    const onDone = vi.fn()

    await act(async () =>
      root.render(<AddDaemonModal onClose={() => {}} onDone={onDone} registerDismiss={() => () => {}} />)
    )
    const done = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue')!
    await act(async () => done.click())

    expect(onDone).toHaveBeenCalledWith('dmn_live')
  })
})

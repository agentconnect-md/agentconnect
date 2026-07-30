// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daemons: [] as Array<Record<string, unknown>>,
  provisionDaemon: vi.fn(),
  deleteDaemon: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    members: [],
    provisionDaemon: mocks.provisionDaemon,
    deleteDaemon: mocks.deleteDaemon,
    refresh: mocks.refresh
  })
}))

// The dialog reads the signed-in user (it pins them in the visibility share set);
// the real hook fetches /me on mount, which would reach for the CP from a unit test.
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: null, me: null }) }))

import { ModalProvider, useModal } from './ModalProvider'

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
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  upgradeDaemon: vi.fn(),
  setDaemonAutoUpgrade: vi.fn()
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    upgradeDaemon: mocks.upgradeDaemon,
    restartDaemon: vi.fn(),
    setDaemonAutoUpgrade: mocks.setDaemonAutoUpgrade,
    daemons: [],
    refresh: vi.fn()
  })
}))
vi.mock('@/lib/api', () => ({ getDaemonLifecycleOp: vi.fn() }))
vi.mock('@/lib/daemon-notifications', () => ({ registerCommandedLifecycleOpId: vi.fn() }))

import DaemonLifecycleModal from './DaemonLifecycleModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let daemon: DaemonRow

beforeEach(() => {
  mocks.calls = []
  mocks.upgradeDaemon.mockReset().mockImplementation(async () => {
    mocks.calls.push('upgrade')
    return { id: 'op1', status: 'pending', phase: 'preparing' }
  })
  mocks.setDaemonAutoUpgrade.mockReset().mockImplementation(async () => {
    mocks.calls.push('auto')
  })
  daemon = {
    daemonId: 'd1',
    name: 'agent-0',
    version: '1.40.2',
    latestVersion: '1.41.0',
    releaseChannel: 'stable',
    availableVersions: ['1.39.0', '1.40.2', '1.41.0'],
    canManageLifecycle: true,
    autoUpgrade: false,
    autoUpgradeSupported: true
  } as unknown as DaemonRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () =>
  act(async () => root.render(<DaemonLifecycleModal daemon={daemon} mode="upgrade" onClose={() => {}} />))
const toggle = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!
const pick = (version: string) =>
  act(async () => {
    const select = host.querySelector('select')!
    select.value = version
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
const upgrade = () =>
  act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Upgrade')!.click())

describe('DaemonLifecycleModal auto-upgrade switch', () => {
  it('turns auto-upgrade on after the upgrade is commanded', async () => {
    await render()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle().click())
    await upgrade()
    expect(mocks.calls).toEqual(['upgrade', 'auto'])
    expect(mocks.setDaemonAutoUpgrade).toHaveBeenCalledWith('d1', true)
  })

  it('leaves the setting alone when the switch is untouched', async () => {
    await render()
    await upgrade()
    expect(mocks.setDaemonAutoUpgrade).not.toHaveBeenCalled()
  })

  it('turns auto-upgrade off when an owner switches it off here', async () => {
    daemon = { ...daemon, autoUpgrade: true }
    await render()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle().click())
    await upgrade()
    expect(mocks.setDaemonAutoUpgrade).toHaveBeenCalledWith('d1', false)
  })

  it('shows a disabled switch for a daemon that cannot upgrade itself', async () => {
    daemon = { ...daemon, autoUpgradeSupported: false }
    await render()
    expect(toggle().disabled).toBe(true)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('shows the switch off and locked for a target below the announced release', async () => {
    daemon = { ...daemon, autoUpgrade: true }
    await render()
    await pick('1.39.0')
    expect(toggle().disabled).toBe(true)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('Upgrading to an older version turns auto-upgrade off.')
    await upgrade()
    expect(mocks.setDaemonAutoUpgrade).not.toHaveBeenCalled()
  })

  it('says the upgrade started when only the switch fails', async () => {
    mocks.setDaemonAutoUpgrade.mockRejectedValue(new Error('boom'))
    await render()
    await act(async () => toggle().click())
    await upgrade()
    expect(mocks.upgradeDaemon).toHaveBeenCalled()
    expect(host.textContent).toContain('The upgrade started, but auto-upgrade could not be changed: boom')
  })
})

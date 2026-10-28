// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ setDaemonAutoUpgrade: vi.fn() }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ setDaemonAutoUpgrade: mocks.setDaemonAutoUpgrade })
}))

import { DaemonAutoUpgradeSetting } from './DaemonAutoUpgradeSetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let daemon: DaemonRow

beforeEach(() => {
  mocks.setDaemonAutoUpgrade.mockReset().mockResolvedValue(undefined)
  daemon = {
    daemonId: 'd1',
    version: '1.40.2',
    latestVersion: '1.41.0',
    upgradeAvailable: true,
    lifecycleOp: null,
    canManageLifecycle: true,
    autoUpgrade: false,
    autoUpgradeSupported: true,
    lastAutoUpgrade: null
  } as unknown as DaemonRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const toggle = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!

describe.each([false, true])('DaemonAutoUpgradeSetting (mobile: %s)', (mobile) => {
  const render = () => act(async () => root.render(<DaemonAutoUpgradeSetting daemon={daemon} mobile={mobile} />))

  it('lets an owner turn it on for a supported daemon', async () => {
    await render()
    expect(toggle().disabled).toBe(false)
    expect(host.textContent).toContain('restarts only when the daemon is idle')
    await act(async () => toggle().click())
    expect(mocks.setDaemonAutoUpgrade).toHaveBeenCalledWith('d1', true)
  })

  it('is disabled with the reason when the daemon cannot upgrade itself', async () => {
    daemon.autoUpgradeSupported = false
    await render()
    expect(toggle().disabled).toBe(true)
    expect(host.textContent).toContain('not available for pool members')
  })

  it('is read-only for a caller who cannot manage the daemon lifecycle', async () => {
    daemon.canManageLifecycle = false
    await render()
    expect(toggle().disabled).toBe(true)
  })

  it('says a switched-on daemon is waiting for an idle window', async () => {
    daemon.autoUpgrade = true
    await render()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Waiting for an idle window to upgrade to v1.41.0')
  })

  it('shows the last automatic failure with its reason', async () => {
    daemon.lastAutoUpgrade = {
      id: 'op-1',
      status: 'failed',
      targetVersion: '1.41.0',
      outcome: 'rolled back: crashed on start',
      settledAt: '2026-10-28T00:00:00.000Z'
    }
    await render()
    expect(host.textContent).toContain('Auto-upgrade to v1.41.0 failed: rolled back: crashed on start')
  })

  it('surfaces a refused change and returns the switch to the stored value', async () => {
    mocks.setDaemonAutoUpgrade.mockRejectedValue(new Error('auto-upgrade is not supported by this daemon'))
    await render()
    await act(async () => toggle().click())
    expect(host.textContent).toContain('auto-upgrade is not supported by this daemon')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })
})

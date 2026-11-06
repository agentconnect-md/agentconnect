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

const tooltip = () => host.querySelector<HTMLElement>('[title]')?.title ?? ''
const details = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  return host.querySelector('[role="note"]')?.textContent ?? ''
}

describe('DaemonAutoUpgradeSetting', () => {
  const render = () => act(async () => root.render(<DaemonAutoUpgradeSetting daemon={daemon} />))

  it('lets an owner turn it on for a supported daemon', async () => {
    await render()
    expect(toggle().disabled).toBe(false)
    expect(tooltip()).toContain('restarts only when the daemon is idle')
    await act(async () => toggle().click())
    expect(mocks.setDaemonAutoUpgrade).toHaveBeenCalledWith('d1', true)
  })

  it('is disabled with the reason when the daemon cannot upgrade itself', async () => {
    daemon.autoUpgradeSupported = false
    await render()
    expect(toggle().disabled).toBe(true)
    expect(tooltip()).toContain('not available for pool members')
    expect(await details()).toContain('not available for pool members')
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
    expect(tooltip()).toContain('Waiting for an idle window to upgrade to v1.41.0')
    expect(await details()).toContain('Waiting for an idle window to upgrade to v1.41.0')
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
    expect(await details()).toContain('Auto-upgrade to v1.41.0 failed: rolled back: crashed on start')
  })

  it('keeps the details inside a narrow viewport when the label sits near its right edge', async () => {
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    try {
      await render()
      const label = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
      label.getBoundingClientRect = () => ({ left: 200, bottom: 100 }) as DOMRect
      await act(async () => label.click())
      const panel = host.querySelector<HTMLElement>('[role="note"]')!
      expect([panel.style.left, panel.style.width, panel.style.top]).toEqual(['24px', '280px', '106px'])
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    }
  })

  it('surfaces a refused change and returns the switch to the stored value', async () => {
    mocks.setDaemonAutoUpgrade.mockRejectedValue(new Error('auto-upgrade is not supported by this daemon'))
    await render()
    await act(async () => toggle().click())
    expect(host.textContent).toContain('auto-upgrade is not supported by this daemon')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })
})

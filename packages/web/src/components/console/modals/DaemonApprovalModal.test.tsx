// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ change: vi.fn(), refresh: vi.fn(), close: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/api', () => ({ changeDaemonApproval: mocks.change, creatorLabel: () => 'Example member' }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('../ModalProvider', () => ({ useModal: () => ({ openModal: mocks.open }) }))

import DaemonApprovalModal from './DaemonApprovalModal'
import { DaemonApprovalAction } from '../DaemonApproval'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let daemon: DaemonRow
beforeEach(() => {
  vi.clearAllMocks()
  mocks.change.mockResolvedValue(undefined)
  daemon = {
    daemonId: 'd1',
    name: 'edge-1',
    host: 'machine.example.test',
    status: 'online',
    createdBy: 'u1',
    createdAt: '2026-01-01',
    sessionEpoch: 7,
    canManageApproval: true,
    approval: { status: 'pending', revision: 0, source: null, changedAt: null, changedBy: null }
  } as DaemonRow
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const render = (revoke = false) =>
  act(async () => root.render(<DaemonApprovalModal daemon={daemon} revoke={revoke} onClose={mocks.close} />))
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!

it('reviews the machine and submits the displayed approval revision and connection', async () => {
  await render()
  expect([...host.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['Created by', 'Host', 'Status'])
  expect(host.textContent).toContain('machine.example.test')
  await act(async () => button('Approve').click())
  expect(mocks.change).toHaveBeenCalledExactlyOnceWith(daemon, 'approved')
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
})

it('does not offer approval actions to other editors', async () => {
  daemon.canManageApproval = false
  await act(async () => root.render(<DaemonApprovalAction daemon={daemon} />))
  expect(host.querySelector('button')).toBeNull()
  await render()
  expect(button('Approve').disabled).toBe(true)
  expect(mocks.change).not.toHaveBeenCalled()
})

it('requires a connected machine to approve but permits offline revocation', async () => {
  daemon.status = 'offline'
  await render()
  expect(button('Approve').disabled).toBe(true)
  expect(host.textContent).toContain('Connect this daemon before approving it.')
  await render(true)
  await act(async () => button('Revoke approval').click())
  expect(mocks.change).toHaveBeenCalledExactlyOnceWith(daemon, 'revoked')
})

it('keeps the dialog open after a stale review is rejected', async () => {
  mocks.change.mockRejectedValue(new Error('approval changed; refresh and try again'))
  await render()
  await act(async () => button('Approve').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('approval changed')
  expect(mocks.close).not.toHaveBeenCalled()
})

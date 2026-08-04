// @vitest-environment happy-dom

// A Lark/Feishu device registration is minted against ONE cloud: its
// authorization URL, its poll and the app it creates all belong to that region.
// The region switcher lives on the host's picker tile, so the fragment has to
// tell the host to hold it while a registration is pending — otherwise a switch
// silently relabels the still-original registration as the other cloud. The
// monolith did this with `disabled={… || feishuPhase === 'authorizing'}`.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'

const mocks = vi.hoisted(() => ({
  startFeishuRegistration: vi.fn(),
  getFeishuRegistration: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  startFeishuRegistration: mocks.startFeishuRegistration,
  getFeishuRegistration: mocks.getFeishuRegistration
}))

import { FeishuWizardBody } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent

let host: HTMLDivElement
let root: Root
let setRegionLocked: ReturnType<typeof vi.fn<(locked: boolean) => void>>

function wizardHost(): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: false, publicUrl: null },
    mode: 'create',
    selectedBot: null,
    region: 'lark',
    transport: 'socket',
    setTransport: vi.fn(),
    shared: false,
    mockMode: false,
    setFooter: vi.fn(),
    setIdentityChrome: vi.fn(),
    setRegionLocked,
    setError: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn()
  }
}

const lastLock = () => setRegionLocked.mock.calls.at(-1)?.[0]

function buttonWithText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`no button labeled "${text}"`)
  return found
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setRegionLocked = vi.fn<(locked: boolean) => void>()
  mocks.startFeishuRegistration.mockReset()
  mocks.getFeishuRegistration.mockReset()
  mocks.getFeishuRegistration.mockResolvedValue({ status: 'pending', failureReason: null })
  vi.stubGlobal(
    'open',
    vi.fn(() => null)
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('Lark/Feishu region lock', () => {
  it('holds the host region switcher only while a registration is pending', async () => {
    mocks.startFeishuRegistration.mockResolvedValue({
      id: 'reg-1',
      authorizationUrl: 'https://open.example.test/authorize?state=reg-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      transport: 'socket'
    })

    await act(async () => root.render(<FeishuWizardBody agent={agent} host={wizardHost()} />))
    // Nothing started yet — the user may still pick the other cloud.
    expect(lastLock()).toBe(false)

    await act(async () => buttonWithText('Create Lark bot').click())
    await settle()

    expect(mocks.startFeishuRegistration).toHaveBeenCalledTimes(1)
    expect(lastLock()).toBe(true)
  })

  it('releases the switcher when the registration never starts', async () => {
    mocks.startFeishuRegistration.mockRejectedValue(new Error('Lark rejected the request'))

    await act(async () => root.render(<FeishuWizardBody agent={agent} host={wizardHost()} />))
    await act(async () => buttonWithText('Create Lark bot').click())
    await settle()

    expect(lastLock()).toBe(false)
  })
})

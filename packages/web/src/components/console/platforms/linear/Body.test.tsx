// @vitest-environment happy-dom

// The wizard pane's three availability conditions (§4.2, §7.1). The daemon-capability
// leg is the host's picker gate and is pinned in `module.test.tsx`; the other two are
// the pane's, and both fail CLOSED — a pane that offers "Connect Linear" without a
// relay, or without the deployment's Linear app, sends the operator through an OAuth
// round trip that cannot land.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackConfigDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'

const mocks = vi.hoisted(() => ({
  probeConfig: null as SlackConfigDto | null,
  probeFailed: false,
  startLinearConnect: vi.fn(),
  getLinearConnect: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  startLinearConnect: mocks.startLinearConnect,
  getLinearConnect: mocks.getLinearConnect
}))
vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({ config: mocks.probeConfig, failed: mocks.probeFailed, apply: vi.fn() })
}))

import { ApiError } from '@/lib/api'
import { LinearWizardBody } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: true, publicUrl: null },
    mode: 'create',
    selectedBot: null,
    transport: 'http',
    setTransport: vi.fn(),
    shared: false,
    mockMode: false,
    setFooter: (state) => {
      footer = state
    },
    setIdentityChrome: vi.fn(),
    setRegionLocked: vi.fn(),
    setError: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    ...over
  }
}

/** A probe answer — only `relayAvailable` matters here; the pane reads the VALUE
 *  off the host so the two can never disagree. */
const answered: SlackConfigDto = {
  configured: true,
  durable: true,
  funnelEnabled: true,
  autoAvailable: true,
  accessExpiresAt: null,
  relayAvailable: true,
  relayPublicUrl: null,
  platformInstallAvailable: true,
  updatedAt: null
}

const text = () => host.textContent ?? ''

function connectButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Connect Linear'))
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
  footer = null
  mocks.probeConfig = null
  mocks.probeFailed = false
  mocks.startLinearConnect.mockReset()
  mocks.getLinearConnect.mockReset()
  mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'pending', failureReason: null, botId: null })
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

describe('the Linear connect hand-off', () => {
  it('waits instead of offering the hand-off while the deployment probe is in flight', async () => {
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    expect(text()).toContain('Checking your Linear setup')
    expect(connectButton()).toBeUndefined()
  })

  it('refuses without public callback delivery', async () => {
    mocks.probeConfig = answered
    const hostState = wizardHost({ relayCapability: { available: false, publicUrl: null } })
    await act(async () => root.render(<LinearWizardBody agent={agent} host={hostState} />))

    expect(text()).toContain('HTTP callbacks only')
    expect(connectButton()).toBeUndefined()
  })

  it('reads a failed probe as no relay rather than as an answer it never got', async () => {
    mocks.probeFailed = true
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    expect(text()).toContain('HTTP callbacks only')
  })

  it('offers the hand-off once a relay is connected, naming this agent as the default', async () => {
    mocks.probeConfig = answered
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))

    expect(connectButton()).toBeDefined()
    expect(text()).toContain('deploy-bot becomes its default agent')
  })

  it('self-disables when the deployment registered no Linear app', async () => {
    // The funnel's 404 is the only signal there is — nothing advertises the
    // deployment app to the console, so the pane learns it from the route.
    mocks.probeConfig = answered
    mocks.startLinearConnect.mockRejectedValue(new ApiError('not found', 404))
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    await act(async () => connectButton()!.click())
    await settle()

    expect(text()).toContain('isn’t set up on this deployment yet')
    expect(connectButton()).toBeUndefined()
  })

  it('opens the authorize URL and waits for the round trip', async () => {
    mocks.probeConfig = answered
    mocks.startLinearConnect.mockResolvedValue({
      id: 'c1',
      connectUrl: 'https://linear.app/oauth/authorize?state=c1'
    })
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    await act(async () => connectButton()!.click())
    await settle()

    expect(mocks.startLinearConnect).toHaveBeenCalledWith('agent-a')
    expect(window.open).toHaveBeenCalledWith(
      'https://linear.app/oauth/authorize?state=c1',
      '_blank',
      expect.any(String)
    )
    expect(text()).toContain('Waiting for Linear')
  })

  it('closes the modal once the funnel row settles', async () => {
    mocks.probeConfig = answered
    mocks.startLinearConnect.mockResolvedValue({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize' })
    mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'completed', failureReason: null, botId: 'bot-9' })
    const close = vi.fn()
    const invalidate = vi.fn()
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost({ close, invalidate })} />))
    await act(async () => connectButton()!.click())
    await settle()

    expect(invalidate).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('shows the settled row’s refusal — the throwaway tab has no other channel back', async () => {
    mocks.probeConfig = answered
    mocks.startLinearConnect.mockResolvedValue({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize' })
    mocks.getLinearConnect.mockResolvedValue({
      id: 'c1',
      status: 'failed',
      failureReason: 'workspace_taken',
      botId: null
    })
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    await act(async () => connectButton()!.click())
    await settle()

    expect(text()).toContain('already connected to a different organization')
    // Back to a clickable state rather than stuck waiting on a settled row.
    expect(connectButton()).toBeDefined()
  })

  it('keeps the host’s create primary hidden — the pane commits with its own button', async () => {
    mocks.probeConfig = answered
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost()} />))
    expect(footer?.hidden).toBe(true)
  })

  it('explains membership rather than the funnel in reuse mode', async () => {
    mocks.probeConfig = answered
    await act(async () => root.render(<LinearWizardBody agent={agent} host={wizardHost({ mode: 'existing' })} />))

    expect(connectButton()).toBeUndefined()
    expect(text()).toContain('joins this workspace as a member')
  })
})

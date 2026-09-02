// @vitest-environment happy-dom

// The wizard pane. Two things it has to get right, and they are the two questions the
// corrected model asks: WHICH connected workspace this agent joins (single-select, the
// existing-bot reuse path), and — only when there is none, or the operator asks for
// another — the zero-config connect hand-off.
//
// Its three availability conditions (§4.2, §7.1) both fail CLOSED: a pane that offers
// a connect without a relay, or without the deployment's Linear app, sends the
// operator through an OAuth round trip that cannot land. The daemon-capability leg is
// the host's picker gate and is pinned in `module.test.tsx`.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto, SlackConfigDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from '../contract'

const mocks = vi.hoisted(() => ({
  probeConfig: null as SlackConfigDto | null,
  probeFailed: false,
  bots: [] as BotDto[],
  loading: false,
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
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    get loading() {
      return mocks.loading
    }
  })
}))

import { ApiError } from '@/lib/api'
import { LinearWizardBody } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null
let identity: WizardIdentityChromeState | null

function workspace(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'ws-1',
    name: 'Example Workspace',
    platform: 'linear',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: true,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    workspaceName: 'Example Workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

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
    setIdentityChrome: (state) => {
      identity = state
    },
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
const buttons = () => [...host.querySelectorAll('button')]
const buttonWith = (label: string) => buttons().find((b) => b.textContent?.includes(label))

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(over: Partial<WizardHost> = {}): Promise<WizardHost> {
  const state = wizardHost(over)
  await act(async () => root.render(<LinearWizardBody agent={agent} host={state} />))
  await settle()
  return state
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  identity = null
  mocks.probeConfig = null
  mocks.probeFailed = false
  mocks.bots = []
  mocks.loading = false
  mocks.startLinearConnect.mockReset()
  mocks.getLinearConnect.mockReset()
  mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'pending', failureReason: null, botId: null })
  mocks.startLinearConnect.mockResolvedValue({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize?state=c1' })
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

describe('the pane’s deployment conditions', () => {
  it('waits instead of offering anything while the deployment probe is in flight', async () => {
    mocks.bots = [workspace()]
    await render()

    expect(text()).toContain('Checking your Linear setup')
    expect(buttonWith('Example Workspace')).toBeUndefined()
  })

  it('refuses without public callback delivery', async () => {
    mocks.probeConfig = answered
    await render({ relayCapability: { available: false, publicUrl: null } })

    expect(text()).toContain('HTTP callbacks only')
    expect(buttonWith('Connect Linear')).toBeUndefined()
  })

  it('reads a failed probe as no relay rather than as an answer it never got', async () => {
    mocks.probeFailed = true
    await render()
    expect(text()).toContain('HTTP callbacks only')
  })

  it('self-disables when the deployment registered no Linear app', async () => {
    // The funnel's 404 is the only signal there is — nothing advertises the
    // deployment app to the console, so the pane learns it from the route.
    mocks.probeConfig = answered
    mocks.startLinearConnect.mockRejectedValue(new ApiError('not found', 404))
    await render()
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()

    expect(text()).toContain('isn’t set up on this deployment yet')
  })
})

describe('the workspace picker', () => {
  it('replaces the host identity chassis and its footer primary', async () => {
    // The chassis asks "create an identity or reuse one" — a question Linear does not
    // have. Hiding it is what keeps the mode cards, the free-bot list and the share
    // toggle off a platform whose bot is a workspace.
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    await render()

    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)
  })

  it('lists the org’s connected workspaces by name, and nothing else', async () => {
    mocks.probeConfig = answered
    mocks.bots = [
      workspace({ id: 'ws-1', workspaceName: 'Example Workspace' }),
      workspace({ id: 'ws-2', workspaceName: 'Second Workspace' }),
      // Another platform's bot is not this list's business.
      workspace({ id: 'sl-1', platform: 'slack', name: 'acme', workspaceName: 'acme' })
    ]
    await render()

    expect(text()).toContain('Example Workspace')
    expect(text()).toContain('Second Workspace')
    expect(text()).not.toContain('acme')
  })

  it('links this agent to the picked workspace and closes — one click, no footer step', async () => {
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    const state = await render()
    await act(async () => buttonWith('Example Workspace')!.click())
    await settle()

    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'linear',
      agentId: 'agent-a',
      botId: 'ws-1',
      transport: 'http'
    })
    expect(state.close).toHaveBeenCalled()
  })

  it('shows a workspace this agent already links as linked, and refuses to link it twice', async () => {
    mocks.probeConfig = answered
    mocks.bots = [workspace({ agentIds: ['agent-a', 'agent-b'] })]
    const state = await render()

    const row = buttonWith('Example Workspace')!
    expect(row.textContent).toContain('linked')
    expect(row.disabled).toBe(true)
    await act(async () => row.click())
    expect(state.createIntegration).not.toHaveBeenCalled()
  })

  it('surfaces a refused link instead of closing on it', async () => {
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    const state = await render({ createIntegration: vi.fn(async () => Promise.reject(new Error('bot is revoked'))) })
    await act(async () => buttonWith('Example Workspace')!.click())
    await settle()

    expect(text()).toContain('bot is revoked')
    expect(state.close).not.toHaveBeenCalled()
  })
})

describe('the connect hand-off', () => {
  it('lands on the hand-off when the org has connected none, and opens nothing unasked', async () => {
    // Zero-config is "no fields", not "no button": the authorize tab is a popup, and a
    // popup opened from an effect rather than from a click is blocked by default — a
    // first run that would silently open nothing at all.
    mocks.probeConfig = answered
    await render()

    expect(text()).toContain('You approve the workspace in a Linear popup')
    expect(text()).toContain('becomes the workspace’s default agent')
    expect(mocks.startLinearConnect).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('opens the authorize tab from the operator’s own click', async () => {
    mocks.probeConfig = answered
    await render()
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()

    expect(mocks.startLinearConnect).toHaveBeenCalledWith('agent-a')
    expect(window.open).toHaveBeenCalledWith(
      'https://linear.app/oauth/authorize?state=c1',
      '_blank',
      expect.any(String)
    )
    expect(text()).toContain('Waiting for Linear')
  })

  it('stays on the picker while the bot roster is still loading', async () => {
    // An empty roster that has not answered yet is not "no workspaces" — landing on the
    // hand-off would replace a picker the operator was one tick away from seeing.
    mocks.probeConfig = answered
    mocks.loading = true
    await render()

    expect(text()).toContain('Pick the Linear workspace')
    expect(buttonWith('Connect Linear')).toBeUndefined()
  })

  it('reaches the hand-off from the picker, still without starting one unasked', async () => {
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    await render()
    expect(mocks.startLinearConnect).not.toHaveBeenCalled()

    await act(async () => buttonWith('Connect another workspace')!.click())
    await settle()
    expect(text()).toContain('You approve the workspace in a Linear popup')
    expect(mocks.startLinearConnect).not.toHaveBeenCalled()

    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()
    expect(mocks.startLinearConnect).toHaveBeenCalledWith('agent-a')
  })

  it('goes back to the picker when there is one to go back to', async () => {
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    const state = await render()
    await act(async () => buttonWith('Connect another workspace')!.click())
    await act(async () => buttonWith('Back')!.click())

    expect(text()).toContain('Example Workspace')
    expect(state.close).not.toHaveBeenCalled()
  })

  it('leaves the gate to the host footer when the hand-off is the whole pane', async () => {
    // Nowhere to go back TO, and the modal chassis already renders its own Cancel — a
    // second one beside the primary would be two words for one action.
    mocks.probeConfig = answered
    await render()

    expect(buttonWith('Back')).toBeUndefined()
    expect(buttonWith('Cancel')).toBeUndefined()
  })

  it('renders no second Cancel beside the host’s while the forced pane’s round trip is in flight', async () => {
    mocks.probeConfig = answered
    await render()
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()

    expect(text()).toContain('Waiting for Linear')
    expect(buttonWith('Cancel')).toBeUndefined()
    expect(buttonWith('Back')).toBeUndefined()
  })

  it('closes the authorize popup when the host closes the wizard mid-round-trip', async () => {
    // The host footer's Cancel unmounts the pane; the popup must not outlive the poll.
    const popup = { close: vi.fn(), closed: false }
    vi.stubGlobal(
      'open',
      vi.fn(() => popup)
    )
    mocks.probeConfig = answered
    await render()
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()
    await act(async () => root.unmount())

    expect(popup.close).toHaveBeenCalled()
  })

  it('goes back to the picker from a round trip in flight, closing the popup it opened', async () => {
    const popup = { close: vi.fn(), closed: false }
    vi.stubGlobal(
      'open',
      vi.fn(() => popup)
    )
    mocks.probeConfig = answered
    mocks.bots = [workspace()]
    const state = await render()
    await act(async () => buttonWith('Connect another workspace')!.click())
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()
    await act(async () => buttonWith('Back')!.click())

    expect(popup.close).toHaveBeenCalled()
    expect(text()).toContain('Example Workspace')
    expect(state.close).not.toHaveBeenCalled()
  })

  it('names the settled success and the default agent it just made', async () => {
    mocks.probeConfig = answered
    mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'completed', failureReason: null, botId: 'bot-9' })
    // The refresh a completed round trip fires is what fills the roster in — the pane
    // must stay on its terminal state instead of flipping to a picker behind it.
    const state = await render({ invalidate: vi.fn(() => void (mocks.bots = [workspace()])) })
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()

    expect(state.invalidate).toHaveBeenCalled()
    expect(text()).toContain('Workspace connected')
    expect(text()).toContain('is its default agent')
    expect(text()).not.toContain('bare delegation')
    await act(async () => buttonWith('Done')!.click())
    expect(state.close).toHaveBeenCalled()
  })

  it('shows the settled row’s refusal — the throwaway tab has no other channel back', async () => {
    mocks.probeConfig = answered
    mocks.getLinearConnect.mockResolvedValue({
      id: 'c1',
      status: 'failed',
      failureReason: 'workspace_taken',
      botId: null
    })
    await render()
    await act(async () => buttonWith('Connect Linear')!.click())
    await settle()

    expect(text()).toContain('already connected to a different organization')
    // A settled failure is retryable rather than a dead end, and nothing restarts it
    // behind the operator's back.
    expect(mocks.startLinearConnect).toHaveBeenCalledTimes(1)
    await act(async () => buttonWith('Try again')!.click())
    await settle()
    expect(mocks.startLinearConnect).toHaveBeenCalledTimes(2)
  })
})

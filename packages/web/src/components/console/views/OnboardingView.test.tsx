// @vitest-environment happy-dom
import { act } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  daemons: [] as Array<Record<string, unknown>>,
  integrations: [] as Array<Record<string, unknown>>,
  allSessions: [] as Array<Record<string, unknown>>,
  members: [] as Array<Record<string, unknown>>,
  agentsLoading: false,
  daemonsLoading: false,
  provisionDaemon: vi.fn(),
  reconnectDaemon: vi.fn(),
  deleteDaemon: vi.fn(),
  updateAgent: vi.fn(),
  moveAgent: vi.fn(),
  refresh: vi.fn(),
  refreshDaemons: vi.fn(),
  push: vi.fn(),
  skipOnboarding: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'acme' }),
  useRouter: () => ({ push: mocks.push })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: mocks.agents,
    daemons: mocks.daemons,
    integrations: mocks.integrations,
    allSessions: mocks.allSessions,
    members: mocks.members,
    agentsLoading: mocks.agentsLoading,
    daemonsLoading: mocks.daemonsLoading,
    provisionDaemon: mocks.provisionDaemon,
    reconnectDaemon: mocks.reconnectDaemon,
    deleteDaemon: mocks.deleteDaemon,
    updateAgent: mocks.updateAgent,
    moveAgent: mocks.moveAgent,
    refresh: mocks.refresh,
    refreshDaemons: mocks.refreshDaemons
  })
}))
// RuntimeSelect pulls the ACP registry context + AgentMark; stub it to the picked value.
vi.mock('@/components/console/RuntimeSelect', () => ({
  RuntimeSelect: ({ value }: { value: string }) => `runtime-${value}`
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { email: 'dana@acme.dev', initials: 'DR' } }) }))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true }))
vi.mock('@/lib/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/onboarding')>()
  return { ...actual, skipOnboarding: mocks.skipOnboarding }
})
vi.mock('@/lib/daemon-commands', () => ({ daemonCommands: (command: string) => ({ run: command, login: command }) }))
vi.mock('@/components/console/GettingStartedChecklist', () => ({
  useGsActions: () => ({ runAction: vi.fn(), firstAgent: mocks.agents[0] }),
  useGithubProfileLinked: () => undefined,
  useGithubAppEnabled: () => undefined,
  // Same convention as the two probes above: undefined is the "unknowable, keep the
  // step" value, so the reveal renders the full checklist (computeGettingStarted only
  // drops the session-access row on a definitive false).
  useSessionAccessCardAvailable: () => undefined,
  useSlackPlatformAppAvailable: () => true,
  GsRows: () => <div>rows</div>
}))
vi.mock('@/components/marks', () => ({
  LogoMark: () => <span>logo</span>,
  LoadingState: () => <span>loading data</span>
}))
vi.mock('@/components/ui', () => ({
  Avatar: () => <span>avatar</span>,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  Icon: () => <span />
}))

import OnboardingView from './OnboardingView'
import { FALLBACK_RUNTIME_IDS } from '@/lib/data'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

const button = (label: string) => {
  const match = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}
const click = async (label: string) => {
  await act(async () => {
    button(label).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const render = async () => {
  await act(async () => root.render(<OnboardingView />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

/** Cloud pool on ⇒ onboarding skips the daemon phase entirely (lib/feature-flags.ts). */
const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

beforeEach(() => {
  setFlags('') // self-hosted by default: the daemon phase is the blocking first step
  mocks.agents = []
  mocks.daemons = []
  mocks.integrations = []
  mocks.allSessions = []
  mocks.members = []
  mocks.agentsLoading = false
  mocks.daemonsLoading = false
  mocks.provisionDaemon.mockReset()
  mocks.reconnectDaemon.mockReset()
  mocks.deleteDaemon.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
  mocks.refreshDaemons.mockReset().mockResolvedValue(undefined)
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.moveAgent.mockReset().mockResolvedValue(undefined)
  mocks.push.mockReset()
  mocks.skipOnboarding.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('onboarding — connect step', () => {
  it('mints a join command on mount when no daemon is online', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Connect your daemon')
    expect(host.textContent).toContain('agentconnect run')
    expect(host.textContent).toContain('Listening for dmn_new')
  })

  it('reconnects an existing offline daemon instead of provisioning a new one', async () => {
    mocks.daemons = [{ daemonId: 'offline-1', status: 'offline' }]
    mocks.reconnectDaemon.mockResolvedValue({ command: 'agentconnect run --resume' })
    await render()
    expect(mocks.reconnectDaemon).toHaveBeenCalledWith('offline-1')
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
  })

  it('deletes an unclaimed provisioned daemon when exploring the console instead', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    await click('Explore the console first')
    expect(mocks.deleteDaemon).toHaveBeenCalledWith('dmn_new')
    expect(mocks.skipOnboarding).toHaveBeenCalledWith('acme')
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
  })

  // Partial-load regression: agents resolving first (every org ships the builtin
  // preset) must NOT trigger a mint while the fleet list is still loading — the
  // pending response may already contain a connected daemon.
  it('does not mint while the daemon list is still loading, even with agents loaded', async () => {
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
    mocks.daemonsLoading = true
    await render()
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(mocks.reconnectDaemon).not.toHaveBeenCalled()
  })

  it('offers Retry after a mint failure and re-drives the request', async () => {
    mocks.provisionDaemon
      .mockRejectedValueOnce(new Error('cp unreachable'))
      .mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    expect(host.textContent).toContain('cp unreachable')
    await click('Retry')
    expect(mocks.refreshDaemons).toHaveBeenCalled()
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('agentconnect run')
  })

  // A failed refresh leaves the stale snapshot — re-arming against it could duplicate
  // an ambiguously-successful provision. Stay latched, show the error, keep Retry.
  it('does not re-arm provisioning when the fleet refresh itself fails', async () => {
    mocks.provisionDaemon.mockRejectedValueOnce(new Error('cp unreachable'))
    mocks.refreshDaemons.mockRejectedValue(new Error('network down'))
    await render()
    await click('Retry')
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1) // no second mint
    expect(host.textContent).toContain('Could not refresh the daemon list')
  })

  // Ambiguous success: the failed provision actually landed server-side. Retry must
  // observe the refreshed fleet (the new offline row) and reconnect it — never mint
  // a second daemon against the stale empty list.
  it('retries via reconnect when the failed provision succeeded server-side', async () => {
    mocks.provisionDaemon.mockRejectedValueOnce(new Error('response lost'))
    mocks.refreshDaemons.mockImplementation(async () => {
      mocks.daemons = [{ daemonId: 'dmn_ghost', status: 'offline' }]
    })
    mocks.reconnectDaemon.mockResolvedValue({ command: 'agentconnect run --resume' })
    await render()
    expect(host.textContent).toContain('response lost')
    await click('Retry')
    expect(mocks.reconnectDaemon).toHaveBeenCalledWith('dmn_ghost')
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
  })
})

describe('onboarding — daemon online reveal', () => {
  beforeEach(() => {
    mocks.daemons = [{ daemonId: 'dmn_new', status: 'online', name: 'edge-1' }]
  })

  it('reveals the checklist and never provisions a daemon', async () => {
    await render()
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Your daemon is online')
    expect(host.textContent).toContain('Getting started')
    expect(host.textContent).toContain('rows') // <GsRows/> stub
  })

  it('finish stays disabled until every step is done; skip always exits to the console', async () => {
    await render() // only the daemon step is done → finish disabled
    expect(button('Finish onboarding').disabled).toBe(true)
    await click('Skip for now')
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
    // an online daemon that has connected is never deleted on the way out
    expect(mocks.deleteDaemon).not.toHaveBeenCalled()
  })
})

describe('onboarding — configure the built-in agent', () => {
  beforeEach(() => {
    mocks.daemons = [
      {
        daemonId: 'dmn_new',
        status: 'online',
        name: 'edge-1',
        runtimeModels: [{ runtime: 'claude', models: ['claude-sonnet-4-5'] }]
      }
    ]
    // The org's unplaced built-in preset: no daemon, deferred runtime.
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
  })

  it('shows the configure step for an unplaced built-in agent instead of the reveal', async () => {
    await render()
    expect(host.textContent).toContain('Configure')
    expect(host.textContent).toContain('runtime-claude') // RuntimeSelect stub, seeded from the daemon
    expect(host.textContent).not.toContain('Your daemon is online')
  })

  it('sets the runtime BEFORE moving the agent onto the connected daemon, then reveals', async () => {
    await render()
    await click('Save and continue')
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: 'claude', model: 'claude-sonnet-4-5' })
    expect(mocks.moveAgent).toHaveBeenCalledWith('ag_ac', { kind: 'daemon', daemonId: 'dmn_new' })
    // Order matters: the CP rejects a move on a runtime-less agent.
    const updateOrder = mocks.updateAgent.mock.invocationCallOrder[0] ?? 0
    const moveOrder = mocks.moveAgent.mock.invocationCallOrder[0] ?? Infinity
    expect(updateOrder).toBeLessThan(moveOrder)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('lets the user skip to the reveal without configuring', async () => {
    await render()
    await click('Skip for now')
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Your daemon is online')
  })
})

// The cloud pool hosts the agents, so there is nothing to connect: no mint, no waiting
// card, and the built-in agent is configured without a placement move.
describe('onboarding — cloud pool', () => {
  beforeEach(() => setFlags('daemon-pool'))

  it('skips the daemon phase and never provisions one', async () => {
    await render()
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(mocks.reconnectDaemon).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Connect your daemon')
    expect(host.textContent).toContain('Welcome to AgentConnect')
  })

  it('configures the built-in agent with no daemon row and no placement move', async () => {
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
    await render()
    expect(host.textContent).toContain('Configure')
    expect(host.textContent).not.toContain('just connected') // no "Runs on" row
    await click('Save and continue')
    // No daemon reports runtimes on the pool, so the static fallback seeds the picker.
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: FALLBACK_RUNTIME_IDS[0] })
    expect(mocks.moveAgent).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Welcome to AgentConnect')
  })
})

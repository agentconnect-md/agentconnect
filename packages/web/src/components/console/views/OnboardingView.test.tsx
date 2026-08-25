// @vitest-environment happy-dom
import { act } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  daemons: [] as Array<Record<string, unknown>>,
  agentsLoading: false,
  daemonsLoading: false,
  org: { id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner', onboardingCompleted: false } as Record<
    string,
    unknown
  > | null,
  provisionDaemon: vi.fn(),
  reconnectDaemon: vi.fn(),
  deleteDaemon: vi.fn(),
  updateAgent: vi.fn(),
  moveAgent: vi.fn(),
  refresh: vi.fn(),
  refreshDaemons: vi.fn(),
  updateOrg: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  skipOnboarding: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'acme' }),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: mocks.agents,
    daemons: mocks.daemons,
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
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: mocks.org, orgPath: (path: string) => `/acme${path}`, updateOrg: mocks.updateOrg }),
  orgUrlPrefix: () => 'app.example/'
}))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true }))
vi.mock('@/lib/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/onboarding')>()
  return { ...actual, skipOnboarding: mocks.skipOnboarding }
})
vi.mock('@/lib/daemon-commands', () => ({ daemonCommands: (command: string) => ({ run: command, login: command }) }))
vi.mock('@/components/marks', () => ({
  LoadingState: () => <span>loading data</span>
}))
vi.mock('@/components/ui', () => ({
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
const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

beforeEach(() => {
  setFlags('') // self-hosted, no pool: org step → daemon step, no fork
  mocks.agents = []
  mocks.daemons = []
  mocks.agentsLoading = false
  mocks.daemonsLoading = false
  mocks.org = { id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner', onboardingCompleted: false }
  // Defaults so tests that merely pass THROUGH the daemon step don't crash the mint
  // effect; assertions on call counts/args are unaffected.
  mocks.provisionDaemon.mockReset().mockResolvedValue({ daemonId: 'dmn_default', command: 'agentconnect run' })
  mocks.reconnectDaemon.mockReset().mockResolvedValue({ command: 'agentconnect run --resume' })
  mocks.deleteDaemon.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
  mocks.refreshDaemons.mockReset().mockResolvedValue(undefined)
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.moveAgent.mockReset().mockResolvedValue(undefined)
  mocks.updateOrg.mockReset().mockResolvedValue(undefined)
  mocks.push.mockReset()
  mocks.replace.mockReset()
  mocks.skipOnboarding.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('onboarding — access', () => {
  it('bounces a non-owner back to the console', async () => {
    mocks.org = { ...mocks.org!, role: 'collaborator' }
    await render()
    expect(mocks.replace).toHaveBeenCalledWith('/acme/home')
    expect(host.textContent).toContain('loading data') // never renders the wizard
  })

  it('opens straight on the daemon step when the deployment has no pool', async () => {
    await render()
    expect(host.textContent).toContain('Run the daemon')
    // Org creation (/welcome) was step 1, so the daemon step reads 2 of 2.
    expect(host.textContent).toContain('Step 2 of 2')
  })
})

describe('onboarding — daemon step (no pool: the only path)', () => {
  it('mints a join command on entering the step when no daemon is online', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('agentconnect run')
    expect(host.textContent).toContain('Listening for dmn_new')
  })

  // With the pool flag off the console hides pool Pods, so an org whose fleet carries them
  // is still daemon-less here: mint a real join command, never a reconnect token for a Pod.
  it('ignores pool member Pods when the deployment does not offer the pool', async () => {
    mocks.daemons = [{ daemonId: 'pool-pod-1', pool: true, status: 'online', name: 'ac-cloud-7f9' }]
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
    expect(mocks.reconnectDaemon).not.toHaveBeenCalled()
  })

  it('reconnects an existing offline daemon instead of provisioning a new one', async () => {
    mocks.daemons = [{ daemonId: 'offline-1', status: 'offline' }]
    mocks.reconnectDaemon.mockResolvedValue({ command: 'agentconnect run --resume' })
    await render()
    expect(mocks.reconnectDaemon).toHaveBeenCalledWith('offline-1')
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
  })

  // Partial-load regression: agents resolving first must NOT trigger a mint while the
  // fleet list is still loading — the pending response may contain a connected daemon.
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

  it('Skip marks the org onboarded, THEN deletes the unclaimed provisioned daemon, and exits', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    await click('Skip')
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
    expect(mocks.deleteDaemon).toHaveBeenCalledWith('dmn_new')
    // Cleanup only after the completion PATCH succeeded — a failed PATCH keeps the user
    // in the wizard with a command whose row must still exist.
    const patchOrder = mocks.updateOrg.mock.invocationCallOrder[0] ?? Infinity
    const deleteOrder = mocks.deleteDaemon.mock.invocationCallOrder[0] ?? 0
    expect(patchOrder).toBeLessThan(deleteOrder)
    expect(mocks.skipOnboarding).toHaveBeenCalledWith('acme')
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
  })

  it('keeps the minted daemon when the completion PATCH fails on Skip', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    mocks.updateOrg.mockRejectedValue(new Error('cp unreachable'))
    await render()
    await click('Skip')
    expect(mocks.deleteDaemon).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(host.textContent).toContain('cp unreachable')
  })
})

describe('onboarding — daemon online: configure + finish', () => {
  beforeEach(() => {
    mocks.daemons = [
      {
        daemonId: 'dmn_new',
        status: 'online',
        name: 'edge-1',
        host: 'darwin/arm64',
        version: '0.4.2',
        runtimeModels: [{ runtime: 'claude', models: ['claude-sonnet-4-5'] }]
      }
    ]
    // The org's unplaced built-in preset: no daemon, deferred runtime.
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
  })

  it('shows the online daemon card and the runtime pickers, without provisioning', async () => {
    await render()
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(host.textContent).toContain('edge-1')
    expect(host.textContent).toContain('online')
    expect(host.textContent).toContain('runtime-claude') // RuntimeSelect stub, seeded from the daemon
  })

  it('Finish sets the runtime BEFORE moving the agent, marks onboarded, and exits', async () => {
    await render()
    await click('Finish')
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: 'claude', model: 'claude-sonnet-4-5' })
    expect(mocks.moveAgent).toHaveBeenCalledWith('ag_ac', { kind: 'daemon', daemonId: 'dmn_new' })
    // Order matters: the CP rejects a move on a runtime-less agent.
    const updateOrder = mocks.updateAgent.mock.invocationCallOrder[0] ?? 0
    const moveOrder = mocks.moveAgent.mock.invocationCallOrder[0] ?? Infinity
    expect(updateOrder).toBeLessThan(moveOrder)
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
    expect(mocks.deleteDaemon).not.toHaveBeenCalled() // a connected daemon is never deleted
  })

  it('does not mark the org onboarded when placement fails', async () => {
    mocks.moveAgent.mockRejectedValue(new Error('placement refused'))
    await render()
    await click('Finish')
    expect(mocks.updateOrg).not.toHaveBeenCalled() // flag only after ALL placement calls succeed
    expect(mocks.push).not.toHaveBeenCalled()
    expect(host.textContent).toContain('placement refused')
  })

  it('stays on the wizard when the completion PATCH itself fails', async () => {
    mocks.updateOrg.mockRejectedValue(new Error('cp unreachable'))
    await render()
    await click('Finish')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(host.textContent).toContain('cp unreachable')
  })

  it('marks the org onboarded only AFTER the placement calls', async () => {
    await render()
    await click('Finish')
    const moveOrder = mocks.moveAgent.mock.invocationCallOrder[0] ?? Infinity
    const flagOrder = mocks.updateOrg.mock.invocationCallOrder[0] ?? 0
    expect(moveOrder).toBeLessThan(flagOrder)
  })

  it('re-homes an already-placed built-in agent: move onto the daemon FIRST, then patch', async () => {
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: 'dmn_pool', runtime: 'claude' }]
    await render()
    expect(host.textContent).toContain('What should the agent run on?')
    await click('Finish')
    expect(mocks.moveAgent).toHaveBeenCalledWith('ag_ac', { kind: 'daemon', daemonId: 'dmn_new' })
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: 'claude', model: 'claude-sonnet-4-5' })
    // Already configured ⇒ the spec PATCH must run against its new home, so the move lands first.
    const moveOrder = mocks.moveAgent.mock.invocationCallOrder[0] ?? Infinity
    const updateOrder = mocks.updateAgent.mock.invocationCallOrder[0] ?? 0
    expect(moveOrder).toBeLessThan(updateOrder)
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
  })

  it('hides the pickers only when the org has no built-in agent at all', async () => {
    mocks.agents = []
    await render()
    expect(host.textContent).not.toContain('What should the agent run on?')
    await click('Finish')
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    expect(mocks.moveAgent).not.toHaveBeenCalled()
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
  })
})

// The pool (Cloud / cluster) path: the fork appears, and picking the pool configures the
// built-in agent against a pool member's reported capabilities without any provisioning.
describe('onboarding — pool fork', () => {
  beforeEach(() => setFlags('daemon-pool'))

  it('holds a spinner while the agent snapshot is still loading — no premature Finish', async () => {
    mocks.agentsLoading = true
    await render()
    expect(host.textContent).toContain('loading data')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Finish'))).toBe(false)
  })

  it('Back → pool → Finish still cleans up the daemon minted on the detour', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_detour', command: 'agentconnect run' })
    await render()
    await click('Daemon')
    await click('Continue') // daemon step mints a row
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
    await click('Back')
    await click('Cluster')
    await click('Finish')
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
    expect(mocks.deleteDaemon).toHaveBeenCalledWith('dmn_detour')
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
  })

  it('forks after the org step and finishes right there when nothing needs configuring', async () => {
    await render()
    expect(host.textContent).toContain('Where to run')
    expect(host.textContent).toContain('Cluster') // self-hosted pool label (no `managed` flag)
    await click('Finish') // pool preselected, no unplaced builtin ⇒ the fork is the last step
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
  })

  it('reads runtimes from a pool member but places on the pool, not the Pod', async () => {
    mocks.daemons = [
      {
        daemonId: 'pool-pod-1',
        pool: true,
        status: 'online',
        name: 'ac-cloud-7f9',
        runtimeModels: [{ runtime: 'claude', models: ['claude-sonnet-4-5'] }]
      }
    ]
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
    await render()
    await click('Continue') // pool selected, builtin unplaced ⇒ runtime step
    expect(host.textContent).toContain('Choose runtime')
    expect(host.textContent).toContain('runtime-claude') // seeded from the pool member
    expect(host.textContent).not.toContain('ac-cloud-7f9') // Pod identity never shown
    await click('Finish')
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: 'claude', model: 'claude-sonnet-4-5' })
    expect(mocks.moveAgent).toHaveBeenCalledWith('ag_ac', { kind: 'pool' })
    expect(mocks.updateOrg).toHaveBeenCalledWith('org-1', { onboardingCompleted: true })
  })

  it('with no pool member the fallback seeds the picker and nothing is placed', async () => {
    mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
    await render()
    await click('Continue')
    await click('Finish')
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: FALLBACK_RUNTIME_IDS[0] })
    expect(mocks.moveAgent).not.toHaveBeenCalled()
  })

  it('picking Daemon at the fork routes to the connect step', async () => {
    mocks.provisionDaemon.mockResolvedValue({ daemonId: 'dmn_new', command: 'agentconnect run' })
    await render()
    await click('Daemon')
    await click('Continue')
    expect(host.textContent).toContain('Run the daemon')
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)
  })
})

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
  updateAgent: vi.fn(),
  moveAgent: vi.fn(),
  refresh: vi.fn(),
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
    updateAgent: mocks.updateAgent,
    moveAgent: mocks.moveAgent,
    refresh: mocks.refresh
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
vi.mock('@/components/console/GettingStartedChecklist', () => ({
  useGsActions: () => ({ runAction: vi.fn(), firstAgent: mocks.agents[0] }),
  useGithubProfileLinked: () => undefined,
  useGithubAppEnabled: () => undefined,
  // Same convention as the two probes above: undefined is the "unknowable, keep the
  // step" value, so the reveal renders the full checklist (computeGettingStarted only
  // drops the session-access row on a definitive false).
  useSessionAccessCardAvailable: () => undefined,
  useSlackPlatformAppAvailable: () => true,
  GsRows: ({ items }: { items: Array<{ key: string; label: string }> }) => (
    <div>rows {items.map((i) => i.key).join(',')}</div>
  )
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

beforeEach(() => {
  mocks.agents = []
  mocks.daemons = []
  mocks.integrations = []
  mocks.allSessions = []
  mocks.members = []
  mocks.agentsLoading = false
  mocks.daemonsLoading = false
  mocks.refresh.mockReset()
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

describe('onboarding — checklist reveal', () => {
  it('reveals the checklist with no daemon step and never provisions one', async () => {
    await render()
    expect(host.textContent).not.toContain('Connect your daemon')
    expect(host.textContent).toContain('Welcome to AgentConnect')
    expect(host.textContent).toContain('Getting started')
    expect(host.textContent).toContain('rows') // <GsRows/> stub
    expect(host.textContent).not.toContain('daemon') // no connect-a-daemon row
  })

  it('finish stays disabled until every step is done; skip always exits to the console', async () => {
    await render()
    expect(button('Finish onboarding').disabled).toBe(true)
    await click('Skip for now')
    expect(mocks.skipOnboarding).toHaveBeenCalledWith('acme')
    expect(mocks.push).toHaveBeenCalledWith('/acme/home')
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
    expect(host.textContent).not.toContain('Welcome to AgentConnect')
    // the daemon is never shown or chosen here
    expect(host.textContent).not.toContain('edge-1')
  })

  // No daemon yet (the connect step is gone): runtime/model still save, placement is
  // simply skipped and waits for the checklist's daemon step.
  it('saves runtime and model with no daemon, without a placement move', async () => {
    mocks.daemons = []
    await render()
    await click('Save and continue')
    expect(mocks.updateAgent).toHaveBeenCalledWith('ag_ac', { runtime: 'claude' })
    expect(mocks.moveAgent).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Welcome to AgentConnect')
  })

  it('sets the runtime BEFORE moving the agent onto the org daemon, then reveals', async () => {
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
    expect(host.textContent).toContain('Welcome to AgentConnect')
  })
})

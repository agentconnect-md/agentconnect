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
    provisionDaemon: mocks.provisionDaemon,
    reconnectDaemon: mocks.reconnectDaemon,
    deleteDaemon: mocks.deleteDaemon,
    refresh: mocks.refresh
  })
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
  mocks.provisionDaemon.mockReset()
  mocks.reconnectDaemon.mockReset()
  mocks.deleteDaemon.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
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

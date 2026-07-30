// @vitest-environment happy-dom
import { act } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  daemons: [] as Array<Record<string, unknown>>,
  integrations: [] as Array<Record<string, unknown>>,
  agentsLoading: false,
  daemonsLoading: false,
  provisionDaemon: vi.fn(),
  reconnectDaemon: vi.fn(),
  deleteDaemon: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'acme' }),
  useRouter: () => ({ push: vi.fn() })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: mocks.agents,
    daemons: mocks.daemons,
    integrations: mocks.integrations,
    agentsLoading: mocks.agentsLoading,
    daemonsLoading: mocks.daemonsLoading,
    provisionDaemon: mocks.provisionDaemon,
    reconnectDaemon: mocks.reconnectDaemon,
    deleteDaemon: mocks.deleteDaemon,
    refresh: mocks.refresh
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/onboarding')>()
  return { ...actual, skipOnboarding: vi.fn() }
})
vi.mock('@/lib/daemon-commands', () => ({ daemonCommands: (command: string) => ({ run: command, login: command }) }))
vi.mock('@/lib/data', () => ({ agentLabel: () => 'Agent' }))
vi.mock('@/components/marks', () => ({
  LogoMark: () => <span>logo</span>,
  Spinner: () => <span>loading</span>,
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

beforeEach(async () => {
  mocks.agents = []
  mocks.daemons = []
  mocks.integrations = []
  mocks.agentsLoading = false
  mocks.daemonsLoading = false
  mocks.provisionDaemon.mockReset()
  mocks.reconnectDaemon.mockReset()
  mocks.deleteDaemon.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<OnboardingView />))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('daemon onboarding lifecycle', () => {
  it('deletes an unclaimed row and provisions a fresh command after Back', async () => {
    mocks.provisionDaemon.mockImplementation(async () => ({
      daemonId: `new-${mocks.provisionDaemon.mock.calls.length}`,
      apiKey: 'secret',
      displayTail: 'tail',
      command: 'agentconnect run'
    }))

    await click('Add a Daemon')
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(1)

    await click('Back')
    expect(mocks.deleteDaemon).toHaveBeenCalledWith('new-1')

    await click('Add a Daemon')
    expect(mocks.provisionDaemon).toHaveBeenCalledTimes(2)
  })

  it('keeps an offline daemon on step 1 and mints a recoverable reconnect command', async () => {
    mocks.daemons = [{ daemonId: 'offline-1', status: 'offline', name: 'edge-1', host: 'edge-1', version: '1.0.0' }]
    mocks.reconnectDaemon.mockResolvedValue({
      apiKeyId: 'key-1',
      apiKey: 'secret',
      displayTail: 'tail',
      command: 'agentconnect run'
    })
    await act(async () => root.render(<OnboardingView />))

    await click('Add a Daemon')
    expect(mocks.reconnectDaemon).toHaveBeenCalledWith('offline-1')
    expect(mocks.provisionDaemon).not.toHaveBeenCalled()
    expect(button('Create an agent').disabled).toBe(true)

    await click('Back')
    expect(mocks.deleteDaemon).not.toHaveBeenCalled()
    await click('Add a Daemon')
    expect(mocks.reconnectDaemon).toHaveBeenCalledTimes(2)
  })

  it('resumes at the live step when daemons resolve before agents/integrations', async () => {
    act(() => root.unmount())
    // First load: daemons resolve for a fully-live org while agents are still loading.
    mocks.daemons = [{ daemonId: 'new-1', status: 'online', name: 'edge-1', host: 'edge-1', version: '1.0.0' }]
    mocks.agents = []
    mocks.integrations = []
    mocks.agentsLoading = true
    mocks.daemonsLoading = false
    root = createRoot(host)
    await act(async () => root.render(<OnboardingView />))
    // Must not seed a mid-wizard step from the partial data — still on the welcome screen.
    expect(host.textContent).toContain('Welcome to AgentConnect')

    // Agents/integrations finish loading — the wizard now resumes at the final step.
    mocks.agents = [{ id: 'agent-1', daemon: 'new-1', hookKinds: [] }]
    mocks.integrations = [{ id: 'int-1' }]
    mocks.agentsLoading = false
    await act(async () => root.render(<OnboardingView />))
    expect(host.textContent).toContain('You’re live')
  })

  it('never deletes a claimed daemon that disconnects before Finish', async () => {
    mocks.provisionDaemon.mockResolvedValue({
      daemonId: 'new-1',
      apiKey: 'secret',
      displayTail: 'tail',
      command: 'agentconnect run'
    })
    await click('Add a Daemon')

    mocks.daemons = [{ daemonId: 'new-1', status: 'online', name: 'edge-1', host: 'edge-1', version: '1.0.0' }]
    await act(async () => root.render(<OnboardingView />))
    await click('Create an agent')

    mocks.agents = [{ id: 'agent-1', daemon: 'new-1', hookKinds: [] }]
    mocks.daemons = [{ daemonId: 'new-1', status: 'offline', name: 'edge-1', host: 'edge-1', version: '1.0.0' }]
    await act(async () => root.render(<OnboardingView />))
    await click('Set up integration')
    await click('Finish')

    expect(mocks.deleteDaemon).not.toHaveBeenCalled()
  })
})

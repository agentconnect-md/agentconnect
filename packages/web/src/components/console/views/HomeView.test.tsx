// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Uses the REAL lib/data catalog helpers (modelCapability / effortChoicesFor /
// permissionModeChoicesFor / preferredModelFor) so the P1 logic actually runs;
// only the providers + heavy child components are stubbed. Each ComposerMenu
// records its props so tests can assert which run-selectors render and with what.
const mocks = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  daemons: [] as Array<Record<string, unknown>>,
  menus: [] as Array<{ title: string; value: string; options: string[] }>,
  openPlayground: vi.fn(() => 'pg_1'),
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: mocks.agents,
    daemons: mocks.daemons,
    crons: [],
    allSessions: [],
    usage24h: null,
    getAgent: () => undefined,
    loading: false
  })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({
    openPlayground: mocks.openPlayground,
    pgSend: vi.fn(),
    pgSetModel: vi.fn(),
    pgSetEffort: vi.fn(),
    pgSetPermissionMode: vi.fn()
  })
}))
vi.mock('@/components/console/ComposerMenu', () => ({
  ComposerMenu: (props: { title: string; value: string; options: { value: string }[] }) => {
    mocks.menus.push({ title: props.title, value: props.value, options: props.options.map((o) => o.value) })
    return <div data-menu={props.title} />
  }
}))
vi.mock('@/components/marks', () => ({
  AgentIconView: () => <span />,
  ModelMark: () => <span />,
  PlatformMark: () => <span />,
  LoadingState: () => <span>loading</span>
}))
vi.mock('@/components/ui', () => ({ Icon: () => <span /> }))

import HomeView from './HomeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

const claudeCatalog = {
  models: [
    {
      id: 'claude-sonnet-4-5',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ],
      defaultEffort: 'high'
    }
  ],
  permissionModes: [
    { value: 'default', name: 'Default' },
    { value: 'plan', name: 'Plan' }
  ],
  defaultModel: 'claude-sonnet-4-5',
  source: 'acp',
  observedAt: ''
}
const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'bot',
  runtime: 'claude',
  model: '',
  reasoning: '',
  permissionMode: '',
  daemon: 'd1',
  status: 'online',
  icon: null,
  ...over
})
const daemon = (over: Record<string, unknown> = {}) => ({
  daemonId: 'd1',
  status: 'online',
  runtimeModels: [
    { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: false }
  ],
  ...over
})

const render = async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<HomeView />))
}

beforeEach(() => {
  mocks.menus = []
  mocks.openPlayground.mockClear()
  mocks.push.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const menu = (title: string) => mocks.menus.find((m) => m.title === title)

describe('HomeView run-selectors (catalog-aware)', () => {
  it('resolves a blank stored model to the daemon default (shown == what runs)', async () => {
    mocks.agents = [agent({ model: '' })]
    mocks.daemons = [daemon()]
    await render()
    expect(menu('Model')?.value).toBe('claude-sonnet-4-5')
    expect(menu('Effort')?.value).toBe('high') // catalog defaultEffort
    expect(menu('Permission')?.value).toBe('default')
  })

  it('hides Effort/Permission for a runtime with no such vocabulary (opencode)', async () => {
    mocks.agents = [agent({ id: 'a2', runtime: 'opencode', daemon: 'd2' })]
    mocks.daemons = [
      daemon({
        daemonId: 'd2',
        runtimeModels: [
          { runtime: 'opencode', models: ['deepseek/deepseek-v4'], modelCatalog: undefined, authRequired: false }
        ]
      })
    ]
    await render()
    expect(menu('Model')).toBeTruthy()
    expect(menu('Effort')).toBeUndefined()
    expect(menu('Permission')).toBeUndefined()
  })
})

describe('HomeView readiness gate', () => {
  it('shows the offline banner when the selected agent’s daemon is not serving', async () => {
    mocks.agents = [agent()]
    mocks.daemons = [daemon({ status: 'offline' })]
    await render()
    expect(host.textContent).toContain('is offline')
  })

  it('shows the no-runtime banner when the daemon runtime requires auth', async () => {
    mocks.agents = [agent()]
    mocks.daemons = [
      daemon({
        runtimeModels: [
          { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: true }
        ]
      })
    ]
    await render()
    expect(host.textContent).toContain('No AI runtime is signed in')
  })
})

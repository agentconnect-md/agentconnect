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
  memberSets: [] as Array<Record<string, unknown>>,
  menus: [] as Array<{ title: string; value: string; options: string[] }>,
  openPlayground: vi.fn(() => 'pg_1'),
  pgSend: vi.fn(),
  pgSetModel: vi.fn(),
  pgSetEffort: vi.fn(),
  pgSetPermissionPreset: vi.fn(),
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (p: string) => `/acme${p}` }) }))
// The fresh-org bounce is covered by its own logic (lib/onboarding); hold it open here.
vi.mock('@/lib/use-onboarding-redirect', () => ({ useOnboardingRedirect: () => false }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: mocks.agents,
    daemons: mocks.daemons,
    memberSets: mocks.memberSets,
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
    pgSend: mocks.pgSend,
    pgSetModel: mocks.pgSetModel,
    pgSetEffort: mocks.pgSetEffort,
    pgSetPermissionPreset: mocks.pgSetPermissionPreset
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
  LogoMark: () => <span />,
  LoadingState: () => <span>loading</span>,
  Spinner: () => <span />
}))
// prepareWebchatImage needs createImageBitmap/canvas (not in happy-dom); the
// pipeline itself is covered by webchat-image.test.ts.
vi.mock('@/lib/webchat-image', () => ({
  clipboardImageFile: () => undefined,
  prepareWebchatImage: vi.fn(async () => ({ name: 'shot.webp', mimeType: 'image/webp', data: 'QUJD' }))
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: { name: 'Riley Kim', initials: 'RK' }, me: null }) }))
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

/** The console offers a set target's own page only where the deployment asked for that surface. */
const setFlags = (value: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = { FEATURE_FLAGS: value }
}

beforeEach(() => {
  mocks.menus = []
  mocks.memberSets = []
  setFlags('daemon-pool,daemon-groups')
  mocks.openPlayground.mockClear()
  mocks.pgSend.mockClear()
  mocks.pgSetModel.mockClear()
  mocks.pgSetEffort.mockClear()
  mocks.pgSetPermissionPreset.mockClear()
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

  it('resolves a stored effort the selected model does not offer, and STAGES the resolved value on send', async () => {
    const lowMed = {
      models: [
        {
          id: 'm-lowmed',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
          ],
          defaultEffort: 'medium'
        }
      ],
      permissionModes: [{ value: 'default', name: 'Default' }],
      defaultModel: 'm-lowmed',
      source: 'acp',
      observedAt: ''
    }
    mocks.agents = [agent({ model: 'm-lowmed', reasoning: 'xhigh' })] // stored xhigh not offered by m-lowmed
    mocks.daemons = [
      daemon({
        runtimeModels: [{ runtime: 'claude', models: ['m-lowmed'], modelCatalog: lowMed, authRequired: false }]
      })
    ]
    await render()
    // Displayed effort is resolved to an offered level, not the phantom `xhigh`.
    expect(menu('Effort')?.value).toBe('medium')
    // …and send stages exactly that (never `xhigh`).
    const ta = host.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(ta, 'hi')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.sendbtn')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.pgSetModel).toHaveBeenCalledWith('pg_1', 'a1', 'm-lowmed')
    expect(mocks.pgSetEffort).toHaveBeenCalledWith('pg_1', 'a1', 'medium')
    expect(mocks.pgSend).toHaveBeenCalled()
  })

  it('stages an offered level for blank reasoning when the catalog entry has no defaultEffort', async () => {
    // Phase-2 shape: efforts present, defaultEffort intentionally absent.
    const noDefault = {
      models: [
        {
          id: 'm-nodef',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
          ]
        }
      ],
      permissionModes: [{ value: 'default', name: 'Default' }],
      defaultModel: 'm-nodef',
      source: 'acp',
      observedAt: ''
    }
    mocks.agents = [agent({ model: 'm-nodef', reasoning: '' })] // blank stored effort
    mocks.daemons = [
      daemon({
        runtimeModels: [{ runtime: 'claude', models: ['m-nodef'], modelCatalog: noDefault, authRequired: false }]
      })
    ]
    await render()
    // Not blank: falls back to the first offered level, so the pill can't claim a level the turn won't run.
    expect(menu('Effort')?.value).toBe('low')
    const ta = host.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(ta, 'hi')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.sendbtn')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.pgSetEffort).toHaveBeenCalledWith('pg_1', 'a1', 'low') // displayed == staged
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

  it('shows and stages Auto as one Codex permission preset', async () => {
    const codexCatalog = {
      models: [{ id: 'gpt-5.6-sol' }],
      permissionModes: [
        { value: 'read-only', name: 'Read-only' },
        { value: 'agent', name: 'Agent' },
        { value: 'agent-full-access', name: 'Agent (full access)' }
      ],
      defaultModel: 'gpt-5.6-sol',
      defaultPermissionMode: 'agent',
      source: 'acp',
      observedAt: ''
    }
    mocks.agents = [
      agent({
        runtime: 'codex',
        model: 'gpt-5.6-sol',
        permissionMode: 'agent',
        approvalsReviewer: 'auto_review'
      })
    ]
    mocks.daemons = [
      daemon({
        runtimeModels: [{ runtime: 'codex', models: ['gpt-5.6-sol'], modelCatalog: codexCatalog, authRequired: false }]
      })
    ]
    await render()
    expect(menu('Permission')).toMatchObject({
      value: 'agent:auto-review',
      options: ['read-only', 'agent', 'agent:auto-review', 'agent-full-access']
    })

    const ta = host.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(ta, 'hi')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.sendbtn')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.pgSetPermissionPreset).toHaveBeenCalledWith('pg_1', 'a1', 'agent:auto-review')
  })
})

describe('HomeView attach', () => {
  it('sends an attached image with the first turn (image-only send allowed)', async () => {
    mocks.agents = [agent()]
    mocks.daemons = [daemon()]
    await render()
    const sendBtn = host.querySelector<HTMLButtonElement>('button.sendbtn')!
    expect(sendBtn.disabled).toBe(true) // no text, no image yet
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [new File(['x'], 'shot.png', { type: 'image/png' })] })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(host.querySelector('img')).toBeTruthy() // preview chip
    expect(sendBtn.disabled).toBe(false) // image alone enables send
    await act(async () => {
      sendBtn.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    // The image rides pgSend's explicit argument (the session id is minted in the same tick).
    expect(mocks.pgSend).toHaveBeenCalledWith(
      'pg_1',
      'a1',
      '',
      undefined,
      undefined,
      expect.objectContaining({ data: 'QUJD', mimeType: 'image/webp' })
    )
    expect(host.querySelector('img')).toBeNull() // composer cleared after send
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

  it('shows no banner when the selected agent’s daemon is healthy but ANOTHER daemon is not', async () => {
    mocks.agents = [agent()]
    mocks.daemons = [
      daemon(),
      daemon({
        daemonId: 'd2',
        status: 'offline',
        runtimeModels: [
          { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: true }
        ]
      })
    ]
    await render()
    expect(host.textContent).not.toContain('is offline')
    expect(host.textContent).not.toContain('No AI runtime is signed in')
  })

  it('defaults past a NOT-ready agentconnect preset to a ready agent (no banner for an unused daemon)', async () => {
    mocks.agents = [agent({ id: 'a-pre', name: 'agentconnect', daemon: 'd2' }), agent({ id: 'a1', name: 'bot' })]
    mocks.daemons = [daemon(), daemon({ daemonId: 'd2', status: 'offline' })]
    await render()
    expect(mocks.menus.find((m) => m.title === 'Agent')?.value).toBe('a1')
    expect(host.textContent).not.toContain('is offline')
  })

  it('still prefers the agentconnect preset when it is ready', async () => {
    mocks.agents = [agent({ id: 'a1', name: 'bot' }), agent({ id: 'a-pre', name: 'agentconnect' })]
    mocks.daemons = [daemon()]
    await render()
    expect(mocks.menus.find((m) => m.title === 'Agent')?.value).toBe('a-pre')
  })
})

// A pool or group agent names no member — `daemon` carries the set sentinel — so resolving its
// daemon BY ID found nothing. Nothing reads as "no runtime reported a login problem", which is why
// such an agent was never blocked and its real model catalog never reached the composer.
describe('HomeView readiness through the placement', () => {
  const onPool = (over: Record<string, unknown> = {}) =>
    agent({ daemon: 'pool', placementKind: 'set', setId: null, placementReady: true, ...over })
  const poolMember = (authRequired: boolean) =>
    daemon({
      daemonId: 'pod-a',
      pool: true,
      memberSetId: 'set-pool',
      name: 'AgentConnect Cloud',
      runtimeModels: [{ runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired }]
    })

  it('blocks a pool agent whose runtime needs a login, and names what it runs on', async () => {
    mocks.agents = [onPool()]
    mocks.daemons = [poolMember(true)]
    await render()
    expect(host.textContent).toContain('No AI runtime is signed in')
    expect(host.textContent).toContain('Kubernetes cluster')
  })

  it('leaves it startable when the pool member is signed in', async () => {
    mocks.agents = [onPool()]
    mocks.daemons = [poolMember(false)]
    await render()
    expect(host.textContent).not.toContain('No AI runtime is signed in')
  })

  it('reads the pool’s own model catalog, not the static fallback', async () => {
    mocks.agents = [onPool({ model: '' })]
    mocks.daemons = [poolMember(false)]
    await render()
    expect(menu('Model')?.value).toBe('claude-sonnet-4-5')
    expect(menu('Effort')?.value).toBe('high')
  })

  it('resolves a GROUP placement to its own member, never to a pool member', async () => {
    mocks.agents = [onPool({ placementKind: 'set', setId: 'set-lab' })]
    mocks.memberSets = [{ setId: 'set-lab', name: 'lab', memberDaemonIds: ['dmn-lab'], agentCount: 1 }]
    mocks.daemons = [
      poolMember(false),
      daemon({
        daemonId: 'dmn-lab',
        memberSetId: 'set-lab',
        name: 'lab-box',
        runtimeModels: [
          { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: true }
        ]
      })
    ]
    await render()
    expect(host.textContent).toContain('No AI runtime is signed in')
    expect(host.textContent).toContain('lab')
  })
})

// Agents, daemons and member sets are three independent reads. Readiness depends on all three, so
// the default-agent memo has to as well — a group placement reads as the POOL until its group
// resolves, which is exactly the window in which an auth-blocked agent looks startable.
describe('HomeView default agent across a late member-set read', () => {
  const catalogFor = (authRequired: boolean) => [
    { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired }
  ]

  it('re-picks the default once the group resolves the preset as auth-blocked', async () => {
    // The preset sits on a group whose member needs a login; another agent on a machine is ready.
    mocks.agents = [
      agent({
        id: 'preset',
        name: 'agentconnect',
        daemon: 'pool',
        placementKind: 'set',
        setId: 'set-lab',
        placementReady: true
      }),
      agent({ id: 'ready', name: 'other', daemon: 'dmn-1' })
    ]
    mocks.daemons = [
      daemon({ daemonId: 'pod-a', pool: true, memberSetId: 'set-pool', runtimeModels: catalogFor(false) }),
      daemon({ daemonId: 'dmn-lab', memberSetId: 'set-lab', runtimeModels: catalogFor(true) }),
      daemon({ daemonId: 'dmn-1', runtimeModels: catalogFor(false) })
    ]
    // Member sets have not landed: the group placement reads as the pool, whose member IS signed
    // in, so the preset looks ready and is chosen.
    await render()
    expect(host.textContent).not.toContain('No AI runtime is signed in')

    // The SAME mount then receives the group list — a re-render, not a remount, because a remount
    // rebuilds the memo and would pass either way.
    mocks.memberSets = [{ setId: 'set-lab', name: 'lab', memberDaemonIds: ['dmn-lab'], agentCount: 1 }]
    await act(async () => root.render(<HomeView />))
    // With the group known the preset is auth-blocked, so the default moves to the ready agent and
    // no banner shows. While `memberSets` was not an input, the stale preset stayed selected.
    expect(host.textContent).not.toContain('No AI runtime is signed in')
  })
})

// Both set targets NotFound behind their own flag, while a placement made before the flag went off
// is still NAMED here — so the banner's action must not offer a door that does not open.
describe('HomeView blocked-banner action behind the flags', () => {
  const blockedOnGroup = () => {
    mocks.agents = [agent({ daemon: 'pool', placementKind: 'set', setId: 'set-lab', placementReady: true })]
    mocks.memberSets = [{ setId: 'set-lab', name: 'lab', memberDaemonIds: ['dmn-lab'], agentCount: 1 }]
    mocks.daemons = [
      daemon({
        daemonId: 'dmn-lab',
        memberSetId: 'set-lab',
        runtimeModels: [
          { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: true }
        ]
      })
    ]
  }
  const clickAction = () => {
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fix')
    if (!btn) throw new Error('Fix action not rendered')
    act(() => btn.click())
  }

  it('opens the group where the deployment offers groups', async () => {
    blockedOnGroup()
    await render()
    clickAction()
    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/groups/set-lab')
  })

  it('falls back to Infra where it does not, instead of the group NotFound', async () => {
    setFlags('')
    blockedOnGroup()
    await render()
    clickAction()
    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons')
  })

  it('falls back to Infra for a pool placement behind the pool flag', async () => {
    setFlags('')
    mocks.agents = [agent({ daemon: 'pool', placementKind: 'set', setId: null, placementReady: true })]
    mocks.daemons = [
      daemon({
        daemonId: 'pod-a',
        pool: true,
        memberSetId: 'set-pool',
        runtimeModels: [
          { runtime: 'claude', models: ['claude-sonnet-4-5'], modelCatalog: claudeCatalog, authRequired: true }
        ]
      })
    ]
    await render()
    clickAction()
    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons')
  })
})

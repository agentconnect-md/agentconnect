// @vitest-environment happy-dom
/**
 * A daemon group has its own page because it is a placement TARGET, not a machine — and the
 * whole risk of the page is that it starts reading like whichever member happened to answer.
 * So these tests pin the two rules: every aggregate is over the members that are SERVING, and
 * the group itself never borrows a member's host, version or uptime.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, MemberSetRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  daemons: [] as unknown[],
  agents: [] as unknown[],
  memberSets: [] as unknown[],
  memberSetsLoading: false,
  daemonsLoading: false,
  agentsLoading: false,
  routeId: 'g1',
  push: vi.fn(),
  openModal: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ id: mocks.routeId })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: mocks.daemons,
    agents: mocks.agents,
    memberSets: mocks.memberSets,
    memberSetsLoading: mocks.memberSetsLoading,
    daemonsLoading: mocks.daemonsLoading,
    agentsLoading: mocks.agentsLoading
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))

const GroupDetailView = (await import('./GroupDetailView')).default

function daemon(id: string, over: Partial<DaemonRow> = {}): DaemonRow {
  return {
    daemonId: id,
    pool: false,
    memberSetId: null,
    name: id,
    version: '1.41.0',
    latestVersion: '1.41.0',
    releaseChannel: 'latest',
    upgradeAvailable: false,
    availableVersions: [],
    lifecycleOp: null,
    lifecycleStatus: null,
    canManageLifecycle: true,
    status: 'online',
    host: `${id}.internal`,
    cpu: 20,
    mem: 40,
    loadAgents: 0,
    caps: { platforms: [], runtimes: [], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: [],
    activeSessions: '0',
    conns: '8',
    uptime: '1m',
    createdBy: '',
    createdAt: '',
    lastModifiedBy: '',
    lastModifiedAt: '',
    sessionRetention: '7d',
    visibility: 'org',
    sharedWith: [],
    canEdit: true,
    canManageSharing: true,
    ...over
  } as DaemonRow
}

const group = (over: Partial<MemberSetRow> = {}): MemberSetRow => ({
  setId: 'g1',
  name: 'build-farm',
  memberDaemonIds: [],
  agentCount: 0,
  spreadSessions: false,
  ...over
})

/** An agent placed on the GROUP: kind `set` plus the group's own set id — never a member id,
 *  because whichever member holds the duty is interchangeable. */
const onGroup = (id: string, setId = 'g1', over: Partial<Agent> = {}): Agent =>
  ({
    id,
    daemon: 'pool',
    placementKind: 'set',
    setId,
    placementReady: true,
    name: id,
    status: 'online',
    runtime: 'claude',
    model: 'opus',
    ...over
  }) as Agent

/** An agent PINNED to one machine — it does not move with the group and is not on it. */
const pinned = (id: string, daemonId: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    daemon: daemonId,
    placementKind: 'daemon',
    setId: null,
    name: id,
    status: 'online',
    runtime: 'claude',
    model: 'opus',
    ...over
  }) as Agent

function render(): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => {
    root.render(<GroupDetailView />)
  })
  const html = host.innerHTML
  act(() => root.unmount())
  host.remove()
  return html
}

beforeEach(() => {
  mocks.daemons = []
  mocks.agents = []
  mocks.memberSets = []
  mocks.memberSetsLoading = false
  mocks.daemonsLoading = false
  mocks.agentsLoading = false
  mocks.routeId = 'g1'
  mocks.push.mockClear()
  mocks.openModal.mockClear()
})

describe('GroupDetailView', () => {
  it('names the group and its members without feature flags, and reads them as one fleet', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [daemon('d1'), daemon('d2', { status: 'offline' })]

    const html = render()

    expect(html).toContain('build-farm')
    expect(html).toContain('d1, d2')
    expect(html).toContain('2 daemons')
    // Serving is what routes work, so it is what the strip counts.
    expect(html).toContain('1 / 2')
  })

  it('is online while ANY member is serving', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [daemon('d1', { status: 'offline' }), daemon('d2')]

    // One serving member is what routes work, so it is what makes the group online.
    expect(render()).toContain('1 / 2')

    mocks.daemons = [daemon('d1', { status: 'offline' }), daemon('d2', { status: 'offline' })]

    const dark = render()
    expect(dark).toContain('0 / 2')
    // Nothing on the page is green once no member answers — the group's own badge included.
    expect(dark).not.toContain('var(--status-online)')
  })

  it('never borrows a member’s host, version or uptime for the group itself', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1', { host: 'builder.internal', version: '9.9.9', uptime: '31d' })]

    const html = render()

    // A group has no machine identity of its own — showing one is the bug this page avoids.
    expect(html).not.toContain('builder.internal')
    expect(html).not.toContain('9.9.9')
    expect(html).not.toContain('31d')
  })

  it('counts the agents placed on the GROUP, not the ones pinned to its members', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]
    mocks.agents = [onGroup('a1'), onGroup('elsewhere', 'g2'), pinned('a3', 'd1')]

    const html = render()

    expect(html).toContain('Agents on this group')
    expect(html).toContain('>a1<')
    // A group placement naming another set is not this group's.
    expect(html).not.toContain('>elsewhere<')
    // A pinned agent stays pinned — it is reported against its member, not the group.
    expect(html).not.toContain('>a3<')
  })

  it('reads the runtimes over the SERVING members only', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [
      daemon('d1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      }),
      daemon('d2', {
        status: 'offline',
        runtimeModels: [{ runtime: 'codex', version: '1.0.0', models: ['gpt-5'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]
    mocks.agents = [onGroup('a1')]

    const html = render()

    expect(html).toContain('Only what every serving member offers')
    expect(html).toContain('v0.54.1')
    // A member that stopped answering can no longer offer a runtime, so it constrains nothing.
    expect(html).not.toContain('v1.0.0')
    expect(html).toContain('1 agent')
  })

  it('lists only the runtimes EVERY serving member offers', () => {
    // An agent placed here lands on whichever member is serving, so a runtime one of them lacks
    // is not one the group can run — advertising it promises a placement that fails.
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [
      daemon('d1', {
        runtimeModels: [
          { runtime: 'claude', version: '0.54.1', models: ['opus', 'sonnet'], acpProtocolVersion: 1 },
          { runtime: 'codex', version: '1.0.0', models: ['gpt-5'], acpProtocolVersion: 1 }
        ]
      }),
      daemon('d2', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]

    const html = render()

    expect(html).toContain('Claude')
    // Only d1 has codex, so the group cannot run it.
    expect(html).not.toContain('Codex')
    // ... and the same rule applies one level down: only d1 offers sonnet.
    expect(html).toContain('1 model')
    expect(html).not.toContain('2 models')
  })

  it('says "mixed" rather than picking one member’s version', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [
      daemon('d1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      }),
      daemon('d2', {
        runtimeModels: [{ runtime: 'claude', version: '0.60.0', models: ['opus'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]

    const html = render()

    expect(html).toContain('mixed')
    expect(html).not.toContain('v0.54.1')
    expect(html).not.toContain('v0.60.0')
  })

  describe('names the members whose runtime needs a login', () => {
    const claude = (authRequired?: boolean) => ({
      runtime: 'claude',
      version: '0.54.1',
      models: ['opus'],
      acpProtocolVersion: 1,
      ...(authRequired === undefined ? {} : { authRequired })
    })
    const clickLogin = () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root: Root = createRoot(host)
      act(() => {
        root.render(<GroupDetailView />)
      })
      act(() => {
        host.querySelector<HTMLElement>('button[title="Show the command to sign in on the daemon host."]')?.click()
      })
      act(() => root.unmount())
      host.remove()
    }

    it('names the one member, and the command names its host', () => {
      mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
      mocks.daemons = [
        daemon('agent-1', { daemonId: 'd1', runtimeModels: [claude(true)] }),
        daemon('agent-2', { daemonId: 'd2', runtimeModels: [claude()] })
      ] as unknown[]

      expect(render()).toContain('Login required on agent-1')
      clickLogin()
      expect(mocks.openModal).toHaveBeenCalledWith(
        'runtimeLogin',
        expect.objectContaining({ runtimeId: 'claude', daemonName: 'agent-1' })
      )
      expect(mocks.openModal.mock.calls[0]![1]).not.toHaveProperty('daemonNames')
    })

    it('names both members when two need it, and hands the modal the list', () => {
      mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
      mocks.daemons = [
        daemon('agent-1', { daemonId: 'd1', runtimeModels: [claude(true)] }),
        daemon('agent-2', { daemonId: 'd2', runtimeModels: [claude(true)] })
      ] as unknown[]

      expect(render()).toContain('Login required on agent-1, agent-2')
      clickLogin()
      expect(mocks.openModal).toHaveBeenCalledWith(
        'runtimeLogin',
        expect.objectContaining({ runtimeId: 'claude', daemonNames: ['agent-1', 'agent-2'] })
      )
      expect(mocks.openModal.mock.calls[0]![1]).not.toHaveProperty('daemonName')
    })

    it('shows no warning when no member needs it', () => {
      mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
      mocks.daemons = [
        daemon('agent-1', { daemonId: 'd1', runtimeModels: [claude(false)] }),
        daemon('agent-2', { daemonId: 'd2', runtimeModels: [claude()] })
      ] as unknown[]

      expect(render()).not.toContain('Login required')
    })

    it('does not count a member that is offline', () => {
      // An offline member neither offers the runtime nor constrains it, so its stale probe is not a warning.
      mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
      mocks.daemons = [
        daemon('agent-1', { daemonId: 'd1', runtimeModels: [claude()] }),
        daemon('agent-2', { daemonId: 'd2', status: 'offline', runtimeModels: [claude(true)] })
      ] as unknown[]

      const html = render()
      expect(html).toContain('Claude')
      expect(html).not.toContain('Login required')
    })
  })

  it('says members share no runtime, rather than that none reported one', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [
      daemon('d1', {
        runtimeModels: [{ runtime: 'claude', version: '0.54.1', models: ['opus'], acpProtocolVersion: 1 }]
      }),
      daemon('d2', {
        runtimeModels: [{ runtime: 'codex', version: '1.0.0', models: ['gpt-5'], acpProtocolVersion: 1 }]
      })
    ] as unknown[]

    const html = render()

    expect(html).toContain('No runtime is on every serving member')
  })

  it('opens a member’s own page, because that is where a machine’s detail lives', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root: Root = createRoot(host)
    act(() => {
      root.render(<GroupDetailView />)
    })
    act(() => {
      host.querySelector<HTMLElement>('.row.click')?.click()
    })
    act(() => root.unmount())
    host.remove()

    expect(mocks.push).toHaveBeenCalledWith('/acme/daemons/d1')
  })

  it('says how to populate an empty group instead of showing an empty table', () => {
    mocks.memberSets = [group()]

    const html = render()

    expect(html).toContain('No daemons in this group')
    expect(html).toContain('0 / 0')
  })

  it('waits for the membership rather than calling a found group empty', () => {
    // `memberSets` is the smallest of three independent SWR keys, so a deep link resolves the
    // group's NAME a round trip before its members. Answering there is a confident wrong answer.
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemonsLoading = true

    const html = render()

    expect(html).not.toContain('No daemons in this group')
    expect(html).not.toContain('0 / 0')

    mocks.daemonsLoading = false
    mocks.agentsLoading = true

    expect(render()).not.toContain('No agents target this group yet')
  })

  it('sums active sessions over the SERVING members only', () => {
    // Per-DAEMON figures, so the sum includes the sessions of agents pinned to a member — and a
    // member that stopped answering contributes nothing, whatever it last reported.
    mocks.memberSets = [group({ memberDaemonIds: ['d1', 'd2'] })]
    mocks.daemons = [daemon('d1', { activeSessions: '4' }), daemon('d2', { status: 'offline', activeSessions: '9' })]
    mocks.agents = [onGroup('a1'), pinned('a2', 'd1')]

    const html = render()

    expect(html).toContain('Active sessions')
    expect(html).toContain('>4<')
    expect(html).not.toContain('>13<')
  })

  it('offers no log tail — a fabricated one is indistinguishable from telemetry', () => {
    mocks.memberSets = [group({ memberDaemonIds: ['d1'] })]
    mocks.daemons = [daemon('d1')]

    expect(render()).not.toContain('tail · local time')
  })

  it('404s on a set id this org does not own, and waits while the list loads', () => {
    mocks.routeId = 'nope'
    mocks.memberSets = [group()]

    expect(render()).toContain('Group not found')

    mocks.memberSetsLoading = true

    expect(render()).not.toContain('Group not found')
  })
})

describe('one runtime tab per strategy a serving member offers', () => {
  const ON = { available: true } as const
  const KVM = 'microsandbox needs a usable /dev/kvm'
  type Runtime = DaemonRow['runtimeModels'][number]
  const claude = (strategies: Runtime['strategies'], over: Partial<Runtime> = {}): Runtime => ({
    runtime: 'claude',
    version: '9.0.0',
    hostVersion: '2.0.0',
    models: ['merged-model'],
    strategies,
    ...over
  })
  // In the VM image only: no host install and no saved login, as a bundled runtime reads.
  const imageOnly: Runtime = {
    runtime: 'opencode',
    version: '1.5.0',
    models: [],
    hostAvailable: false,
    credentialsConfigured: false,
    authRequired: true,
    strategies: {
      host: { available: false, unavailableReason: 'not installed' },
      microsandbox: { available: true, models: ['image-model'] }
    }
  }
  const withTable = (name: string, table: NonNullable<DaemonRow['caps']['strategies']>, runtimes: Runtime[]) =>
    daemon(name, {
      daemonId: name,
      caps: { platforms: [], runtimes: [], acp: true, features: [], strategies: table },
      runtimeModels: runtimes
    })

  let host: HTMLDivElement
  let root: Root
  const mount = () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<GroupDetailView />))
  }
  const unmount = () => {
    act(() => root.unmount())
    host.remove()
  }
  const control = () => host.querySelector('[aria-label="Runtime environment"]')
  const choose = (label: string) =>
    act(() =>
      Array.from(control()!.querySelectorAll('button'))
        .find((b) => b.textContent === label)!
        .click()
    )

  beforeEach(() => {
    mocks.memberSets = [group({ memberDaemonIds: ['agent-1', 'agent-2'] })]
  })

  it('names each tab as the daemon card does, in its order, when any serving member offers it', () => {
    mocks.daemons = [
      withTable('agent-1', { microsandbox: ON, host: ON }, []),
      withTable('agent-2', { srt: ON, host: ON }, [])
    ]
    mount()
    const tabs = Array.from(control()!.querySelectorAll('button'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Host', 'Sandbox', 'VM'])
    expect(tabs.map((tab) => tab.getAttribute('title'))).toEqual([
      'No isolation boundary: sessions run directly on the machine.',
      'SRT: process isolation with bubblewrap, on Linux.',
      'microsandbox: one microVM per session. Needs KVM.'
    ])
    expect(control()!.querySelector('[aria-pressed="true"]')?.textContent).toBe('Host')
    expect(host.textContent).toContain('Only what every serving member offers')
    unmount()
  })

  it('lists each strategy’s own runtimes and models, and image-only runtimes only under VM', () => {
    const strategies = (vmModels: string[]) => ({
      host: { available: true, models: ['host-model'] },
      microsandbox: { available: true, models: vmModels }
    })
    mocks.daemons = [
      withTable('agent-1', { host: ON, microsandbox: ON }, [claude(strategies(['vm-model', 'vm-extra'])), imageOnly]),
      withTable('agent-2', { host: ON, microsandbox: ON }, [claude(strategies(['vm-model'])), imageOnly])
    ]
    mount()
    expect(host.textContent).toContain('v2.0.0')
    expect(host.textContent).not.toContain('v9.0.0')
    expect(host.textContent).not.toContain('opencode')
    expect(host.textContent).not.toContain('Login required')
    expect(host.textContent).not.toContain('runtimes not on host')

    choose('VM')
    expect(host.textContent).toContain('v9.0.0')
    // Only the model every member's image advertises.
    expect(host.textContent).toContain('1 model')
    expect(host.textContent).not.toContain('opencode')
    const fold = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('not on host'))!
    expect(fold.textContent).toBe('Show runtimes not on host (1)')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    act(() => fold.click())
    expect(host.textContent).toContain('opencode')
    expect(host.textContent).toContain('Login required on agent-1, agent-2')
    unmount()
  })

  it('names only the members a tab counts as needing a login', () => {
    const codex = (authRequired: boolean): Runtime => ({
      runtime: 'codex',
      version: '3.0.0',
      models: ['gpt-model'],
      authRequired,
      strategies: { host: { available: true, models: ['gpt-model'] }, srt: { available: true, models: ['gpt-model'] } }
    })
    mocks.daemons = [
      withTable('agent-1', { host: ON, srt: ON }, [codex(false)]),
      withTable('agent-2', { host: ON, srt: { available: false, reason: 'bubblewrap is missing' } }, [codex(true)])
    ]
    mount()
    expect(host.textContent).toContain('Login required on agent-2')
    // agent-2 cannot run the sandbox, so it neither constrains that tab nor needs a login there.
    choose('Sandbox')
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).not.toContain('Login required')
    unmount()
  })

  it('shows the reason for a strategy no serving member can run', () => {
    mocks.daemons = [
      withTable('agent-1', { host: ON, microsandbox: { available: false, reason: KVM } }, [
        claude({ host: { available: true, models: ['host-model'] } })
      ]),
      withTable('agent-2', { host: ON, microsandbox: { available: false, reason: 'another reason' } }, [
        claude({ host: { available: true, models: ['host-model'] } })
      ])
    ]
    mount()
    choose('VM')
    expect(host.textContent).toContain(`VM is unavailable on this group. ${KVM}`)
    expect(host.textContent).not.toContain('Claude Code')
    choose('Host')
    expect(host.textContent).toContain('Claude Code')
    unmount()
  })

  it('reads a member that reports no table from its merged list in every tab', () => {
    mocks.daemons = [
      withTable('agent-1', { host: ON, microsandbox: ON }, [
        claude({
          host: { available: true, models: ['host-model'] },
          microsandbox: { available: true, models: ['vm-model'] }
        }),
        { runtime: 'codex', version: '3.0.0', models: ['gpt-model'] }
      ]),
      daemon('agent-2', {
        daemonId: 'agent-2',
        runtimeModels: [claude(null, { models: ['host-model', 'vm-model'] })]
      })
    ]
    mount()
    expect(host.textContent).toContain('1 model')
    // The legacy member has no codex, so no tab can promise it.
    expect(host.textContent).not.toContain('Codex')
    choose('VM')
    expect(host.textContent).toContain('1 model')
    expect(host.textContent).not.toContain('Codex')
    unmount()

    // No serving member reports a table: today's single merged list, with no tabs.
    mocks.daemons = [
      daemon('agent-1', { daemonId: 'agent-1', runtimeModels: [claude(null)] }),
      daemon('agent-2', { daemonId: 'agent-2', runtimeModels: [claude(null)] })
    ]
    mount()
    expect(control()).toBeNull()
    expect(host.textContent).toContain('v9.0.0')
    unmount()
  })

  it('counts the group’s agents whose execution is the tab’s strategy', () => {
    const both = { host: { available: true, models: ['host-model'] }, srt: { available: true, models: ['host-model'] } }
    mocks.daemons = [
      withTable('agent-1', { host: ON, srt: ON }, [claude(both)]),
      withTable('agent-2', { host: ON, srt: ON }, [claude(both)])
    ]
    mocks.agents = [
      onGroup('a1', 'g1', { execution: 'host' }),
      onGroup('a2', 'g1', { execution: 'srt' }),
      onGroup('a3', 'g1', { execution: 'srt' }),
      pinned('a4', 'agent-1', { execution: 'host' })
    ]
    mount()
    expect(host.textContent).toContain('v2.0.0 · 1 agent')
    choose('Sandbox')
    expect(host.textContent).toContain('v2.0.0 · 2 agents')
    unmount()
  })
})

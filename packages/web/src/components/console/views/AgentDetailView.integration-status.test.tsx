// @vitest-environment happy-dom
// The agent page's integration pill: revoked, then rejected, then offline when nothing serves the agent, else connected.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow, IntegrationRow } from '@/lib/data'
import { botCardCopy } from '@/components/console/platforms/registry'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: {} as unknown,
  daemons: [] as unknown[],
  integrations: [] as unknown[]
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'agent-1' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() })
}))
vi.mock('next/link', () => ({
  default: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  )
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/PlaygroundProvider', () => ({ usePlayground: () => ({ openPlayground: vi.fn() }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/use-session-list', () => ({ useSessionList: () => ({ sessions: [], total: 0, isLoading: false }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({ runtimes: [] }), acpRuntime: () => null }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [mocks.agent],
    getAgent: () => mocks.agent,
    getSessions: () => [],
    daemons: mocks.daemons,
    daemonsLoading: false,
    integrations: mocks.integrations,
    bots: [],
    agentsLoading: false,
    updateAgent: vi.fn(async () => undefined),
    refresh: vi.fn(),
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] }))
}))

function agentOn(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'pilot',
    model: 'sonnet',
    runtime: 'claude',
    desc: '',
    outputMode: '—',
    showFooter: true,
    showStatusBar: false,
    reasoning: '',
    fastMode: false,
    pause: false,
    memoryProvider: 'none',
    memoryAutoDistill: false,
    status: 'online',
    daemon: 'd1',
    placementKind: 'daemon',
    workspace: { mode: 'scratch', files: [] },
    integrations: [],
    visibility: 'org',
    ...over
  } as unknown as Agent
}

function daemon(status: DaemonRow['status']): DaemonRow {
  return {
    daemonId: 'd1',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    status,
    caps: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: []
  } as unknown as DaemonRow
}

function slackIntegration(revoked: boolean, over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'int-1',
    agentId: 'agent-1',
    botId: 'bot-1',
    shareable: false,
    name: 'Example Workspace',
    platform: 'slack',
    kind: 'Custom app',
    workspace: '—',
    daemon: 'd1',
    status: revoked ? 'offline' : 'online',
    revoked,
    channels: [],
    ...over
  }
}

const AgentDetailView = (await import('./AgentDetailView')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AgentDetailView />
      </SWRConfig>
    )
  })
  return host
}

/** Each branch's pill: the element right after the identity link (desktop) or leading the action track (mobile). */
function pills(scope: HTMLElement): { mobile: HTMLElement; desktop: HTMLElement } {
  const unlinks = [...scope.querySelectorAll('button')].filter((b) => b.getAttribute('title') === 'Delete integration')
  const mobileUnlink = unlinks.find((b) => b.closest('.desktop\\:hidden'))!
  const desktopUnlink = unlinks.find((b) => !b.closest('.desktop\\:hidden'))!
  const mobile = mobileUnlink.parentElement!.firstElementChild as HTMLElement
  const desktop = desktopUnlink.parentElement!.querySelector('a .badge:last-child') as HTMLElement
  return { mobile, desktop }
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.daemons = []
  mocks.integrations = []
})

describe('AgentDetailView integration pill', () => {
  it('reads connected while the agent is served and the credential is live', async () => {
    mocks.agent = agentOn()
    mocks.daemons = [daemon('online')]
    mocks.integrations = [slackIntegration(false)]
    const { mobile, desktop } = pills(await render())

    for (const pill of [mobile, desktop]) {
      expect(pill.textContent).toBe('connected')
      expect(pill.className).toContain('bg-(--brand-soft)')
      expect(pill.getAttribute('title')).toBeNull()
    }
  })

  it('reads offline, neutrally, when the owning daemon is offline — the agents list’s own rule', async () => {
    mocks.agent = agentOn()
    mocks.daemons = [daemon('offline')]
    mocks.integrations = [slackIntegration(false)]
    const { mobile, desktop } = pills(await render())

    for (const pill of [mobile, desktop]) {
      expect(pill.textContent).toBe('offline')
      expect(pill.className).toContain('bg-(--surface-active)')
      expect(pill.className).not.toContain('status-error')
    }
  })

  it('reads revoked with the platform module’s sentence, ahead of an offline agent', async () => {
    mocks.agent = agentOn()
    mocks.daemons = [daemon('offline')]
    mocks.integrations = [slackIntegration(true)]
    const scope = await render()
    const { mobile, desktop } = pills(scope)

    for (const pill of [mobile, desktop]) {
      expect(pill.textContent).toBe('revoked')
      expect(pill.className).toContain('bg-(--status-error-soft)')
      expect(pill.getAttribute('title')).toBe(botCardCopy('slack').revokedHint)
    }
    expect(desktop.className).toContain('badge')
    // The header's mark cluster flags the same integration.
    expect(scope.querySelectorAll('[data-revoked-dot]')).toHaveLength(1)
  })

  it('reads rejected with the module’s sentence and the platform’s code, ahead of an offline agent', async () => {
    mocks.agent = agentOn()
    mocks.daemons = [daemon('offline')]
    mocks.integrations = [slackIntegration(false, { rejected: true, credentialCode: 'invalid_auth' })]
    const scope = await render()
    const { mobile, desktop } = pills(scope)

    for (const pill of [mobile, desktop]) {
      expect(pill.textContent).toBe('rejected')
      expect(pill.className).toContain('bg-(--status-error-soft)')
      expect(pill.getAttribute('title')).toBe(`${botCardCopy('slack').rejectedHint} (invalid_auth)`)
    }
    expect(scope.querySelectorAll('[data-revoked-dot]')).toHaveLength(1)
  })

  it('reads revoked over a rejection, with the code the revocation recorded', async () => {
    mocks.agent = agentOn()
    mocks.daemons = [daemon('online')]
    mocks.integrations = [slackIntegration(true, { rejected: true, credentialCode: 'token_revoked' })]
    const { mobile, desktop } = pills(await render())

    for (const pill of [mobile, desktop]) {
      expect(pill.textContent).toBe('revoked')
      expect(pill.getAttribute('title')).toBe(`${botCardCopy('slack').revokedHint} (token_revoked)`)
    }
  })
})

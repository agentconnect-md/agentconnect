// @vitest-environment happy-dom
// A module card with no Body keeps the host's generic rows and first-channel subline; its Notice sits right under the header.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, DaemonRow, IntegrationRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  agent: {} as unknown,
  integrations: [] as unknown[],
  bots: [] as unknown[],
  startSlackPlatformInstall: vi.fn(),
  getSlackPlatformInstall: vi.fn()
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
    daemons: [daemon],
    daemonsLoading: false,
    integrations: mocks.integrations,
    bots: mocks.bots,
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
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  startSlackPlatformInstall: mocks.startSlackPlatformInstall,
  getSlackPlatformInstall: mocks.getSlackPlatformInstall
}))

const daemon = {
  daemonId: 'd1',
  pool: false,
  memberSetId: null,
  name: 'edge-1',
  status: 'online',
  caps: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
  runtimeModels: [],
  mcpServers: []
} as unknown as DaemonRow

const agent = {
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
  visibility: 'org'
} as unknown as Agent

function slackIntegration(revoked: boolean): IntegrationRow {
  return {
    id: 'int-1',
    agentId: 'agent-1',
    botId: 'bot-1',
    shareable: false,
    name: 'Example Workspace',
    platform: 'slack',
    kind: 'Built-in app',
    workspace: '—',
    daemon: 'd1',
    status: revoked ? 'offline' : 'online',
    revoked,
    channels: [{ channelId: 'C-general', name: 'general', kind: 'channel', trigger: 'mention' }]
  }
}

function builtinBot(revokedAt: string | null): BotDto {
  return {
    id: 'bot-1',
    name: 'agentconnect',
    platform: 'slack',
    prebuilt: true,
    slackAppId: 'A0BUILTIN1',
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: false,
    inUseByAgentId: null,
    agentIds: revokedAt ? [] : ['agent-1'],
    lastUsedAt: null,
    freedFromAgent: null,
    revokedAt,
    createdAt: '2026-01-01T00:00:00.000Z'
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

/** Each branch's card header: the row holding the unlink (desktop) or its action track (mobile). */
function headers(scope: HTMLElement): { mobile: HTMLElement; desktop: HTMLElement } {
  const unlinks = [...scope.querySelectorAll('button')].filter((b) => b.getAttribute('title') === 'Delete integration')
  const mobileUnlink = unlinks.find((b) => b.closest('.desktop\\:hidden'))!
  const desktopUnlink = unlinks.find((b) => !b.closest('.desktop\\:hidden'))!
  return { mobile: mobileUnlink.parentElement!.parentElement!, desktop: desktopUnlink.parentElement! }
}

/** What the card renders after its header. */
function below(header: HTMLElement): HTMLElement[] {
  const rest: HTMLElement[] = []
  for (let next = header.nextElementSibling; next; next = next.nextElementSibling) rest.push(next as HTMLElement)
  return rest
}

beforeEach(() => {
  mocks.agent = agent
  mocks.startSlackPlatformInstall.mockReset()
  mocks.getSlackPlatformInstall.mockReset()
  mocks.startSlackPlatformInstall.mockResolvedValue({ id: 'install-1', installUrl: 'https://slack.example.test/oauth' })
  mocks.getSlackPlatformInstall.mockResolvedValue({
    id: 'install-1',
    status: 'pending',
    failureReason: null,
    missingScopes: [],
    botId: null
  })
  vi.spyOn(window, 'open').mockReturnValue(null)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.integrations = []
  mocks.bots = []
  vi.restoreAllMocks()
})

describe('an integration card whose module adds no Body', () => {
  it('keeps the generic conversation list and the mobile first-channel subline', async () => {
    mocks.integrations = [slackIntegration(false)]
    mocks.bots = [builtinBot(null)]
    const { mobile, desktop } = headers(await render())

    expect(mobile.querySelector('a .font-mono')?.textContent).toBe('#general')
    for (const header of [mobile, desktop]) {
      expect(below(header).some((row) => row.textContent?.includes('general'))).toBe(true)
      // A live integration needs no repair, so the module adds nothing to the header.
      expect(header.querySelector('[aria-label="Reinstall the Slack app"]')).toBeNull()
    }
  })

  it('puts the module’s Notice directly under the header, above the same generic rows', async () => {
    mocks.integrations = [slackIntegration(true)]
    mocks.bots = [builtinBot('2026-09-01T00:00:00.000Z')]
    const scope = await render()
    const { mobile, desktop } = headers(scope)

    for (const header of [mobile, desktop]) {
      const reinstall = header.querySelector('[aria-label="Reinstall the Slack app"]') as HTMLButtonElement
      expect(reinstall).not.toBeNull()
      await act(async () => reinstall.click())
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    for (const [header, padX] of [
      [mobile, 16],
      [desktop, 14]
    ] as const) {
      const [notice, ...rows] = below(header)
      expect(notice?.getAttribute('role')).toBe('status')
      expect(notice?.textContent).toBe('Reinstalling…')
      expect(notice?.style.padding).toBe(`10px ${padX}px`)
      expect(rows.some((row) => row.textContent?.includes('general'))).toBe(true)
    }
    expect(mobile.querySelector('a .font-mono')?.textContent).toBe('#general')
  })
})

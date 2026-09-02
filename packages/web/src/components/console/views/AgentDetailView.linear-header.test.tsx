// @vitest-environment happy-dom
// The mobile integration header keeps the workspace identity readable: its action
// track is one group that wraps under a floored identity link, so a module that adds
// controls (Linear's `grant expired` badge plus reconnect) cannot squeeze the name out.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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
    agents: [agent],
    getAgent: () => agent,
    getSessions: () => [],
    daemons: [],
    daemonsLoading: false,
    integrations: [linearIntegration],
    bots: [{ id: 'bot-1', platform: 'linear', revokedAt: '2026-09-01T00:00:00.000Z' }],
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
  workspace: { mode: 'scratch', files: [] },
  integrations: [],
  visibility: 'org'
} as unknown as Parameters<typeof Object.freeze>[0]

const linearIntegration = {
  id: 'int-1',
  agentId: 'agent-1',
  botId: 'bot-1',
  platform: 'linear',
  name: 'Acme Engineering Workspace',
  channels: [],
  shareable: true
} as unknown as Parameters<typeof Object.freeze>[0]

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

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the mobile integration header under a module that adds controls', () => {
  it('groups the action track so it wraps under a floored identity link', async () => {
    const scope = await render()
    // Both form factors render; the mobile list is the one under the `desktop:hidden` branch.
    const unlink = [...scope.querySelectorAll('button')].find(
      (b) => b.getAttribute('title') === 'Delete integration' && b.closest('.desktop\\:hidden')
    ) as HTMLElement
    const track = unlink.parentElement as HTMLElement
    const row = track.parentElement as HTMLElement

    // Every trailing control shares ONE flex-none track, so the row wraps it as a unit.
    expect(track.className).toContain('flex-none')
    expect(track.textContent).toContain('connected')
    expect([...track.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))).toContain(
      'Reconnect this workspace'
    )
    expect(track.textContent).toContain('grant expired')

    // …onto a second line, because the identity link keeps a floor instead of shrinking to nothing.
    expect(row.className).toContain('flex-wrap')
    const link = row.querySelector('a') as HTMLElement
    expect(link.className).toContain('min-w-36')
    expect(link.className).not.toContain('min-w-0')
    expect(link.textContent).toContain('Acme Engineering Workspace')
  })
})

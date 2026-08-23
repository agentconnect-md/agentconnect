// @vitest-environment happy-dom
/**
 * The GitLab card is the console's GitLab MANAGEMENT surface: an unconnected
 * organization gets one entry point, a connected one gets its connection
 * lifecycle and its bots. The BOT is the row (§18.1), mirroring the
 * chat-platform cards, and one row is one AGENT — the account it holds in each
 * top-level group is a pair on that row, not a row of its own. Projects are
 * managed where they are used, so the only project rows left are the ones no
 * bot holds. The write actions are asserted against the endpoint they call: a
 * repair that silently posted to the wrong binding would still look right.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GitlabConnectionDto, type GitlabOrgAccountDto, type GitlabProjectBindingDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchProjects: vi.fn(),
  fetchAccounts: vi.fn(),
  repairProject: vi.fn(),
  deleteProject: vi.fn(),
  transferProject: vi.fn(),
  disconnect: vi.fn(),
  startOauth: vi.fn(),
  reread: vi.fn()
}))

// One stable org object: the card keys its fetch effect on `activeOrg`, so a
// fresh literal per render would re-run it forever.
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-gitlab' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: ReactElement; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}))
// The bot's face and name come from the agent the console already loaded, so the
// card joins on the agent id rather than having the API repeat the agent's identity.
const AGENT = {
  id: 'agent-1',
  name: 'gitlab-pilot',
  displayName: 'GitLab pilot',
  runtime: 'claude',
  model: 'sonnet',
  icon: { kind: 'glyph' as const, glyph: 'bot', color: '#c62a78' }
}
vi.mock('@/lib/data-context', () => {
  const data = { getAgent: (id: string) => (id === AGENT.id ? AGENT : undefined) }
  return { useConsoleData: () => data }
})
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGitlabConnections: mocks.fetchConnections,
  fetchGitlabProjects: mocks.fetchProjects,
  fetchGitlabAccounts: mocks.fetchAccounts,
  repairGitlabProject: mocks.repairProject,
  deleteGitlabProject: mocks.deleteProject,
  transferGitlabProject: mocks.transferProject,
  disconnectGitlabConnection: mocks.disconnect,
  startGitlabOauth: mocks.startOauth
}))
// The mock records the key and options so the freshness contract is assertable, and
// serves the roster the test set — the card's own reads stay the effect's business.
vi.mock('swr', () => ({
  default: (key: unknown, fetcher: ((k: unknown) => Promise<unknown>) | null, options: SwrOptions) => {
    lastSwr = { key, options }
    if (!key || !fetcher) return { data: undefined, mutate: mocks.reread }
    return { data: read(), mutate: mocks.reread }
  }
}))

interface SwrOptions {
  refreshInterval?: (latest: unknown) => number
}

/** What the roster read answers with right now, or undefined before it has answered. */
function read(): { enabled: boolean; accounts: GitlabOrgAccountDto[]; converging: boolean } | undefined {
  return roster === undefined ? undefined : { enabled: true, accounts: roster, converging }
}

const GitlabCard = (await import('./GitlabCard')).default

const CONNECTION: GitlabConnectionDto = {
  id: 'conn-1',
  gitlabUserId: '4711',
  gitlabUsername: 'octo-maintainer',
  state: 'connected',
  scopes: ['api'],
  connectedBy: 'user-1',
  mine: true,
  accessExpiresAt: null,
  assignedProjects: 0,
  createdAt: '2026-08-01T00:00:00.000Z'
}

const BINDING: GitlabProjectBindingDto = {
  id: 'bind-1',
  projectId: '90210',
  projectPath: 'example-group/example-project',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  installerConnectionId: 'conn-1',
  accounts: [
    {
      agentId: 'agent-1',
      username: 'gitlab-pilot-5b350c0aeba7-2bivoj',
      displayName: 'GitLab pilot',
      userId: '9042',
      state: 'ready',
      stateReason: null
    }
  ],
  webhookState: 'installed',
  credentialEpoch: '1',
  createdAt: '2026-08-02T00:00:00.000Z'
}

/** The agent's account in one top-level group. An agent that reaches two owns two of these. */
const BOT: GitlabOrgAccountDto = {
  id: 'acct-1',
  agentId: 'agent-1',
  rootGroupId: '900',
  rootGroupPath: 'example-group',
  username: 'gitlab-pilot-5b350c0aeba7-2bivoj',
  displayName: 'GitLab pilot',
  userId: '9042',
  state: 'ready',
  stateReason: null,
  lifecycle: 'active',
  bindingIds: ['bind-1']
}

/** The SAME agent in a second top-level group — GitLab bot accounts cannot cross that boundary. */
const BOT_OTHER_GROUP: GitlabOrgAccountDto = {
  ...BOT,
  id: 'acct-1b',
  rootGroupId: '901',
  rootGroupPath: 'other-group',
  username: 'gitlab-pilot-5b350c0aeba7-rwzj7',
  bindingIds: ['bind-2']
}

/** A different agent's bot in the same group. */
const OTHER_BOT: GitlabOrgAccountDto = {
  ...BOT,
  id: 'acct-2',
  agentId: 'agent-2',
  username: 'triager-77c10b21eba7-2bivoj',
  displayName: 'triager'
}

const BINDING_TWO: GitlabProjectBindingDto = {
  ...BINDING,
  id: 'bind-2',
  projectId: '90211',
  projectPath: 'other-group/second-project'
}

let roster: GitlabOrgAccountDto[] | undefined
/** The server's answer to "does convergence still owe this organization work". */
let converging = false
let lastSwr: { key: unknown; options: SwrOptions } | undefined
let host: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<GitlabCard canWrite />)
  })
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

/** The compact controls carry their meaning in the tooltip, the way the messaging rows do. */
function iconButtonIn(scope: ParentNode, title: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('title')?.includes(title)
  )
  if (!found) throw new Error(`icon button not found: ${title}`)
  return found
}

async function click(label: string, scope: ParentNode = host): Promise<void> {
  const target = buttonIn(scope, label)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickIcon(title: string, scope: ParentNode = host): Promise<void> {
  const target = iconButtonIn(scope, title)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** One connection row and everything the card renders under it. */
function connectionRow(id: string): HTMLElement {
  const found = host.querySelector(`[data-gitlab-connection="${id}"]`)
  if (!found) throw new Error(`no connection row: ${id}`)
  return found as HTMLElement
}

/** One bot row — keyed by the AGENT, since its accounts are pairs on that row. */
function botRow(agentId: string): HTMLElement {
  const found = host.querySelector(`[data-gitlab-bot="${agentId}"]`)
  if (!found) throw new Error(`no bot row: ${agentId}`)
  return found as HTMLElement
}

/** The projects no bot holds — they keep their state and their actions. */
function orphanSection(): HTMLElement | null {
  return host.querySelector('[data-gitlab-orphans]')
}

function projectRow(scope: ParentNode, bindingId: string): HTMLElement {
  const found = scope.querySelector(`[data-gitlab-project="${bindingId}"]`)
  if (!found) throw new Error(`no project row: ${bindingId}`)
  return found as HTMLElement
}

function modal(): HTMLElement {
  const found = host.querySelector('.modal')
  if (!found) throw new Error('no confirmation modal is open')
  return found as HTMLElement
}

/** What SWR would wait before asking again — 0 means the card has stopped polling. */
function pollInterval(): number {
  const refresh = lastSwr?.options.refreshInterval
  if (!refresh) throw new Error('the card declared no refresh interval')
  return refresh(read())
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  mocks.fetchProjects.mockResolvedValue([])
  roster = []
  converging = false
})

describe('GitlabCard', () => {
  it('states the absence, and asks for no projects, on a deployment with no GitLab application', async () => {
    // The card mounts everywhere and learns availability from the API (§18.3):
    // an unconfigured control plane 404s the whole surface, which is an absence
    // to state — never a load error, and never a second request.
    mocks.fetchConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()
    expect(host.textContent).toContain('Not enabled on this deployment')
    expect(mocks.fetchProjects).not.toHaveBeenCalled()
    expect(lastSwr?.key).toBeNull()
    expect([...host.querySelectorAll('button')]).toHaveLength(0)
  })

  it('offers a single connect entry point when nothing is connected', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    expect(host.textContent).toContain('Not connected')
    expect(buttonIn(host, 'Connect GitLab')).toBeTruthy()
    expect(host.querySelectorAll('[data-gitlab-bot]')).toHaveLength(0)
  })

  it('gives one agent one row, with the agent’s own face and name', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const row = botRow('agent-1')
    // The agent's own name, not the derived GitLab display name — the bot IS that agent.
    expect(row.textContent).toContain('GitLab pilot')
    expect(row.querySelector('[data-agent-icon-glyph]')).toBeTruthy()
    const toAgent = row.querySelector('a[href^="/agents/"]') as HTMLAnchorElement
    expect(toAgent.getAttribute('href')).toBe('/agents/agent-1?tab=config')
    expect(host.textContent).not.toContain('Connect GitLab')
  })

  it('shows an agent that reaches two groups as ONE row with a pair for each', async () => {
    // An account cannot cross a top-level group, so an agent spanning two owns two accounts.
    // That is one bot with two faces on GitLab, not two bots — the row must read that way.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING, BINDING_TWO])
    roster = [BOT, BOT_OTHER_GROUP]
    await render()

    expect(host.querySelectorAll('[data-gitlab-bot]')).toHaveLength(1)
    const row = botRow('agent-1')
    const pairs = [...row.querySelectorAll('[data-gitlab-account]')]
    expect(pairs).toHaveLength(2)
    expect(pairs[0]!.textContent).toContain('example-group')
    expect(pairs[0]!.textContent).toContain('@gitlab-pilot-5b350c0aeba7-2bivoj')
    expect(pairs[1]!.textContent).toContain('other-group')
    expect(pairs[1]!.textContent).toContain('@gitlab-pilot-5b350c0aeba7-rwzj7')
    // One agent, so its name appears once rather than once per account.
    expect(row.querySelectorAll('a[href^="/agents/"]')).toHaveLength(1)
  })

  it('gives an agent in one group a single pair', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const pairs = [...botRow('agent-1').querySelectorAll('[data-gitlab-account]')]
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.textContent).toContain('example-group')
  })

  it('keeps two different agents on two rows', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT, OTHER_BOT]
    await render()

    expect(host.querySelectorAll('[data-gitlab-bot]')).toHaveLength(2)
    expect(botRow('agent-1')).toBeTruthy()
    expect(botRow('agent-2')).toBeTruthy()
  })

  it('links each pair’s handle to its GitLab profile, in a tab that cannot reach back', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING, BINDING_TWO])
    roster = [BOT, BOT_OTHER_GROUP]
    await render()

    const links = [...botRow('agent-1').querySelectorAll('a[href^="https://gitlab.com/"]')] as HTMLAnchorElement[]
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://gitlab.com/gitlab-pilot-5b350c0aeba7-2bivoj',
      'https://gitlab.com/gitlab-pilot-5b350c0aeba7-rwzj7'
    ])
    expect(links.every((link) => link.getAttribute('target') === '_blank')).toBe(true)
    expect(links.every((link) => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true)
  })

  it('names no project under a bot: projects are managed where they are used', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const row = botRow('agent-1')
    expect(row.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
    expect(row.textContent).not.toContain('example-group/example-project')
    // And a project a bot holds is not orphaned either — it simply has no row here.
    expect(orphanSection()).toBeNull()
  })

  it('stays quiet on a healthy bot and speaks up on a refused one', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [
      BOT,
      {
        ...OTHER_BOT,
        userId: null,
        rootGroupPath: null,
        state: 'admin_degraded',
        stateReason: 'service_account_quota',
        bindingIds: []
      }
    ]
    await render()

    // Healthy: named, not badged.
    expect(botRow('agent-1').textContent).not.toContain('ready')
    const refused = botRow('agent-2')
    expect(refused.textContent).toContain('setup incomplete')
    expect(refused.textContent).not.toContain('service_account_quota')
    // No account on GitLab yet, so its handle is not a dead profile link.
    expect(refused.querySelector('a[href^="https://gitlab.com/"]')).toBeNull()
    // The group falls back to its number rather than borrowing another project's path.
    expect(refused.textContent).toContain('group 900')
  })

  it('marks a retiring account as leaving', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    roster = [{ ...BOT, lifecycle: 'retiring', bindingIds: [] }]
    await render()
    expect(botRow('agent-1').textContent).toContain('removing')
  })

  it('repairs every project the bot holds, from the bot’s own control', async () => {
    // Account convergence runs per project, so repairing the bot means repairing each of them.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING, BINDING_TWO])
    roster = [BOT, BOT_OTHER_GROUP]
    mocks.repairProject.mockImplementation(async (id: string) => ({ ...BINDING, id }))
    await render()

    await clickIcon('Repair this bot', botRow('agent-1'))
    expect(mocks.repairProject.mock.calls.map((call) => call[0]).sort()).toEqual(['bind-1', 'bind-2'])
    expect(mocks.reread).toHaveBeenCalled()
  })

  it('offers a take-over on a bot only where administration lost its authority', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()
    // Its administering account is connected and the project is healthy: nothing to take over.
    expect(() => iconButtonIn(botRow('agent-1'), 'Take over')).toThrow()
  })

  it('offers it once that account is no longer connected, and takes the projects over', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.transferProject.mockResolvedValue(BINDING)
    await render()

    await clickIcon('Take over', botRow('agent-1'))
    expect(mocks.transferProject).not.toHaveBeenCalled()
    await click('Take over', modal())
    expect(mocks.transferProject).toHaveBeenCalledWith('bind-1')
  })

  it('says why a take-over was refused, in GitLab terms', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.transferProject.mockRejectedValue(new ApiError('gitlab: nope', 403, 'GITLAB_NOT_MAINTAINER'))
    await render()

    await clickIcon('Take over', botRow('agent-1'))
    await click('Take over', modal())
    expect(host.textContent).toContain('Maintainer or Owner access')
    expect(host.querySelector('.modal')).toBeNull()
    expect(host.textContent).not.toContain('GITLAB_NOT_MAINTAINER')
  })

  it('gives a project no bot holds its own group, with its actions', async () => {
    // A binding outlives its last consumer: it still owns the webhook and the claim,
    // so it must keep somewhere to be repaired, taken over, or removed from.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([{ ...BINDING, state: 'admin_degraded' as const }])
    mocks.repairProject.mockResolvedValue({ ...BINDING, state: 'provisioning' as const })
    roster = []
    await render()

    const orphans = orphanSection()!
    expect(orphans.textContent).toContain('Projects without a bot')
    const project = projectRow(orphans, 'bind-1')
    expect(project.textContent).toContain('example-group/example-project')
    expect(project.textContent).toContain('setup incomplete')
    expect(iconButtonIn(project, 'Repair')).toBeTruthy()
    expect(iconButtonIn(project, 'Remove')).toBeTruthy()
    // Its administering account is still connected, so there is no authority to take over.
    expect(() => iconButtonIn(project, 'Take over')).toThrow()

    await clickIcon('Repair', project)
    expect(mocks.repairProject).toHaveBeenCalledWith('bind-1')
  })

  it('moves a project out of that group as soon as a bot holds it', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = []
    await render()
    expect(projectRow(orphanSection()!, 'bind-1')).toBeTruthy()

    await act(async () => root.unmount())
    roster = [BOT]
    await render()
    expect(orphanSection()).toBeNull()
  })

  it('badges an orphan’s webhook only while it needs attention', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      { ...BINDING, webhookState: 'not_needed' as const },
      { ...BINDING, id: 'bind-repairing', projectPath: 'example-group/a', webhookState: 'repairing' as const },
      {
        ...BINDING,
        id: 'bind-failed',
        projectPath: 'example-group/b',
        state: 'admin_degraded' as const,
        webhookState: 'failed' as const
      }
    ])
    roster = []
    await render()

    const orphans = orphanSection()!
    expect(projectRow(orphans, 'bind-1').textContent).not.toContain('webhook')
    expect(projectRow(orphans, 'bind-repairing').textContent).toContain('webhook repairing')
    const failed = projectRow(orphans, 'bind-failed')
    expect(failed.textContent).toContain('webhook failed')
    expect(iconButtonIn(failed, 'Repair')).toBeTruthy()
  })

  it('removes an orphaned project after confirming, and drops its row', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    mocks.deleteProject.mockResolvedValue({ removed: true })
    roster = []
    await render()

    await clickIcon('Remove', projectRow(orphanSection()!, 'bind-1'))
    expect(mocks.deleteProject).not.toHaveBeenCalled()
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('explains, rather than attempts, a removal with no account to run it', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = []
    await render()

    await clickIcon('Remove', projectRow(orphanSection()!, 'bind-1'))
    expect(modal().textContent).toContain('no longer connected')
    expect(() => buttonIn(modal(), 'Remove')).toThrow()
    expect(mocks.deleteProject).not.toHaveBeenCalled()
  })

  it('polls on the server’s convergence answer, not on how the roster happens to look', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    converging = true
    await render()
    expect(pollInterval()).toBeGreaterThan(0)

    await act(async () => root.unmount())
    converging = false
    await render()
    expect(pollInterval()).toBe(0)
  })

  it('keeps asking before the read has answered at all', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = undefined
    await render()
    expect(pollInterval()).toBeGreaterThan(0)
  })

  it('keys the roster read on the bound projects, so a removal cannot serve a stale one', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = []
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await render()
    const before = lastSwr?.key

    await clickIcon('Remove', projectRow(orphanSection()!, 'bind-1'))
    await click('Remove', modal())
    expect(lastSwr?.key).not.toEqual(before)
  })

  it('surfaces the reconnect hint when GitLab stopped accepting the connection', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'reauth_required' as const }]
    })
    await render()
    expect(host.textContent).toContain('reconnect needed')
    expect(buttonIn(host, 'Reconnect')).toBeTruthy()
  })

  it('offers Disconnect, not Remove, while the connection is still live', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.disconnect.mockResolvedValue({
      removed: false,
      connection: { ...CONNECTION, state: 'disconnected' as const }
    })
    await render()
    const row = connectionRow('conn-1')
    expect(buttonIn(row, 'Disconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Remove')).toThrow()

    await click('Disconnect')
    expect(mocks.disconnect).not.toHaveBeenCalled()
    await click('Disconnect', modal())
    expect(mocks.disconnect).toHaveBeenCalledWith('conn-1')
    expect(host.textContent).toContain('disconnected')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(1)
  })

  it('finishes a released connection that administers nothing: Remove instead of Disconnect', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 0 }]
    })
    mocks.disconnect.mockResolvedValue({ removed: true, connection: null })
    await render()
    const row = connectionRow('conn-1')
    expect(buttonIn(row, 'Reconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Disconnect')).toThrow()

    await click('Remove')
    await click('Remove', modal())
    expect(mocks.disconnect).toHaveBeenCalledWith('conn-1')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(0)
  })

  it('explains why a released connection with projects still assigned cannot go', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 2 }]
    })
    await render()
    const row = connectionRow('conn-1')
    expect(row.textContent).toContain('still administers 2 projects')
    expect(() => buttonIn(row, 'Remove')).toThrow()
    expect(row.textContent).not.toContain('assignedProjects')
  })

  it('keeps a connect action reachable for a caller who owns none of the connections', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs] })
    await render()
    expect(buttonIn(host, 'Connect my account')).toBeTruthy()
  })

  it('drops that action once the caller has an own connected account', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs, CONNECTION] })
    await render()
    expect(() => buttonIn(host, 'Connect my account')).toThrow()
    expect(() => buttonIn(host, 'Connect GitLab')).toThrow()
  })

  it('lists every retained connection, stale ones included', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [
        { ...CONNECTION, id: 'conn-old', gitlabUsername: 'former-admin', state: 'disconnected' as const },
        { ...CONNECTION, id: 'conn-new', gitlabUsername: 'current-admin' }
      ]
    })
    await render()
    expect(host.textContent).toContain('former-admin')
    expect(host.textContent).toContain('current-admin')
    expect(host.querySelectorAll('[data-gitlab-connection]')).toHaveLength(2)
  })

  it('manages what is set up but never picks a project', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    expect(() => buttonIn(host, 'Add project')).toThrow()
    expect(host.querySelector('input[aria-label="Search GitLab projects"]')).toBeNull()
  })

  it('says where projects come from when nothing is set up yet', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    await render()
    expect(host.textContent).toContain('No projects are set up yet')
    expect(host.textContent).toContain('agent workspace')
  })

  it('translates known binding reasons and hides unmapped machine categories', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      { ...BINDING, id: 'bind-known', state: 'admin_degraded' as const, stateReason: 'project_not_accessible' },
      {
        ...BINDING,
        id: 'bind-unknown',
        projectPath: 'example-group/mystery',
        state: 'runtime_degraded' as const,
        stateReason: 'some_future_category'
      }
    ])
    roster = []
    await render()
    expect(host.textContent).toContain('GitLab project is no longer accessible')
    expect(host.textContent).not.toContain('some_future_category')
    expect(host.textContent).not.toContain('project_not_accessible')
    expect(host.textContent).toContain('bot access degraded')
  })
})

// @vitest-environment happy-dom
/**
 * The GitLab card is the console's GitLab MANAGEMENT surface: an unconnected
 * organization gets one entry point, a connected one gets its connection
 * lifecycle, its bots, and the health of the projects each bot is a member of.
 * The BOT is the row (§18.1), mirroring the chat-platform cards; picking a
 * project is deliberately not here — that happens where the project is used.
 * The write actions are asserted against the endpoint they call: a repair that
 * silently posted to the wrong binding would still look right on screen.
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  type GitlabConnectionDto,
  type GitlabMembershipDto,
  type GitlabOrgAccountDto,
  type GitlabProjectBindingDto
} from '@/lib/api'

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
  onSuccess?: (latest: unknown) => void
}

/** Drive one successful revalidation of the roster read, the way SWR's poll would. */
async function revalidate(): Promise<void> {
  const onSuccess = lastSwr?.options.onSuccess
  if (!onSuccess) throw new Error('the card handles no roster revalidation')
  await act(async () => {
    onSuccess(read())
  })
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
      username: 'agentconnect-a1-g900',
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

/** One hold on a project: a read & write workspace, no triggers. */
const MEMBER: GitlabMembershipDto = {
  bindingId: 'bind-1',
  accessLevel: 30,
  workspace: 'write',
  triggerFamilies: [],
  triggerCount: 0
}

const BOT: GitlabOrgAccountDto = {
  id: 'acct-1',
  agentId: 'agent-1',
  rootGroupId: '900',
  rootGroupPath: 'example-group',
  username: 'agentconnect-a1-g900',
  displayName: 'GitLab pilot',
  userId: '9042',
  state: 'ready',
  stateReason: null,
  lifecycle: 'active',
  memberships: [MEMBER]
}

/** A second agent's bot in the same top-level group — one account per agent, not per project. */
const OTHER_BOT: GitlabOrgAccountDto = {
  ...BOT,
  id: 'acct-2',
  agentId: 'agent-2',
  username: 'agentconnect-a2-g900',
  displayName: 'triager'
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

async function click(label: string, scope: ParentNode = host): Promise<void> {
  const target = buttonIn(scope, label)
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

/** One bot row and the project rows underneath it. */
function botRow(accountId: string): HTMLElement {
  const found = host.querySelector(`[data-gitlab-bot="${accountId}"]`)
  if (!found) throw new Error(`no bot row: ${accountId}`)
  return found as HTMLElement
}

/** The projects no bot is a member of — they keep their state and their actions. */
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
    // The bot roster is not asked for either: a disabled surface has no key.
    expect(lastSwr?.key).toBeNull()
    expect([...host.querySelectorAll('button')]).toHaveLength(0)
  })

  it('offers a single connect entry point when nothing is connected', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    expect(host.textContent).toContain('Not connected')
    expect(buttonIn(host, 'Connect GitLab')).toBeTruthy()
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('shows the connected identity, its bots, and no connect button', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()
    expect(host.textContent).toContain('octo-maintainer')
    expect(host.textContent).toContain('example-group/example-project')
    expect(host.textContent).toContain('ready')
    expect(host.textContent).toContain('agentconnect-a1-g900')
    expect(host.textContent).not.toContain('Connect GitLab')
  })

  it('keys a row by bot: the agent’s face and name, its handle, its group, and its health', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const row = botRow('acct-1')
    // The agent's own name, not the derived GitLab display name — the bot IS that agent.
    expect(row.textContent).toContain('GitLab pilot')
    expect(row.textContent).toContain('@agentconnect-a1-g900')
    expect(row.textContent).toContain('example-group')
    expect(row.querySelector('[data-agent-icon-glyph]')).toBeTruthy()
    // And the row leads back to that agent's page.
    const toAgent = row.querySelector('a[href^="/agents/"]') as HTMLAnchorElement
    expect(toAgent.getAttribute('href')).toBe('/agents/agent-1?tab=config')
  })

  it('links the bot handle to its GitLab profile, in a tab that cannot reach back', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const handle = host.querySelector('[data-gitlab-account]') as HTMLAnchorElement
    expect(handle.textContent).toBe('@agentconnect-a1-g900')
    expect(handle.getAttribute('href')).toBe('https://gitlab.com/agentconnect-a1-g900')
    expect(handle.getAttribute('target')).toBe('_blank')
    expect(handle.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('puts the bot’s projects underneath it, with role and state', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    const project = projectRow(botRow('acct-1'), 'bind-1')
    expect(project.textContent).toContain('example-group/example-project')
    // The role is GitLab's word for the access level the membership carries.
    expect(project.textContent).toContain('Developer')
    expect(project.textContent).toContain('ready')
    // The project-level actions live on the project line, not on the bot.
    expect(buttonIn(project, 'Repair')).toBeTruthy()
    expect(buttonIn(project, 'Remove')).toBeTruthy()
  })

  it('says nothing about a webhook that is healthy or simply not needed', async () => {
    // A workspace-only project has no trigger pointing at it, so it wants no ingress at all.
    // That is a resting state, not a condition — badging it reads as a fault that is not there.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      { ...BINDING, webhookState: 'not_needed' as const },
      { ...BINDING, id: 'bind-hooked', projectPath: 'example-group/hooked', webhookState: 'installed' as const }
    ])
    roster = [{ ...BOT, memberships: [...BOT.memberships, { ...MEMBER, bindingId: 'bind-hooked' }] }]
    await render()

    const bot = botRow('acct-1')
    expect(bot.textContent).not.toContain('webhook')
    // The rest of the row is untouched: the project, its role, and its state still read.
    expect(projectRow(bot, 'bind-1').textContent).toContain('ready')
  })

  it('badges a webhook only while it needs attention, and keeps Repair on the failed one', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      { ...BINDING, webhookState: 'repairing' as const },
      {
        ...BINDING,
        id: 'bind-failed',
        projectPath: 'example-group/broken',
        state: 'admin_degraded' as const,
        webhookState: 'failed' as const
      }
    ])
    roster = [{ ...BOT, memberships: [...BOT.memberships, { ...MEMBER, bindingId: 'bind-failed' }] }]
    await render()

    const bot = botRow('acct-1')
    expect(projectRow(bot, 'bind-1').textContent).toContain('webhook repairing')
    const failed = projectRow(bot, 'bind-failed')
    expect(failed.textContent).toContain('webhook failed')
    expect(buttonIn(failed, 'Repair')).toBeTruthy()
  })

  it('names why the bot is on the project: its workspace, its triggers, or both', async () => {
    // Removing an agent's triggers leaves its workspace using the project. Without the reason on
    // the line the surviving bot reads as a leftover, and people go looking for something to delete.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      BINDING,
      { ...BINDING, id: 'bind-both', projectPath: 'example-group/both' },
      { ...BINDING, id: 'bind-triggers', projectPath: 'example-group/triggers-only' }
    ])
    roster = [
      {
        ...BOT,
        memberships: [
          { ...MEMBER, workspace: 'read' },
          {
            ...MEMBER,
            bindingId: 'bind-both',
            triggerFamilies: ['issues', 'merge_request'],
            triggerCount: 2
          },
          { ...MEMBER, bindingId: 'bind-triggers', workspace: null, triggerFamilies: ['issues'], triggerCount: 1 }
        ]
      }
    ]
    await render()

    const bot = botRow('acct-1')
    expect(projectRow(bot, 'bind-1').textContent).toContain('workspace (read)')
    // Both reasons, in GitLab's own words for the families.
    expect(projectRow(bot, 'bind-both').textContent).toContain('workspace (read & write) · triggers: Issues, MRs')
    // Triggers alone, with no workspace clause invented for it.
    const triggersOnly = projectRow(bot, 'bind-triggers').textContent ?? ''
    expect(triggersOnly).toContain('triggers: Issues')
    expect(triggersOnly).not.toContain('workspace')
  })

  it('says nothing about a reason when a membership no authorization justifies is on its way out', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [{ ...BOT, memberships: [{ ...MEMBER, workspace: null, triggerFamilies: [], triggerCount: 0 }] }]
    await render()

    const project = projectRow(botRow('acct-1'), 'bind-1')
    expect(project.textContent).not.toContain('workspace')
    expect(project.textContent).not.toContain('triggers')
    // The project itself still reads, and is still actionable.
    expect(project.textContent).toContain('example-group/example-project')
    expect(buttonIn(project, 'Repair')).toBeTruthy()
  })

  it('lists a project shared by two bots under both, once each', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT, OTHER_BOT]
    await render()

    expect(host.querySelectorAll('[data-gitlab-bot]')).toHaveLength(2)
    expect(projectRow(botRow('acct-1'), 'bind-1')).toBeTruthy()
    expect(projectRow(botRow('acct-2'), 'bind-1')).toBeTruthy()
    // Shared, not orphaned: every bot on it accounts for it.
    expect(orphanSection()).toBeNull()

    // Removing it from either line removes the project itself, and the copy says so.
    await click('Remove', projectRow(botRow('acct-2'), 'bind-1'))
    expect(modal().textContent).toContain('from this organization')
    expect(modal().textContent).toContain('all 2 bots')
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('keeps a bot whose last project went away, with its health', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([])
    roster = [{ ...BOT, lifecycle: 'retiring', memberships: [] }]
    await render()

    const row = botRow('acct-1')
    expect(row.textContent).toContain('removing')
    expect(row.textContent).toContain('Removing…')
    expect(row.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
    // The bot is on screen, so the "nothing set up yet" notice is not.
    expect(host.textContent).not.toContain('No projects are set up yet')
  })

  it('says what a refused bot account needs, in GitLab terms and with no machine code', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    // The group hit its bot-account ceiling: the account has no GitLab user and no group to name.
    roster = [
      {
        ...BOT,
        userId: null,
        rootGroupPath: null,
        state: 'admin_degraded',
        stateReason: 'service_account_quota'
      }
    ]
    await render()

    const row = botRow('acct-1')
    expect(row.textContent).toContain('setup incomplete')
    expect(row.textContent).toContain('limit of bot accounts')
    expect(row.textContent).not.toContain('service_account_quota')
    // No account on GitLab yet, so the handle names it without offering a dead profile link.
    const handle = row.querySelector('[data-gitlab-account]')!
    expect(handle.tagName).toBe('SPAN')
    // The group falls back to its number rather than borrowing another project's path.
    expect(row.textContent).toContain('group 900')
  })

  it('does not call a refused account retiring: it is waiting for Repair, not leaving', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    // Refused creation leaves an ACTIVE account row that never got a membership.
    roster = [{ ...BOT, userId: null, state: 'admin_degraded', stateReason: 'service_account_quota', memberships: [] }]
    await render()

    const row = botRow('acct-1')
    expect(row.textContent).toContain('Not a member of any project yet')
    expect(row.textContent).not.toContain('on its way out')
    expect(row.textContent).not.toContain('removing')
    // And the health line still says what to do about it.
    expect(row.textContent).toContain('limit of bot accounts')
  })

  it('gives a project no bot is a member of its own group, with its actions', async () => {
    // A binding outlives its last consumer: it still owns the webhook and the claim,
    // so it must keep somewhere to be repaired, transferred, or removed from.
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
    expect(buttonIn(project, 'Repair')).toBeTruthy()
    expect(buttonIn(project, 'Remove')).toBeTruthy()
    // Its administering account is still connected, so there is no authority to take over.
    expect(() => buttonIn(project, 'Take over')).toThrow()

    await click('Repair', project)
    expect(mocks.repairProject).toHaveBeenCalledWith('bind-1')
  })

  it('moves a project out of that group as soon as a bot becomes a member', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = []
    await render()
    expect(projectRow(orphanSection()!, 'bind-1')).toBeTruthy()
    expect(host.querySelectorAll('[data-gitlab-bot]')).toHaveLength(0)

    // The provisioning saga lands the membership; the next roster read carries it.
    await act(async () => root.unmount())
    roster = [BOT]
    await render()
    expect(orphanSection()).toBeNull()
    expect(projectRow(botRow('acct-1'), 'bind-1')).toBeTruthy()
  })

  it('polls on the server’s convergence answer, not on how the roster happens to look', async () => {
    // A membership can change while this project set does not — a hook disabled elsewhere
    // converges asynchronously — so a roster that merely looks settled proves nothing.
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

  it('keeps polling through a role-only downgrade, then shows the settled role', async () => {
    // Dropping one of an agent's two authorizations downgrades its surviving membership
    // instead of removing it: the bot and the project both stay, only the role moves.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    converging = true
    await render()
    expect(projectRow(botRow('acct-1'), 'bind-1').textContent).toContain('Developer')
    expect(pollInterval()).toBeGreaterThan(0)

    await act(async () => root.unmount())
    roster = [{ ...BOT, memberships: [{ ...MEMBER, accessLevel: 20 }] }]
    converging = false
    await render()
    expect(projectRow(botRow('acct-1'), 'bind-1').textContent).toContain('Reporter')
    expect(pollInterval()).toBe(0)
  })

  it('re-reads the projects while convergence is pending, and once more when it settles', async () => {
    // A webhook still installing lives on the project row, not the roster, and the projects were
    // read once at mount — so without this the transient badge would sit there until a reload.
    // The response that reports settled is the one carrying the finished state AND the one that
    // stops the poll, so skipping the read there would strand the badge for good.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([{ ...BINDING, webhookState: 'repairing' as const }])
    roster = [BOT]
    converging = true
    await render()
    const row = () => projectRow(botRow('acct-1'), 'bind-1')
    expect(row().textContent).toContain('webhook repairing')

    // A poll taken while it is still installing re-reads, and the badge honestly stays.
    const pending = mocks.fetchProjects.mock.calls.length
    await revalidate()
    expect(mocks.fetchProjects.mock.calls.length).toBeGreaterThan(pending)
    expect(row().textContent).toContain('webhook repairing')

    // The install completes, and the roster settles in the same breath.
    mocks.fetchProjects.mockResolvedValue([BINDING])
    converging = false
    const settling = mocks.fetchProjects.mock.calls.length
    await revalidate()
    expect(mocks.fetchProjects.mock.calls.length).toBe(settling + 1)
    expect(row().textContent).not.toContain('webhook')
    expect(pollInterval()).toBe(0)

    // Exactly one: a settled answer following a settled one reads nothing more.
    await revalidate()
    expect(mocks.fetchProjects.mock.calls.length).toBe(settling + 1)
  })

  it('lets the newest project read win when an older one resolves after it', async () => {
    // Each roster answer launches its own project read, so two are in flight at once and the
    // network decides the order they land in. Unfenced, a slow read of the transient state
    // paints over the finished one that already arrived — after polling has stopped for good.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([{ ...BINDING, webhookState: 'repairing' as const }])
    roster = [BOT]
    converging = true
    await render()
    const row = () => projectRow(botRow('acct-1'), 'bind-1')

    let older!: (rows: GitlabProjectBindingDto[]) => void
    let newer!: (rows: GitlabProjectBindingDto[]) => void
    mocks.fetchProjects.mockReturnValueOnce(new Promise((resolve) => (older = resolve)))
    mocks.fetchProjects.mockReturnValueOnce(new Promise((resolve) => (newer = resolve)))
    await revalidate()
    converging = false
    await revalidate()

    // The newer read lands first and shows the install finished.
    await act(async () => newer([BINDING]))
    expect(row().textContent).not.toContain('webhook')

    // The older one answers last, still describing the install as running, and is discarded.
    await act(async () => older([{ ...BINDING, webhookState: 'repairing' as const }]))
    expect(row().textContent).not.toContain('webhook')
  })

  it('discards the read taken at mount when a newer one has already answered', async () => {
    // The mount read is launched before the roster surface is even enabled, so it races every
    // fenced read that follows. Left unfenced it answers last and paints its own snapshot back.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    let initial!: (rows: GitlabProjectBindingDto[]) => void
    mocks.fetchProjects.mockReturnValueOnce(new Promise((resolve) => (initial = resolve)))
    roster = [BOT]
    converging = true
    await render()

    // A fenced poll answers first, with the install finished.
    let newer!: (rows: GitlabProjectBindingDto[]) => void
    mocks.fetchProjects.mockReturnValueOnce(new Promise((resolve) => (newer = resolve)))
    await revalidate()
    await act(async () => newer([BINDING]))
    const row = () => projectRow(botRow('acct-1'), 'bind-1')
    expect(row().textContent).not.toContain('webhook')

    // The mount read finally lands, still describing the install as running, and is dropped.
    await act(async () => initial([{ ...BINDING, webhookState: 'repairing' as const }]))
    expect(row().textContent).not.toContain('webhook')
  })

  it('leaves the projects alone once nothing is converging', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    converging = false
    await render()
    const reads = mocks.fetchProjects.mock.calls.length

    await revalidate()
    expect(mocks.fetchProjects.mock.calls.length).toBe(reads)
  })

  it('keeps asking before the read has answered at all', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = undefined
    await render()
    expect(pollInterval()).toBeGreaterThan(0)
  })

  it('re-reads the roster after Repair, whose account changes leave the project set alone', async () => {
    // Repair can create or heal an account and its membership without touching the bound
    // projects, so nothing about the key would change and the cached roster would stay stale.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.repairProject.mockResolvedValue({ ...BINDING, state: 'ready' as const })
    await render()

    await click('Repair', projectRow(botRow('acct-1'), 'bind-1'))
    expect(mocks.repairProject).toHaveBeenCalledWith('bind-1')
    expect(mocks.reread).toHaveBeenCalled()
  })

  it('re-reads the roster after a takeover, which re-runs convergence under the new account', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.transferProject.mockResolvedValue({ ...BINDING, installerConnectionId: 'conn-1' })
    await render()

    await click('Take over', projectRow(botRow('acct-1'), 'bind-1'))
    await click('Take over', modal())
    expect(mocks.reread).toHaveBeenCalled()
  })

  it('re-reads the roster when a removal did not finish and the project set stayed put', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.deleteProject.mockResolvedValue({ removed: false, state: 'cleanup_pending', stateReason: 'cleanup_failed' })
    await render()

    await click('Remove', projectRow(botRow('acct-1'), 'bind-1'))
    await click('Remove', modal())
    expect(mocks.reread).toHaveBeenCalled()
    // The project is still listed, in the state GitLab left it in.
    expect(host.textContent).toContain('removal incomplete')
  })

  it('keys the roster read on the bound projects, so a removal cannot serve a stale one', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await render()
    const before = lastSwr?.key

    await click('Remove', projectRow(botRow('acct-1'), 'bind-1'))
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    // The key carries the binding set, so the entry recorded under the old one is unreachable.
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

    // Disconnect is confirmed, and the row survives it — in its released state.
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
    expect(mocks.disconnect).not.toHaveBeenCalled()
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
    expect(buttonIn(row, 'Reconnect')).toBeTruthy()
    expect(() => buttonIn(row, 'Remove')).toThrow()
    expect(() => buttonIn(row, 'Disconnect')).toThrow()
    // The blocking count is stated in words, never as a machine code.
    expect(row.textContent).not.toContain('assignedProjects')
  })

  it('breaks the removal deadlock: transfer first, then the blocked line clears', async () => {
    // The account that set the project up is gone, so removing the project would
    // need an administering account it no longer has: takeover is the way out.
    const stale = { ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }
    const mine = { ...CONNECTION, id: 'conn-2', gitlabUsername: 'current-admin', assignedProjects: 0 }
    mocks.fetchConnections.mockResolvedValueOnce({ enabled: true, connections: [stale, mine] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    expect(connectionRow('conn-1').textContent).toContain('still administers 1 project')
    expect(connectionRow('conn-1').textContent).toContain('Transfer that project')
    expect(() => buttonIn(connectionRow('conn-1'), 'Remove')).toThrow()

    const project = () => projectRow(botRow('acct-1'), 'bind-1')
    // Remove is explained, not attempted: the saga would fail halfway at GitLab.
    await click('Remove', project())
    expect(modal().textContent).toContain('no longer connected')
    expect(() => buttonIn(modal(), 'Remove')).toThrow()
    expect(mocks.deleteProject).not.toHaveBeenCalled()
    await click('Close', modal())

    // Take it over, and the counts both sides show move with it.
    mocks.transferProject.mockResolvedValue({ ...BINDING, installerConnectionId: 'conn-2' })
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [
        { ...stale, assignedProjects: 0 },
        { ...mine, assignedProjects: 1 }
      ]
    })
    await click('Take over', project())
    expect(mocks.transferProject).not.toHaveBeenCalled()
    await click('Take over', modal())
    expect(mocks.transferProject).toHaveBeenCalledWith('bind-1')
    expect(connectionRow('conn-1').textContent).not.toContain('still administers')
    expect(buttonIn(connectionRow('conn-1'), 'Remove')).toBeTruthy()

    // And removal now runs for real, under the account that took it over.
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await click('Remove', project())
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('offers Take over only where administration lost its authority, never on a healthy row', async () => {
    // Taking a project over swaps the account that administers it. That is only meaningful when
    // the current one cannot act — a degraded project under a CONNECTED account is a Repair.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([
      BINDING,
      { ...BINDING, id: 'bind-degraded', projectPath: 'example-group/degraded', state: 'admin_degraded' as const },
      { ...BINDING, id: 'bind-cleanup', projectPath: 'example-group/going', state: 'cleanup_pending' as const }
    ])
    roster = [
      {
        ...BOT,
        memberships: [
          ...BOT.memberships,
          { ...MEMBER, bindingId: 'bind-degraded' },
          { ...MEMBER, bindingId: 'bind-cleanup' }
        ]
      }
    ]
    await render()

    const bot = botRow('acct-1')
    expect(() => buttonIn(projectRow(bot, 'bind-1'), 'Take over')).toThrow()
    // Degraded, but its own account is still connected and can repair it.
    expect(() => buttonIn(projectRow(bot, 'bind-degraded'), 'Take over')).toThrow()
    // A removal waiting for authority is the one state that always needs one.
    expect(buttonIn(projectRow(bot, 'bind-cleanup'), 'Take over')).toBeTruthy()
  })

  it('offers Take over once the account administering a project is no longer connected', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()
    expect(buttonIn(projectRow(botRow('acct-1'), 'bind-1'), 'Take over')).toBeTruthy()
  })

  it('offers Transfer on a project awaiting cleanup, connected installer and all', async () => {
    // A removal that failed halfway leaves cleanup_pending under a connected account:
    // the takeover is what lets someone else finish it.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([{ ...BINDING, state: 'cleanup_pending' as const }])
    roster = [BOT]
    await render()
    expect(buttonIn(projectRow(botRow('acct-1'), 'bind-1'), 'Take over')).toBeTruthy()
  })

  it('keeps a connect action reachable for a caller who owns none of the connections', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs] })
    await render()
    // Every listed account belongs to someone else, so the caller can still start their own.
    expect(buttonIn(host, 'Connect my account')).toBeTruthy()
  })

  it('drops that action once the caller has an own connected account', async () => {
    const theirs = { ...CONNECTION, id: 'conn-theirs', gitlabUsername: 'someone-else', mine: false }
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [theirs, CONNECTION] })
    await render()
    expect(() => buttonIn(host, 'Connect my account')).toThrow()
    expect(() => buttonIn(host, 'Connect GitLab')).toThrow()
  })

  it('points a takeover refused for want of an own account at that action', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, mine: false, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.transferProject.mockRejectedValue(new ApiError('no own connection', 409, 'GITLAB_NO_OWN_CONNECTION'))
    await render()

    await click('Take over', projectRow(botRow('acct-1'), 'bind-1'))
    await click('Take over', modal())
    // The refusal names the affordance, and that affordance is on screen.
    expect(host.textContent).toContain('Connect my account')
    expect(buttonIn(host, 'Connect my account')).toBeTruthy()
  })

  it('says why a takeover was refused, in GitLab terms', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'disconnected' as const, assignedProjects: 1 }]
    })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.transferProject.mockRejectedValue(new ApiError('gitlab: nope', 403, 'GITLAB_NOT_MAINTAINER'))
    await render()

    await click('Take over', projectRow(botRow('acct-1'), 'bind-1'))
    await click('Take over', modal())
    expect(host.textContent).toContain('Maintainer or Owner access')
    // The refusal is readable: the dialog is gone and no machine code is shown.
    expect(host.querySelector('.modal')).toBeNull()
    expect(host.textContent).not.toContain('GITLAB_NOT_MAINTAINER')
  })

  it('repairs and removes the project it was invoked on', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    mocks.repairProject.mockResolvedValue({ ...BINDING, state: 'provisioning' as const })
    mocks.deleteProject.mockResolvedValue({ removed: true })
    await render()

    await click('Repair')
    expect(mocks.repairProject).toHaveBeenCalledWith('bind-1')

    // Removal is confirmed, never fired by the row button itself.
    await click('Remove')
    expect(mocks.deleteProject).not.toHaveBeenCalled()
    await click('Remove', modal())
    expect(mocks.deleteProject).toHaveBeenCalledWith('bind-1')
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(0)
  })

  it('lists every retained connection, stale ones included', async () => {
    // The repository orders by createdAt ASC and retains stale rows, so the first is often unusable.
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

  it('manages bindings but never picks a project: no add-project surface', async () => {
    // Authorization lives at the point of use; the card is the health list, like GitHub's.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchProjects.mockResolvedValue([BINDING])
    roster = [BOT]
    await render()

    expect(() => buttonIn(host, 'Add project')).toThrow()
    expect(host.querySelector('input[aria-label="Search GitLab projects"]')).toBeNull()
    // The health list itself is untouched: the project, its state, and its repairs.
    expect(host.querySelectorAll('[data-gitlab-project]')).toHaveLength(1)
    expect(buttonIn(host, 'Repair')).toBeTruthy()
  })

  it('says where projects come from when a connection has none', async () => {
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
        id: 'bind-rotation',
        projectPath: 'example-group/rotating',
        state: 'admin_degraded' as const,
        stateReason: 'rotation_gitlab_503'
      },
      {
        ...BINDING,
        id: 'bind-fence',
        projectPath: 'example-group/interrupted',
        state: 'admin_degraded' as const,
        stateReason: 'claim_fence_lost'
      },
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
    expect(host.textContent).toContain('The project bot credential needs repair')
    // The lease fence also trips on same-org cleanup or a competing repair, so the copy stays neutral.
    expect(host.textContent).toContain('Setup was interrupted')
    expect(host.textContent).not.toContain('Another organization')
    // An unmapped category leaves the state badge alone and says nothing else.
    expect(host.textContent).not.toContain('some_future_category')
    expect(host.textContent).not.toContain('rotation_gitlab_503')
    expect(host.textContent).not.toContain('project_not_accessible')
    expect(host.textContent).toContain('bot access degraded')
  })
})

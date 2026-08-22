// @vitest-environment happy-dom
/**
 * The agent detail page's own GitLab identity card (gitlab-com-integration.md
 * §18.1): the bot account the agent acts as, one per top-level group, with the
 * profile link and the account's own health.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitlabAgentAccountDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ fetchAccounts: vi.fn() }))

// One stable org object: a fresh literal per render would re-key the fetch forever.
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-gitlab' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGitlabAgentAccounts: mocks.fetchAccounts
}))
// The mock records the key and options so the freshness contract is assertable.
vi.mock('swr', () => ({
  default: (key: unknown, fetcher: ((k: unknown) => Promise<unknown>) | null, options: SwrOptions) => {
    lastCall = { key, options }
    if (!key || !fetcher) return { data: undefined }
    return { data: swrData }
  }
}))

interface SwrOptions {
  refreshInterval?: (latest: unknown) => number
}

const AgentGitlabIdentity = (await import('./AgentGitlabIdentity')).AgentGitlabIdentity

const ACCOUNT: GitlabAgentAccountDto = {
  id: 'acct-1',
  rootGroupId: '900',
  rootGroupPath: 'example-group',
  username: 'agentconnect-a1-g900',
  displayName: 'reviewer',
  userId: '9042',
  state: 'ready',
  stateReason: null,
  lifecycle: 'active'
}

type Read = { enabled: boolean; accounts: GitlabAgentAccountDto[] } | undefined

/** The same agent's account in a SECOND top-level group — accounts cannot cross that boundary. */
const OTHER_GROUP_ACCOUNT: GitlabAgentAccountDto = {
  ...ACCOUNT,
  id: 'acct-2',
  rootGroupId: '901',
  rootGroupPath: 'other-group',
  username: 'agentconnect-a1-g901'
}

let swrData: Read
let lastCall: { key: unknown; options: SwrOptions } | undefined
let host: HTMLDivElement
let root: Root

// No default argument: "SWR has no data yet" IS one of the cases, and a default would swallow it.
async function render(data: Read, consumers: readonly string[] = ['example-group/example-project']): Promise<void> {
  swrData = data
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AgentGitlabIdentity agentId="agent-1" consumerProjectPaths={consumers} />)
  })
}

/** What SWR would wait before asking again — 0 means the card has stopped polling. */
function pollInterval(): number {
  return lastCall!.options.refreshInterval!(swrData)
}

function chips(): HTMLElement[] {
  return [...host.querySelectorAll('[data-gitlab-account]')] as HTMLElement[]
}

beforeEach(() => {
  mocks.fetchAccounts.mockReset()
  lastCall = undefined
  document.body.innerHTML = ''
})

describe('AgentGitlabIdentity', () => {
  it('shows the account username, display name, health, and profile link for one group', async () => {
    await render({ enabled: true, accounts: [ACCOUNT] })

    expect(chips()).toHaveLength(1)
    expect(host.textContent).toContain('GitLab identity')
    expect(host.textContent).toContain('bot @agentconnect-a1-g900')
    expect(host.textContent).toContain('Shown on GitLab as reviewer')
    expect(host.textContent).toContain('ready')
    const link = host.querySelector('[data-gitlab-account] a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://gitlab.com/agentconnect-a1-g900')
    // A new tab, and never one that can reach back into the console.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    // A single group needs no heading — the grouping only earns one when it disambiguates.
    expect(host.querySelectorAll('[data-gitlab-group]')).toHaveLength(1)
    expect(host.textContent).not.toContain('example-group')
  })

  it('renders nothing when the agent has no account, and nothing when GitLab is not configured', async () => {
    await render({ enabled: true, accounts: [] })
    expect(host.textContent).toBe('')

    await render({ enabled: false, accounts: [] })
    expect(host.textContent).toBe('')

    await render(undefined)
    expect(host.textContent).toBe('')
  })

  it('groups by top-level group, labelled by path, when the agent spans several', async () => {
    await render({
      enabled: true,
      accounts: [
        ACCOUNT,
        {
          ...ACCOUNT,
          id: 'acct-2',
          rootGroupId: '901',
          rootGroupPath: 'other-group',
          username: 'agentconnect-a1-g901'
        },
        // No bound project has reported a path yet: the numeric group still labels its own bucket.
        {
          ...ACCOUNT,
          id: 'acct-3',
          rootGroupId: '902',
          rootGroupPath: null,
          username: 'agentconnect-a1-g902'
        }
      ]
    })

    const groups = [...host.querySelectorAll('[data-gitlab-group]')]
    expect(groups.map((g) => g.getAttribute('data-gitlab-group'))).toEqual(['900', '901', '902'])
    expect(host.textContent).toContain('example-group')
    expect(host.textContent).toContain('other-group')
    expect(host.textContent).toContain('group 902')
    expect(chips()).toHaveLength(3)
  })

  it('translates a refused account: the group is out of bot accounts', async () => {
    await render({
      enabled: true,
      accounts: [
        { ...ACCOUNT, userId: null, state: 'admin_degraded', stateReason: 'service_account_quota', displayName: null }
      ]
    })

    expect(host.textContent).toContain('setup incomplete')
    expect(host.textContent).toContain('limit of bot accounts')
    // The account does not exist on GitLab yet, so its deterministic name links nowhere.
    expect(host.querySelector('[data-gitlab-account] a')).toBeNull()
    expect(host.textContent).toContain('bot @agentconnect-a1-g900')
  })

  it('marks an account whose last project went away as being removed', async () => {
    await render({ enabled: true, accounts: [{ ...ACCOUNT, lifecycle: 'retiring' }] })
    expect(host.textContent).toContain('removing')
  })

  it('hides an unmapped machine reason but keeps the state badge', async () => {
    await render({
      enabled: true,
      accounts: [{ ...ACCOUNT, state: 'runtime_degraded', stateReason: 'some_internal_category' }]
    })

    expect(host.textContent).toContain('bot access degraded')
    expect(host.textContent).not.toContain('some_internal_category')
  })
  it('keys the read by the consumer set, so binding a project cannot read the pre-bind entry', async () => {
    await render({ enabled: true, accounts: [] }, [])
    const beforeBind = JSON.stringify(lastCall!.key)

    await render({ enabled: true, accounts: [] }, ['example-group/example-project'])
    const afterBind = JSON.stringify(lastCall!.key)

    // The CP creates the account behind hook CRUD, so the old entry must be unreachable.
    expect(afterBind).not.toBe(beforeBind)
    expect(afterBind).toContain('agent-1')

    // Swapping one project for another in a different group is also a change, at equal count.
    await render({ enabled: true, accounts: [] }, ['other-group/example-project'])
    expect(JSON.stringify(lastCall!.key)).not.toBe(afterBind)
  })

  it('polls while convergence is still in flight and rests once it has landed', async () => {
    // A consumer exists but its account does not yet — the saga runs after hook CRUD returned.
    await render({ enabled: true, accounts: [] })
    expect(pollInterval()).toBeGreaterThan(0)

    // Still provisioning is equally in flight.
    await render({ enabled: true, accounts: [{ ...ACCOUNT, state: 'provisioning' }] })
    expect(pollInterval()).toBeGreaterThan(0)

    // The last consumer went away but the identity is still listed: retirement in flight.
    await render({ enabled: true, accounts: [ACCOUNT] }, [])
    expect(pollInterval()).toBeGreaterThan(0)

    // Agreed: an account for the group that has one, and nothing transient left.
    await render({ enabled: true, accounts: [ACCOUNT] })
    expect(pollInterval()).toBe(0)

    // No consumer and no account is equally settled — the common agent must not poll at all.
    await render({ enabled: true, accounts: [] }, [])
    expect(pollInterval()).toBe(0)
  })

  it('counts top-level groups, not consumers: two projects in one group settle at one account', async () => {
    // A second project under the SAME group shares the one account — already settled.
    await render({ enabled: true, accounts: [ACCOUNT] }, [
      'example-group/example-project',
      'example-group/another-project'
    ])
    expect(pollInterval()).toBe(0)
  })

  it('keeps polling until the SECOND group’s account arrives', async () => {
    const consumers = ['example-group/example-project', 'other-group/example-project']
    // One of two groups has landed: stopping here would hide the second identity until a reload.
    await render({ enabled: true, accounts: [ACCOUNT] }, consumers)
    expect(pollInterval()).toBeGreaterThan(0)

    await render({ enabled: true, accounts: [ACCOUNT, OTHER_GROUP_ACCOUNT] }, consumers)
    expect(pollInterval()).toBe(0)
  })

  it('keeps polling while ONE of several accounts is still retiring', async () => {
    // Dropping to one group: the surviving account alone is the settled shape.
    await render({
      enabled: true,
      accounts: [ACCOUNT, OTHER_GROUP_ACCOUNT]
    })
    expect(pollInterval()).toBeGreaterThan(0)

    await render({ enabled: true, accounts: [ACCOUNT] })
    expect(pollInterval()).toBe(0)
  })

  it('keeps polling a retarget to another group, which leaves the COUNT unchanged', async () => {
    const retargeted = ['other-group/example-project']
    // The CP commits the new consumer and returns before convergence runs, so the first read can
    // still be the old group's account: one expected group, one account, and nothing transient.
    await render({ enabled: true, accounts: [ACCOUNT] }, retargeted)
    expect(pollInterval()).toBeGreaterThan(0)

    await render({ enabled: true, accounts: [{ ...OTHER_GROUP_ACCOUNT, id: ACCOUNT.id }] }, retargeted)
    expect(pollInterval()).toBe(0)
  })

  it('keeps polling a refused account, which cannot yet name the group it serves', async () => {
    // Creation was refused, so no project is bound and the group is unknown — asking again is what
    // heals the card once someone frees up the group's bot accounts.
    await render({
      enabled: true,
      accounts: [
        {
          ...ACCOUNT,
          userId: null,
          rootGroupPath: null,
          state: 'admin_degraded',
          stateReason: 'service_account_quota'
        }
      ]
    })
    expect(pollInterval()).toBeGreaterThan(0)
    expect(host.textContent).toContain('limit of bot accounts')
  })
})

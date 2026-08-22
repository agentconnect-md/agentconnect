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
// SWR resolves through the mocked fetcher directly — the card has no revalidation behaviour to test.
vi.mock('swr', () => ({
  default: (key: unknown, fetcher: ((k: unknown) => Promise<unknown>) | null) => {
    if (!key || !fetcher) return { data: undefined }
    return { data: swrData }
  }
}))

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

let swrData: { enabled: boolean; accounts: GitlabAgentAccountDto[] } | undefined
let host: HTMLDivElement
let root: Root

// No default argument: "SWR has no data yet" IS one of the cases, and a default would swallow it.
async function render(data: { enabled: boolean; accounts: GitlabAgentAccountDto[] } | undefined): Promise<void> {
  swrData = data
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AgentGitlabIdentity agentId="agent-1" />)
  })
}

function chips(): HTMLElement[] {
  return [...host.querySelectorAll('[data-gitlab-account]')] as HTMLElement[]
}

beforeEach(() => {
  mocks.fetchAccounts.mockReset()
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
})

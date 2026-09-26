// @vitest-environment happy-dom
// Installation grants in Edit workspace: rows beside the repositories, an owner-only authorize flow, access toggle and revoke.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstallationAuthDto, GithubInstallationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const role = vi.hoisted(() => ({ value: 'owner' as string }))
const mocks = vi.hoisted(() => ({
  createAgentInstallation: vi.fn(),
  deleteAgentInstallation: vi.fn(),
  updateAgentInstallation: vi.fn()
}))

const installation = (over: Partial<GithubInstallationDto>): GithubInstallationDto => ({
  id: 'inst-row',
  installationId: 12345,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current',
  pullRequestsPermission: 'write',
  checksPermission: 'write',
  settingsUrl: 'https://github.example.test/settings/installations/12345',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

const installations = vi.hoisted(() => ({ rows: [] as GithubInstallationDto[] }))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path, myRole: role.value }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: installations.rows })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  createAgentInstallation: mocks.createAgentInstallation,
  deleteAgentInstallation: mocks.deleteAgentInstallation,
  updateAgentInstallation: mocks.updateAgentInstallation
}))

import EditWorkspaceModal from './EditWorkspaceModal'
import { fetchGithubRepoRoster } from '@/lib/api'
import { grantableInstallations } from './AddAgentRepoModal'

const agent = { id: 'agent-a', name: 'build-agent', canEdit: true, workspace: { mode: 'scratch' } } as unknown as Agent

const grant = (over: Partial<AgentInstallationAuthDto> = {}): AgentInstallationAuthDto => ({
  id: 'grant-1',
  provider: 'github',
  installationId: 12345,
  accountLogin: 'acme',
  access: 'read',
  materialize: 'on-demand',
  createdBy: 'user-1',
  createdAt: '2026-09-02T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  // By decision is behind its console flag.
  window.__AC_ENV = { FEATURE_FLAGS: 'repository-decision' }
  role.value = 'owner'
  installations.rows = [
    installation({ id: 'inst-acme', installationId: 12345, accountLogin: 'acme' }),
    installation({
      id: 'inst-example',
      installationId: 23456,
      accountLogin: 'example-org',
      repositorySelection: 'selected'
    }),
    installation({ id: 'inst-paused', installationId: 34567, accountLogin: 'paused-org', suspended: true })
  ]
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  for (const mock of Object.values(mocks)) mock.mockReset()
  window.__AC_ENV = {}
})

async function render(grants: AgentInstallationAuthDto[], onInstallationGrantsChange = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <EditWorkspaceModal
        agent={agent}
        authorized={[]}
        installationGrants={grants}
        onInstallationGrantsChange={onInstallationGrantsChange}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )
  })
  return onInstallationGrantsChange
}

const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text))
const grantRow = (id: number) => document.querySelector<HTMLDivElement>(`[data-installation-grant="${id}"]`)
const revoke = () => document.querySelector<HTMLButtonElement>('button[aria-label="Revoke installation access"]')
const segment = (id: number, title: 'Read only' | 'Read & write') =>
  grantRow(id)?.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`) ?? null

// Installations are authorized from Authorize repository's GitHub picker, as "All of <account>".
const openPicker = async () => {
  await act(async () =>
    Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Authorize repository'))
      ?.click()
  )
  await act(async () =>
    Array.from(document.querySelectorAll<HTMLElement>('.inp'))
      .find((el) => el.textContent?.includes('Pick a repository'))
      ?.click()
  )
}
const exactButton = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)

describe('EditWorkspaceModal installation grants', () => {
  it('lists a grant as every repository of its account with its tier and checkout', async () => {
    await render([grant({ access: 'write' })])

    const row = grantRow(12345)
    expect(row?.textContent).toContain('All of acme')
    expect(segment(12345, 'Read & write')?.getAttribute('aria-pressed')).toBe('true')
    expect(segment(12345, 'Read only')?.getAttribute('aria-pressed')).toBe('false')
    expect(row?.textContent).toContain('On demand')
    expect(revoke()?.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('No additional repositories authorized.')
  })

  it('leaves the rows visible but installations unpickable and revoke disabled for an editor who is not an owner', async () => {
    role.value = 'admin'
    await render([grant()])

    expect(button('Authorize an installation')).toBeUndefined()
    expect(grantRow(12345)).not.toBeNull()
    expect(revoke()?.disabled).toBe(true)
    expect(segment(12345, 'Read & write')?.disabled).toBe(true)
    expect(segment(12345, 'Read & write')?.closest('[role="group"]')?.parentElement?.title).toBe(
      'Only organization owners can authorize or revoke an installation'
    )

    await openPicker()
    const offered = document.querySelector<HTMLButtonElement>('[data-installation="23456"]')
    expect(offered?.getAttribute('aria-disabled')).toBe('true')
    expect(offered?.title).toBe('Only organization owners can authorize or revoke an installation')
    await act(async () => offered?.click())
    expect(document.body.textContent).not.toContain('Push, open PRs & run GitHub Actions in every repository')
    expect(document.querySelector('[data-installation="23456"]')).not.toBeNull()
  })

  it('raises a grant’s access with an access-only PATCH, then offers no lowering', async () => {
    mocks.updateAgentInstallation.mockResolvedValueOnce(grant({ access: 'write' }))
    const onChange = await render([grant()])

    await act(async () => segment(12345, 'Read & write')?.click())
    expect(mocks.updateAgentInstallation).toHaveBeenCalledWith('agent-a', 'grant-1', { access: 'write' })
    expect(onChange).toHaveBeenCalledWith([grant({ access: 'write' })])
    expect(segment(12345, 'Read & write')?.getAttribute('aria-pressed')).toBe('true')

    expect(segment(12345, 'Read only')?.disabled).toBe(true)
    await act(async () => segment(12345, 'Read only')?.click())
    expect(mocks.updateAgentInstallation).toHaveBeenCalledOnce()
  })

  it('offers only live installations the agent does not hold and posts the picked one at the chosen tier', async () => {
    const created = grant({ id: 'grant-2', installationId: 23456, accountLogin: 'example-org', access: 'write' })
    mocks.createAgentInstallation.mockResolvedValue(created)
    const onChange = await render([grant()])

    expect(button('Authorize an installation')).toBeUndefined()
    await openPicker()
    const offered = Array.from(document.querySelectorAll('[data-installation]')).map((el) =>
      el.getAttribute('data-installation')
    )
    // acme is already granted and paused-org is suspended, so example-org is the one offered.
    expect(offered).toEqual(['23456'])
    expect(document.body.textContent).toContain('Selected repositories')

    await act(async () => document.querySelector<HTMLButtonElement>('[data-installation="23456"]')?.click())
    expect(document.body.textContent).toContain('All of example-org')
    // A whole installation checks out By decision or On demand, never Always.
    const checkout = document.querySelector('[role="group"][aria-label="Checkout"]')
    expect(Array.from(checkout?.querySelectorAll('button') ?? []).map((b) => b.textContent)).toEqual([
      'By decision',
      'On demand'
    ])
    expect(document.body.textContent).toContain('Push, open PRs & run GitHub Actions in every repository')
    await act(async () =>
      Array.from(document.querySelectorAll<HTMLElement>('div'))
        .find((el) => el.textContent === 'Read & write')
        ?.click()
    )
    await act(async () => exactButton('Add')?.click())

    expect(mocks.createAgentInstallation).toHaveBeenCalledWith('agent-a', {
      installationId: 23456,
      access: 'write',
      materialize: 'on-demand'
    })
    expect(onChange).toHaveBeenCalledWith([grant(), created])
    expect(grantRow(23456)?.textContent).toContain('All of example-org')
  })

  it('opens straight at a preselected installation for an installation-wide trigger', async () => {
    const created = grant({ id: 'grant-2', installationId: 23456, accountLogin: 'example-org', access: 'write' })
    mocks.createAgentInstallation.mockResolvedValue(created)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const onChange = vi.fn()
    await act(async () => {
      root?.render(
        <EditWorkspaceModal
          agent={agent}
          authorized={[]}
          installationGrants={[]}
          initialRepositoryAuthorization={{ installationId: 23456, access: 'write' }}
          onInstallationGrantsChange={onChange}
          onClose={() => undefined}
          onChanged={() => undefined}
        />
      )
    })

    expect(document.body.textContent).toContain('All of example-org')
    await act(async () => exactButton('Add')?.click())

    expect(mocks.createAgentInstallation).toHaveBeenCalledWith('agent-a', {
      installationId: 23456,
      access: 'write',
      materialize: 'on-demand'
    })
    expect(onChange).toHaveBeenCalledWith([created])
  })

  it('groups the picker by account, in installation order: the installation first, then its repositories', async () => {
    const repo = (fullName: string, installationId: string) => ({
      fullName,
      private: false,
      defaultBranch: 'main',
      description: null,
      updatedAt: null,
      installationId
    })
    // Edit workspace's own repository field reads the roster too, so every read answers with these two.
    vi.mocked(fetchGithubRepoRoster).mockResolvedValue({
      repos: [repo('example-org/tools', 'inst-example'), repo('acme/api', 'inst-acme')],
      privateReposHidden: false,
      failed: false
    })
    await render([grant()])
    await openPicker()

    const groups = Array.from(document.querySelectorAll('[data-picker-group]')).map((group) => [
      group.getAttribute('data-picker-group'),
      Array.from(group.querySelectorAll('button')).map(
        (option) => option.getAttribute('data-installation') ?? option.querySelector('[title]')?.getAttribute('title')
      )
    ])
    // acme is already granted, so its group lists only its repository.
    expect(groups).toEqual([
      ['acme', ['acme/api']],
      ['example-org', ['23456', 'example-org/tools']]
    ])
    vi.mocked(fetchGithubRepoRoster).mockResolvedValue({ repos: [], privateReposHidden: false, failed: false })
  })

  it('shows the server refusal and stays on the step', async () => {
    mocks.createAgentInstallation.mockRejectedValue(new Error('only an organization owner may do this'))
    await render([])

    await openPicker()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-installation="12345"]')?.click())
    await act(async () => exactButton('Add')?.click())

    expect(document.body.textContent).toContain('only an organization owner may do this')
    expect(document.body.textContent).toContain('All of acme')
  })

  it('revokes a grant and drops its row', async () => {
    mocks.deleteAgentInstallation.mockResolvedValue(undefined)
    const onChange = await render([grant()])

    await act(async () => revoke()?.click())

    expect(mocks.deleteAgentInstallation).toHaveBeenCalledWith('agent-a', 'grant-1')
    expect(onChange).toHaveBeenCalledWith([])
    expect(grantRow(12345)).toBeNull()
    expect(document.body.textContent).toContain('No additional repositories authorized.')
  })
})

describe('grantableInstallations', () => {
  it('drops suspended installations and ones the agent already holds', () => {
    const rows = [
      installation({ installationId: 1, accountLogin: 'held' }),
      installation({ installationId: 2, accountLogin: 'free' }),
      installation({ installationId: 3, accountLogin: 'paused', suspended: true })
    ]
    expect(grantableInstallations(rows, [grant({ installationId: 1 })]).map((row) => row.accountLogin)).toEqual([
      'free'
    ])
  })
})

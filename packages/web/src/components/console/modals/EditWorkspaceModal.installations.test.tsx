// @vitest-environment happy-dom
// Installation grants in Edit workspace: rows beside the repositories, an owner-only authorize flow and revoke.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstallationAuthDto, GithubInstallationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const role = vi.hoisted(() => ({ value: 'owner' as string }))
const mocks = vi.hoisted(() => ({ createAgentInstallation: vi.fn(), deleteAgentInstallation: vi.fn() }))

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
  deleteAgentInstallation: mocks.deleteAgentInstallation
}))

import EditWorkspaceModal from './EditWorkspaceModal'
import { grantableInstallations } from './AuthorizeInstallationModal'

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
  mocks.createAgentInstallation.mockReset()
  mocks.deleteAgentInstallation.mockReset()
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

describe('EditWorkspaceModal installation grants', () => {
  it('lists a grant as every repository of its account with its tier and checkout', async () => {
    await render([grant({ access: 'write' })])

    const row = grantRow(12345)
    expect(row?.textContent).toContain('All repositories in acme')
    expect(row?.textContent).toContain('write')
    expect(row?.textContent).toContain('On demand')
    expect(revoke()?.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('No additional repositories authorized.')
  })

  it('leaves the rows visible but the entry and revoke disabled for an editor who is not an owner', async () => {
    role.value = 'admin'
    await render([grant()])

    const entry = button('Authorize an installation')
    expect(entry?.disabled).toBe(true)
    expect(entry?.parentElement?.getAttribute('title')).toBe(
      'Only organization owners can authorize or revoke an installation'
    )
    expect(grantRow(12345)).not.toBeNull()
    expect(revoke()?.disabled).toBe(true)
  })

  it('offers only live installations the agent does not hold and posts the picked one at the chosen tier', async () => {
    const created = grant({ id: 'grant-2', installationId: 23456, accountLogin: 'example-org', access: 'write' })
    mocks.createAgentInstallation.mockResolvedValue(created)
    const onChange = await render([grant()])

    await act(async () => button('Authorize an installation')?.click())
    const offered = Array.from(document.querySelectorAll('[data-installation]')).map((el) =>
      el.getAttribute('data-installation')
    )
    // acme is already granted and paused-org is suspended; the one left is preselected.
    expect(offered).toEqual(['23456'])
    expect(document.body.textContent).toContain('Selected repositories')
    expect(document.querySelector('[data-access="read"]')?.className).toContain('border-(--brand)')

    await act(async () => document.querySelector<HTMLButtonElement>('[data-access="write"]')?.click())
    await act(async () => button('Authorize')?.click())

    expect(mocks.createAgentInstallation).toHaveBeenCalledWith('agent-a', {
      installationId: 23456,
      access: 'write',
      materialize: 'on-demand'
    })
    expect(onChange).toHaveBeenCalledWith([grant(), created])
    expect(grantRow(23456)?.textContent).toContain('All repositories in example-org')
  })

  it('shows the server refusal and stays on the step', async () => {
    mocks.createAgentInstallation.mockRejectedValue(new Error('only an organization owner may do this'))
    await render([])

    await act(async () => button('Authorize an installation')?.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-installation="12345"]')?.click())
    await act(async () => button('Authorize')?.click())

    expect(document.body.textContent).toContain('only an organization owner may do this')
    expect(document.querySelector('[data-installation="12345"]')).not.toBeNull()
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

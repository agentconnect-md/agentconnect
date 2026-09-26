// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRepoAuthDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const repositoryModal = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
const mocks = vi.hoisted(() => ({ updateAgentRepo: vi.fn() }))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  updateAgentRepo: mocks.updateAgentRepo
}))
vi.mock('@/components/console/modals/AddAgentRepoModal', () => ({
  default: (props: Record<string, unknown>) => {
    repositoryModal.props = props
    return <div>repository authorization step</div>
  }
}))

import EditWorkspaceModal from './EditWorkspaceModal'
import type { Agent } from '@/lib/data'

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  canEdit: true,
  workspace: { mode: 'scratch' }
} as unknown as Agent

describe('EditWorkspaceModal repository access', () => {
  it('manages additional repositories in the main workspace editor', () => {
    const html = renderToStaticMarkup(
      <EditWorkspaceModal
        agent={agent}
        authorized={[
          {
            id: 'repo-auth-1',
            repoFullName: 'acme/shared-tools',
            access: 'write',
            createdBy: 'user-1',
            createdAt: '2026-08-06T00:00:00.000Z'
          }
        ]}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    expect(html).toContain('Additional repositories')
    expect(html).toContain('Authorize repository')
    expect(html).toContain('acme/shared-tools')
    expect(html).toContain('Revoke repository access')
  })

  it('opens contextual shortcuts at the workspace authorization step', () => {
    const html = renderToStaticMarkup(
      <EditWorkspaceModal
        agent={agent}
        authorized={[]}
        initialRepositoryAuthorization={{ repo: 'acme/service', access: 'write' }}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )

    expect(html).toContain('repository authorization step')
    expect(repositoryModal.props).toMatchObject({
      initialRepo: 'acme/service',
      initialAccess: 'write',
      workspaceContext: true
    })
  })
})

const row = (over: Partial<AgentRepoAuthDto> = {}): AgentRepoAuthDto => ({
  id: 'repo-auth-1',
  repoFullName: 'example-org/example-repo',
  access: 'read',
  materialize: 'always',
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  // By decision is behind its console flag.
  window.__AC_ENV = { FEATURE_FLAGS: 'repository-decision' }
})

afterEach(async () => {
  window.__AC_ENV = {}
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.updateAgentRepo.mockReset()
})

async function render(authorized: AgentRepoAuthDto[], onAuthorizedChange = vi.fn()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <EditWorkspaceModal
        agent={agent}
        authorized={authorized}
        onAuthorizedChange={onAuthorizedChange}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )
  })
  return onAuthorizedChange
}

const checkoutOf = (name = 'example-org/example-repo') =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="Checkout for ${name}"]`)
const choice = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
    (item) => item.textContent === label
  )
const pick = async (label: string) => {
  await act(async () => checkoutOf()?.click())
  await act(async () => choice(label)?.click())
}

const accessOf = (title: 'Read only' | 'Read & write', name = 'example-org/example-repo') =>
  document.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="Access for ${name}"] button[aria-label="${title}"]`
  )

describe('EditWorkspaceModal repository access toggle', () => {
  it('replaces the static tier badge, pressing neither segment for a legacy comment row', async () => {
    await render([row(), row({ id: 'repo-auth-2', repoFullName: 'example-org/legacy', access: 'comment' })])
    expect(accessOf('Read only')?.getAttribute('aria-pressed')).toBe('true')
    expect(accessOf('Read & write')?.getAttribute('aria-pressed')).toBe('false')
    expect(accessOf('Read only', 'example-org/legacy')?.getAttribute('aria-pressed')).toBe('false')
    expect(accessOf('Read & write', 'example-org/legacy')?.getAttribute('aria-pressed')).toBe('false')
    expect(document.body.innerHTML).not.toContain('>read<')
  })

  it('raises a row’s access with an access-only PATCH, then offers no lowering', async () => {
    mocks.updateAgentRepo.mockResolvedValueOnce(row({ access: 'write' }))
    const onAuthorizedChange = await render([row()])

    await act(async () => accessOf('Read & write')?.click())
    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'repo-auth-1', { access: 'write' })
    expect(onAuthorizedChange).toHaveBeenLastCalledWith([row({ access: 'write' })])
    expect(accessOf('Read & write')?.getAttribute('aria-pressed')).toBe('true')

    expect(accessOf('Read only')?.disabled).toBe(true)
    expect(accessOf('Read only')?.title).toBe('Revoke and authorize again to lower access')
    await act(async () => accessOf('Read only')?.click())
    expect(mocks.updateAgentRepo).toHaveBeenCalledOnce()
  })

  it('names a refused change in the section’s error line and keeps the tier', async () => {
    mocks.updateAgentRepo.mockRejectedValue(new Error('you need write permission on example-org/example-repo'))
    await render([row()])
    await act(async () => accessOf('Read & write')?.click())

    expect(document.body.textContent).toContain('you need write permission on example-org/example-repo')
    expect(accessOf('Read only')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('EditWorkspaceModal repository checkout', () => {
  it('shows each row’s checkout, an older CP’s row as Always', async () => {
    await render([
      row({ materialize: undefined }),
      row({ id: 'repo-auth-2', repoFullName: 'example-org/second', materialize: 'on-demand' })
    ])
    expect(checkoutOf()?.textContent).toBe('Always')
    expect(checkoutOf('example-org/second')?.textContent).toBe('On demand')
    expect(document.querySelector('[role="group"][aria-label="Checkout"]')).toBeNull()
    // No provider is ready where the agent runs, so By decision is offered but cannot be chosen.
    await act(async () => checkoutOf()?.click())
    expect(choice('By decision')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => choice('By decision')?.click())
    expect(mocks.updateAgentRepo).not.toHaveBeenCalled()
    expect(document.querySelector('[data-repository-selector]')).toBeNull()
  })

  it('switches a row to On demand with a materialize-only PATCH', async () => {
    mocks.updateAgentRepo.mockResolvedValue(row({ materialize: 'on-demand' }))
    const onAuthorizedChange = await render([row()])
    await pick('On demand')

    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'repo-auth-1', { materialize: 'on-demand' })
    expect(onAuthorizedChange).toHaveBeenCalledWith([row({ materialize: 'on-demand' })])
    expect(checkoutOf()?.textContent).toBe('On demand')
    expect(choice('On demand')).toBeUndefined()
  })

  it('keeps the row and names the failure when the switch is refused', async () => {
    mocks.updateAgentRepo.mockRejectedValue(new Error('authorization not found'))
    await render([row()])
    await pick('On demand')

    expect(document.body.textContent).toContain('authorization not found')
    expect(checkoutOf()?.textContent).toBe('Always')
  })

  it('sends nothing when the current checkout is picked again', async () => {
    await render([row()])
    await pick('Always')
    expect(mocks.updateAgentRepo).not.toHaveBeenCalled()
  })
})

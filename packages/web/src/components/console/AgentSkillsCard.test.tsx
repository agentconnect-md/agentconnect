// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  // The org registry the caller can see.
  skillSources: [
    { id: 's1', name: 'example-ai-kit', source: 'github.com/acme/ai-kit', subDir: null, skills: [], visibility: 'org' },
    {
      id: 's2',
      name: 'internal-runbooks',
      source: 'github.com/acme/runbooks',
      subDir: null,
      skills: [],
      visibility: 'org'
    },
    {
      id: 's3',
      name: 'ops-kit',
      source: 'https://git.example.test/ops/kit',
      subDir: null,
      skills: [],
      visibility: 'org',
      credential: null
    },
    {
      id: 's4',
      name: 'team-kit',
      source: 'https://gitlab.example.test/team/kit',
      subDir: null,
      skills: [],
      visibility: 'org',
      credential: { provider: 'gitlab', repoId: '42' }
    }
  ] as unknown[],
  managed: [
    { id: 'm1', name: 'safe-deploy', currentRevision: 3, fileCount: 2, archivedAt: null, canManage: true }
  ] as unknown[],
  savedSkills: [] as string[],
  savedManaged: [] as string[],
  failures: [] as unknown[],
  manifest: { resolvable: true, skills: [] } as unknown,
  updateAgent: vi.fn(async (_id: string, _patch: unknown) => undefined)
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: mocks.updateAgent,
    skillSources: mocks.skillSources,
    skillSourcesLoading: false,
    createSkillSource: vi.fn(),
    members: []
  })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'o1' } }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'u1' } }) }))
vi.mock('@/lib/api', () => ({
  fetchAgentDto: vi.fn(async () => ({ skills: mocks.savedSkills, managedSkills: mocks.savedManaged })),
  fetchAgentSkillSources: vi.fn(async () => []),
  fetchAgentSkillSourceStatus: vi.fn(async () => ({ sources: mocks.failures })),
  fetchSkillSourceSkills: vi.fn(async () => mocks.manifest),
  listManagedSkills: vi.fn(async () => mocks.managed),
  listManagedSkillRevisions: vi.fn(async () => []),
  setManagedSkillArchived: vi.fn(async () => undefined),
  searchSkillRegistry: vi.fn(async () => ({ reachable: true, skills: [] })),
  fetchConnectorCatalog: vi.fn(async () => ({ providers: [] })),
  memberDisplayName: (m: { id: string }) => m.id,
  fmtDate: (d: unknown) => String(d),
  repoLabel: (r: unknown) => String(r),
  repoWebUrl: () => undefined
}))
vi.mock('@/components/marks', () => ({ GithubMark: () => null, LoadingState: () => null }))

import { AgentSkillsCard } from './AgentSkillsCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement | undefined
let root: Root | undefined

async function render(): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<AgentSkillsCard agentId="a1" canEdit />)
  })
  return host.textContent ?? ''
}

/** Open the header's Add menu — it portals to the body, so what it offers is
 *  never in the card's own subtree. */
async function openAddMenu(): Promise<string> {
  const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Add'))
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger!.click()
  })
  return document.querySelector('[data-anchored-flyout]')?.textContent ?? ''
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.savedSkills = []
  mocks.savedManaged = []
  mocks.failures = []
  mocks.manifest = { resolvable: true, skills: [] }
  mocks.updateAgent.mockClear()
})

describe('AgentSkillsCard', () => {
  it('shows the empty state and offers both libraries when nothing is enabled', async () => {
    expect(await render()).toContain('No skills')
    const menu = await openAddMenu()
    expect(menu).toContain('Managed skills')
    expect(menu).toContain('safe-deploy')
    expect(menu).toContain('Git skill sources')
    expect(menu).toContain('example-ai-kit')
    // The quick-add items that open the library's own dialogs.
    expect(menu).toContain('Search skills.sh')
    expect(menu).toContain('Add custom skill source')
  })

  // The rows ARE the saved refs, so an enabled source leaves the Add menu.
  it('rows the enabled source and drops it from the Add menu', async () => {
    mocks.savedSkills = ['example-ai-kit/*']
    const text = await render()
    expect(text).toContain('example-ai-kit')
    expect(text).toContain('all skills')
    expect(text).not.toContain('internal-runbooks')
    const menu = await openAddMenu()
    expect(menu).toContain('internal-runbooks')
    expect(menu).not.toContain('example-ai-kit')
  })

  it('rows an enabled managed bundle with its pinned revision', async () => {
    mocks.savedManaged = ['m1']
    const text = await render()
    expect(text).toContain('safe-deploy')
    expect(text).toContain('rev 3')
    expect(text).toContain('managed')
    expect(await openAddMenu()).toContain('No further approved managed skills')
  })

  // A partial selection reads as a count, not as the whole source.
  it('badges a picked subset with how many skills are selected', async () => {
    mocks.savedSkills = ['internal-runbooks/safe-deploy']
    const text = await render()
    expect(text).toContain('internal-runbooks')
    expect(text).toContain('1 selected')
  })

  // An anonymous source off GitHub is marked; a credentialed GitLab one is not.
  it('marks an anonymous other-host source as trusted by URL', async () => {
    mocks.savedSkills = ['ops-kit/*', 'team-kit/*']
    await render()
    const rows = [...host!.querySelectorAll('.mono.truncate')].map((el) => el.closest('.flex.items-center'))
    const ops = rows.find((row) => row?.textContent?.includes('ops-kit'))
    const team = rows.find((row) => row?.textContent?.includes('team-kit'))
    expect(ops?.textContent).toContain('trusted by URL')
    expect(team?.textContent).not.toContain('trusted by URL')
  })

  it('shows the latest failure reason beside the source that failed', async () => {
    mocks.savedSkills = ['ops-kit/*', 'example-ai-kit/*']
    mocks.failures = [{ name: 'ops-kit', code: 'fetch_failed', reportedAt: '2026-10-01T00:00:00.000Z' }]
    await render()
    const failure = host!.querySelector('[data-skill-source-failure]')
    expect(failure?.getAttribute('data-skill-source-failure')).toBe('fetch_failed')
    expect(failure?.textContent).toContain('Last install failed')
    expect(failure?.textContent).toContain('Fetching the repository failed')
    expect(failure?.textContent).toContain('fetch_failed')
    expect(host!.querySelectorAll('[data-skill-source-failure]')).toHaveLength(1)
  })

  it('offers a typed skill filter when the source cannot be scanned', async () => {
    mocks.savedSkills = ['ops-kit/*']
    mocks.manifest = { resolvable: false, skills: [] }
    await render()
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('button[aria-label="Choose individual skills"]')!.click()
    })
    const input = host!.querySelector<HTMLInputElement>('input[aria-label="Choose individual skills"]')
    expect(input).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'deploy, rollback')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const apply = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Apply')
    await act(async () => apply!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('a1', { skills: ['ops-kit/deploy', 'ops-kit/rollback'] })
  })

  it('refuses typed names that the source filter would never install', async () => {
    mocks.skillSources = mocks.skillSources.map((src) =>
      (src as { id: string }).id === 's3' ? { ...(src as object), skills: ['deploy'] } : src
    )
    mocks.savedSkills = ['ops-kit/*']
    mocks.manifest = { resolvable: false, skills: [] }
    try {
      await render()
      await act(async () => {
        host!.querySelector<HTMLButtonElement>('button[aria-label="Choose individual skills"]')!.click()
      })
      expect(host!.querySelector('[data-source-filter]')?.textContent).toContain('installs only: deploy')
      const input = host!.querySelector<HTMLInputElement>('input[aria-label="Choose individual skills"]')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'rollback')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const apply = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Apply')
      expect(apply!.disabled).toBe(true)
    } finally {
      mocks.skillSources = mocks.skillSources.map((src) =>
        (src as { id: string }).id === 's3' ? { ...(src as object), skills: [] } : src
      )
    }
  })
})

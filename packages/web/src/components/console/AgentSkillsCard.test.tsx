// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  // The org registry the caller can see.
  skillSources: [
    { id: 's1', name: 'example-ai-kit', source: 'github.com/acme/ai-kit', subDir: null, visibility: 'org' },
    { id: 's2', name: 'internal-runbooks', source: 'github.com/acme/runbooks', subDir: null, visibility: 'org' }
  ] as unknown[],
  managed: [
    { id: 'm1', name: 'safe-deploy', currentRevision: 3, fileCount: 2, archivedAt: null, canManage: true }
  ] as unknown[],
  savedSkills: [] as string[],
  savedManaged: [] as string[]
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: vi.fn(async () => undefined),
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
  fetchSkillSourceSkills: vi.fn(async () => ({ resolvable: true, skills: [] })),
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
})

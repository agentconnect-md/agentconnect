// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import useSWR, { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listManagedSkills, setApiOrgId, type ManagedSkillDto, type SkillSourceDto } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'

const mocks = vi.hoisted(() => ({
  skillSources: [] as SkillSourceDto[],
  createSkillSource: vi.fn(async (_input: unknown) => undefined)
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    skillSources: mocks.skillSources,
    skillSourcesLoading: false,
    members: [],
    createSkillSource: mocks.createSkillSource
  })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-test' } }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))

import { SkillSourcesCard } from './SkillSourcesCard'

function ActiveManagedSkillCount() {
  const key = consoleKeys.managedSkills('org-test', false)
  const { data = [] } = useSWR(key, ([, orgId]) => listManagedSkills(false, orgId))
  return <output data-active-managed-count>{data.length}</output>
}

let host: HTMLDivElement
let root: Root

// `stepMs` > 0 lets a case out-wait a real debounce (the skills.sh search) instead
// of only flushing microtasks.
async function settleUntil(done: () => boolean, stepMs = 0): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, stepMs))
    })
    if (done()) return
  }
  throw new Error('skills library did not settle')
}

async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// `scope` matters once a dialog is open: the card's own header keeps rendering
// behind the scrim, so "Install" is ambiguous unless the lookup is scoped.
function buttonWithText(text: string, scope = ''): HTMLButtonElement {
  const root = scope ? host.querySelector(scope) : host
  const found = [...(root?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`no button labeled "${text}"${scope ? ` under ${scope}` : ''}`)
  return found
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.createSkillSource.mockClear()
  mocks.skillSources = [
    {
      id: 'source-1',
      name: 'platform-skills',
      source: 'acme/platform-skills',
      githubRepoId: null,
      ref: 'main',
      subDir: null,
      skills: [],
      visibility: 'org',
      sharedWith: [],
      createdBy: 'owner-1',
      canEdit: true,
      canManageSharing: true,
      createdAt: '2026-07-30T00:00:00.000Z'
    }
  ]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('organization Skills library', () => {
  it('renders Git sources and accepted managed skills as tiles in one card', async () => {
    const managed: ManagedSkillDto = {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'release-service',
      description: 'Release safely',
      currentRevision: 2,
      digest: `sha256:${'d'.repeat(64)}`,
      compressedBytes: 120,
      expandedBytes: 300,
      fileCount: 2,
      manifest: { files: [{ path: 'SKILL.md', bytes: 100, digest: `sha256:${'e'.repeat(64)}` }] },
      archivedAt: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      canManage: true
    }
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify([managed]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <SkillSourcesCard canWrite={false} canManage={true} />
        </SWRConfig>
      )
    })
    await settleUntil(() => host.textContent?.includes('release-service') === true)

    expect(host.querySelectorAll('.card')).toHaveLength(1)
    expect(host.textContent).toContain('Skills library')
    expect(host.textContent).toContain('Git sources and managed bundles')
    expect(host.textContent).toContain('platform-skills')
    expect(host.textContent).toContain('acme/platform-skills')
    expect(host.textContent).toContain('release-service')
    expect(host.textContent).toContain('managed · rev 2')
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining('/orgs/org-test/managed-skills?includeArchived=false')
    ])
  })

  it('installs a searched skills.sh hit as a one-skill source, and marks what the library already has', async () => {
    // A same-repo source scoped to a subdirectory covers only that directory, so a
    // skill elsewhere in the repo must stay installable.
    mocks.skillSources.push({
      ...mocks.skillSources[0]!,
      id: 'source-2',
      name: 'docs-kit',
      source: 'openai/skills',
      subDir: 'docs',
      skills: []
    })
    const hits = [
      { id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 169905 },
      // Covered by the seeded acme/platform-skills source (install-all), so it must
      // render as "added" rather than as an installable choice.
      { id: 'acme/platform-skills/review-pr', name: 'review-pr', source: 'acme/platform-skills', installs: 12 },
      { id: 'openai/skills/xlsx', name: 'xlsx', source: 'openai/skills', installs: 7 }
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/skill-sources/registry/search') ? { reachable: true, skills: hits } : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <SkillSourcesCard canWrite={true} canManage={true} />
        </SWRConfig>
      )
    })
    await act(async () => buttonWithText('Add').click())
    await act(async () => buttonWithText('Search skills.sh').click())

    await typeInto(host.querySelector<HTMLInputElement>('input.inp')!, 'pdf')
    await settleUntil(() => host.textContent?.includes('169.9K installs') === true, 40)

    const searchUrl = fetchMock.mock.calls.map(([input]) => String(input)).find((u) => u.includes('/registry/search'))
    expect(searchUrl).toContain('/orgs/org-test/skill-sources/registry/search?q=pdf')
    // The already-covered hit is offered as disabled, naming the source that has it.
    const covered = buttonWithText('review-pr', '.modalbody')
    expect(covered.disabled).toBe(true)
    expect(covered.textContent).toContain('already in your library as platform-skills')

    expect(buttonWithText('xlsx', '.modalbody').disabled).toBe(false)

    // Editing the query retires the previous hits for the whole debounce window —
    // a row from a search the input no longer shows must not stay clickable.
    await typeInto(host.querySelector<HTMLInputElement>('input.inp')!, 'xlsx')
    expect(host.querySelector('.modalbody')?.textContent).toContain('Searching…')
    expect(host.querySelector('.modalbody')?.textContent).not.toContain('169.9K installs')
    await typeInto(host.querySelector<HTMLInputElement>('input.inp')!, 'pdf')
    await settleUntil(() => host.textContent?.includes('169.9K installs') === true, 40)

    await act(async () => buttonWithText('anthropics/skills', '.modalbody').click())
    await act(async () => buttonWithText('Install', '.modalfoot').click())

    expect(mocks.createSkillSource).toHaveBeenCalledWith({
      name: 'pdf',
      source: 'anthropics/skills',
      skills: ['pdf']
    })
  })

  it('revalidates the active-only library count when archiving from the include-archived view', async () => {
    const managed: ManagedSkillDto = {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'release-service',
      description: 'Release safely',
      currentRevision: 2,
      digest: `sha256:${'d'.repeat(64)}`,
      compressedBytes: 120,
      expandedBytes: 300,
      fileCount: 2,
      manifest: { files: [{ path: 'SKILL.md', bytes: 100, digest: `sha256:${'e'.repeat(64)}` }] },
      archivedAt: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      canManage: true
    }
    let archived = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        archived = true
        return new Response(JSON.stringify({ ...managed, archivedAt: '2026-08-01T00:00:00.000Z' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      const includeArchived = url.includes('includeArchived=true')
      const rows =
        includeArchived || !archived ? [{ ...managed, archivedAt: archived ? '2026-08-01T00:00:00.000Z' : null }] : []
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ActiveManagedSkillCount />
          <SkillSourcesCard canWrite={false} canManage={true} />
        </SWRConfig>
      )
    })
    await settleUntil(() => host.querySelector('[data-active-managed-count]')?.textContent === '1')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[role="switch"]')!.click()
    })
    await settleUntil(() => fetchMock.mock.calls.some(([input]) => String(input).includes('includeArchived=true')))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[title="Archive"]')!.click()
    })
    await settleUntil(() => host.querySelector('[data-active-managed-count]')?.textContent === '0')

    expect(host.textContent).toContain('managed · archived')
    expect(
      fetchMock.mock.calls.filter(([input, init]) =>
        init?.method === 'POST' ? false : String(input).includes('includeArchived=false')
      ).length
    ).toBeGreaterThanOrEqual(2)
  })
})

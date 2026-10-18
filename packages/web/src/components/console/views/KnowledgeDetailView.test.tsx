// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setApiOrgId,
  setMemberDirectory,
  type OrganizationKnowledgeDto,
  type OrganizationKnowledgeRevisionDto
} from '@/lib/api'

const mocks = vi.hoisted(() => ({
  routeId: '55555555-5555-4555-8555-555555555555',
  role: 'owner' as 'owner' | 'collaborator',
  register: vi.fn()
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: mocks.routeId })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: mocks.role, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: 'agent-1', name: 'dreamer', displayName: '', runtime: 'claude' }],
    integrations: [{ platform: 'slack' }],
    members: []
  })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: null, me: null }) }))
vi.mock('@/components/console/Shell', () => ({ useCrumbSlot: () => ({ register: mocks.register }) }))
vi.mock('next/dynamic', () => ({
  default: () =>
    function MarkdownStub({ content }: { content: string }) {
      return <div data-markdown>{content}</div>
    }
}))

import KnowledgeDetailView from './KnowledgeDetailView'

const ENTRY: OrganizationKnowledgeDto = {
  id: mocks.routeId,
  title: 'Release policy',
  content: '# Current',
  summary: 'Current summary',
  tags: ['release'],
  currentRevision: 2,
  digest: `sha256:${'c'.repeat(64)}`,
  source: 'manual',
  writerKind: null,
  kind: 'entry',
  visibility: 'all',
  readers: [],
  sourceAgentId: null,
  sourceDreamId: null,
  sourceSessionIds: [],
  createdByUserId: 'owner-1',
  reviewedByUserId: null,
  archivedAt: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
  revisionCreatedAt: '2026-07-31T00:00:00.000Z',
  canManage: true
}

function revisionRows(current: number): OrganizationKnowledgeRevisionDto[] {
  return [
    {
      knowledgeId: ENTRY.id,
      revision: current,
      content: current === 2 ? '# Current' : '# Newly published',
      summary: current === 2 ? 'Current summary' : 'New summary',
      tags: ['release'],
      digest: ENTRY.digest,
      source: 'manual',
      writerKind: null,
      sourceAgentId: null,
      sourceDreamId: null,
      sourceSessionIds: [],
      createdByUserId: 'owner-1',
      reviewedByUserId: null,
      createdAt: '2026-07-31T00:00:00.000Z'
    },
    {
      knowledgeId: ENTRY.id,
      revision: 1,
      content: '# Historical policy',
      summary: 'Initial summary',
      tags: ['history'],
      digest: `sha256:${'f'.repeat(64)}`,
      source: 'dream',
      writerKind: null,
      sourceAgentId: 'agent-1',
      sourceDreamId: 'dream-1',
      sourceSessionIds: ['session-1'],
      createdByUserId: null,
      reviewedByUserId: 'owner-1',
      createdAt: '2026-07-30T00:00:00.000Z'
    }
  ]
}

let host: HTMLDivElement
let root: Root

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

// The editor's own footer button — a history row reads "Published by …", so scope the lookup to the dialog.
function dialogButton(label: string): HTMLButtonElement {
  const dialog = host.querySelector('[role="dialog"]')
  const found = dialog && [...dialog.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  if (!found) throw new Error(`dialog button not found: ${label}`)
  return found
}

async function render() {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <KnowledgeDetailView />
      </SWRConfig>
    )
  })
}

async function settleUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (done()) return
  }
  throw new Error('view did not settle')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
  setMemberDirectory([
    { userId: 'owner-1', email: null, name: 'Ada', picture: null, role: 'owner', isCurrentUser: false, joinedAt: '' }
  ])
  mocks.role = 'owner'
  mocks.register.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  setMemberDirectory([])
  vi.unstubAllGlobals()
})

describe('knowledge entry page', () => {
  it('renders the current revision, switches to an older one in place, and follows a revision published here', async () => {
    let currentRevision = 2
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return json(revisionRows(currentRevision))
      if (init?.method === 'PATCH') {
        currentRevision = 3
        return json({ ...ENTRY, currentRevision, content: '# Newly published' })
      }
      return json({ ...ENTRY, currentRevision, content: currentRevision === 2 ? '# Current' : '# Newly published' })
    })
    vi.stubGlobal('fetch', fetchMock)
    await render()
    await settleUntil(() => host.textContent?.includes('# Current') === true)
    await settleUntil(() => host.textContent?.includes('rev 1') === true)

    // The header reads as people, not ids; the mobile push bar gets the title.
    expect(host.textContent).toContain('Published by Ada')
    expect(host.textContent).not.toContain('owner-1')
    expect(host.textContent).not.toContain('sha256')
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ id: ENTRY.id, title: 'Release policy' }))

    await act(async () => button('rev 1').click())
    expect(host.textContent).toContain('# Historical policy')
    expect(host.textContent).toContain('Viewing rev 1.')
    expect(host.textContent).toContain('Proposed by dreamer · reviewed by Ada')
    expect(host.textContent).not.toContain('dream-1')
    // The header's summary, tags, and date follow the revision on screen; the title and rev badge stay the entry's.
    expect(host.textContent).toContain('Initial summary')
    expect(host.textContent).not.toContain('Current summary')
    expect(host.textContent).toContain('history')
    expect(host.textContent).toContain('Jul 30, 2026')
    expect(host.textContent).toContain('Release policy')
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/revisions'))).toHaveLength(1)

    await act(async () => button('Show current').click())
    expect(host.textContent).toContain('# Current')
    expect(host.textContent).toContain('Current summary')
    expect(host.textContent).not.toContain('Initial summary')
    expect(host.textContent).not.toContain('Viewing rev')

    // Publishing from the page: the editor carries the current text, and the new revision takes over.
    await act(async () => button('New revision').click())
    expect(host.textContent).toContain('Publish rev 3')
    await act(async () => dialogButton('Publish').click())
    await settleUntil(() => host.textContent?.includes('# Newly published') === true)
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ title: 'Release policy', expectedRevision: 2 })
    await settleUntil(() => host.textContent?.includes('rev 3') === true)
    expect(host.textContent).not.toContain('Publish rev 3')
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/revisions'))).toHaveLength(2)
  })

  it('archives and restores from the header', async () => {
    let archivedAt: string | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return json(revisionRows(2))
      if (url.endsWith('/archive')) {
        archivedAt = (JSON.parse(String(init?.body)) as { archived: boolean }).archived
          ? '2026-08-01T00:00:00.000Z'
          : null
        return json({ ...ENTRY, archivedAt })
      }
      return json({ ...ENTRY, archivedAt })
    })
    vi.stubGlobal('fetch', fetchMock)
    await render()
    await settleUntil(() => host.textContent?.includes('# Current') === true)

    await act(async () => button('Archive').click())
    await settleUntil(() => host.textContent?.includes('Archived') === true)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('New revision'))).toBe(false)
    await act(async () => button('Restore').click())
    await settleUntil(() => host.textContent?.includes('Archived') === false)
    const bodies = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/archive'))
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([{ archived: true }, { archived: false }])
  })

  it('offers no management actions to a member who cannot manage knowledge', async () => {
    mocks.role = 'collaborator'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        json(String(input).endsWith('/revisions') ? revisionRows(2) : { ...ENTRY, canManage: false })
      )
    )
    await render()
    await settleUntil(() => host.textContent?.includes('# Current') === true)
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(labels.some((label) => label.includes('New revision') || label.includes('Archive'))).toBe(false)
  })

  it('reports a missing entry with the console not-found notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'not found' }, 404))
    )
    await render()
    await settleUntil(() => host.textContent?.includes('Knowledge not found') === true)
    expect(host.textContent).toContain(mocks.routeId)
    expect(button('Back to knowledge')).toBeDefined()
  })

  it('reads About as a document with footnotes and a sources rail, and offers no visibility change on it', async () => {
    const about = {
      ...ENTRY,
      kind: 'organization' as const,
      title: 'About',
      source: 'agent',
      sourceAgentId: 'agent-1',
      content: [
        '# About',
        'Example Org builds release tooling. (#general, 2026-10-17)',
        'It serves platform teams. (https://www.example.test/about/, 2026-10-16) (web)',
        '',
        '## Repositories and systems',
        '- example-org/example-repo holds billing (example-org/example-repo, 2026-10-16) (inferred)',
        '- The release runbook lives in the Library ("Release runbook", 2026-10-15)',
        '- Releases are cut on Tuesdays (#General, 2026-10-17)'
      ].join('\n')
    }
    const channels = {
      ...ENTRY,
      id: 'channels-id',
      kind: 'channels' as const,
      content: '- [slack] general: all hands (#general, 2026-10-17)'
    }
    const runbook = { ...ENTRY, id: 'runbook-id', title: 'Release runbook' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/revisions')) return json([])
        if (url.includes('/knowledge/organization')) return json({ research: {}, entries: [about, channels] })
        if (url.includes('/knowledge?')) return json([runbook])
        return json(about)
      })
    )
    await render()
    await settleUntil(() => host.querySelector('#about-source-3 a') !== null)
    const content = host.textContent ?? ''
    // The summary is one paragraph; each line ends in its source's footnote, numbered by first appearance.
    expect(host.querySelector('p')?.textContent).toBe('Example Org builds release tooling.1 It serves platform teams.2')
    expect(content).toContain('Repositories and systems')
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'The release runbook lives in the Library3',
      'Releases are cut on Tuesdays1',
      'example-org/example-repo holds billing4'
    ])
    expect(content.indexOf('Not confirmed yet')).toBeGreaterThan(content.indexOf('Releases are cut on Tuesdays'))
    expect(content).not.toContain('inferred')
    expect(content).toContain('Updated')
    expect(content).toContain('by dreamer')
    // The rail groups the sources, each with its footnote and how many lines cite it.
    expect(content).toContain('Where this came from')
    expect(host.querySelector('#about-source-1')?.textContent).toBe('1#general2')
    expect(host.querySelector('#about-source-2 a')?.getAttribute('href')).toBe('https://www.example.test/about/')
    expect(host.querySelector('#about-source-2')?.textContent).toContain('www.example.test/about')
    expect(host.querySelector('#about-source-3 a')?.getAttribute('href')).toBe('/knowledge/runbook-id')
    // Hovering a footnote marks its source in the rail.
    const note = host.querySelector<HTMLAnchorElement>('a[href="#about-source-1"]')!
    await act(async () => note.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(host.querySelector('#about-source-1')?.className).toContain('bg-(--surface-active)')
    expect(content).toContain('All agents')
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(labels).not.toContain('Change')
    expect(labels.some((label) => label.includes('Archive'))).toBe(false)
    expect(labels.some((label) => label.includes('Clear'))).toBe(true)
  })

  it('lists Channels by platform, read places first, with a source chip only where another place is the source', async () => {
    const channels = {
      ...ENTRY,
      kind: 'channels' as const,
      title: 'Channels',
      content: [
        '# Channels',
        '- [slack] ops: incidents (#ops, 2026-10-12) (inferred)',
        '- [slack] release: release trains and freezes — (#release, 2026-10-17)',
        '- [telegram] Field Team: site visits (#release, 2026-10-16)'
      ].join('\n')
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => json(String(input).endsWith('/revisions') ? [] : channels))
    )
    await render()
    await settleUntil(() => host.textContent?.includes('release trains and freezes') === true)
    const rows = [...host.querySelectorAll('[title^="2026-"]')]
    expect(rows.map((row) => row.getAttribute('title'))).toEqual(['2026-10-17', '2026-10-16', '2026-10-12'])
    // Slack writes a place with "#", Telegram without; a chip shows only for a source other than the place itself.
    expect(rows[0]!.textContent).toBe('#releaserelease trains and freezes')
    expect(rows[1]!.textContent).toBe('Field Teamsite visits#release')
    expect(rows[2]!.textContent).toBe('#opsincidents')
    const content = host.textContent ?? ''
    expect(content.indexOf('Not read yet')).toBeGreaterThan(content.indexOf('site visits'))
    expect(content.indexOf('Not read yet')).toBeLessThan(content.indexOf('incidents'))
    expect(content).not.toContain('inferred')
  })

  it("puts Edit and Remove on the caller's own People card only, and writes it through its own route", async () => {
    mocks.role = 'collaborator'
    const people = {
      ...ENTRY,
      kind: 'people' as const,
      title: 'People',
      visibility: 'selected' as const,
      readers: ['agent-1'],
      content: [
        '# People',
        '## Me (@me on Slack) `user:me-1`',
        'Role: designer (self, 2026-10-17)',
        '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`',
        'Role: on-call lead (#ops, 2026-10-17)'
      ].join('\n')
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return json([])
      if (url.endsWith('/people/mine') && init?.method === 'PUT') return json({ revision: 3 })
      if (url.endsWith('/people/mine')) return json({ revision: 2, entries: [], keys: ['user:me-1'] })
      return json(people)
    })
    vi.stubGlobal('fetch', fetchMock)
    await render()
    await settleUntil(() => host.querySelectorAll('[aria-label="Edit"]').length === 1)
    expect(host.textContent).toContain('on-call lead')
    expect(host.textContent).toContain('You')
    expect(host.querySelectorAll('[aria-label="Remove"]')).toHaveLength(1)
    expect(host.querySelectorAll('[aria-label="Clear"]')).toHaveLength(0)

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit"]')!.click())
    const textarea = host.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
    expect(textarea.value).toContain('`user:me-1`')
    await act(async () => dialogButton('Save').click())
    await settleUntil(() => host.querySelector('[role="dialog"]') === null)
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(String(put?.[0])).toContain('/people/mine')
    expect(JSON.parse(String(put?.[1]?.body))).toMatchObject({ expectedRevision: 2 })
  })
})

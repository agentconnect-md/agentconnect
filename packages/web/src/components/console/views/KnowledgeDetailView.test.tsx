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
  useConsoleData: () => ({ agents: [{ id: 'agent-1', name: 'dreamer', displayName: '' }] })
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
})

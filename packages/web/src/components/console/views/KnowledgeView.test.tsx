// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type OrganizationKnowledgeDto, type OrganizationSuggestionDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'collaborator', tab: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.tab)
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: mocks.role, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ agents: [] }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: null, me: null }) }))

vi.mock('next/dynamic', () => ({
  default: () =>
    function MarkdownStub({ content }: { content: string }) {
      return <div data-markdown>{content}</div>
    }
}))

import KnowledgeView from './KnowledgeView'
import { SuggestionRow } from '@/components/console/SuggestionRow'

const BASE: OrganizationSuggestionDto = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceAgentId: '22222222-2222-4222-8222-222222222222',
  sourceAgentName: 'dreamer',
  sourceDaemonId: '33333333-3333-4333-8333-333333333333',
  dreamId: 'dream-1',
  candidateId: '44444444-4444-4444-8444-444444444444',
  kind: 'knowledge',
  operation: 'create',
  targetArtifactId: null,
  targetRevision: null,
  title: 'Safe deployment',
  summary: 'A reusable deployment procedure',
  tags: ['release'],
  digest: `sha256:${'a'.repeat(64)}`,
  contentBytes: 42,
  sessionIds: ['session-1'],
  state: 'pending',
  contentAvailable: true,
  reviewedAt: null,
  reviewReason: null,
  acceptedArtifactId: null,
  acceptedArtifactRevision: null,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z'
}

const KNOWLEDGE: OrganizationKnowledgeDto = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Release policy',
  content: '# Current body',
  summary: 'How releases are cut',
  tags: ['release', 'ops'],
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

const KNOWLEDGE_BODY = {
  kind: 'knowledge',
  digest: BASE.digest,
  snapshotToken: `sha256:${'b'.repeat(64)}`,
  content: '# Deployment\nRun every gate.',
  summary: BASE.summary,
  tags: BASE.tags
}

let host: HTMLDivElement
let root: Root

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')]
}

/** The button whose text is exactly `label`, else the first one containing it ("Accept" must not find the "Accepted" pill). */
function button(label: string): HTMLButtonElement {
  const found =
    buttons().find((candidate) => candidate.textContent?.trim() === label) ??
    buttons().find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

function hasButton(label: string): boolean {
  return buttons().some((candidate) => candidate.textContent?.trim() === label)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function reviewBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/review'))
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))
}

async function renderRow(
  suggestion: OrganizationSuggestionDto,
  { open = true, onReviewed = vi.fn(async () => undefined), onToggle = vi.fn() } = {}
) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SuggestionRow suggestion={suggestion} open={open} onToggle={onToggle} onReviewed={onReviewed} />
      </SWRConfig>
    )
  })
  return { onReviewed, onToggle }
}

async function renderView() {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <KnowledgeView />
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
  mocks.role = 'owner'
  mocks.tab = ''
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('organization suggestion review row', () => {
  it('keeps a closed row to its summary line: no body read, no decisions', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await renderRow(BASE, { open: false })

    expect(host.textContent).toContain('Safe deployment')
    expect(host.textContent).toContain('Proposed by dreamer')
    expect(host.textContent).toContain('1 session')
    expect(hasButton('Accept')).toBe(false)
    expect(hasButton('Reject')).toBe(false)
    expect(host.querySelector('button[aria-expanded="false"]')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps both decisions disabled while the source review surface is unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await renderRow({ ...BASE, contentAvailable: false })

    expect(button('Reject').disabled).toBe(true)
    expect(button('Accept').disabled).toBe(true)
    expect(host.textContent).toContain('Unavailable')
    expect(host.textContent).toContain("Can't review while the proposing agent is offline.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the body when the row opens and enables Accept once the full text has rendered', async () => {
    let releaseContent!: (response: Response) => void
    const contentResponse = new Promise<Response>((resolve) => {
      releaseContent = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/content')) return contentResponse
      return json({ ...BASE, state: 'accepted' }, init?.method === 'POST' ? 200 : 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onReviewed } = await renderRow(BASE)
    await settleUntil(() => fetchMock.mock.calls.length === 1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/knowledge-suggestions/${BASE.id}/content`)
    // Opening is the inspection: nothing to click first, and Accept waits for the body it binds to.
    expect(hasButton('Inspect')).toBe(false)
    expect(button('Accept').disabled).toBe(true)
    expect(button('Reject').disabled).toBe(false)

    await act(async () => releaseContent(json(KNOWLEDGE_BODY)))
    await settleUntil(() => host.textContent?.includes('Run every gate.') === true)
    expect(host.textContent).toContain('# Deployment')
    expect(button('Accept').disabled).toBe(false)

    await act(async () => button('Accept').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    expect(reviewBody(fetchMock)).toEqual({ decision: 'accept', snapshotToken: KNOWLEDGE_BODY.snapshotToken })
  })

  it('rejects from an open row without waiting for the body: nothing is installed, so no snapshot is needed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/content')) return new Promise<Response>(() => undefined)
      return json({ ...BASE, state: 'rejected' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { onReviewed } = await renderRow(BASE)
    await settleUntil(() => !button('Reject').disabled)

    await act(async () => button('Reject').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    expect(reviewBody(fetchMock)).toEqual({ decision: 'reject' })
  })

  it('surfaces a failed body read with a retry and keeps Accept off', async () => {
    let attempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/content')) return json({}, 500)
      attempts += 1
      return attempts === 1
        ? json({ error: 'Service Unavailable', statusCode: 503, message: 'source daemon offline' }, 503)
        : json(KNOWLEDGE_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderRow(BASE)
    await settleUntil(() => host.textContent?.includes('source daemon offline') === true)
    expect(button('Accept').disabled).toBe(true)
    expect(button('Reject').disabled).toBe(false)

    await act(async () => button('Retry').click())
    await settleUntil(() => host.textContent?.includes('Run every gate.') === true)
    expect(button('Accept').disabled).toBe(false)
  })

  it('renders every text file and identifies binary assets in a complete skill tree', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        kind: 'skill',
        digest: BASE.digest,
        snapshotToken: `sha256:${'b'.repeat(64)}`,
        files: [
          {
            path: 'SKILL.md',
            encoding: 'utf8',
            content: '---\nname: safe-deploy\ndescription: Deploy safely\n---\n# Safe deploy'
          },
          { path: 'scripts/check.sh', encoding: 'utf8', content: '#!/bin/sh\necho ready' },
          { path: 'assets/logo.png', encoding: 'base64', content: 'iVBORw==' }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await renderRow({ ...BASE, kind: 'skill', title: 'safe-deploy' })
    await settleUntil(() => host.textContent?.includes('echo ready') === true)

    expect(host.textContent).toContain('3 files')
    // The manifest leads the tree even though "assets/" sorts first.
    expect(host.textContent?.indexOf('SKILL.md')).toBeLessThan(host.textContent?.indexOf('assets/logo.png') ?? -1)
    expect(host.textContent).toContain('scripts/check.sh')
    expect(host.textContent).toContain('echo ready')
    expect(host.textContent).toContain('assets/logo.png')
    expect(host.textContent).toContain('Binary asset')
    expect(button('Accept').disabled).toBe(false)
  })

  it('reduces an accepted suggestion to one outcome row that opens the accepted entry', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await renderRow({
      ...BASE,
      state: 'accepted',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      acceptedArtifactId: KNOWLEDGE.id,
      acceptedArtifactRevision: 1
    })
    expect(host.textContent).toContain('Accepted as rev 1')
    expect(host.querySelector(`a[href="/knowledge/${KNOWLEDGE.id}"]`)).not.toBeNull()
    expect(buttons()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    // Internal identifiers stay out of the row.
    expect(host.textContent).not.toContain('dream-1')
    expect(host.textContent).not.toContain('session-1')
    expect(host.textContent).not.toContain('sha256')
  })

  it('shows a rejection with its reason and nothing to click', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await renderRow({
      ...BASE,
      state: 'rejected',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      reviewReason: 'Duplicates the release runbook'
    })
    expect(host.textContent).toContain('Rejected')
    expect(host.textContent).toContain('Duplicates the release runbook')
    expect(buttons()).toEqual([])
    expect(host.querySelector('a')).toBeNull()
  })
})

describe('organization knowledge surface', () => {
  it('shows the empty library above external memory without loading managed skills', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json([]))
    vi.stubGlobal('fetch', fetchMock)
    await renderView()
    await settleUntil(() => host.textContent?.includes('No knowledge yet') === true)

    const content = host.textContent ?? ''
    expect(content).toContain('External memory')
    expect(content.indexOf('No knowledge yet')).toBeLessThan(content.indexOf('External memory'))
    expect(content).not.toContain('Managed skills')
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls.some((url) => url.includes('/knowledge?includeArchived=false'))).toBe(true)
    expect(urls.some((url) => url.includes('/memory-plugin-installations'))).toBe(true)
    expect(urls.some((url) => url.includes('/external-memory-connections'))).toBe(true)
    expect(urls.some((url) => url.includes('/managed-skills'))).toBe(false)
  })

  it('lists entries as rows that open the entry page and counts pending suggestions on the tab', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/knowledge-suggestions')) return json([BASE, { ...BASE, id: 'second' }])
      if (url.includes('/knowledge?')) return json([KNOWLEDGE])
      return json([])
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderView()
    await settleUntil(() => host.textContent?.includes('Release policy') === true)
    await settleUntil(() => button('Suggestions').textContent?.includes('2') === true)

    const row = host.querySelector<HTMLAnchorElement>(`a[href="/knowledge/${KNOWLEDGE.id}"]`)
    expect(row?.textContent).toContain('Release policy')
    expect(row?.textContent).toContain('How releases are cut')
    expect(row?.textContent).toContain('rev 2')
    // The body and history live on the entry page, not in the list.
    expect(host.textContent).not.toContain('# Current body')
    expect(host.querySelectorAll('select')).toHaveLength(0)
    expect(button('Publish')).toBeDefined()
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls.some((url) => url.includes('/knowledge-suggestions?state=pending'))).toBe(true)
  })

  it('reviews from the Suggestions tab: one row opens at a time, and a decision refreshes the list', async () => {
    mocks.tab = 'tab=suggestions'
    const second = { ...BASE, id: 'second', title: 'Rollback checklist', summary: null }
    let pendingRows = [BASE, second]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/content')) return json(KNOWLEDGE_BODY)
      if (url.endsWith('/review')) {
        pendingRows = pendingRows.filter((row) => !url.includes(row.id))
        return json({ ...BASE, state: 'accepted' }, init?.method === 'POST' ? 200 : 500)
      }
      if (url.includes('/knowledge-suggestions')) return json(pendingRows)
      if (url.includes('/knowledge?')) return json([KNOWLEDGE])
      return json([])
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderView()
    await settleUntil(() => host.textContent?.includes('Rollback checklist') === true)
    expect(host.textContent).toContain('2 suggestions')
    expect(hasButton('Accept')).toBe(false)
    expect(fetchMock.mock.calls.every(([input]) => !String(input).endsWith('/content'))).toBe(true)

    await act(async () => button('Safe deployment').click())
    await settleUntil(() => host.textContent?.includes('Run every gate.') === true)
    expect(host.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1)

    // Opening the second row closes the first: one body on screen at a time.
    await act(async () => button('Rollback checklist').click())
    await settleUntil(() => button('Rollback checklist').getAttribute('aria-expanded') === 'true')
    expect(button('Safe deployment').getAttribute('aria-expanded')).toBe('false')
    await settleUntil(() => !button('Accept').disabled)

    await act(async () => button('Accept').click())
    await settleUntil(() => host.textContent?.includes('Rollback checklist') === false)
    expect(reviewBody(fetchMock)).toEqual({ decision: 'accept', snapshotToken: KNOWLEDGE_BODY.snapshotToken })
    expect(host.textContent).toContain('Safe deployment')
    expect(host.textContent).toContain('1 suggestion')
  })

  it('hides the review tab and the publish action from members who cannot manage knowledge', async () => {
    mocks.role = 'collaborator'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      json(String(input).includes('/knowledge?') ? [{ ...KNOWLEDGE, canManage: false }] : [])
    )
    vi.stubGlobal('fetch', fetchMock)
    await renderView()
    await settleUntil(() => host.textContent?.includes('Release policy') === true)

    expect(host.textContent).not.toContain('Suggestions')
    expect(buttons().some((b) => b.textContent?.includes('Publish'))).toBe(false)
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/knowledge-suggestions'))).toBe(true)
  })
})

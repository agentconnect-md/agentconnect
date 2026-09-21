// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type OrganizationKnowledgeDto, type OrganizationSuggestionDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'collaborator' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
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
import { SuggestionCard } from '@/components/console/SuggestionCard'

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

let host: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function renderCard(suggestion: OrganizationSuggestionDto, onReviewed = vi.fn(async () => undefined)) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SuggestionCard suggestion={suggestion} onReviewed={onReviewed} />
      </SWRConfig>
    )
  })
  return onReviewed
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
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('organization suggestion review card', () => {
  it('keeps both review decisions disabled while the source review surface is unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await renderCard({ ...BASE, contentAvailable: false })

    expect(button('Reject').disabled).toBe(true)
    expect(button('Accept').disabled).toBe(true)
    expect(button('Inspect').disabled).toBe(true) // nothing to read the body from
    expect(host.textContent).toContain('Unavailable')
    expect(host.textContent).toContain("Can't review while the proposing agent is offline.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders the full knowledge Markdown body before enabling acceptance', async () => {
    let releaseContent!: (response: Response) => void
    const contentResponse = new Promise<Response>((resolve) => {
      releaseContent = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/content')) return contentResponse
      return json({ ...BASE, state: 'accepted' }, init?.method === 'POST' ? 200 : 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onReviewed = await renderCard(BASE)
    // Accept is disabled until the body renders — it binds to the inspected snapshot — and the
    // step that unlocks it sits right beside it.
    expect(button('Accept').disabled).toBe(true)
    expect(button('Inspect').disabled).toBe(false)
    expect(host.textContent).toContain('Inspect the full text to enable Accept.')
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => button('Inspect').click())
    await settleUntil(() => fetchMock.mock.calls.length === 1)
    await act(async () => {
      releaseContent(
        json({
          kind: 'knowledge',
          digest: BASE.digest,
          snapshotToken: `sha256:${'b'.repeat(64)}`,
          content: '# Deployment\nRun every gate.',
          summary: BASE.summary,
          tags: BASE.tags
        })
      )
    })
    await settleUntil(() => host.textContent?.includes('Run every gate.') === true)

    expect(host.textContent).toContain('# Deployment')
    expect(host.textContent).not.toContain('Inspect the full text')
    expect(button('Accept').disabled).toBe(false)
    await act(async () => button('Accept').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    const reviewCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/review'))
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({
      decision: 'accept',
      snapshotToken: `sha256:${'b'.repeat(64)}`
    })
    expect(onReviewed).toHaveBeenCalledTimes(1)
  })

  it('inspects from the header, then accepts — the inspect click never posts a review', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/content')) {
        return json({
          kind: 'knowledge',
          digest: BASE.digest,
          snapshotToken: `sha256:${'c'.repeat(64)}`,
          content: '# Deployment',
          summary: BASE.summary,
          tags: BASE.tags
        })
      }
      return json({ ...BASE, state: 'accepted' }, init?.method === 'POST' ? 200 : 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const onReviewed = await renderCard(BASE)

    await act(async () => button('Inspect').click())
    await settleUntil(() => host.textContent?.includes('Deployment') === true)
    // That click fetched the body; it did NOT review anything.
    expect(fetchMock.mock.calls.every(([input]) => !String(input).endsWith('/review'))).toBe(true)

    await act(async () => button('Accept').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    const reviewCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/review'))
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({
      decision: 'accept',
      snapshotToken: `sha256:${'c'.repeat(64)}`
    })
  })

  it('rejects without inspecting: nothing is installed, so no snapshot is needed', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ ...BASE, state: 'rejected' })
    )
    vi.stubGlobal('fetch', fetchMock)
    const onReviewed = await renderCard(BASE)
    await act(async () => button('Reject').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    const reviewCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/review'))
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({ decision: 'reject' })
    expect(fetchMock.mock.calls.every(([input]) => !String(input).endsWith('/content'))).toBe(true)
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
    await renderCard({ ...BASE, kind: 'skill', title: 'safe-deploy' })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => button('Inspect').click())
    await settleUntil(() => host.textContent?.includes('echo ready') === true)

    expect(host.textContent).toContain('SKILL.md')
    expect(host.textContent).toContain('scripts/check.sh')
    expect(host.textContent).toContain('echo ready')
    expect(host.textContent).toContain('assets/logo.png')
    expect(host.textContent).toContain('Binary asset')
  })

  it('reduces a reviewed suggestion to one outcome line that links to the accepted entry', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await renderCard({
      ...BASE,
      state: 'accepted',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      acceptedArtifactId: KNOWLEDGE.id,
      acceptedArtifactRevision: 1
    })
    expect(host.textContent).toContain('Accepted as rev 1')
    expect(host.querySelector(`a[href="/knowledge/${KNOWLEDGE.id}"]`)).not.toBeNull()
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([])
    // Internal identifiers stay out of the card.
    expect(host.textContent).not.toContain('dream-1')
    expect(host.textContent).not.toContain('session-1')
    expect(host.textContent).not.toContain('sha256')
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

  it('hides the review tab and the publish action from members who cannot manage knowledge', async () => {
    mocks.role = 'collaborator'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      json(String(input).includes('/knowledge?') ? [{ ...KNOWLEDGE, canManage: false }] : [])
    )
    vi.stubGlobal('fetch', fetchMock)
    await renderView()
    await settleUntil(() => host.textContent?.includes('Release policy') === true)

    expect(host.textContent).not.toContain('Suggestions')
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Publish'))).toBe(false)
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/knowledge-suggestions'))).toBe(true)
  })
})

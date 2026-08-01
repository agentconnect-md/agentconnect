// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type OrganizationKnowledgeDto, type OrganizationSuggestionDto } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

vi.mock('next/dynamic', () => ({
  default: () =>
    function MarkdownStub({ content }: { content: string }) {
      return <div data-markdown>{content}</div>
    }
}))

import KnowledgeView, { KnowledgeEntry, SuggestionCard } from './KnowledgeView'

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

let host: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

async function render(suggestion: OrganizationSuggestionDto, onReviewed = vi.fn(async () => undefined)) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SuggestionCard suggestion={suggestion} onReviewed={onReviewed} />
      </SWRConfig>
    )
  })
  return onReviewed
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
    await render({ ...BASE, contentAvailable: false })

    expect(button('Reject').disabled).toBe(true)
    expect(button('Accept').disabled).toBe(true)
    expect(host.textContent).toContain('paused for safety')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders the full knowledge Markdown body before enabling acceptance', async () => {
    let releaseContent!: (response: Response) => void
    const contentResponse = new Promise<Response>((resolve) => {
      releaseContent = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/content')) {
        return contentResponse
      }
      return new Response(JSON.stringify({ ...BASE, state: 'accepted' }), {
        status: init?.method === 'POST' ? 200 : 500,
        headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onReviewed = await render(BASE)
    expect(button('Accept').disabled).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => button('Inspect staged content').click())
    await settleUntil(() => fetchMock.mock.calls.length === 1)
    await act(async () => {
      releaseContent(
        new Response(
          JSON.stringify({
            kind: 'knowledge',
            digest: BASE.digest,
            snapshotToken: `sha256:${'b'.repeat(64)}`,
            content: '# Deployment\nRun every gate.',
            summary: BASE.summary,
            tags: BASE.tags
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    })
    await settleUntil(() => !button('Accept').disabled)

    expect(host.textContent).toContain('# Deployment')
    expect(host.textContent).toContain('Run every gate.')
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

  it('renders every text file and identifies binary assets in a complete skill tree', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    await render({ ...BASE, kind: 'skill', title: 'safe-deploy' })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => button('Inspect staged content').click())
    await settleUntil(() => host.textContent?.includes('echo ready') === true)

    expect(host.textContent).toContain('SKILL.md')
    expect(host.textContent).toContain('scripts/check.sh')
    expect(host.textContent).toContain('echo ready')
    expect(host.textContent).toContain('assets/logo.png')
    expect(host.textContent).toContain('Binary asset')
  })
})

describe('organization knowledge surface', () => {
  it('renders knowledge above external memory without loading managed skills', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <KnowledgeView />
        </SWRConfig>
      )
    })
    await settleUntil(() => host.textContent?.includes('No organization knowledge has been published yet.') === true)

    const content = host.textContent ?? ''
    expect(content).toContain('Knowledge library')
    expect(content).toContain('External memory')
    expect(content.indexOf('Knowledge library')).toBeLessThan(content.indexOf('External memory'))
    expect(content).not.toContain('Managed skills')
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls.some((url) => url.includes('/knowledge?includeArchived=false'))).toBe(true)
    expect(urls.some((url) => url.includes('/memory-plugin-installations'))).toBe(true)
    expect(urls.some((url) => url.includes('/external-memory-connections'))).toBe(true)
    expect(urls.some((url) => url.includes('/managed-skills'))).toBe(false)
  })

  it('loads and selects historical knowledge content, then refreshes an open entry for a new revision', async () => {
    const knowledge: OrganizationKnowledgeDto = {
      id: '55555555-5555-4555-8555-555555555555',
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
    let knowledgeCurrentRevision = 2
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify([
            {
              knowledgeId: knowledge.id,
              revision: knowledgeCurrentRevision,
              content: knowledgeCurrentRevision === 2 ? '# Current' : '# Newly published',
              summary: knowledgeCurrentRevision === 2 ? 'Current summary' : 'New summary',
              tags: ['release'],
              digest: knowledge.digest,
              source: 'manual',
              sourceAgentId: null,
              sourceDreamId: null,
              sourceSessionIds: [],
              createdByUserId: 'owner-1',
              reviewedByUserId: null,
              createdAt: '2026-07-31T00:00:00.000Z'
            },
            {
              knowledgeId: knowledge.id,
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
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <KnowledgeEntry record={knowledge} canManage={false} onEdit={() => undefined} onArchive={() => undefined} />
        </SWRConfig>
      )
    })
    await act(async () => {
      const details = host.querySelector('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    await settleUntil(() => host.querySelectorAll('select').length === 1)

    const knowledgeSelect = host.querySelector('select')!
    await act(async () => {
      knowledgeSelect.value = '1'
      knowledgeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.textContent).toContain('# Historical policy')
    expect(host.textContent).toContain('reviewed by owner-1')
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining(`/knowledge/${knowledge.id}/revisions`)
    ])

    knowledgeCurrentRevision = 3
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <KnowledgeEntry
            record={{ ...knowledge, currentRevision: 3 }}
            canManage={false}
            onEdit={() => undefined}
            onArchive={() => undefined}
          />
        </SWRConfig>
      )
    })
    await settleUntil(() => host.textContent?.includes('# Newly published') === true)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/revisions'))).toHaveLength(2)
    expect(host.textContent).not.toContain('Revision history is unavailable.')
  })
})

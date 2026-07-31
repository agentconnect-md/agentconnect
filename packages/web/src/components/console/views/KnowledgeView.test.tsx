// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setApiOrgId,
  type ManagedSkillDto,
  type OrganizationKnowledgeDto,
  type OrganizationSuggestionDto
} from '@/lib/api'

vi.mock('next/dynamic', () => ({
  default: () =>
    function MarkdownStub({ content }: { content: string }) {
      return <div data-markdown>{content}</div>
    }
}))

import { KnowledgeEntry, ManagedSkillEntry, SuggestionCard } from './KnowledgeView'

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
  it('allows an owner to reject unavailable metadata while keeping acceptance gated on the body', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ ...BASE, state: 'rejected' }), {
          status: init?.method === 'POST' ? 200 : 500,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const onReviewed = await render({ ...BASE, contentAvailable: false })

    expect(button('Reject').disabled).toBe(false)
    expect(button('Accept').disabled).toBe(true)
    expect(host.textContent).toContain('offline, upgrading, or no longer owns')

    await act(async () => button('Reject').click())
    await settleUntil(() => onReviewed.mock.calls.length === 1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ decision: 'reject' })
    expect(onReviewed).toHaveBeenCalledTimes(1)
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

describe('immutable organization artifact history', () => {
  it('loads and selects historical knowledge content and managed-skill bundle metadata on expansion', async () => {
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
    const skill: ManagedSkillDto = {
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/knowledge/')
        ? [
            {
              knowledgeId: knowledge.id,
              revision: 2,
              content: '# Current',
              summary: 'Current summary',
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
          ]
        : [
            {
              managedSkillId: skill.id,
              revision: 2,
              digest: skill.digest,
              compressedBytes: 120,
              expandedBytes: 300,
              fileCount: 2,
              manifest: skill.manifest,
              source: 'dream',
              sourceAgentId: 'agent-1',
              sourceDreamId: 'dream-2',
              sourceSessionIds: ['session-2'],
              createdByUserId: null,
              reviewedByUserId: 'owner-1',
              createdAt: '2026-07-31T00:00:00.000Z'
            },
            {
              managedSkillId: skill.id,
              revision: 1,
              digest: `sha256:${'1'.repeat(64)}`,
              compressedBytes: 90,
              expandedBytes: 180,
              fileCount: 1,
              manifest: {
                files: [{ path: 'references/initial.md', bytes: 80, digest: `sha256:${'2'.repeat(64)}` }]
              },
              source: 'dream',
              sourceAgentId: 'agent-1',
              sourceDreamId: 'dream-1',
              sourceSessionIds: ['session-1'],
              createdByUserId: null,
              reviewedByUserId: 'owner-1',
              createdAt: '2026-07-30T00:00:00.000Z'
            }
          ]
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <KnowledgeEntry record={knowledge} canManage={false} onEdit={() => undefined} onArchive={() => undefined} />
          <ManagedSkillEntry skill={skill} canManage={false} onArchive={() => undefined} />
        </SWRConfig>
      )
    })
    await act(async () => {
      for (const details of host.querySelectorAll('details')) {
        details.open = true
        details.dispatchEvent(new Event('toggle'))
      }
    })
    await settleUntil(() => host.querySelectorAll('select').length === 2)

    const [knowledgeSelect, skillSelect] = [...host.querySelectorAll('select')]
    await act(async () => {
      knowledgeSelect!.value = '1'
      knowledgeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
      skillSelect!.value = '1'
      skillSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.textContent).toContain('# Historical policy')
    expect(host.textContent).toContain('reviewed by owner-1')
    expect(host.textContent).toContain('references/initial.md')
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/knowledge/${knowledge.id}/revisions`),
        expect.stringContaining(`/managed-skills/${skill.id}/revisions`)
      ])
    )
  })
})

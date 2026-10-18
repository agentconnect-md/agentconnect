// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type OrganizationKnowledgeDto } from '@/lib/api'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, orgPath: (path: string) => path })
}))

import { AgentKnowledgePanel } from './AgentKnowledgePanel'

const ENTRY: OrganizationKnowledgeDto = {
  id: 'entry-id',
  title: 'Release policy',
  content: '# Current',
  summary: null,
  tags: [],
  currentRevision: 1,
  digest: `sha256:${'c'.repeat(64)}`,
  source: 'manual',
  writerKind: null,
  kind: 'entry',
  visibility: 'all',
  readers: [],
  sourceAgentId: null,
  sourceDreamId: null,
  sourceSessionIds: [],
  createdByUserId: null,
  reviewedByUserId: null,
  archivedAt: null,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  revisionCreatedAt: '2026-10-18T00:00:00.000Z',
  canManage: true
}
const entry = (over: Partial<OrganizationKnowledgeDto>): OrganizationKnowledgeDto => ({ ...ENTRY, ...over })

let host: HTMLDivElement
let root: Root

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function render(record: OrganizationKnowledgeDto[], library: OrganizationKnowledgeDto[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/knowledge/organization')
        ? json({ research: { agentId: null, researchedAt: null, runningSince: null }, entries: record })
        : json(library)
    )
  )
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AgentKnowledgePanel agentId="agent-a" />
      </SWRConfig>
    )
  })
  for (let attempt = 0; attempt < 10; attempt += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
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

describe('an agent’s Knowledge tab', () => {
  it('lists only the entries the agent reads, with no reads label', async () => {
    await render(
      [
        entry({ id: 'about', kind: 'organization', title: 'About', content: '# About' }),
        entry({ id: 'channels', kind: 'channels', title: 'Channels', content: '# Channels' }),
        entry({
          id: 'people',
          kind: 'people',
          title: 'People',
          content: '# People',
          visibility: 'selected',
          readers: []
        })
      ],
      [
        entry({ id: 'open', title: 'Release policy' }),
        entry({ id: 'mine', title: 'On-call guide', visibility: 'selected', readers: ['agent-a'] }),
        entry({ id: 'theirs', title: 'Pricing notes', visibility: 'selected', readers: ['agent-b'] })
      ]
    )
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      '/knowledge',
      '/knowledge/about',
      '/knowledge/channels',
      '/knowledge/open',
      '/knowledge/mine'
    ])
    expect(host.textContent).not.toContain('Reads it')
    expect(host.textContent).not.toContain('Does not read it')
  })

  it('keeps the Handbook header and drops an empty Library', async () => {
    await render([], [entry({ id: 'theirs', visibility: 'selected', readers: ['agent-b'] })])
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/knowledge'])
    expect(host.textContent).toContain('Handbook')
    expect(host.textContent).not.toContain('Library')
  })
})

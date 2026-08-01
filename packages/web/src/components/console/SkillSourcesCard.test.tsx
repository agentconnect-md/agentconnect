// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSkillDto, SkillSourceDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  skillSources: [] as SkillSourceDto[]
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    skillSources: mocks.skillSources,
    skillSourcesLoading: false,
    members: []
  })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-test' } }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))

import { SkillSourcesCard } from './SkillSourcesCard'

let host: HTMLDivElement
let root: Root

async function settleUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (done()) return
  }
  throw new Error('skills library did not settle')
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
      ownerUserId: 'owner-1',
      canEdit: true,
      canManageSharing: true,
      createdAt: '2026-07-30T00:00:00.000Z'
    }
  ]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
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
      async () =>
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
})

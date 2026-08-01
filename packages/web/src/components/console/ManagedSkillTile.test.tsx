// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId, type ManagedSkillDto } from '@/lib/api'
import { ManagedSkillTile } from './ManagedSkillTile'

let host: HTMLDivElement
let root: Root

async function settleUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (done()) return
  }
  throw new Error('managed skill tile did not settle')
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

describe('managed skill library tile', () => {
  it('lazily browses immutable revisions and refreshes an open tile when the current revision advances', async () => {
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
    let currentRevision = 2
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              managedSkillId: skill.id,
              revision: currentRevision,
              digest: skill.digest,
              compressedBytes: 120,
              expandedBytes: 300,
              fileCount: 2,
              manifest:
                currentRevision === 2
                  ? skill.manifest
                  : { files: [{ path: 'references/latest.md', bytes: 100, digest: `sha256:${'3'.repeat(64)}` }] },
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
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const render = async (value: ManagedSkillDto) => {
      await act(async () => {
        root.render(
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <ManagedSkillTile skill={value} canManage={false} onArchive={() => undefined} />
          </SWRConfig>
        )
      })
    }
    await render(skill)

    expect(host.textContent).toContain('managed · rev 2')
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Show revision history"]')!.click()
    })
    await settleUntil(() => host.querySelector('select') !== null)

    const select = host.querySelector('select')!
    await act(async () => {
      select.value = '1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.textContent).toContain('references/initial.md')
    expect(host.textContent).toContain('reviewed by owner-1')

    currentRevision = 3
    await render({ ...skill, currentRevision: 3 })
    await settleUntil(() => host.textContent?.includes('references/latest.md') === true)

    expect(host.textContent).toContain('managed · rev 3')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('Revision history is unavailable.')
  })
})

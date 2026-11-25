// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({ getArtifact: vi.fn(), getArtifactRevision: vi.fn() }))
const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getArtifact: api.getArtifact,
  getArtifactRevision: api.getArtifactRevision
}))
vi.mock('@/lib/artifact-download', () => ({
  fetchArtifactFile: async (_id: string, revision: number, file: { mediaType: string }) =>
    new Blob([`body of r${revision}`], { type: file.mediaType }),
  downloadArtifactRevision: vi.fn()
}))
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ID }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => `/acme/artifacts/${ID}`,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), back: vi.fn() })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/components/console/Shell', () => ({ useCrumbSlot: () => ({ register: () => undefined }) }))
vi.mock('@/components/console/search-open', () => ({ useSearchOpen: () => () => undefined }))

import { ApiError } from '@/lib/api'
import ArtifactView, { requestedRevision } from './ArtifactView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const summary = (number: number, agent: string) => ({
  number,
  entry: 'notes.txt',
  entryMediaType: 'text/plain',
  fileCount: 1,
  totalBytes: 10,
  producedBy: { agentId: 'agent-1', name: agent },
  producedInSessionId: 'session-1',
  createdAt: `2026-11-2${number}T10:00:00.000Z`
})
const ARTIFACT: ArtifactDto = {
  id: ID,
  title: 'Release notes',
  audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
  owner: null,
  viewerIsOwner: true,
  originSessionId: 'session-1',
  latestRevision: 3,
  createdAt: '2026-11-21T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  revisions: [summary(3, 'Atlas'), summary(2, 'Hermes')]
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function settle() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function renderView(search: string) {
  nav.search = search
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ArtifactView />
      </SWRConfig>
    )
  })
  await settle()
}

beforeEach(() => {
  api.getArtifact.mockReset().mockResolvedValue(ARTIFACT)
  api.getArtifactRevision.mockReset().mockImplementation(async (_id: string, number: number) => ({
    ...summary(number, number === 3 ? 'Atlas' : 'Hermes'),
    artifactId: ID,
    latestRevision: 3,
    manifest: {
      entry: 'notes.txt',
      files: [{ path: 'notes.txt', sha256: '0'.repeat(64), bytes: 10, mediaType: 'text/plain' }]
    }
  }))
  nav.replace.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('requestedRevision', () => {
  it('accepts only a positive revision number', () => {
    expect(requestedRevision('2')).toBe(2)
    expect(requestedRevision(null)).toBeUndefined()
    expect(requestedRevision('0')).toBeUndefined()
    expect(requestedRevision('2abc')).toBeUndefined()
  })
})

describe('ArtifactView', () => {
  it('opens the latest revision without a revision in the URL, with the info line', async () => {
    await renderView('')
    expect(api.getArtifactRevision).toHaveBeenCalledWith(ID, 3)
    expect(container.querySelector('h1')!.textContent).toBe('Release notes')
    expect(container.textContent).toContain('Atlas')
    expect(container.textContent).toContain('Everyone')
    expect(container.querySelector('pre code')!.textContent).toBe('body of r3')
  })

  it('opens the revision the URL pins and offers the newer one', async () => {
    await renderView('revision=2')
    expect(api.getArtifactRevision).toHaveBeenCalledWith(ID, 2)
    expect(container.textContent).toContain('Hermes')
    expect(container.textContent).toContain('A newer revision (r3) is available.')
    const latest = [...container.querySelectorAll('button')].find((b) => b.textContent === 'View latest')!
    await act(async () => latest.click())
    expect(nav.replace).toHaveBeenCalledWith(`/acme/artifacts/${ID}?revision=3`, { scroll: false })
  })

  it('switches revisions from the menu, which lists each with its agent, and writes the choice to the URL', async () => {
    await renderView('revision=3')
    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(menuButton.textContent).toContain('r3')
    await act(async () => menuButton.click())
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Revision 3'),
      expect.stringContaining('Revision 2')
    ])
    expect(items[1]!.textContent).toContain('Hermes')
    expect(items[0]!.getAttribute('aria-checked')).toBe('true')
    await act(async () => items[1]!.click())
    expect(nav.replace).toHaveBeenCalledWith(`/acme/artifacts/${ID}?revision=2`, { scroll: false })
  })

  it('opens the latest with a notice when the URL’s revision is no longer kept', async () => {
    await renderView('revision=1')
    expect(api.getArtifactRevision).toHaveBeenCalledWith(ID, 3)
    expect(container.textContent).toContain('Revision 1 is no longer kept, so the latest revision (r3) is shown.')
  })

  it('shows one neutral unavailable page for a deleted artifact or one the viewer cannot see', async () => {
    api.getArtifact.mockRejectedValue(new ApiError('artifact not found', 404))
    await renderView('revision=2')
    expect(container.textContent).toContain('Artifact unavailable')
    expect(container.textContent).toContain('may have been deleted, or you may not have access')
    expect(api.getArtifactRevision).not.toHaveBeenCalled()
  })
})

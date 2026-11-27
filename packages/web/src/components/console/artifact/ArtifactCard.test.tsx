// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({ getArtifact: vi.fn() }))
const download = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getArtifact: api.getArtifact
}))
vi.mock('@/lib/artifact-download', () => ({ downloadArtifactRevision: download.run }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
// Like Next's Link: the click handler runs first, and a prevented click does not navigate.
const navigated = vi.hoisted(() => ({ hrefs: [] as string[] }))
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string
    children: React.ReactNode
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void
  }) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event)
        const prevented = event.defaultPrevented
        event.preventDefault()
        if (!prevented) navigated.hrefs.push(href)
      }}
    >
      {children}
    </a>
  )
}))

import { ApiError } from '@/lib/api'
import { ArtifactCard } from './ArtifactCard'
import { ArtifactOpenerProvider, ArtifactPlacementProvider, type ArtifactOpener } from './artifact-opener'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const revision = (number: number, entryMediaType = 'text/html') => ({
  number,
  entry: 'index.html',
  entryMediaType,
  fileCount: 1,
  totalBytes: 2048,
  producedBy: { agentId: 'agent-1', name: 'Atlas' },
  producedInSessionId: 'session-1',
  createdAt: '2026-11-25T10:00:00.000Z'
})
const artifact = (latest: number, kept: number[]): ArtifactDto => ({
  id: ID,
  title: 'Q3 dashboard',
  audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
  owner: null,
  viewerIsOwner: true,
  originSessionId: 'session-1',
  latestRevision: latest,
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
  revisions: kept.map((n) => revision(n))
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function renderCard(
  revisionNumber: number,
  place: { opener?: ArtifactOpener; placement?: 'dock' | 'pane' } = {}
) {
  const card = <ArtifactCard marker={{ artifactId: ID, revision: revisionNumber, title: 'Old title' }} />
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ArtifactOpenerProvider opener={place.opener ?? null}>
          {place.placement ? (
            <ArtifactPlacementProvider placement={place.placement}>{card}</ArtifactPlacementProvider>
          ) : (
            card
          )}
        </ArtifactOpenerProvider>
      </SWRConfig>
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return container.querySelector<HTMLElement>('[data-testid="artifact-card"]')!
}

const phone = { matches: false }

beforeEach(() => {
  phone.matches = false
  navigated.hrefs = []
  window.matchMedia = ((query: string) => ({
    matches: phone.matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  window.__AC_ENV = { ARTIFACTS_CONTENT_DOMAIN: 'example-usercontent.net' }
  api.getArtifact.mockReset()
  download.run.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  delete window.__AC_ENV
  act(() => root.unmount())
  container.remove()
})

describe('ArtifactCard', () => {
  it('shows the latest revision with its type, size, Open pinned to the revision, and Download', async () => {
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const card = await renderCard(2)
    expect(card.dataset.state).toBe('latest')
    expect(card.textContent).toContain('Q3 dashboard')
    expect(card.textContent).toContain('r2 · 2.0 KB')
    expect(card.querySelector('a')!.getAttribute('href')).toBe(`/acme/artifacts/${ID}?revision=2`)
    expect(card.textContent).not.toContain('Newer revision')

    const button = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Download'))!
    await act(async () => button.click())
    expect(download.run).toHaveBeenCalledWith(ID, 2, 'Q3 dashboard', undefined)
  })

  it('says a newer revision exists on an older card', async () => {
    api.getArtifact.mockResolvedValue(artifact(3, [3, 2, 1]))
    const card = await renderCard(1)
    expect(card.dataset.state).toBe('newer')
    expect(card.textContent).toContain('Newer revision available (r3)')
  })

  it('notes a revision that is no longer kept and still opens the artifact', async () => {
    api.getArtifact.mockResolvedValue(artifact(3, [3]))
    const card = await renderCard(1)
    expect(card.dataset.state).toBe('aged-out')
    expect(card.textContent).toContain('no longer kept')
    expect(card.querySelector('a')).not.toBeNull()
  })

  it('shows one neutral unavailable state for a deleted artifact or one the viewer cannot see', async () => {
    api.getArtifact.mockRejectedValue(new ApiError('artifact not found', 404))
    const card = await renderCard(1)
    expect(card.dataset.state).toBe('unavailable')
    expect(card.textContent).toContain('Old title')
    expect(card.textContent).toContain('may have been deleted, or you don’t have access')
    expect(card.querySelector('a')).toBeNull()
    expect(card.querySelector('button')).toBeNull()
  })

  it('shows a neutral not-enabled state without reading anything on a deployment without artifacts', async () => {
    window.__AC_ENV = {}
    const card = await renderCard(1)
    expect(card.dataset.state).toBe('not-enabled')
    expect(card.textContent).toContain('Old title')
    expect(card.textContent).toContain('Artifacts are not enabled on this deployment')
    expect(card.querySelector('a')).toBeNull()
    expect(card.querySelector('button')).toBeNull()
    expect(api.getArtifact).not.toHaveBeenCalled()
  })

  it('shows the same state when the Control Plane answers that artifacts are not enabled', async () => {
    api.getArtifact.mockRejectedValue(new ApiError('not enabled', 409, 'ARTIFACTS_NOT_ENABLED'))
    const card = await renderCard(1)
    expect(card.dataset.state).toBe('not-enabled')
    expect(card.querySelector('a')).toBeNull()
  })
})

describe('ArtifactCard Open', () => {
  const click = async (card: HTMLElement, init: MouseEventInit = {}) => {
    const open = card.querySelector<HTMLAnchorElement>('a[data-artifact-open]')!
    await act(async () => {
      open.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
    })
    return open
  }

  it('links to the standalone page outside a session page', async () => {
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const card = await renderCard(2)
    const open = await click(card)
    expect(open.dataset.artifactOpen).toBe('page')
    expect(navigated.hrefs).toEqual([`/acme/artifacts/${ID}?revision=2`])
  })

  it('opens the viewer in the dock from the main conversation', async () => {
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const opener = { open: vi.fn() }
    const card = await renderCard(1, { opener })
    const open = await click(card)
    expect(open.dataset.artifactOpen).toBe('dock')
    expect(opener.open).toHaveBeenCalledWith({ artifactId: ID, revision: 1 }, 'dock')
    expect(navigated.hrefs).toEqual([])
    // The link stays the standalone page, for a new tab or a copied address.
    expect(open.getAttribute('href')).toBe(`/acme/artifacts/${ID}?revision=1`)
  })

  it('opens the viewer in the left pane from a task thread in the dock', async () => {
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const opener = { open: vi.fn() }
    const card = await renderCard(2, { opener, placement: 'pane' })
    await click(card)
    expect(opener.open).toHaveBeenCalledWith({ artifactId: ID, revision: 2 }, 'pane')
  })

  it('leaves a modified click to the browser', async () => {
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const opener = { open: vi.fn() }
    const card = await renderCard(2, { opener })
    await click(card, { metaKey: true })
    expect(opener.open).not.toHaveBeenCalled()
    expect(navigated.hrefs).toHaveLength(1)
  })

  it('opens the standalone page on a phone, which has no dock', async () => {
    phone.matches = true
    api.getArtifact.mockResolvedValue(artifact(2, [2, 1]))
    const opener = { open: vi.fn() }
    const card = await renderCard(2, { opener })
    const open = await click(card)
    expect(open.dataset.artifactOpen).toBe('page')
    expect(opener.open).not.toHaveBeenCalled()
    expect(navigated.hrefs).toEqual([`/acme/artifacts/${ID}?revision=2`])
  })
})

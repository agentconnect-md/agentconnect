// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionArtifactDto, SessionArtifactPageDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({ listSessionArtifacts: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  listSessionArtifacts: api.listSessionArtifacts
}))
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
import type { DockTabStatus } from './SessionDock'
import { ArtifactsList, artifactsListStatus } from './ArtifactsList'
import { ArtifactOpenerProvider, type ArtifactOpener } from '@/components/console/artifact/artifact-opener'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const SESSION = 'slack:T1:C1:1700000000.000100'
const id = (n: number) => `0b6d1d55-5f43-4c8e-9a51-${String(n).padStart(12, '0')}`
const row = (n: number, entryMediaType = 'text/html', entry = 'index.html'): SessionArtifactDto => ({
  id: id(n),
  title: `Artifact ${n}`,
  audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
  owner: null,
  viewerIsOwner: true,
  originSessionId: SESSION,
  latestRevision: n,
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  latest: {
    number: n,
    entry,
    entryMediaType,
    fileCount: 1,
    totalBytes: 2048,
    producedBy: { agentId: 'agent-1', name: 'Atlas' },
    producedInSessionId: SESSION,
    createdAt: '2026-11-25T10:00:00.000Z'
  }
})
const page = (artifacts: SessionArtifactDto[], nextCursor: string | null = null): SessionArtifactPageDto => ({
  artifacts,
  nextCursor
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let statuses: DockTabStatus[]

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderList(props: { refreshKey?: string; opener?: ArtifactOpener; cache?: Map<unknown, unknown> } = {}) {
  const cache = props.cache ?? new Map()
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => cache as never, dedupingInterval: 0 }}>
        <ArtifactOpenerProvider opener={props.opener ?? null}>
          <ArtifactsList
            sessionId={SESSION}
            refreshKey={props.refreshKey ?? ''}
            onStatusChange={(status) => statuses.push(status)}
          />
        </ArtifactOpenerProvider>
      </SWRConfig>
    )
  })
  await flush()
  return cache
}

const rows = () => [...container.querySelectorAll<HTMLAnchorElement>('[data-artifact-row]')]

beforeEach(() => {
  statuses = []
  navigated.hrefs = []
  api.listSessionArtifacts.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('artifactsListStatus', () => {
  it('is empty only once every page has answered with nothing', () => {
    expect(artifactsListStatus({ rows: 0, loading: true, failed: false, more: false })).toBe('loading')
    expect(artifactsListStatus({ rows: 0, loading: false, failed: false, more: true })).toBe('loading')
    expect(artifactsListStatus({ rows: 0, loading: false, failed: false, more: false })).toBe('empty')
    expect(artifactsListStatus({ rows: 0, loading: false, failed: true, more: false })).toBe('ready')
    expect(artifactsListStatus({ rows: 2, loading: true, failed: false, more: true })).toBe('ready')
  })
})

describe('ArtifactsList', () => {
  it('draws one row per artifact and opens the latest revision in the dock', async () => {
    api.listSessionArtifacts.mockResolvedValue(page([row(3), row(1, 'text/markdown', 'notes.md')]))
    const open = vi.fn()
    await renderList({ opener: { open } })

    expect(api.listSessionArtifacts).toHaveBeenCalledWith(SESSION, { orgId: 'org-1', limit: 25 })
    const [first, second] = rows()
    expect(rows()).toHaveLength(2)
    expect(first!.textContent).toContain('Artifact 3')
    expect(first!.textContent).toContain('r3')
    expect(first!.textContent).toContain('5m ago')
    expect(first!.innerHTML).toContain('lucide-app-window')
    expect(second!.innerHTML).toContain('lucide-file-text')
    expect(second!.getAttribute('href')).toBe(`/acme/artifacts/${id(1)}`)
    expect(statuses.at(-1)).toBe('ready')

    await act(async () => first!.click())
    expect(open).toHaveBeenCalledWith({ artifactId: id(3) }, 'dock')
    expect(navigated.hrefs).toEqual([])
  })

  it('follows short and empty pages until the list ends', async () => {
    api.listSessionArtifacts
      .mockResolvedValueOnce(page([], 'c1'))
      .mockResolvedValueOnce(page([row(2)], 'c2'))
      .mockResolvedValueOnce(page([row(1)], null))
    await renderList()

    expect(api.listSessionArtifacts.mock.calls.map(([, opts]) => opts.cursor)).toEqual([undefined, 'c1', 'c2'])
    expect(rows().map((a) => a.textContent)).toEqual([
      expect.stringContaining('Artifact 2'),
      expect.stringContaining('Artifact 1')
    ])
    expect(statuses).not.toContain('empty')
    expect(container.querySelector('[data-artifacts-more]')).toBeNull()
  })

  it('stops following at a screenful and offers the rest behind Show more', async () => {
    const full = Array.from({ length: 25 }, (_, i) => row(100 - i))
    api.listSessionArtifacts.mockResolvedValueOnce(page(full, 'c1')).mockResolvedValueOnce(page([row(1)], null))
    await renderList()

    expect(api.listSessionArtifacts).toHaveBeenCalledTimes(1)
    const more = container.querySelector<HTMLButtonElement>('[data-artifacts-more]')!
    expect(more.textContent).toContain('Show more')
    await act(async () => more.click())
    await flush()
    expect(api.listSessionArtifacts.mock.calls.at(-1)![1]).toMatchObject({ cursor: 'c1' })
    expect(rows()).toHaveLength(26)
    expect(container.querySelector('[data-artifacts-more]')).toBeNull()
  })

  it('reports empty and draws nothing of its own when the session published none', async () => {
    api.listSessionArtifacts.mockResolvedValue(page([]))
    await renderList()
    expect(statuses.at(-1)).toBe('empty')
    expect(container.querySelector('[data-artifacts-list]')).toBeNull()
  })

  it('says a failed read failed', async () => {
    api.listSessionArtifacts.mockRejectedValue(new ApiError('session not found', 404))
    await renderList()
    expect(container.querySelector('[data-artifacts-list]')?.getAttribute('data-artifacts-list')).toBe('failed')
    expect(container.textContent).toContain('Artifacts couldn’t be loaded')
    expect(statuses.at(-1)).toBe('ready')
  })

  it('says a deployment without artifacts has none', async () => {
    api.listSessionArtifacts.mockRejectedValue(new ApiError('not enabled', 409, 'ARTIFACTS_NOT_ENABLED'))
    await renderList()
    expect(container.querySelector('[data-artifacts-list]')?.getAttribute('data-artifacts-list')).toBe('not-enabled')
    expect(container.textContent).toContain('Artifacts are not enabled on this deployment.')
  })

  it('re-reads when the transcript gains an artifact card', async () => {
    api.listSessionArtifacts.mockResolvedValueOnce(page([row(1)]))
    const cache = await renderList({ refreshKey: `${id(1)}:1` })
    expect(api.listSessionArtifacts).toHaveBeenCalledTimes(1)

    await renderList({ refreshKey: `${id(1)}:1`, cache })
    expect(api.listSessionArtifacts).toHaveBeenCalledTimes(1)

    api.listSessionArtifacts.mockResolvedValueOnce(page([row(2), row(1)]))
    await renderList({ refreshKey: `${id(1)}:1,${id(2)}:2`, cache })
    expect(api.listSessionArtifacts).toHaveBeenCalledTimes(2)
    expect(rows()).toHaveLength(2)
  })
})

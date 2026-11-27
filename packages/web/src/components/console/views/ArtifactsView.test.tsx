// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgArtifactDto, OrgArtifactPageDto, OrgArtifactShareDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({
  listArtifacts: vi.fn(),
  listOrgArtifactShares: vi.fn(),
  deleteArtifact: vi.fn(),
  updateArtifact: vi.fn(),
  revokeArtifactShare: vi.fn(),
  getArtifact: vi.fn()
}))
const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))
const env = vi.hoisted(() => ({ role: 'collaborator' as string, mobile: false }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...api
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/acme/artifacts',
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), back: vi.fn() })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1', name: 'Acme', slug: 'acme' },
    myRole: env.role,
    orgPath: (path: string) => `/acme${path}`
  })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [{ id: AGENT, name: 'atlas', displayName: 'Atlas' }] })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { userId: 'user-1' } }) }))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => env.mobile }))
vi.mock('@/components/console/Shell', () => ({ useMobileFilterSlot: () => ({ register: () => undefined }) }))

import { ApiError } from '@/lib/api'
import ArtifactsView from './ArtifactsView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const AGENT = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const id = (n: number) => `1c7e2e66-6a54-4d9f-8b62-${String(n).padStart(12, '0')}`
const none = { rename: false, changeAudience: false, sharePublic: false, revokeShares: false }
const all = { rename: true, changeAudience: true, sharePublic: true, revokeShares: true }

function row(n: number, over: Partial<OrgArtifactDto> = {}): OrgArtifactDto {
  return {
    id: id(n),
    title: `Artifact ${n}`,
    audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
    owner: { userId: 'user-2', displayName: 'Grace', email: null, platform: null },
    viewerIsOwner: false,
    originSessionId: 'session-1',
    originSessionVisible: false,
    latestRevision: 2,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    latest: {
      number: 2,
      entry: 'index.html',
      entryMediaType: 'text/html',
      fileCount: 1,
      totalBytes: 2048,
      producedBy: { agentId: AGENT, name: 'Atlas' },
      producedInSessionId: 'session-1',
      createdAt: '2026-11-20T10:00:00.000Z'
    },
    kind: 'page',
    shared: { any: false, public: false },
    permissions: none,
    ...over
  }
}
const page = (artifacts: OrgArtifactDto[], nextCursor: string | null = null): OrgArtifactPageDto => ({
  artifacts,
  nextCursor
})
function share(n: number, viewerCanView: boolean): OrgArtifactShareDto {
  return {
    id: `share-${n}`,
    artifactId: id(n),
    revision: 1,
    audience: 'public',
    displayTail: '…abc123',
    createdBy: { userId: 'user-2', displayName: 'Grace', email: null, platform: null },
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:00.000Z',
    revokedAt: null,
    artifact: { id: id(n), title: `Shared ${n}`, owner: null, viewerCanView }
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function settle() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function renderView(search = '') {
  nav.search = search
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ArtifactsView />
      </SWRConfig>
    )
  })
  await settle()
}

const state = () => container.querySelector('[data-artifacts-state]')?.getAttribute('data-artifacts-state')
const rowIds = () =>
  [...container.querySelectorAll('[data-artifact-row]')].map((el) => el.getAttribute('data-artifact-row'))
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await settle()
}
async function openMenu(rowSelector: string) {
  await click(container.querySelector(`${rowSelector} [data-artifact-actions]`))
  return [...document.body.querySelectorAll('[data-anchored-flyout] [data-action]')]
}
const actionKeys = (items: Element[]) => items.map((el) => el.getAttribute('data-action'))

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  nav.replace.mockReset()
  env.role = 'collaborator'
  env.mobile = false
  window.__AC_ENV = { ARTIFACTS_CONTENT_DOMAIN: 'content.example.test' }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  delete window.__AC_ENV
})

describe('ArtifactsView states', () => {
  it('says artifacts are not enabled without a content domain, and reads nothing', async () => {
    window.__AC_ENV = {}
    await renderView()
    expect(container.querySelector('[data-testid="artifacts-not-enabled"]')).toBeTruthy()
    expect(api.listArtifacts).not.toHaveBeenCalled()
  })

  it('says artifacts are not enabled when the CP refuses with ARTIFACTS_NOT_ENABLED', async () => {
    api.listArtifacts.mockRejectedValue(new ApiError('off', 409, 'ARTIFACTS_NOT_ENABLED'))
    await renderView()
    expect(container.querySelector('[data-testid="artifacts-not-enabled"]')).toBeTruthy()
  })

  it('shows the empty state, and the filtered empty state with a way back', async () => {
    api.listArtifacts.mockResolvedValue(page([]))
    await renderView()
    expect(state()).toBe('empty')

    await renderView('scope=mine')
    expect(state()).toBe('no-matches')
    await click(container.querySelector('[data-artifacts-state="no-matches"] button'))
    expect(nav.replace).toHaveBeenCalledWith('/acme/artifacts', { scroll: false })
  })

  it('shows a failure with a retry', async () => {
    api.listArtifacts.mockRejectedValueOnce(new ApiError('boom', 500))
    await renderView()
    expect(state()).toBe('failed')
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await click(container.querySelector('[data-artifacts-state="failed"] button'))
    expect(rowIds()).toEqual([id(1)])
  })
})

describe('ArtifactsView list', () => {
  it('draws every column, naming organization owners for an ownerless artifact', async () => {
    api.listArtifacts.mockResolvedValue(
      page([
        row(1, { shared: { any: true, public: true }, latest: { ...row(1).latest, fileCount: 3, totalBytes: 4096 } }),
        row(2, { owner: null, kind: 'pdf' })
      ])
    )
    await renderView()
    const [first, second] = [...container.querySelectorAll('[data-artifact-row]')]
    expect(first!.textContent).toContain('Artifact 1')
    expect(first!.textContent).toContain('Page')
    expect(first!.textContent).toContain('Atlas')
    expect(first!.textContent).toContain('Grace')
    expect(first!.textContent).toContain('4.0 KB')
    expect(first!.textContent).toContain('3 files')
    expect(first!.textContent).toContain('Public link')
    expect(second!.textContent).toContain('PDF')
    expect(second!.textContent).toContain('Organization owners')
    expect(second!.textContent).toContain('Not shared')
    expect(first!.querySelector('a')?.getAttribute('href')).toBe(`/acme/artifacts/${id(1)}`)
  })

  it('passes the URL’s filters to the list route', async () => {
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await renderView(`scope=mine&agent=${AGENT}&type=page&public=1`)
    expect(api.listArtifacts).toHaveBeenCalledWith(
      { scope: 'mine', agentId: AGENT, type: 'page', publiclyShared: true },
      { orgId: 'org-1', limit: 25 }
    )
  })

  it('writes a filter change to the URL', async () => {
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await renderView('type=page')
    await click(container.querySelector('[data-scope="mine"]'))
    expect(nav.replace).toHaveBeenLastCalledWith('/acme/artifacts?scope=mine&type=page', { scroll: false })
    await click(container.querySelector('[data-filter="public"]'))
    expect(nav.replace).toHaveBeenLastCalledWith('/acme/artifacts?type=page&public=1', { scroll: false })
  })

  it('follows short filtered pages until it has rows, then loads more on request', async () => {
    api.listArtifacts
      .mockResolvedValueOnce(page([], 'c1'))
      .mockResolvedValueOnce(page([row(1)], 'c2'))
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 30 }, (_, i) => row(i + 10)),
          'c3'
        )
      )
      .mockResolvedValueOnce(page([row(99)]))
    await renderView('type=page')
    // The empty first page and the one-row second are followed into a third, which fills the screen.
    expect(api.listArtifacts.mock.calls.map(([, opts]) => opts.cursor)).toEqual([undefined, 'c1', 'c2'])
    expect(rowIds()).toHaveLength(31)
    await click(container.querySelector('[data-artifacts-more]'))
    expect(api.listArtifacts.mock.calls.at(-1)![1]).toMatchObject({ cursor: 'c3' })
    expect(rowIds()).toHaveLength(32)
    expect(container.querySelector('[data-artifacts-more]')).toBeNull()
  })
})

describe('ArtifactsView row actions', () => {
  it('gives a member who can view only open, revisions and share', async () => {
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await renderView()
    expect(actionKeys(await openMenu('[data-artifact-row]'))).toEqual(['open', 'revisions', 'share'])
  })

  it('gives the owner the session link, rename, audience and delete', async () => {
    api.listArtifacts.mockResolvedValue(
      page([row(1, { viewerIsOwner: true, permissions: all, originSessionVisible: true })])
    )
    await renderView()
    const items = await openMenu('[data-artifact-row]')
    expect(actionKeys(items)).toEqual(['open', 'revisions', 'share', 'session', 'rename', 'audience', 'delete'])
    expect(items.find((el) => el.getAttribute('data-action') === 'session')?.getAttribute('href')).toBe(
      '/acme/sessions/session-1'
    )
  })

  it('shows a fixed audience as unavailable, with the reason', async () => {
    api.listArtifacts.mockResolvedValue(
      page([
        row(1, {
          permissions: { ...all, changeAudience: false },
          audience: { visibility: 'external', externalProvider: 'slack', editorsAgentId: null }
        })
      ])
    )
    await renderView()
    const audience = (await openMenu('[data-artifact-row]')).find((el) => el.getAttribute('data-action') === 'audience')
    expect((audience as HTMLButtonElement).disabled).toBe(true)
    expect(audience!.textContent).toContain('can’t be changed')
  })

  it('renames and re-reads the list', async () => {
    api.listArtifacts.mockResolvedValue(page([row(1, { permissions: all })]))
    api.updateArtifact.mockResolvedValue({})
    await renderView()
    const rename = (await openMenu('[data-artifact-row]')).find((el) => el.getAttribute('data-action') === 'rename')
    await click(rename)
    const input = document.body.querySelector<HTMLInputElement>('[data-artifact-dialog="rename"] input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Launch plan')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const calls = api.listArtifacts.mock.calls.length
    await click(
      [...document.body.querySelectorAll('[data-artifact-dialog="rename"] .modalfoot button')].find(
        (el) => el.textContent === 'Save'
      )
    )
    expect(api.updateArtifact).toHaveBeenCalledWith(id(1), { title: 'Launch plan' })
    expect(api.listArtifacts.mock.calls.length).toBeGreaterThan(calls)
  })

  it('changes the audience to the organization', async () => {
    api.listArtifacts.mockResolvedValue(
      page([
        row(1, { permissions: all, audience: { visibility: 'private', externalProvider: null, editorsAgentId: null } })
      ])
    )
    api.updateArtifact.mockResolvedValue({})
    await renderView()
    await click((await openMenu('[data-artifact-row]')).find((el) => el.getAttribute('data-action') === 'audience'))
    await click(document.body.querySelector('[data-audience="org"]'))
    await click(
      [...document.body.querySelectorAll('[data-artifact-dialog="audience"] .modalfoot button')].find(
        (el) => el.textContent === 'Save'
      )
    )
    expect(api.updateArtifact).toHaveBeenCalledWith(id(1), { audience: 'org' })
  })

  it('confirms a delete as final before deleting', async () => {
    api.listArtifacts.mockResolvedValueOnce(page([row(1, { permissions: all }), row(2)]))
    api.deleteArtifact.mockResolvedValue(undefined)
    await renderView()
    await click(
      (await openMenu(`[data-artifact-row="${id(1)}"]`)).find((el) => el.getAttribute('data-action') === 'delete')
    )
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('every revision of it, and every share link to it')
    expect(dialog.textContent).toContain('can’t be undone')
    expect(api.deleteArtifact).not.toHaveBeenCalled()
    api.listArtifacts.mockResolvedValue(page([row(2)]))
    await click([...dialog.querySelectorAll('button')].find((el) => el.textContent === 'Delete artifact'))
    expect(api.deleteArtifact).toHaveBeenCalledWith(id(1))
    expect(rowIds()).toEqual([id(2)])
  })

  it('opens the actions in a bottom sheet on a phone', async () => {
    env.mobile = true
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await renderView()
    await click(container.querySelector('[data-artifact-actions]'))
    const sheet = container.querySelector('[data-artifact-actions-sheet]')
    expect(sheet).toBeTruthy()
    expect(actionKeys([...sheet!.querySelectorAll('[data-action]')])).toEqual(['open', 'revisions', 'share'])
  })
})

describe('ArtifactsView public links', () => {
  it('hides the public-links tab from anyone but an organization owner', async () => {
    api.listArtifacts.mockResolvedValue(page([row(1)]))
    await renderView('tab=public')
    expect(container.querySelector('[data-artifacts-tab]')).toBeNull()
    expect(api.listOrgArtifactShares).not.toHaveBeenCalled()
    expect(rowIds()).toEqual([id(1)])
  })

  it('lists public links for an organization owner, with revoke and delete even where they cannot open', async () => {
    env.role = 'owner'
    api.listOrgArtifactShares.mockResolvedValue({ shares: [share(1, false), share(2, true)], nextCursor: null })
    api.revokeArtifactShare.mockResolvedValue(undefined)
    await renderView('tab=public')
    expect(container.querySelector('[data-artifacts-tab="public"]')?.className).toContain('on')
    const [hidden, visible] = [...container.querySelectorAll('[data-public-share]')]
    expect(hidden!.textContent).toContain('Shared 1')
    expect(hidden!.textContent).toContain('Organization owners')
    expect(hidden!.textContent).toContain('Grace')
    expect(hidden!.querySelector('a')).toBeNull()
    expect(visible!.querySelector('a')?.getAttribute('href')).toBe(`/acme/artifacts/${id(2)}?revision=1`)

    const items = await openMenu('[data-public-share="share-1"]')
    expect(actionKeys(items)).toEqual(['revoke', 'delete'])
    await click(items[0])
    api.listOrgArtifactShares.mockResolvedValue({ shares: [share(2, true)], nextCursor: null })
    await click(
      [...document.body.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent === 'Revoke link')
    )
    expect(api.revokeArtifactShare).toHaveBeenCalledWith(id(1), 'share-1')
    expect(container.querySelectorAll('[data-public-share]')).toHaveLength(1)
  })

  it('shows the empty public-links state', async () => {
    env.role = 'owner'
    api.listOrgArtifactShares.mockResolvedValue({ shares: [], nextCursor: null })
    await renderView('tab=public')
    expect(state()).toBe('empty')
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactShareDto, CreatedArtifactShareDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), revoke: vi.fn() }))
const who = vi.hoisted(() => ({ role: 'collaborator' as string | null, userId: 'user-2' }))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  listArtifactShares: api.list,
  createArtifactShare: api.create,
  updateArtifactShare: api.update,
  revokeArtifactShare: api.revoke
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', name: 'Example Org', slug: 'example' }, myRole: who.role })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { userId: who.userId } }) }))

import { ApiError } from '@/lib/api'
import { ArtifactShareDialog } from './ArtifactShareDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const share = (id: string, over: Partial<ArtifactShareDto> = {}): ArtifactShareDto => ({
  id,
  artifactId: ID,
  revision: 2,
  audience: 'org',
  displayTail: `…${id.slice(-6)}`,
  createdBy: { userId: 'user-9', displayName: 'Robin', email: null, platform: null },
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  revokedAt: null,
  ...over
})

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function open(viewerIsOwner = false) {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ArtifactShareDialog
          artifact={{ id: ID, title: 'Release notes', viewerIsOwner }}
          revision={3}
          onClose={onClose}
        />
      </SWRConfig>
    )
  })
  await settle()
}

const dialog = () => document.querySelector<HTMLElement>('[data-artifact-share-dialog]')!
const button = (text: string, scope: ParentNode = dialog()) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
const choice = (audience: string) => dialog().querySelector<HTMLButtonElement>(`[data-share-audience="${audience}"]`)!
const row = (id: string) => dialog().querySelector<HTMLElement>(`[data-artifact-share="${id}"]`)!
async function click(target: HTMLElement | undefined) {
  expect(target).toBeDefined()
  await act(async () => target!.click())
  await settle()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  who.role = 'collaborator'
  who.userId = 'user-2'
  api.list.mockReset().mockResolvedValue([])
  api.create.mockReset()
  api.update.mockReset()
  api.revoke.mockReset()
  onClose.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('a member who is not the owner', () => {
  it('can create an organization link but sees why a public one is not theirs to make', async () => {
    await open()
    expect(choice('org').disabled).toBe(false)
    expect(choice('org').getAttribute('aria-checked')).toBe('true')
    expect(choice('public').disabled).toBe(true)
    expect(choice('public').textContent).toContain(
      'Only the artifact’s owner or an organization owner can share it with anyone.'
    )
    expect(dialog().textContent).toContain('Everyone in Example Org')
  })

  it('lists every link with its revision, creator and date, and offers revoke only on their own', async () => {
    api.list.mockResolvedValue([
      share('share-aaaaaa', { audience: 'public' }),
      share('share-bbbbbb', { createdBy: { userId: 'user-2', displayName: 'Me', email: null, platform: null } })
    ])
    await open()
    const theirs = row('share-aaaaaa')
    expect(theirs.textContent).toContain('Anyone with the link')
    expect(theirs.textContent).toContain('…aaaaaa')
    expect(theirs.textContent).toContain('r2 · Robin · Nov 20, 2026')
    expect(button('Revoke', theirs)).toBeUndefined()
    expect(button('Limit to members', theirs)).toBeUndefined()
    const mine = row('share-bbbbbb')
    expect(mine.textContent).toContain('r2 · You')
    expect(button('Revoke', mine)).toBeDefined()
    expect(button('Make public', mine)).toBeUndefined()
  })

  it('surfaces a refused revoke and keeps the link listed', async () => {
    api.list.mockResolvedValue([
      share('share-bbbbbb', { createdBy: { userId: 'user-2', displayName: null, email: null, platform: null } })
    ])
    api.revoke.mockRejectedValue(new ApiError('nope', 403, 'ARTIFACT_SHARE_FORBIDDEN'))
    await open()
    await click(button('Revoke', row('share-bbbbbb')))
    await click(button('Revoke', row('share-bbbbbb').querySelector('[data-artifact-share-confirm]')!))
    expect(row('share-bbbbbb').querySelector('[role="alert"]')!.textContent).toBe(
      'Only the artifact’s owner or an organization owner can do this.'
    )
  })
})

describe('the owner', () => {
  it('is told copies cannot be recalled before creating a public link, then copies the link shown once', async () => {
    const created: CreatedArtifactShareDto = {
      ...share('share-cccccc', {
        revision: 3,
        audience: 'public',
        createdBy: { userId: 'user-2', displayName: null, email: null, platform: null }
      }),
      token: 'tok',
      linkPath: '/share/tok',
      link: 'https://console.example.test/share/tok'
    }
    api.create.mockResolvedValue(created)
    await open(true)
    expect(dialog().querySelector('[data-artifact-share-recall]')).toBeNull()
    await click(choice('public'))
    expect(dialog().querySelector('[data-artifact-share-recall]')!.textContent).toContain(
      'Copies already downloaded can’t be recalled'
    )
    await click(button('Create public link'))
    expect(api.create).toHaveBeenCalledWith(ID, { revision: 3, audience: 'public' })
    const shown = dialog().querySelector<HTMLInputElement>('[data-artifact-share-created] input')!
    expect(shown.value).toBe('https://console.example.test/share/tok')
    await click(button('Copy'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://console.example.test/share/tok')
    expect(button('Copied')).toBeDefined()
    expect(row('share-cccccc').textContent).toContain('r3 · You')
  })

  it('confirms before making an existing link public, and narrows one at once', async () => {
    api.list.mockResolvedValue([share('share-aaaaaa'), share('share-dddddd', { audience: 'public' })])
    api.update.mockImplementation(async (_id: string, shareId: string, audience: 'public' | 'org') =>
      share(shareId, { audience })
    )
    await open(true)
    await click(button('Make public', row('share-aaaaaa')))
    expect(api.update).not.toHaveBeenCalled()
    const confirm = row('share-aaaaaa').querySelector<HTMLElement>('[data-artifact-share-confirm="public"]')!
    expect(confirm.textContent).toContain('Copies already downloaded can’t be recalled')
    await click(button('Make public', confirm))
    expect(api.update).toHaveBeenCalledWith(ID, 'share-aaaaaa', 'public')
    expect(row('share-aaaaaa').textContent).toContain('Anyone with the link')

    await click(button('Limit to members', row('share-dddddd')))
    expect(api.update).toHaveBeenCalledWith(ID, 'share-dddddd', 'org')
  })

  it('revokes a link after confirming, and drops it from the list', async () => {
    api.list.mockResolvedValue([share('share-aaaaaa')])
    api.revoke.mockResolvedValue(undefined)
    await open(true)
    await click(button('Revoke', row('share-aaaaaa')))
    expect(row('share-aaaaaa').textContent).toContain('It will stop working immediately')
    await click(button('Revoke', row('share-aaaaaa').querySelector('[data-artifact-share-confirm]')!))
    expect(api.revoke).toHaveBeenCalledWith(ID, 'share-aaaaaa')
    expect(dialog().querySelector('[data-artifact-share="share-aaaaaa"]')).toBeNull()
    expect(dialog().textContent).toContain('No links yet.')
  })

  it('stops offering a public link once the server refuses one', async () => {
    who.role = 'owner'
    api.create.mockRejectedValue(new ApiError('nope', 403, 'ARTIFACT_SHARE_FORBIDDEN'))
    await open()
    await click(choice('public'))
    await click(button('Create public link'))
    expect(choice('public').disabled).toBe(true)
    expect(choice('org').getAttribute('aria-checked')).toBe('true')
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(
      'Only the artifact’s owner or an organization owner can do this.'
    )
  })
})

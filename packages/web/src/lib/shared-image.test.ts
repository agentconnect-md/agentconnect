import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ resolve: vi.fn(), download: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, resolveSharedImageOriginal: api.resolve, downloadSessionFile: api.download }
})

import { ApiError } from '@/lib/api'
import {
  applyImageUpdate,
  currentImageState,
  fetchOriginal,
  originalName,
  originalReachable,
  originalStatusKey,
  OriginalError,
  publishImageState,
  resetImageStates,
  type SharedImageState
} from './shared-image'
import { applyImageUpdateToSteps, upsertImageStep } from './shared-image-steps'
import type { SessionStep } from './data'

const POST = '11111111-1111-4111-8111-111111111111'
const ATT = '22222222-2222-4222-8222-222222222222'
const ORIGINAL = new Uint8Array(new TextEncoder().encode('the full-resolution original'))

async function hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

const preview = { name: 'chart.png', mimeType: 'image/png' as const, data: btoa('preview-bytes') }

async function cached(status: 'pending' | 'ready' | 'upload_failed' | 'expired' = 'ready'): Promise<SharedImageState> {
  return {
    attachment: preview,
    original: {
      kind: 'cache',
      attachmentId: ATT,
      mimeType: 'image/png',
      bytes: ORIGINAL.byteLength,
      sha256: await hex(ORIGINAL),
      status
    },
    revision: 1
  }
}

const later = new Date(Date.now() + 10 * 60_000).toISOString()

beforeEach(() => {
  api.resolve.mockReset()
  api.download.mockReset()
  resetImageStates()
})
afterEach(() => vi.restoreAllMocks())

describe('original state', () => {
  it('ignores an update older than the state it holds', async () => {
    const held = { ...(await cached('ready')), revision: 3 }
    expect(applyImageUpdate(held, { revision: 2, original: { kind: 'workspace' } })).toBe(held)
    expect(applyImageUpdate(held, { revision: 4, original: { kind: 'workspace' } }).original).toEqual({
      kind: 'workspace'
    })
  })

  it('lets every surface showing a post see its newest published state', async () => {
    const base = await cached('pending')
    publishImageState(POST, { ...(await cached('ready')), revision: 2 })
    expect(currentImageState(POST, base).original).toMatchObject({ status: 'ready' })
    publishImageState(POST, { ...(await cached('upload_failed')), revision: 1 })
    expect(currentImageState(POST, base).revision).toBe(2)
  })

  it('labels each original state the card cannot simply offer', async () => {
    expect(originalStatusKey({ kind: 'inline' })).toBeUndefined()
    expect(originalStatusKey((await cached('pending')).original)).toBe('originalUploading')
    expect(originalStatusKey((await cached('upload_failed')).original)).toBe('originalUploadFailed')
    expect(originalStatusKey((await cached('expired')).original)).toBe('originalExpired')
  })

  it('offers a failed upload only through the workspace original behind its marker', async () => {
    const state = await cached('upload_failed')
    expect(originalReachable({ state })).toBe(false)
    const file = { path: 'out/chart.png', name: 'chart.png', mimeType: 'image/png', bytes: 9, sha256: 'ab'.repeat(8) }
    expect(originalReachable({ state, file, agentId: 'a', sessionId: 's' })).toBe(true)
  })

  it('names the download after the cached original, then the marker, then the preview', async () => {
    const state = await cached()
    expect(originalName({ state })).toBe('chart.png')
    const named = { ...state, original: { ...state.original, name: 'final.png' } } as SharedImageState
    expect(originalName({ state: named })).toBe('final.png')
  })
})

describe('fetchOriginal', () => {
  it('serves an inline original from the preview bytes without a network request', async () => {
    const fetcher = vi.fn()
    const blob = await fetchOriginal(
      { state: { attachment: preview, original: { kind: 'inline' }, revision: 0 } },
      fetcher
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(await blob.text()).toBe('preview-bytes')
    expect(blob.type).toBe('image/png')
  })

  it('uses a fresh signed GET and returns the verified original bytes', async () => {
    const state = { ...(await cached()), download: { url: 'https://store.example.test/o', expiresAt: later } }
    const fetcher = vi.fn(async () => new Response(ORIGINAL))
    const blob = await fetchOriginal({ postId: POST, state, sessionId: 's' }, fetcher)
    expect(fetcher).toHaveBeenCalledWith('https://store.example.test/o', expect.anything())
    expect(api.resolve).not.toHaveBeenCalled()
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(ORIGINAL)
  })

  it('refuses bytes whose digest does not match the shared original', async () => {
    const state = { ...(await cached()), download: { url: 'https://store.example.test/o', expiresAt: later } }
    const tampered = new Uint8Array(ORIGINAL)
    tampered[0] = 0
    const fetcher = vi.fn(async () => new Response(tampered))
    await expect(fetchOriginal({ state, sessionId: 's' }, fetcher)).rejects.toMatchObject({ refusal: 'changed' })
  })

  it('renews an expired URL through the resolver and publishes what it learned', async () => {
    const state = {
      ...(await cached()),
      download: { url: 'https://store.example.test/old', expiresAt: new Date(0).toISOString() }
    }
    api.resolve.mockResolvedValue({
      original: state.original,
      download: { url: 'https://store.example.test/new', expiresAt: later }
    })
    const fetcher = vi.fn(async () => new Response(ORIGINAL))
    await fetchOriginal({ postId: POST, state, sessionId: 'session-1' }, fetcher)
    expect(api.resolve).toHaveBeenCalledWith('session-1', ATT)
    expect(fetcher).toHaveBeenCalledWith('https://store.example.test/new', expect.anything())
    expect(currentImageState(POST, state).download?.url).toBe('https://store.example.test/new')
  })

  it('reports an expired original the resolver found missing, and the card learns it', async () => {
    const state = await cached()
    api.resolve.mockResolvedValue({ original: { ...state.original, status: 'expired' } })
    const err = await fetchOriginal({ postId: POST, state, sessionId: 's' }, vi.fn()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OriginalError)
    expect((err as OriginalError).refusal).toBe('expired')
    expect(currentImageState(POST, state).original).toMatchObject({ status: 'expired' })
  })

  it('cannot resolve a cached original without the author session', async () => {
    await expect(fetchOriginal({ state: await cached() }, vi.fn())).rejects.toMatchObject({ refusal: 'unavailable' })
  })

  it('falls back to the digest-pinned workspace download when there is no cached copy', async () => {
    const file = { path: 'out/chart.png', name: 'chart.png', mimeType: 'image/png', bytes: 9, sha256: 'ab'.repeat(8) }
    api.download.mockResolvedValue(new Blob(['ws']))
    const state: SharedImageState = { attachment: preview, original: { kind: 'workspace' }, revision: 0 }
    const blob = await fetchOriginal({ state, file, agentId: 'agent-1', sessionId: 'session-1' })
    expect(api.download).toHaveBeenCalledWith('agent-1', {
      sessionId: 'session-1',
      path: 'out/chart.png',
      sha256: file.sha256
    })
    expect(blob.type).toBe('image/png')
    api.download.mockRejectedValue(new ApiError('changed', 409, 'WORKSPACE_FILE_CHANGED'))
    await expect(fetchOriginal({ state, file, agentId: 'agent-1', sessionId: 'session-1' })).rejects.toMatchObject({
      refusal: 'changed'
    })
  })
})

describe('image steps', () => {
  const step = (state: SharedImageState): SessionStep => ({
    kind: 'done',
    turnId: 't',
    text: 'caption',
    postId: POST,
    segmentId: POST,
    sharedImage: state
  })

  it('keeps one card per post whichever copy lands first', async () => {
    const first = upsertImageStep([], step(await cached('pending')))
    const again = upsertImageStep(first, step(await cached('pending')))
    expect(again).toBe(first)
    const newer = upsertImageStep(first, step({ ...(await cached('ready')), revision: 2 }))
    expect(newer).toHaveLength(1)
    expect(newer[0]!.sharedImage?.original).toMatchObject({ status: 'ready' })
  })

  it('applies an update to its own post and ignores a stale one', async () => {
    const steps = [step(await cached('pending'))]
    const ready = applyImageUpdateToSteps(steps, {
      conversationId: POST,
      agentId: POST,
      postId: POST,
      revision: 2,
      original: (await cached('ready')).original
    })
    expect(ready[0]!.sharedImage?.revision).toBe(2)
    const stale = applyImageUpdateToSteps(ready, {
      conversationId: POST,
      agentId: POST,
      postId: POST,
      revision: 1,
      original: (await cached('upload_failed')).original
    })
    expect(stale).toBe(ready)
  })
})

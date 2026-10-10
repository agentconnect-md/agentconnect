import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { RdWebchatPost, SharedImage, WebchatImageUpdate, WebchatOutput } from '@agentconnect.md/protocol'
import { LocalStore } from '../src/store/local-store.js'
import {
  displayedSharedImage,
  previewByteBudget,
  publishWebchatSharedImage,
  resolveSharedImageOriginal,
  SharedImagePublishError,
  sweepSharedImageStaging,
  type SharedImagePublisherDeps,
  type SharedImageTurn
} from '../src/webchat/shared-image.js'
import type { WebchatTurnOutput } from '../src/webchat/turn-output.js'
import { closeWebchatSegmentForImage } from '../src/webchat/turn-output.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const TURN = '33333333-3333-4333-8333-333333333333'
const SHA = 'c'.repeat(64)
const quietLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

async function openStore(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-shared-image-')), 'local.sqlite'))
}

function turnOutput(): { wc: WebchatTurnOutput; outputs: WebchatOutput[]; posts: RdWebchatPost[] } {
  const outputs: WebchatOutput[] = []
  const posts: RdWebchatPost[] = []
  const wc = {
    conversationId: CONVERSATION,
    turnId: TURN,
    sink: { output: (o: WebchatOutput) => void outputs.push(o), done: vi.fn() },
    postSink: (post: RdWebchatPost) => void posts.push(post),
    index: 0,
    replyText: '',
    replySegments: [],
    heldText: '',
    messageEmitted: false
  } as WebchatTurnOutput
  return { wc, outputs, posts }
}

function turnFor(wc: WebchatTurnOutput, over: Partial<SharedImageTurn> = {}): SharedImageTurn {
  return {
    agentId: AGENT,
    outwardSessionId: 'session-1',
    transcriptChannel: CONVERSATION,
    thread: `webchat:${CONVERSATION}`,
    admission: { agentId: AGENT, sessionKey: 'k1' },
    wc,
    stillPublishable: () => true,
    ...over
  }
}

const inlinePrepared = {
  ok: true as const,
  inline: true,
  original: { mimeType: 'image/png' as const, name: 'chart.png' },
  preview: { mimeType: 'image/png' as const, name: 'chart.png', data: Buffer.from('PNG'), width: 4, height: 3 }
}
const reducedPrepared = { ...inlinePrepared, inline: false }

function deps(store: LocalStore, over: Partial<SharedImagePublisherDeps> = {}) {
  const updates: WebchatImageUpdate[] = []
  const d: SharedImagePublisherDeps = {
    store,
    prepare: vi.fn(async () => inlinePrepared),
    fileTransfer: () => undefined,
    signPut: vi.fn(async () => {
      throw new Error('no bucket')
    }),
    signGet: vi.fn(async () => ({ missing: true })),
    network: () => 'public',
    stagingRoot: join(mkdtempSync(join(tmpdir(), 'ac-shared-image-staging-')), 'staging'),
    sendUpdate: (update) => void updates.push(update),
    log: quietLog,
    ...over
  }
  return { d, updates }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

/** A bucket stand-in that accepts or refuses one PUT and records the bytes it received. */
async function bucket(status: number): Promise<{ url: string; received: () => Buffer }> {
  const chunks: Buffer[] = []
  server = createServer((req, res) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.statusCode = status
      res.end()
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/object`, received: () => Buffer.concat(chunks) }
}

describe('publishWebchatSharedImage', () => {
  it('commits the card before emitting it and returns a receipt without image bytes', async () => {
    const store = await openStore()
    const { d } = deps(store)
    const { wc, outputs, posts } = turnOutput()
    const receipt = await publishWebchatSharedImage(d, turnFor(wc), {
      path: 'outputs/images/chart.png',
      caption: 'Revenue',
      bytes: Buffer.from('PNG'),
      sha256: SHA
    })

    expect(receipt).toMatchObject({
      type: 'agentconnect.image',
      version: 1,
      published: true,
      original: { kind: 'inline' }
    })
    expect(JSON.stringify(receipt)).not.toContain(Buffer.from('PNG').toString('base64'))
    const stored = await store.transcriptSharedImage(CONVERSATION, receipt.postId)
    expect(stored).toMatchObject({ original: { kind: 'inline' }, revision: 0, attachment: { mimeType: 'image/png' } })

    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.event).toMatchObject({
      kind: 'image',
      postId: receipt.postId,
      text: 'Revenue\n[shared: outputs/images/chart.png (image/png, 3 bytes, sha256:cccccccccccccccc)]',
      original: { kind: 'inline' }
    })
    // Transcript-only for peers: no hop depth, so the post can never wake another agent.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.post.author).toEqual({ kind: 'agent', agentId: AGENT })
    expect(posts[0]!.post.image?.attachment.data).toBe(Buffer.from('PNG').toString('base64'))
    await store.close()
  })

  it('keeps a large original in the workspace without a transfer cache', async () => {
    const store = await openStore()
    const { d } = deps(store, { prepare: vi.fn(async () => reducedPrepared) })
    const { wc } = turnOutput()
    const receipt = await publishWebchatSharedImage(d, turnFor(wc), {
      path: 'big.png',
      bytes: Buffer.alloc(400_000),
      sha256: SHA
    })
    expect(receipt.original).toEqual({ kind: 'workspace' })
    expect(d.signPut).not.toHaveBeenCalled()
    await store.close()
  })

  it('uploads a cached original after the card and updates the same post to ready', async () => {
    const store = await openStore()
    const target = await bucket(200)
    const bytes = Buffer.from('large original bytes')
    const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    const { d, updates } = deps(store, {
      prepare: vi.fn(async () => reducedPrepared),
      fileTransfer: () => ({ maxBytes: 1024 * 1024 }),
      signPut: vi.fn(async () => ({ url: target.url, headers: {} })),
      signGet: vi.fn(async () => ({ url: 'https://bucket.example.test/get', expiresAt: Date.UTC(2030, 0, 1) }))
    })
    const { wc, outputs } = turnOutput()
    const receipt = await publishWebchatSharedImage(d, turnFor(wc), { path: 'big.png', bytes, sha256: sha })

    expect(receipt.original).toMatchObject({ kind: 'cache', status: 'pending' })
    expect(outputs[0]!.event).toMatchObject({ kind: 'image', original: { kind: 'cache', status: 'pending' } })
    await waitFor(() => updates.length === 1)
    expect(updates[0]).toMatchObject({
      conversationId: CONVERSATION,
      postId: receipt.postId,
      revision: 1,
      original: { kind: 'cache', status: 'ready', sha256: sha },
      download: { url: 'https://bucket.example.test/get', expiresAt: '2030-01-01T00:00:00.000Z' }
    })
    expect(target.received()).toEqual(bytes)
    expect(d.signPut).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: bytes.byteLength, sha256: Buffer.from(sha, 'hex').toString('base64') })
    )
    // The signed URL is never persisted.
    const stored = await store.transcriptSharedImage(CONVERSATION, receipt.postId)
    expect(stored).toMatchObject({ revision: 1, original: { status: 'ready' } })
    expect(JSON.stringify(stored)).not.toContain('bucket.example.test')
    await store.close()
  })

  it('marks a failed upload without withdrawing the preview', async () => {
    const store = await openStore()
    const target = await bucket(403)
    const { d, updates } = deps(store, {
      prepare: vi.fn(async () => reducedPrepared),
      fileTransfer: () => ({ maxBytes: 1024 * 1024 }),
      signPut: vi.fn(async () => ({ url: target.url, headers: {} }))
    })
    const { wc } = turnOutput()
    const receipt = await publishWebchatSharedImage(d, turnFor(wc), {
      path: 'big.png',
      bytes: Buffer.from('x'.repeat(10)),
      sha256: SHA
    })
    await waitFor(() => updates.length === 1)
    expect(updates[0]).toMatchObject({ revision: 1, original: { status: 'upload_failed' } })
    expect(updates[0]!.download).toBeUndefined()
    const stored = await store.transcriptSharedImage(CONVERSATION, receipt.postId)
    expect(stored?.attachment.data).toBe(Buffer.from('PNG').toString('base64'))
    await store.close()
  })

  it('publishes nothing when the turn ends before commit', async () => {
    const store = await openStore()
    const { d } = deps(store)
    const { wc, outputs, posts } = turnOutput()
    await expect(
      publishWebchatSharedImage(d, turnFor(wc, { stillPublishable: () => false }), {
        path: 'chart.png',
        bytes: Buffer.from('PNG'),
        sha256: SHA
      })
    ).rejects.toBeInstanceOf(SharedImagePublishError)
    expect(outputs).toHaveLength(0)
    expect(posts).toHaveLength(0)
    await store.close()
  })

  it('names a preview refusal', async () => {
    const store = await openStore()
    const { d } = deps(store, { prepare: vi.fn(async () => ({ ok: false as const, reason: 'unsafe-svg' as const })) })
    const { wc } = turnOutput()
    await expect(
      publishWebchatSharedImage(d, turnFor(wc), { path: 'd.svg', bytes: Buffer.from('<svg/>'), sha256: SHA })
    ).rejects.toThrow(/self-contained static SVG/)
    await store.close()
  })

  it('sweeps staging an earlier process left behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-shared-image-sweep-'))
    mkdirSync(join(root, 'original-abc'))
    writeFileSync(join(root, 'original-abc', 'original'), 'x')
    writeFileSync(join(root, 'keep.txt'), 'x')
    await sweepSharedImageStaging(root)
    expect(readdirSync(root)).toEqual(['keep.txt'])
  })

  it('budgets the preview against the carrier frame', () => {
    expect(previewByteBudget('short')).toBe(160 * 1024)
    expect(previewByteBudget('x'.repeat(200_000))).toBeLessThan(48 * 1024)
  })
})

describe('closeWebchatSegmentForImage', () => {
  it('flushes held text and pins earlier segments ahead of the card', () => {
    const { wc, outputs } = turnOutput()
    wc.replySegments.push({ postId: '44444444-4444-4444-8444-444444444444', text: 'Here [it' })
    wc.segmentIndex = 0
    wc.replyText = 'Here [it'
    wc.heldText = 'Here [it'
    wc.heldTextOffset = 4
    closeWebchatSegmentForImage(wc)
    expect(wc.segmentIndex).toBeUndefined()
    expect(wc.replySegments[0]!.at).toMatch(/^\d+$/)
    expect(outputs.map((o) => o.event?.kind)).toEqual(['message'])
  })
})

describe('original resolution', () => {
  const cacheImage = (status: 'pending' | 'ready'): SharedImage => ({
    attachment: { name: 'p.png', mimeType: 'image/png', data: 'UE5H' },
    original: {
      kind: 'cache',
      attachmentId: '55555555-5555-4555-8555-555555555555',
      name: 'p.png',
      mimeType: 'image/png',
      bytes: 10,
      sha256: SHA,
      status
    },
    revision: 0
  })

  it('reads a pending original with no live delivery as unavailable', () => {
    expect(displayedSharedImage(cacheImage('pending')).original).toMatchObject({ status: 'unavailable' })
    expect(displayedSharedImage(cacheImage('ready')).original).toMatchObject({ status: 'ready' })
  })

  it('signs a fresh GET for a ready original under the console read', async () => {
    const store = await openStore()
    const { d } = deps(store, { signGet: vi.fn(async () => ({ url: 'https://bucket.example.test/g', expiresAt: 1 })) })
    const answer = await resolveSharedImageOriginal(
      d,
      { transcriptChannel: CONVERSATION, agentId: AGENT, postId: 'p', image: cacheImage('ready') },
      '66666666-6666-4666-8666-666666666666'
    )
    expect(answer.download?.url).toBe('https://bucket.example.test/g')
    expect(d.signGet).toHaveBeenCalledWith(
      expect.objectContaining({ resolveId: '66666666-6666-4666-8666-666666666666' })
    )
    await store.close()
  })

  it('records a missing cache object as expired and never re-uploads it', async () => {
    const store = await openStore()
    const { d, updates } = deps(store)
    const { wc } = turnOutput()
    const image = cacheImage('ready')
    await store.appendTranscript({
      channel: CONVERSATION,
      thread: `webchat:${CONVERSATION}`,
      ts: '1000',
      sender: AGENT,
      kind: 'text',
      text: 'img',
      postId: '77777777-7777-4777-8777-777777777777',
      sharedImage: image
    })
    const answer = await resolveSharedImageOriginal(
      d,
      {
        transcriptChannel: CONVERSATION,
        conversationId: wc.conversationId,
        agentId: AGENT,
        postId: '77777777-7777-4777-8777-777777777777',
        image
      },
      '66666666-6666-4666-8666-666666666666'
    )
    expect(answer.original).toMatchObject({ status: 'expired' })
    expect(updates).toEqual([
      expect.objectContaining({ revision: 1, original: expect.objectContaining({ status: 'expired' }) })
    ])
    expect(d.signPut).not.toHaveBeenCalled()
    const found = await store.transcriptSharedImageByAttachment(CONVERSATION, '55555555-5555-4555-8555-555555555555')
    expect(found).toMatchObject({ sender: AGENT, image: { revision: 1, original: { status: 'expired' } } })
    await store.close()
  })
})

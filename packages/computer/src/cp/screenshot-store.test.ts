import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerScreenshotPut } from '@agentconnect.md/protocol/computer'
import { ScreenshotStore, type ScreenshotSignResult, type ScreenshotStoreDeps } from './screenshot-store.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-0000000000aa'
const PNG = Buffer.from('fake png bytes')
const SHA = createHash('sha256').update(PNG).digest('hex')
const agent = { agentId: AGENT, sessionId: 'sess-1' }

const screenshot = (bytes = PNG) => ({
  content: [
    { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: JSON.stringify({ width: 1280, height: 800 }) }
  ]
})

function store(over: Partial<ScreenshotStoreDeps> = {}) {
  const puts: ComputerScreenshotPut[] = []
  const uploads: { url: string; headers: Record<string, string>; body: Buffer }[] = []
  const sign = vi.fn(async (put: ComputerScreenshotPut): Promise<ScreenshotSignResult> => {
    puts.push(put)
    return {
      status: 'upload',
      url: 'https://store.example.test/key?sig=1',
      headers: { 'content-length': String(put.bytes) }
    }
  })
  const commit = vi.fn(async () => true as boolean | 'retry')
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    uploads.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body as Buffer })
    return new Response(null, { status: 200 })
  })
  const s = new ScreenshotStore({
    retentionDays: () => 30,
    computerId: () => COMPUTER,
    sign,
    commit,
    log: () => {},
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => Date.UTC(2026, 9, 21),
    retryMs: 1,
    ...over
  })
  return { s, sign, commit, fetch, puts, uploads }
}

describe('ScreenshotStore', () => {
  it('names an agent session’s screenshot by its hash in the output and uploads it', async () => {
    const { s, puts, uploads, commit } = store()
    const stored = s.stash(screenshot(), agent)!
    expect(stored.ref).toBe(`sha256:${SHA}`)
    // The reference comes first, so a preview that cuts the image bytes keeps it.
    expect(JSON.parse(stored.output.content[0]!.text!)).toEqual({ computer: COMPUTER, stored: `sha256:${SHA}` })
    // The image and its description are still returned to the agent as they were.
    expect(stored.output.content.slice(1)).toEqual(screenshot().content)
    await s.flush()
    expect(puts).toEqual([
      {
        sessionId: 'sess-1',
        agentId: AGENT,
        sha256: SHA,
        bytes: PNG.length,
        contentType: 'image/png',
        takenAt: '2026-10-21T00:00:00.000Z'
      }
    ])
    expect(uploads[0]).toMatchObject({
      url: 'https://store.example.test/key?sig=1',
      headers: { 'content-length': String(PNG.length) }
    })
    expect(Buffer.compare(uploads[0]!.body, PNG)).toBe(0)
    expect(commit).toHaveBeenCalledWith({ sessionId: 'sess-1', sha256: SHA })
    expect(s.pending).toBe(0)
  })

  it('stores nothing with a retention of 0, for a local client, or before registration', async () => {
    expect(store({ retentionDays: () => 0 }).s.stash(screenshot(), agent)).toBeUndefined()
    expect(store().s.stash(screenshot(), {})).toBeUndefined()
    expect(store({ computerId: () => undefined }).s.stash(screenshot(), agent)).toBeUndefined()
    expect(store().s.stash({ content: [{ type: 'text', text: 'no image' }] }, agent)).toBeUndefined()
  })

  it('puts each image’s reference right before it', () => {
    const other = Buffer.from('second png')
    const output = {
      content: [
        { type: 'text', text: 'uncertain' },
        { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: other.toString('base64'), mimeType: 'image/png' }
      ]
    }
    const stored = store().s.stash(output, agent)!
    expect(stored.output.content.map((block) => block.type)).toEqual(['text', 'text', 'image', 'text', 'image'])
    expect(JSON.parse(stored.output.content[1]!.text!)).toEqual({ computer: COMPUTER, stored: `sha256:${SHA}` })
    const otherSha = createHash('sha256').update(other).digest('hex')
    expect(JSON.parse(stored.output.content[3]!.text!)).toEqual({ computer: COMPUTER, stored: `sha256:${otherSha}` })
    expect(stored.ref).toBe(`sha256:${SHA}`)
  })

  it('skips the upload of bytes the CP already holds or will not keep', async () => {
    const { s, fetch } = store({ sign: async () => ({ status: 'stored' }) })
    s.stash(screenshot(), agent)
    await s.flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(s.pending).toBe(0)
  })

  it('retries while the CP cannot sign, and gives up after a few attempts', async () => {
    let answer: ScreenshotSignResult = 'retry'
    const { s, fetch } = store({ sign: vi.fn(async () => answer) })
    s.stash(screenshot(), agent)
    await s.flush()
    expect(s.pending).toBe(1)
    answer = { status: 'upload', url: 'https://store.example.test/key', headers: {} }
    await new Promise((resolve) => setTimeout(resolve, 10))
    await s.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(s.pending).toBe(0)

    const refusing = vi.fn(async () => 'retry' as const)
    const stuck = store({ sign: refusing })
    stuck.s.stash(screenshot(), agent)
    for (let i = 0; i < 6; i++) {
      await stuck.s.flush()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(stuck.s.pending).toBe(0)
    expect(refusing).toHaveBeenCalledTimes(5)
  })

  it('leaves the next attempt to the backoff timer when a screenshot arrives during it', async () => {
    const sign = vi.fn(async () => 'retry' as const)
    const { s } = store({ sign, retryMs: 60_000 })
    s.stash(screenshot(), agent)
    await s.flush()
    expect(sign).toHaveBeenCalledTimes(1)
    for (const bytes of ['b', 'c', 'd']) s.stash(screenshot(Buffer.from(bytes)), agent)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sign).toHaveBeenCalledTimes(1)
    expect(s.pending).toBe(4)
    s.stop()
  })

  it('queues one upload per session for repeated bytes and drops the oldest beyond its bound', () => {
    const { s } = store({ sign: async () => 'retry', maxQueued: 2 })
    s.stash(screenshot(), agent)
    s.stash(screenshot(), agent)
    expect(s.pending).toBe(1)
    s.stash(screenshot(Buffer.from('second')), agent)
    s.stash(screenshot(Buffer.from('third')), agent)
    expect(s.pending).toBe(2)
    s.stop()
  })
})

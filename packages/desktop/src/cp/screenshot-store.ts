// Stores agent sessions' screenshots in the object store (computer-use.md §9): the CP signs, the bytes go straight to the bucket.
import { createHash } from 'node:crypto'
import {
  COMPUTER_SCREENSHOT_CONTENT_TYPES,
  COMPUTER_SCREENSHOT_MAX_BYTES,
  computerScreenshotRef,
  type ComputerScreenshotCommit,
  type ComputerScreenshotContentType,
  type ComputerScreenshotPut,
  type ComputerScreenshotPutOk
} from '@agentconnect.md/protocol/computer'
import type { CallContext } from '../audit.js'
import type { ToolOutput } from '../computer.js'
import type { DriverContent } from '../driver/client.js'

/** Screenshots waiting to upload beyond this drop the oldest; each holds its image in memory. */
const MAX_QUEUED = 20
const RETRY_MS = 5000
const MAX_ATTEMPTS = 5
const PUT_TIMEOUT_MS = 60_000

/** `retry` while the CP cannot answer now; `rejected` when it refused for good. */
export type ScreenshotSignResult = ComputerScreenshotPutOk | 'retry' | 'rejected'

export interface ScreenshotStoreDeps {
  /** Days the CP keeps this Computer's screenshots; 0 while none are stored or the CP does not offer storage. */
  retentionDays: () => number
  computerId: () => string | undefined
  sign: (put: ComputerScreenshotPut) => Promise<ScreenshotSignResult>
  commit: (commit: ComputerScreenshotCommit) => Promise<boolean | 'retry'>
  log: (line: string) => void
  fetch?: typeof fetch
  now?: () => number
  maxQueued?: number
  retryMs?: number
}

interface Job {
  put: ComputerScreenshotPut
  body: Buffer
  attempts: number
}

const isContentType = (value: unknown): value is ComputerScreenshotContentType =>
  (COMPUTER_SCREENSHOT_CONTENT_TYPES as readonly unknown[]).includes(value)

// The reference goes into the JSON text that describes the image, or into a text block of its own after it.
function withReference(content: DriverContent[], index: number, fields: Record<string, string>): DriverContent[] {
  const next = content[index + 1]
  if (next?.type === 'text' && next.text) {
    try {
      const parsed: unknown = JSON.parse(next.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const merged = { ...(parsed as Record<string, unknown>), ...fields }
        return content.map((block, i) => (i === index + 1 ? { type: 'text', text: JSON.stringify(merged) } : block))
      }
    } catch {
      // Not JSON: a block of its own follows instead.
    }
  }
  return [...content.slice(0, index + 1), { type: 'text', text: JSON.stringify(fields) }, ...content.slice(index + 1)]
}

export class ScreenshotStore {
  private queue: Job[] = []
  private running: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private dropped = 0
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly maxQueued: number

  constructor(private readonly deps: ScreenshotStoreDeps) {
    this.doFetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.maxQueued = deps.maxQueued ?? MAX_QUEUED
  }

  get pending(): number {
    return this.queue.length
  }

  /** Queue an agent session's screenshots for upload and name them in its output; anything else is left alone. */
  readonly stash = (output: ToolOutput, context: CallContext): { output: ToolOutput; ref?: string } | undefined => {
    const computerId = this.deps.computerId()
    if (!context.agentId || !context.sessionId || !computerId || this.deps.retentionDays() <= 0) return undefined
    let content = output.content
    let ref: string | undefined
    for (let index = content.length - 1; index >= 0; index--) {
      const block = content[index]!
      if (block.type !== 'image' || !block.data || !isContentType(block.mimeType)) continue
      const body = Buffer.from(block.data, 'base64')
      if (body.length === 0 || body.length > COMPUTER_SCREENSHOT_MAX_BYTES) continue
      const sha256 = createHash('sha256').update(body).digest('hex')
      const stored = computerScreenshotRef(sha256)
      // The first image is the call's own screenshot; the loop runs backwards so indexes stay valid.
      ref = stored
      content = withReference(content, index, { computer: computerId, stored })
      this.enqueue({
        put: {
          sessionId: context.sessionId,
          agentId: context.agentId,
          sha256,
          bytes: body.length,
          contentType: block.mimeType,
          takenAt: new Date(this.now()).toISOString()
        },
        body,
        attempts: 0
      })
    }
    if (!ref) return undefined
    return { output: { ...output, content }, ref }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Upload what is queued, oldest first, until the CP or the bucket stops taking it. */
  flush(): Promise<void> {
    this.running ??= this.drain().finally(() => (this.running = undefined))
    return this.running
  }

  private enqueue(job: Job): void {
    // The same bytes twice in a session are one object; the later offer is redundant.
    if (this.queue.some((q) => q.put.sha256 === job.put.sha256 && q.put.sessionId === job.put.sessionId)) return
    this.queue.push(job)
    if (this.queue.length > this.maxQueued) {
      this.queue.shift()
      this.dropped++
    }
    void this.flush()
  }

  private async drain(): Promise<void> {
    if (this.dropped > 0) {
      this.deps.log(`screenshots: ${this.dropped} were not stored because too many were waiting to upload`)
      this.dropped = 0
    }
    while (this.queue.length > 0) {
      const job = this.queue[0]!
      const outcome = await this.upload(job).catch((error: Error) => {
        this.deps.log(`screenshots: upload failed: ${error.message}`)
        return 'retry' as const
      })
      if (outcome === 'retry' && ++job.attempts < MAX_ATTEMPTS) return this.later()
      if (outcome === 'retry') this.deps.log(`screenshots: gave up storing ${job.put.sha256.slice(0, 12)}`)
      this.queue = this.queue.filter((q) => q !== job)
    }
  }

  private later(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.deps.retryMs ?? RETRY_MS)
    this.timer.unref?.()
  }

  private async upload(job: Job): Promise<'done' | 'retry'> {
    const signed = await this.deps.sign(job.put)
    if (signed === 'retry') return 'retry'
    if (signed === 'rejected') return 'done'
    if (signed.status !== 'upload') return 'done'
    if (!signed.url) return 'done'
    const res = await this.doFetch(signed.url, {
      method: 'PUT',
      headers: signed.headers ?? {},
      body: job.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
    })
    await res.body?.cancel().catch(() => undefined)
    if (res.status < 200 || res.status >= 300) {
      this.deps.log(`screenshots: the object store answered ${res.status}`)
      return res.status >= 500 || res.status === 429 || res.status === 403 ? 'retry' : 'done'
    }
    const committed = await this.deps.commit({ sessionId: job.put.sessionId, sha256: job.put.sha256 })
    if (committed === 'retry') return 'retry'
    if (!committed) this.deps.log(`screenshots: the Control Plane did not confirm ${job.put.sha256.slice(0, 12)}`)
    return 'done'
  }
}

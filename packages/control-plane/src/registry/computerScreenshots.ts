// Computer screenshot storage (computer-use.md §9): signs desktop uploads, confirms them, serves reads and collects expired objects.
import { randomUUID } from 'node:crypto'
import type {
  ComputerPolicy,
  ComputerScreenshotCommit,
  ComputerScreenshotPut,
  ComputerScreenshotPutOk
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import type { ComputerScreenshotRecord, ComputerScreenshotRepo, SessionRepo } from '../persistence/ports.js'
import { OrgId, SessionId } from '../domain/ids.js'
import {
  isScreenshotObjectKey,
  screenshotObjectKey,
  type ScreenshotBucket,
  type ScreenshotObjectKey,
  type SignedScreenshotUrl
} from '../computer-screenshots/bucket.js'

const DAY_MS = 86_400_000
/** An upload not confirmed within this long is collected, its object too if the PUT landed. */
export const COMPUTER_SCREENSHOT_PENDING_MS = 60 * 60_000
/** A desktop's clock may run ahead by this much before its `takenAt` is clamped to the CP's. */
const TAKEN_AT_SKEW_MS = 5 * 60_000
const REAP_BATCH = 200

export interface ComputerScreenshotsOpts {
  defaultDays: number
  maxDays: number
}

export interface ComputerScreenshotLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

/** A stored screenshot a reader may fetch: its metadata and a short-lived signed URL. */
export interface ComputerScreenshotRead {
  record: ComputerScreenshotRecord
  url: SignedScreenshotUrl
}

/** The session an offer names is not known yet, possibly still being recorded; the desktop offers it again later. */
export class ScreenshotSessionPendingError extends Error {
  constructor() {
    super('session not known yet')
  }
}

export class ComputerScreenshots {
  constructor(
    private readonly repo: ComputerScreenshotRepo,
    private readonly sessions: Pick<SessionRepo, 'get'>,
    private readonly bucket: ScreenshotBucket,
    private readonly clock: Clock,
    private readonly opts: ComputerScreenshotsOpts,
    private readonly log?: ComputerScreenshotLog
  ) {}

  /** Days this Computer's screenshots are kept: its policy's value or the deployment default, capped; 0 stores none. */
  retentionDays(policy: Pick<ComputerPolicy, 'screenshotRetentionDays'>): number {
    return Math.min(policy.screenshotRetentionDays ?? this.opts.defaultDays, this.opts.maxDays)
  }

  /** Reserve and sign one upload a desktop offers; already stored bytes and a retention of 0 need no upload. */
  async put(
    computer: {
      orgId: string
      computerId: string
      policy: Pick<ComputerPolicy, 'screenshotRetentionDays' | 'allowedAgents'>
    },
    put: ComputerScreenshotPut
  ): Promise<ComputerScreenshotPutOk> {
    const days = this.retentionDays(computer.policy)
    if (days <= 0) return { status: 'skipped', reason: 'retention is 0' }
    if (put.bytes > this.bucket.maxBytes) return { status: 'skipped', reason: 'too large' }
    // The desktop names the session, so only a session of a granted agent in this org may receive its screenshots.
    if (!computer.policy.allowedAgents.includes(put.agentId)) return { status: 'skipped', reason: 'agent not granted' }
    const session = await this.sessions.get(OrgId(computer.orgId), SessionId(put.sessionId))
    if (!session) throw new ScreenshotSessionPendingError()
    if (session.agentId !== put.agentId) return { status: 'skipped', reason: 'not this agent’s session' }
    const now = this.clock.now()
    const takenAt = new Date(Math.min(Date.parse(put.takenAt), now + TAKEN_AT_SKEW_MS))
    const reserve = () =>
      this.repo.reserve({
        id: randomUUID(),
        orgId: computer.orgId,
        computerId: computer.computerId,
        sessionId: put.sessionId,
        agentId: put.agentId,
        sha256: put.sha256,
        bytes: put.bytes,
        contentType: put.contentType,
        objectKey: screenshotObjectKey({ ...computer, ...put, takenAt }),
        takenAt,
        createdAt: new Date(now),
        expiresAt: new Date(now + days * DAY_MS)
      })
    let row = await reserve()
    // An expired copy the reaper has not reached yet is replaced, not reused.
    if (row.expiresAt.getTime() <= now) {
      await this.collect([row])
      row = await reserve()
    }
    if (row.storedAt) return { status: 'stored' }
    if (row.bytes !== put.bytes || row.contentType !== put.contentType) {
      return { status: 'skipped', reason: 'conflicting upload' }
    }
    const signed = await this.bucket.signPut({
      key: row.objectKey as ScreenshotObjectKey,
      bytes: row.bytes,
      sha256: row.sha256,
      contentType: row.contentType
    })
    return {
      status: 'upload',
      url: signed.url,
      headers: signed.headers,
      expiresAt: new Date(signed.expiresAt).toISOString()
    }
  }

  /** Confirm an upload: the object must hold exactly the announced bytes; only then is it readable and metered. */
  async commit(computerId: string, commit: ComputerScreenshotCommit): Promise<boolean> {
    const row = await this.repo.get(computerId, commit.sessionId, commit.sha256)
    if (!row) return false
    if (row.storedAt) return true
    if (!isScreenshotObjectKey(row.objectKey)) return false
    const held = await this.bucket.holds({ key: row.objectKey, bytes: row.bytes, sha256: row.sha256 })
    if (!held) return false
    await this.repo.markStored(row.id, row.orgId, row.bytes, new Date(this.clock.now()))
    return true
  }

  /** The newest stored, unexpired screenshot with this hash in the session, among the Computers `visible` admits. */
  async read(
    orgId: string,
    sessionId: string,
    sha256: string,
    visible: (computerId: string) => Promise<boolean>
  ): Promise<ComputerScreenshotRead | null> {
    const rows = await this.repo.findStored(orgId, sessionId, sha256, new Date(this.clock.now()))
    for (const record of rows) {
      if (!(await visible(record.computerId))) continue
      return { record, url: await this.sign(record) }
    }
    return null
  }

  /** A page of the session's stored screenshots, oldest first. */
  list(
    orgId: string,
    sessionId: string,
    page: { limit: number; after?: { takenAt: Date; id: string } }
  ): Promise<ComputerScreenshotRecord[]> {
    return this.repo.listStored(orgId, sessionId, new Date(this.clock.now()), page)
  }

  sign(record: ComputerScreenshotRecord): Promise<SignedScreenshotUrl> {
    if (!isScreenshotObjectKey(record.objectKey)) throw new Error('not a screenshot key')
    return this.bucket.signGet({ key: record.objectKey, contentType: record.contentType })
  }

  usage(orgId: string, window: { from: Date; to: Date }) {
    return this.repo.usage(orgId, window, new Date(this.clock.now()))
  }

  /** Shorten what a Computer's screenshots are kept to its retention now; at 0 they read as absent and are collected. */
  applyRetention(computerId: string): Promise<number> {
    return this.repo.clampExpiry({ ...this.opts, computerId })
  }

  /** One sweep: delete expired, abandoned and orphaned screenshots, objects first; returns how many rows went. */
  async reap(): Promise<number> {
    // A lowered default or maximum, or a policy change whose clamp failed, applies to what is already stored.
    await this.repo.clampExpiry(this.opts)
    const now = this.clock.now()
    let total = 0
    for (;;) {
      const rows = await this.repo.reapable(new Date(now), new Date(now - COMPUTER_SCREENSHOT_PENDING_MS), REAP_BATCH)
      if (rows.length === 0) break
      const removed = await this.collect(rows)
      total += removed
      if (removed === 0 || rows.length < REAP_BATCH) break
    }
    return total
  }

  // A row goes only once its object is gone, so a failed delete is retried on the next sweep.
  private async collect(rows: ComputerScreenshotRecord[]): Promise<number> {
    const gone: string[] = []
    for (const row of rows) {
      try {
        if (isScreenshotObjectKey(row.objectKey)) await this.bucket.delete(row.objectKey)
        gone.push(row.id)
      } catch (err) {
        this.log?.warn({ err: (err as Error).message, id: row.id }, 'computer-screenshots: object delete failed')
      }
    }
    return this.repo.deleteRows(gone)
  }
}

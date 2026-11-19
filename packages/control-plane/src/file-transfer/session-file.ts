import { randomUUID } from 'node:crypto'
import type { SessionFilePutOk, SessionFilePutReq } from '@agentconnect.md/protocol'
import { OrgId, SessionId } from '../domain/ids.js'
import type { SessionFileSnapshotRepo, SessionRepo } from '../persistence/ports.js'
import { FileTransferError, sessionFileKey, type FileTransfer, type TransferObjectKey } from './transfer.js'

// Shared-file snapshots (agent-authored-attachments.md §4.1): the CP authorizes, signs and forgets bytes; the session's end releases them.

/** A session row the reaper cannot find is released only after this long, so a snapshot never races its session's first report. */
export const SESSION_FILE_MISSING_GRACE_MS = 60 * 60_000

/** Rows one reaper pass releases. */
const REAP_BATCH = 200

/** A refusal the WS handler answers as an error frame; `retryable` separates outages from denials. */
export class SessionFileRefusal extends Error {
  constructor(
    readonly code: 'SCOPE_DENIED' | 'TOO_LARGE' | 'UNAVAILABLE',
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'SessionFileRefusal'
  }
}

/** A snapshot's short-lived download. */
export interface SessionFileDownload {
  url: string
  expiresAt: number
  name: string
  bytes: number
}

export interface SessionFileService {
  /** `session/file/put`: record and presign one snapshot's PUT; the caller has checked publication authority. */
  signPut(orgId: string, req: SessionFilePutReq): Promise<SessionFilePutOk>
  /** Record an image original kept under its own key, so it is released with its session like a snapshot. */
  retainImage(input: {
    orgId: string
    agentId: string
    sessionId: string
    key: TransferObjectKey
    bytes: number
    sha256Hex: string
  }): Promise<void>
  /** Presign the GET of a session's snapshot whose digest starts with `sha256Prefix`, or undefined when none is held. */
  download(input: {
    orgId: string
    sessionId: string
    sha256Prefix: string
    name?: string
  }): Promise<SessionFileDownload | undefined>
  /** Delete the objects, then the rows, of snapshots whose session is purged or gone; returns how many. */
  reap(): Promise<number>
}

const hexOf = (base64: string): string => Buffer.from(base64, 'base64').toString('hex')

export function createSessionFileService(deps: {
  transfer?: FileTransfer
  snapshots: SessionFileSnapshotRepo
  sessions: Pick<SessionRepo, 'get'>
  now?: () => number
}): SessionFileService {
  const { transfer, snapshots, sessions } = deps
  const now = deps.now ?? Date.now

  const requireTransfer = (): FileTransfer => {
    if (!transfer) throw new SessionFileRefusal('SCOPE_DENIED', 'this deployment has no bucket for file transfers')
    if (!transfer.enabled()) throw new SessionFileRefusal('UNAVAILABLE', 'the transfer bucket is unavailable', true)
    return transfer
  }

  const refusalOf = (err: unknown): unknown =>
    err instanceof FileTransferError
      ? new SessionFileRefusal(
          err.reason === 'too-large' ? 'TOO_LARGE' : 'UNAVAILABLE',
          err.message,
          err.reason === 'transfer-unavailable'
        )
      : err

  return {
    async signPut(orgId, req) {
      const bucket = requireTransfer()
      if (req.bytes > bucket.maxBytes) {
        throw new SessionFileRefusal('TOO_LARGE', `the file exceeds the transfer limit of ${bucket.maxBytes} bytes`)
      }
      // Only the agent's own, still-readable session keeps a snapshot; an unreported one may still be on its way.
      const session = await sessions.get(OrgId(orgId), SessionId(req.sessionId))
      if (!session)
        throw new SessionFileRefusal('SCOPE_DENIED', 'the control plane does not know this session yet', true)
      if (session.agentId !== req.agentId)
        throw new SessionFileRefusal('SCOPE_DENIED', 'the session is not this agent’s')
      if (session.contentPurgedAt) throw new SessionFileRefusal('SCOPE_DENIED', 'the session’s content was deleted')
      const sha256Hex = hexOf(req.sha256)
      const key = sessionFileKey(orgId, req.agentId, req.sessionId, sha256Hex)
      try {
        await snapshots.reserve({
          id: randomUUID(),
          orgId,
          agentId: req.agentId,
          sessionId: req.sessionId,
          sha256: sha256Hex,
          bytes: req.bytes,
          name: req.name,
          objectKey: key
        })
        // The same bytes shared twice in one session upload once.
        if (await bucket.holds({ key, size: req.bytes, sha256: req.sha256 })) return { stored: true }
        const put = await bucket.signPut({
          key,
          bytes: req.bytes,
          sha256: req.sha256,
          network: req.network,
          retain: true
        })
        return { url: put.url, headers: put.headers }
      } catch (err) {
        throw refusalOf(err)
      }
    },

    async retainImage({ orgId, agentId, sessionId, key, bytes, sha256Hex }) {
      await snapshots.reserve({
        id: randomUUID(),
        orgId,
        agentId,
        sessionId,
        sha256: sha256Hex,
        bytes,
        name: null,
        objectKey: key
      })
    },

    async download({ orgId, sessionId, sha256Prefix, name }) {
      if (!transfer) return undefined
      for (const row of await snapshots.findByDigest(orgId, sessionId, sha256Prefix)) {
        const get = await transfer.storedDownload({
          key: row.objectKey as TransferObjectKey,
          size: row.bytes,
          sha256: Buffer.from(row.sha256, 'hex').toString('base64'),
          name: row.name ?? name ?? 'file'
        })
        if (get) return { url: get.url, expiresAt: get.expiresAt, name: row.name ?? name ?? 'file', bytes: row.bytes }
      }
      return undefined
    },

    async reap() {
      if (!transfer) return 0
      let released = 0
      let failure: unknown
      for (const row of await snapshots.reapable(new Date(now() - SESSION_FILE_MISSING_GRACE_MS), REAP_BATCH)) {
        // The object goes first, so a failed delete leaves the row for the next pass; one failure never blocks the rest.
        try {
          await transfer.deleteObject(row.objectKey as TransferObjectKey)
          await snapshots.delete(row.id)
          released += 1
        } catch (err) {
          failure ??= err
        }
      }
      if (failure !== undefined) throw failure
      return released
    }
  }
}

import { randomUUID } from 'node:crypto'
import type {
  SharedImageGetOk,
  SharedImageGetReq,
  SharedImagePutOk,
  SharedImagePutReq,
  SharedImageResolveOk,
  SharedImageResolveReq
} from '@agentconnect.md/protocol'
import { FileTransferError, sharedImageKey, type FileTransfer } from './transfer.js'

// Shared-image originals (webchat-generated-images.md §5): the CP authorizes and signs; bytes go daemon → bucket → browser.

/** How long a console resolve may wait on the daemon's `image/original/get`. */
const RESOLVE_TICKET_TTL_MS = 2 * 60_000

/** Bound on concurrently open console resolves, so a burst cannot grow the map without limit. */
const RESOLVE_TICKET_MAX = 4096

/** A refusal the WS handler answers as an error frame; `retryable` separates outages from denials. */
export class SharedImageRefusal extends Error {
  constructor(
    readonly code: 'SCOPE_DENIED' | 'TOO_LARGE' | 'UNAVAILABLE',
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = 'SharedImageRefusal'
  }
}

export interface SharedImageControl {
  sharedImageResolve(daemonId: string, orgId: string, req: SharedImageResolveReq): Promise<SharedImageResolveOk>
}

export interface SharedImageService {
  /** `image/original/put`: presign the PUT of one original; the caller has checked publication authority. */
  signPut(orgId: string, req: SharedImagePutReq): Promise<SharedImagePutOk>
  /** `image/original/get`: presign a browser GET; `placed` is whether the daemon currently serves the agent. */
  signGet(orgId: string, daemonId: string, req: SharedImageGetReq, placed: boolean): Promise<SharedImageGetOk>
  /** Console read: ask `daemonId` for the original under a ticket that lets it sign one GET for this attachment. */
  resolve(input: {
    orgId: string
    daemonId: string
    agentId: string
    sessionId: string
    attachmentId: string
  }): Promise<SharedImageResolveOk>
}

interface ResolveTicket {
  orgId: string
  daemonId: string
  agentId: string
  attachmentId: string
  expiresAt: number
}

export function createSharedImageService(deps: {
  transfer?: FileTransfer
  control: SharedImageControl
  now?: () => number
}): SharedImageService {
  const { transfer, control } = deps
  const now = deps.now ?? Date.now
  const tickets = new Map<string, ResolveTicket>()
  const sweep = () => {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id)
  }
  const requireTransfer = (): FileTransfer => {
    if (!transfer) throw new SharedImageRefusal('SCOPE_DENIED', 'this deployment has no bucket for file transfers')
    return transfer
  }

  return {
    async signPut(orgId, req) {
      const bucket = requireTransfer()
      if (!bucket.enabled()) throw new SharedImageRefusal('UNAVAILABLE', 'the transfer bucket is unavailable', true)
      if (req.bytes > bucket.maxBytes) {
        throw new SharedImageRefusal('TOO_LARGE', `the original exceeds the transfer limit of ${bucket.maxBytes} bytes`)
      }
      try {
        const put = await bucket.signPut({
          key: sharedImageKey(orgId, req.agentId, req.attachmentId),
          bytes: req.bytes,
          sha256: req.sha256,
          network: req.network
        })
        return { url: put.url, headers: put.headers }
      } catch (err) {
        if (err instanceof FileTransferError) {
          throw new SharedImageRefusal(
            err.reason === 'too-large' ? 'TOO_LARGE' : 'UNAVAILABLE',
            err.message,
            err.reason === 'transfer-unavailable'
          )
        }
        throw err
      }
    },

    async signGet(orgId, daemonId, req, placed) {
      const bucket = requireTransfer()
      sweep()
      const ticket = req.resolveId ? tickets.get(req.resolveId) : undefined
      const ticketed =
        ticket !== undefined &&
        ticket.orgId === orgId &&
        ticket.daemonId === daemonId &&
        ticket.agentId === req.agentId &&
        ticket.attachmentId === req.attachmentId
      if (!placed && !ticketed) throw new SharedImageRefusal('SCOPE_DENIED', 'no open read for this attachment')
      const get = await bucket.storedDownload({
        key: sharedImageKey(orgId, req.agentId, req.attachmentId),
        size: req.bytes,
        sha256: req.sha256,
        name: req.name
      })
      return get ? { url: get.url, expiresAt: get.expiresAt } : { missing: true }
    },

    async resolve({ orgId, daemonId, agentId, sessionId, attachmentId }) {
      sweep()
      if (tickets.size >= RESOLVE_TICKET_MAX) {
        throw new SharedImageRefusal('UNAVAILABLE', 'too many original reads are open', true)
      }
      const resolveId = randomUUID()
      tickets.set(resolveId, { orgId, daemonId, agentId, attachmentId, expiresAt: now() + RESOLVE_TICKET_TTL_MS })
      try {
        return await control.sharedImageResolve(daemonId, orgId, { agentId, sessionId, attachmentId, resolveId })
      } finally {
        tickets.delete(resolveId)
      }
    }
  }
}

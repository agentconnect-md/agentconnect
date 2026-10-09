import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type {
  TransferGetOk,
  TransferGetReq,
  TransferSignOk,
  TransferSignReq,
  WorkspaceReadContent,
  WorkspaceReadReq,
  WorkspaceUploadOk,
  WorkspaceUploadReq
} from '@agentconnect.md/protocol'
import { FileTransferError, transferDownloadKey, type FileTransfer, type TransferObjectKey } from './transfer.js'

// The control plane's half of console file transfer (source-cache-file-transfer.md §5): stat, cache check, ticketed upload, sign.

/** How long a `workspace/upload` ticket may be redeemed: the daemon stages the file before it asks `transfer/sign`. */
const TICKET_TTL_MS = 16 * 60_000

/** A refusal the HTTP route answers as is; `code` follows the workspace error codes. */
export class FileTransferRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FileTransferRefusal'
  }
}

export interface FileTransferControl {
  workspaceRead(daemonId: string, req: WorkspaceReadReq): Promise<WorkspaceReadContent>
  workspaceUpload(daemonId: string, req: WorkspaceUploadReq): Promise<WorkspaceUploadOk>
}

export interface WorkspaceDownload {
  path: string
  size: number
  url: string
  expiresAt: number
  /** The object's base64 SHA-256. */
  sha256: string
  cached: boolean
}

export interface FileTransferService {
  readonly maxBytes: number
  reserveUpload(input: { orgId: string; size: number; sha256: string }): Promise<{
    uploadId: string
    url: string
    headers: Record<string, string>
    expiresAt: number
  }>
  workspaceDownload(input: {
    orgId: string
    daemonId: string
    agentId: string
    sessionId?: string
    repo?: string
    path: string
  }): Promise<WorkspaceDownload>
  /** `transfer/sign` from `daemonId`: presign the PUT one of its open tickets allows. */
  signUpload(daemonId: string, req: TransferSignReq): Promise<TransferSignOk>
  /** `transfer/get`: presign the agent's GET of a console upload in its own organization. */
  uploadedFile(orgId: string, req: TransferGetReq): Promise<TransferGetOk>
}

interface Ticket {
  daemonId: string
  key: TransferObjectKey
  size: number
  expiresAt: number
}

function refusal(err: unknown): unknown {
  if (!(err instanceof FileTransferError)) return err
  if (err.reason === 'stale') return new FileTransferRefusal(409, 'WORKSPACE_STALE', err.message)
  if (err.reason === 'too-large') return new FileTransferRefusal(400, 'WORKSPACE_TOO_LARGE', err.message)
  return new FileTransferRefusal(409, 'WORKSPACE_TRANSFER_UNAVAILABLE', err.message)
}

export function createFileTransferService(deps: {
  transfer: FileTransfer
  control: FileTransferControl
  now?: () => number
}): FileTransferService {
  const { transfer, control } = deps
  const now = deps.now ?? Date.now
  const tickets = new Map<string, Ticket>()
  const sweep = () => {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id)
  }

  return {
    maxBytes: transfer.maxBytes,

    async reserveUpload({ orgId, size, sha256 }) {
      try {
        return await transfer.grantUpload({ org: orgId, size, sha256 })
      } catch (err) {
        throw refusal(err)
      }
    },

    async workspaceDownload(input) {
      const scope = {
        agentId: input.agentId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.repo ? { repo: input.repo } : {})
      }
      // A one-byte read is the stat: the same containment, `.git` rule and root as every console read.
      const head = await control.workspaceRead(input.daemonId, { ...scope, path: input.path, offset: 0, limit: 1 })
      if (!head.exists) throw new FileTransferRefusal(404, 'WORKSPACE_NOT_FOUND', 'no such file')
      if (head.type === 'dir' || head.size === undefined || head.mtime === undefined)
        throw new FileTransferRefusal(400, 'WORKSPACE_NOT_A_FILE', 'not a regular file')
      const size = head.size
      if (size < 1) throw new FileTransferRefusal(400, 'WORKSPACE_NOT_A_FILE', 'an empty file is not transferred')
      try {
        // One object per revision: a rewritten file has a new size or mtime and so a new key.
        const identity = [input.agentId, input.sessionId ?? null, input.repo ?? null, input.path, size, head.mtime]
        const key = transferDownloadKey(input.orgId, identity)
        let sha256 = await transfer.cachedDownload({ key, size })
        const cached = sha256 !== undefined
        if (sha256 === undefined) {
          sweep()
          const ticket = randomUUID()
          tickets.set(ticket, { daemonId: input.daemonId, key, size, expiresAt: now() + TICKET_TTL_MS })
          try {
            const sent = await control.workspaceUpload(input.daemonId, {
              ...scope,
              path: input.path,
              revision: { size, mtime: head.mtime },
              maxBytes: transfer.maxBytes,
              ticket
            })
            if (sent.bytes !== size) throw new FileTransferError('stale', 'the file changed while it was uploaded')
            sha256 = sent.sha256
          } finally {
            tickets.delete(ticket)
          }
        }
        const get = await transfer.signDownload({ key, name: posix.basename(input.path) })
        return { path: input.path, size, url: get.url, expiresAt: get.expiresAt, sha256, cached }
      } catch (err) {
        throw refusal(err)
      }
    },

    async signUpload(daemonId, req) {
      const ticket = tickets.get(req.ticket)
      // A ticket is bound to the daemon it was sent to and the revision the key names.
      if (!ticket || ticket.daemonId !== daemonId || ticket.expiresAt <= now()) {
        throw new FileTransferRefusal(409, 'WORKSPACE_TRANSFER_UNAVAILABLE', 'no open upload for this ticket')
      }
      if (req.bytes !== ticket.size) throw new FileTransferRefusal(409, 'WORKSPACE_STALE', 'the file changed size')
      try {
        const put = await transfer.signPut({
          key: ticket.key,
          bytes: req.bytes,
          sha256: req.sha256,
          network: req.network
        })
        return { url: put.url, headers: put.headers }
      } catch (err) {
        throw refusal(err)
      }
    },

    async uploadedFile(orgId, req) {
      const get = await transfer.uploadedFileUrl({
        org: orgId,
        uploadId: req.uploadId,
        size: req.size,
        sha256: req.sha256,
        network: req.network
      })
      return get ? { url: get.url, expiresAt: get.expiresAt } : {}
    }
  }
}

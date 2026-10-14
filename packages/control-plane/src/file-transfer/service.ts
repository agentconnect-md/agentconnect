import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type {
  TransferGetOk,
  TransferGetReq,
  TransferSettleReq,
  TransferSignOk,
  TransferSignReq,
  TransferUploadOutcome,
  WorkspaceReadContent,
  WorkspaceReadReq,
  WorkspaceUploadBeginOk,
  WorkspaceUploadOk,
  WorkspaceUploadReq
} from '@agentconnect.md/protocol'
import { ProtocolError } from '../domain/errors.js'
import type { UploadTicketRepo } from '../persistence/ports.js'
import {
  FileTransferError,
  isTransferObjectKey,
  transferDownloadKey,
  type FileTransfer,
  type TransferObjectKey
} from './transfer.js'

// The control plane's half of console file transfer (source-cache-file-transfer.md §5): stat, cache check, ticketed upload, sign.

/** How long a `workspace/upload` ticket may be redeemed: the daemon stages the file before it asks `transfer/sign`. */
const TICKET_TTL_MS = 16 * 60_000

/** How long a settled upload stays readable to its pollers. */
const SETTLED_RETAIN_MS = 10 * 60_000

/** How often a caller that did not ask to poll is answered from the shared ticket while it waits. */
const WAIT_STEP_MS = 1_000

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
  /** Start the upload on the daemon and return once it accepted; `transfer/settle` reports the outcome. */
  workspaceUploadBegin(daemonId: string, req: WorkspaceUploadReq): Promise<WorkspaceUploadBeginOk>
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

/** A begun upload still running; the caller polls `operationId`. */
export interface WorkspaceTransferPending {
  operationId: string
  path: string
  size: number
}

export type WorkspaceTransferResult = WorkspaceDownload | WorkspaceTransferPending

export function isTransferPending(result: WorkspaceTransferResult): result is WorkspaceTransferPending {
  return 'operationId' in result
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
    /** The daemon advertises `WORKSPACE_UPLOAD_BEGIN_FEATURE`: begin the upload and track it on the shared ticket. */
    begin?: boolean
    /** Answer a running upload as pending instead of waiting for it; needs `begin`. */
    poll?: boolean
  }): Promise<WorkspaceTransferResult>
  /** A begun upload's state for `agentId`; any replica answers it from the shared ticket. */
  transferStatus(input: { agentId: string; operationId: string }): Promise<WorkspaceTransferResult>
  /** `transfer/settle` from `daemonId`: record a begun upload's outcome; a resend changes nothing. */
  settleUpload(daemonId: string, req: TransferSettleReq): Promise<void>
  /** `transfer/sign` from `daemonId`: presign the PUT one of its open tickets allows. */
  signUpload(daemonId: string, req: TransferSignReq): Promise<TransferSignOk>
  /** `transfer/get`: presign the agent's GET of a console upload in its own organization. */
  uploadedFile(orgId: string, req: TransferGetReq): Promise<TransferGetOk>
}

function refusal(err: unknown): unknown {
  if (!(err instanceof FileTransferError)) return err
  if (err.reason === 'stale') return new FileTransferRefusal(409, 'WORKSPACE_STALE', err.message)
  if (err.reason === 'too-large') return new FileTransferRefusal(400, 'WORKSPACE_TOO_LARGE', err.message)
  return new FileTransferRefusal(409, 'WORKSPACE_TRANSFER_UNAVAILABLE', err.message)
}

/** A settled failure as the error the single-shot RPC would have thrown, so the route maps both alike. */
function outcomeError(outcome: Extract<TransferUploadOutcome, { ok: false }>): ProtocolError {
  return new ProtocolError(outcome.code, outcome.message, outcome.reason ? { details: { reason: outcome.reason } } : {})
}

/** A begun upload nobody settled before its ticket expired. */
function lostUpload(): ProtocolError {
  return new ProtocolError('BAD_PAYLOAD', 'the upload did not finish', { details: { reason: 'transfer-failed' } })
}

export function createFileTransferService(deps: {
  transfer: FileTransfer
  control: FileTransferControl
  /** Shared across replicas: the daemon's `transfer/sign` may reach a CP other than the one that sent `workspace/upload`. */
  tickets: UploadTicketRepo
  /** Test seam for the wait between ticket reads. */
  sleep?: (ms: number) => Promise<void>
}): FileTransferService {
  const { transfer, control, tickets } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const signed = async (key: TransferObjectKey, path: string, size: number, sha256: string, cached: boolean) => {
    const get = await transfer.signDownload({ key, name: posix.basename(path) })
    return { path, size, url: get.url, expiresAt: get.expiresAt, sha256, cached }
  }

  const status = async (agentId: string, operationId: string): Promise<WorkspaceTransferResult> => {
    const ticket = await tickets.get(operationId)
    if (!ticket || ticket.agentId !== agentId || ticket.path === undefined || !isTransferObjectKey(ticket.objectKey))
      throw new FileTransferRefusal(404, 'WORKSPACE_TRANSFER_UNKNOWN', 'no such transfer, or it expired')
    const { outcome, objectKey, path, size } = ticket
    if (outcome && !outcome.ok) throw outcomeError(outcome)
    if (outcome?.ok && outcome.bytes !== size)
      throw new FileTransferError('stale', 'the file changed while it was uploaded')
    // The bucket decides success, so a settle lost on its way still completes the operation.
    const sha256 = outcome?.ok ? outcome.sha256 : await transfer.cachedDownload({ key: objectKey, size })
    if (sha256 === undefined) return { operationId, path, size }
    return await signed(objectKey, path, size, sha256, false)
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
        const hit = await transfer.cachedDownload({ key, size })
        if (hit !== undefined) return await signed(key, input.path, size, hit, true)
        const req = { ...scope, path: input.path, revision: { size, mtime: head.mtime }, maxBytes: transfer.maxBytes }
        if (!input.begin) {
          const ticket = randomUUID()
          await tickets.open(ticket, { daemonId: input.daemonId, objectKey: key, size }, TICKET_TTL_MS)
          try {
            const sent = await control.workspaceUpload(input.daemonId, { ...req, ticket })
            if (sent.bytes !== size) throw new FileTransferError('stale', 'the file changed while it was uploaded')
            return await signed(key, input.path, size, sent.sha256, false)
          } finally {
            // A failed close leaves the row to expire; it must not replace the upload's own outcome.
            await tickets.close(ticket).catch(() => undefined)
          }
        }
        // A retry, on this replica or another, joins the upload already running; the daemon joins a re-sent begin too.
        const joined = await tickets.pending(key, input.daemonId)
        const ticket = joined ?? randomUUID()
        if (!joined) {
          const opened = { daemonId: input.daemonId, objectKey: key, size, agentId: input.agentId, path: input.path }
          await tickets.open(ticket, opened, TICKET_TTL_MS)
        }
        try {
          await control.workspaceUploadBegin(input.daemonId, { ...req, ticket })
        } catch (err) {
          if (!joined) await tickets.close(ticket).catch(() => undefined)
          throw err
        }
        let state = await status(input.agentId, ticket)
        while (!input.poll && isTransferPending(state)) {
          await sleep(WAIT_STEP_MS)
          state = await status(input.agentId, ticket).catch((err: unknown) => {
            throw err instanceof FileTransferRefusal && err.status === 404 ? lostUpload() : err
          })
        }
        return state
      } catch (err) {
        throw refusal(err)
      }
    },

    async signUpload(daemonId, req) {
      // A ticket is bound to the daemon it was sent to and the revision the key names.
      const ticket = await tickets.find(req.ticket, daemonId)
      if (!ticket || !isTransferObjectKey(ticket.objectKey)) {
        throw new FileTransferRefusal(409, 'WORKSPACE_TRANSFER_UNAVAILABLE', 'no open upload for this ticket')
      }
      if (req.bytes !== ticket.size) throw new FileTransferRefusal(409, 'WORKSPACE_STALE', 'the file changed size')
      try {
        const put = await transfer.signPut({
          key: ticket.objectKey,
          bytes: req.bytes,
          sha256: req.sha256,
          network: req.network
        })
        return { url: put.url, headers: put.headers }
      } catch (err) {
        throw refusal(err)
      }
    },

    async transferStatus({ agentId, operationId }) {
      try {
        return await status(agentId, operationId)
      } catch (err) {
        throw refusal(err)
      }
    },

    async settleUpload(daemonId, req) {
      await tickets.settle(req.ticket, daemonId, req.outcome, SETTLED_RETAIN_MS)
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

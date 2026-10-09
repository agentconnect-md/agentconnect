import { posix } from 'node:path'
import type {
  TransferUploadGrant,
  TransferUploadReq,
  WorkspaceTransferGrant,
  WorkspaceTransferReq
} from '@agentconnect.md/protocol'
import { FileTransferError, type FileTransfer } from '../source-cache/transfer.js'
import { WorkspaceConflictError, WorkspaceViolationError, type WorkspaceReader } from './workspace-reader.js'

// The CP-facing half of console file transfer (source-cache-file-transfer.md): authorize, stat, then presign.

/** One workspace file upload may stage and send up to the transfer cap, so it gets far longer than a file read. */
const WORKSPACE_UPLOAD_TIMEOUT_MS = 15 * 60_000

export interface FileTransferControl {
  upload(req: TransferUploadReq): Promise<TransferUploadGrant>
  workspace(req: WorkspaceTransferReq): Promise<WorkspaceTransferGrant>
}

export interface FileTransferControlDeps {
  transfer: FileTransfer
  /** The agent's org, or undefined for an agent this daemon does not serve. */
  orgForAgent: (agentId: string) => string | undefined
  workspaceRead: WorkspaceReader
}

/** Refusals keep the workspace error vocabulary, so the CP maps them like every other workspace answer. */
function asWorkspaceError(err: unknown): unknown {
  if (!(err instanceof FileTransferError)) return err
  if (err.reason === 'stale') return new WorkspaceConflictError(err.message)
  return new WorkspaceViolationError(err.message, err.reason)
}

export function createFileTransferControl(deps: FileTransferControlDeps): FileTransferControl {
  const orgOf = (agentId: string): string => {
    const org = deps.orgForAgent(agentId)
    if (!org) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return org
  }

  return {
    async upload(req) {
      try {
        const org = orgOf(req.agentId)
        if (req.size > deps.transfer.maxBytes) {
          throw new WorkspaceViolationError(
            `files over ${deps.transfer.maxBytes} bytes cannot be uploaded`,
            'too-large'
          )
        }
        const grant = await deps.transfer.grantUpload({ org, size: req.size, sha256: req.sha256 })
        return { uploadId: grant.uploadId, url: grant.url, headers: grant.headers, expiresAt: grant.expiresAt }
      } catch (err) {
        throw asWorkspaceError(err)
      }
    },

    async workspace(req) {
      try {
        const org = orgOf(req.agentId)
        const scope = {
          agentId: req.agentId,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          ...(req.repo ? { repo: req.repo } : {})
        }
        // A one-byte read is the stat: the same containment, `.git` rule and root as every console read.
        const head = await deps.workspaceRead.read({ ...scope, path: req.path, offset: 0, limit: 1 })
        if (!head.exists) throw new WorkspaceViolationError('no such file', 'not-found')
        if (head.type === 'dir' || head.size === undefined)
          throw new WorkspaceViolationError('not a regular file', 'not-a-file')
        const size = head.size
        const grant = await deps.transfer.workspaceFileUrl({
          org,
          // One object per revision: a rewritten file has a new size or mtime and so a new key.
          identity: [req.agentId, req.sessionId ?? null, req.repo ?? null, req.path, size, head.mtime ?? null],
          name: posix.basename(req.path),
          size,
          upload: (put) =>
            deps.workspaceRead.upload(
              { ...scope, path: req.path, maxBytes: deps.transfer.maxBytes, timeoutMs: WORKSPACE_UPLOAD_TIMEOUT_MS },
              put
            )
        })
        return { path: req.path, size, url: grant.url, expiresAt: grant.expiresAt, cached: grant.cached }
      } catch (err) {
        throw asWorkspaceError(err)
      }
    }
  }
}

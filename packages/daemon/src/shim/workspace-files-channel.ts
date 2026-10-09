/**
 * The `read` capability's channel: the console's workspace file operations, executed on the volume
 * the sandbox has mounted.
 *
 * Unlike the git channel, nothing is re-orchestrated here — the daemon does not send a sequence of
 * primitives to be assembled. It names ONE operation, and a remote primitive set (`realpath`,
 * `lstat`, `readdir`, `link`, `rename`) could not replace that: a 200-entry listing would be 200
 * round trips, and the atomic publish's checks would straddle a WebSocket instead of sitting adjacent
 * to their rename.
 *
 * The operation runs against `fd-workspace-files.ts`, which is the sandbox's own implementation. The
 * daemon's is path-based and stays that way — its workspace is not on a filesystem an agent writes
 * to. Here it is, so the answers are bound to open descriptors rather than to names, and what the two
 * DO share is every rule about the answer: the sort, the page, the frame budget, the UTF-8 boundary,
 * the scratch gate and the edit validation all come from the one module, so the console cannot be
 * given two different answers about one file.
 */
import { z } from 'zod'
import type {
  WorkspaceDeleteOk,
  WorkspaceListPage,
  WorkspaceMkdirOk,
  WorkspaceReadContent,
  WorkspaceWriteOk
} from '@agentconnect.md/protocol'
import { WorkspaceErrorReason } from '@agentconnect.md/protocol'
import {
  outdatedForTransfer,
  WorkspaceConflictError,
  WorkspaceViolationError,
  type WorkspaceFiles,
  type WorkspaceUploadReq,
  type WorkspaceUploadSigner,
  type WorkspaceUploaded
} from '../workspace/workspace-files.js'
import { ShimBundleClient } from './bundle-client.js'
import { BundleCreateResultSchema, type TransferStageRequest } from './bundle-protocol.js'
import { createFdWorkspaceFiles } from './fd-workspace-files.js'
import type { ShimRequester } from './channels.js'

/** The requests carry the CP's own zod-validated shapes, re-validated here because a payload that
 *  crossed a channel is unvalidated input again. Only the fields the operations read are named —
 *  `agentId` rides along because every reply echoes it. */
// The two `limit` ceilings mirror `WorkspaceListReq` / `WorkspaceReadReq` exactly. The shim must not
// serve a page larger than the CP's own contract admits — a bound that only exists upstream is not a
// bound on this side, which is the same reason every other check here is duplicated.
const ListReqSchema = z.object({
  agentId: z.string().min(1),
  path: z.string(),
  limit: z.number().int().positive().max(500),
  cursor: z.string().max(64).optional(),
  sessionId: z.string().optional()
})

const ReadReqSchema = z.object({
  agentId: z.string().min(1),
  path: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(65_536),
  sessionId: z.string().optional(),
  encoding: z.enum(['base64']).optional()
})

const WriteReqSchema = z.object({
  agentId: z.string().min(1),
  path: z.string(),
  contentBase64: z.string(),
  ifMatchMtime: z.string().optional()
})

const DeleteReqSchema = z.object({
  agentId: z.string().min(1),
  path: z.string(),
  ifMatchMtime: z.string()
})

const MkdirReqSchema = z.object({
  agentId: z.string().min(1),
  path: z.string()
})

/** Absolute because it is a path in the POD's coordinates, and the shim's fence compares absolutes. */
const RootSchema = z.string().min(1).max(4096)

export const WorkspaceFilesPayloadSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), root: RootSchema, req: ListReqSchema }),
  z.object({ op: z.literal('read'), root: RootSchema, req: ReadReqSchema }),
  // `scratch` is the daemon's answer (it reads agent configuration) and travels with the request, so
  // the half-trusted side never decides whether a workspace is writable — it only enforces it.
  z.object({ op: z.literal('write'), root: RootSchema, scratch: z.boolean(), req: WriteReqSchema }),
  z.object({ op: z.literal('delete'), root: RootSchema, scratch: z.boolean(), req: DeleteReqSchema }),
  z.object({ op: z.literal('mkdir'), root: RootSchema, scratch: z.boolean(), req: MkdirReqSchema })
])
export type WorkspaceFilesPayload = z.infer<typeof WorkspaceFilesPayloadSchema>

/**
 * The reply, with a REFUSAL as data.
 *
 * A shim error frame carries only a string, and these two refusals are the difference between the
 * console saying "that path is not readable" (`BAD_PAYLOAD` plus a machine-readable reason) and
 * "the daemon may be offline" (`INTERNAL`). Flattening them into a message would make a contained
 * path escape look like an outage. Everything else — a bad root, a parse failure, an unexpected
 * `EIO` — stays an error frame, which is exactly what those should read as.
 */
export const WorkspaceFilesReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    refusal: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('violation'), reason: WorkspaceErrorReason, message: z.string().max(500) }),
      // `reason` is absent from an older shim, which the daemon reads as the default `stale`.
      z.object({ kind: z.literal('conflict'), message: z.string().max(500), reason: WorkspaceErrorReason.optional() })
    ])
  })
])
export type WorkspaceFilesReply = z.infer<typeof WorkspaceFilesReplySchema>

/**
 * Apply one operation inside the sandbox.
 *
 * `anchor` is the sandbox's own workspace mount, passed in rather than imported so this module keeps
 * no opinion about where the image mounts things. It is the only path the operations resolve by name,
 * and it is the only one they safely can: a mount point cannot be renamed out from under itself, so
 * unlike everything below it there is no window in which it could become something else. Every step
 * from there down is taken from an open descriptor — see `fd-workspace-files.ts`.
 *
 * The daemon-supplied root is therefore no longer validated and then re-resolved. It is expressed as
 * steps from the anchor and walked, so "is it inside the mount" and "which directory is it" stop
 * being two questions with two answers.
 */
export async function applyWorkspaceFilesPayload(
  payload: unknown,
  anchor: string,
  files: WorkspaceFiles = createFdWorkspaceFiles(anchor)
): Promise<WorkspaceFilesReply> {
  const parsed = WorkspaceFilesPayloadSchema.parse(payload)
  try {
    const value = await run(parsed, files)
    return { ok: true, value }
  } catch (err) {
    if (err instanceof WorkspaceViolationError) {
      return { ok: false, refusal: { kind: 'violation', reason: err.reason, message: err.message.slice(0, 500) } }
    }
    if (err instanceof WorkspaceConflictError) {
      return { ok: false, refusal: { kind: 'conflict', message: err.message.slice(0, 500), reason: err.reason } }
    }
    throw err
  }
}

function run(parsed: WorkspaceFilesPayload, files: WorkspaceFiles): Promise<unknown> {
  switch (parsed.op) {
    case 'list':
      return files.list(parsed.root, parsed.req)
    case 'read':
      return files.read(parsed.root, parsed.req)
    case 'write':
      return files.write(parsed.root, parsed.scratch, parsed.req)
    case 'delete':
      return files.delete(parsed.root, parsed.scratch, parsed.req)
    case 'mkdir':
      return files.mkdir(parsed.root, parsed.scratch, parsed.req)
  }
}

/**
 * The daemon's side: forward each operation to the agent's sandbox and hand back what it answered.
 *
 * A pass-through by design. Every bound and every refusal already happened in the shared
 * implementation on the far side, and re-deriving either here would give the two filesystems two
 * different sets of answers — the exact divergence this seam exists to prevent.
 */
export class ShimWorkspaceFiles implements WorkspaceFiles {
  constructor(
    private readonly requester: ShimRequester,
    /** Bounds ONE file operation. Local work on a mounted volume, so the git channel's network
     *  allowance would only mean a wedged request outliving the reader who asked for it. */
    private readonly timeoutMs = 30_000,
    /** The binding holds the `transfer` grant (and so `bundle`); without it an upload is refused as outdated. */
    private readonly canTransfer = false
  ) {}

  private async run<T>(payload: WorkspaceFilesPayload): Promise<T> {
    const raw = await this.requester.request('read', payload, { timeoutMs: this.timeoutMs })
    const reply = WorkspaceFilesReplySchema.parse(raw)
    // Rebuilt as the SAME classes the local path throws, so the dispatcher above cannot tell the two
    // filesystems apart — which is the whole property this seam is for.
    if (!reply.ok) {
      if (reply.refusal.kind === 'conflict')
        throw new WorkspaceConflictError(reply.refusal.message, reply.refusal.reason)
      throw new WorkspaceViolationError(reply.refusal.message, reply.refusal.reason)
    }
    return reply.value as T
  }

  list(root: string, req: Parameters<WorkspaceFiles['list']>[1]): Promise<WorkspaceListPage> {
    return this.run({ op: 'list', root, req })
  }

  async read(root: string, req: Parameters<WorkspaceFiles['read']>[1]): Promise<WorkspaceReadContent> {
    const content = await this.run<WorkspaceReadContent>({ op: 'read', root, req })
    // An older shim strips `encoding` and answers text or nothing, which must never pass for the file's bytes.
    if (req.encoding === 'base64' && content.type === 'file' && content.encoding !== 'base64') {
      throw new WorkspaceViolationError(
        'this agent’s sandbox predates file downloads; it serves them once the sandbox restarts',
        'sandbox-outdated'
      )
    }
    return content
  }

  write(root: string, scratch: boolean, req: Parameters<WorkspaceFiles['write']>[2]): Promise<WorkspaceWriteOk> {
    return this.run({ op: 'write', root, scratch, req })
  }

  delete(root: string, scratch: boolean, req: Parameters<WorkspaceFiles['delete']>[2]): Promise<WorkspaceDeleteOk> {
    return this.run({ op: 'delete', root, scratch, req })
  }

  mkdir(root: string, scratch: boolean, req: Parameters<WorkspaceFiles['mkdir']>[2]): Promise<WorkspaceMkdirOk> {
    return this.run({ op: 'mkdir', root, scratch, req })
  }

  async upload(
    root: string,
    req: WorkspaceUploadReq,
    sign: WorkspaceUploadSigner,
    abort?: AbortSignal
  ): Promise<WorkspaceUploaded> {
    if (!this.canTransfer) throw outdatedForTransfer()
    const stage: TransferStageRequest = { op: 'stage-file', root, path: req.path, maxBytes: req.maxBytes }
    const staged = await this.requester
      .request('transfer', stage, { timeoutMs: req.timeoutMs, ...(abort ? { abort } : {}) })
      .then((reply) => BundleCreateResultSchema.parse(reply))
      .catch((err: unknown) => {
        throw transferRefusal(err)
      })
    const bundles = new ShimBundleClient(this.requester, req.timeoutMs)
    try {
      const put = await sign({ bytes: staged.bytes, sha256: staged.sha256 })
      return await bundles.upload({ handle: staged.handle, url: put.url, headers: put.headers }, abort)
    } catch (err) {
      throw transferRefusal(err)
    } finally {
      await bundles.discard(staged.handle, abort).catch(() => undefined)
    }
  }
}

const STAGED_REFUSALS = new Set<WorkspaceErrorReason>([
  'not-found',
  'not-a-file',
  'too-large',
  'path-escape',
  'git-internals'
])

/** The shim's refusal reasons cross the channel as `bundle <reason>: …`; a workspace one keeps its reason, anything else failed the transfer. */
function transferRefusal(err: unknown): Error {
  if (err instanceof WorkspaceViolationError) return err
  const reason = /^bundle ([a-z-]+):/.exec(err instanceof Error ? err.message : '')?.[1]
  const parsed = WorkspaceErrorReason.safeParse(reason)
  if (parsed.success && STAGED_REFUSALS.has(parsed.data)) {
    return new WorkspaceViolationError('the file cannot be transferred', parsed.data)
  }
  return new WorkspaceViolationError('the file transfer failed', 'transfer-failed')
}

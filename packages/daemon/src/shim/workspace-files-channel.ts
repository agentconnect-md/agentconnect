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
  WorkspaceReadContent,
  WorkspaceWriteOk
} from '@agentconnect.md/protocol'
import { WorkspaceErrorReason } from '@agentconnect.md/protocol'
import { WorkspaceConflictError, WorkspaceViolationError, type WorkspaceFiles } from '../workspace/workspace-files.js'
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
  sessionId: z.string().optional()
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

/** Absolute because it is a path in the POD's coordinates, and the shim's fence compares absolutes. */
const RootSchema = z.string().min(1).max(4096)

export const WorkspaceFilesPayloadSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), root: RootSchema, req: ListReqSchema }),
  z.object({ op: z.literal('read'), root: RootSchema, req: ReadReqSchema }),
  // `scratch` is the daemon's answer (it reads agent configuration) and travels with the request, so
  // the half-trusted side never decides whether a workspace is writable — it only enforces it.
  z.object({ op: z.literal('write'), root: RootSchema, scratch: z.boolean(), req: WriteReqSchema }),
  z.object({ op: z.literal('delete'), root: RootSchema, scratch: z.boolean(), req: DeleteReqSchema })
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
      z.object({ kind: z.literal('conflict'), message: z.string().max(500) })
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
      return { ok: false, refusal: { kind: 'conflict', message: err.message.slice(0, 500) } }
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
    private readonly timeoutMs = 30_000
  ) {}

  private async run<T>(payload: WorkspaceFilesPayload): Promise<T> {
    const raw = await this.requester.request('read', payload, { timeoutMs: this.timeoutMs })
    const reply = WorkspaceFilesReplySchema.parse(raw)
    // Rebuilt as the SAME classes the local path throws, so the dispatcher above cannot tell the two
    // filesystems apart — which is the whole property this seam is for.
    if (!reply.ok) {
      if (reply.refusal.kind === 'conflict') throw new WorkspaceConflictError(reply.refusal.message)
      throw new WorkspaceViolationError(reply.refusal.message, reply.refusal.reason)
    }
    return reply.value as T
  }

  list(root: string, req: Parameters<WorkspaceFiles['list']>[1]): Promise<WorkspaceListPage> {
    return this.run({ op: 'list', root, req })
  }

  read(root: string, req: Parameters<WorkspaceFiles['read']>[1]): Promise<WorkspaceReadContent> {
    return this.run({ op: 'read', root, req })
  }

  write(root: string, scratch: boolean, req: Parameters<WorkspaceFiles['write']>[2]): Promise<WorkspaceWriteOk> {
    return this.run({ op: 'write', root, scratch, req })
  }

  delete(root: string, scratch: boolean, req: Parameters<WorkspaceFiles['delete']>[2]): Promise<WorkspaceDeleteOk> {
    return this.run({ op: 'delete', root, scratch, req })
  }
}

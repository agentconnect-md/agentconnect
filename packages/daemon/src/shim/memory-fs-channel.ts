/**
 * The memory-tree half of the `read` capability: a cluster agent's managed memory lives on its
 * sandbox volume, and this channel is how the daemon's `MemoryFs` port reaches it.
 *
 * Unlike the workspace channel, the daemon does not name one memory operation and let the pod
 * answer it: the memory logic (history, retention, the write ledger, the dream fence) is policy the
 * daemon keeps in its own process, and only the port's primitives cross the wire. They are shaped
 * for the 256 KiB frame: a read answers one budgeted slice at an offset, and a write is staged as
 * appended chunks into a sibling temp file, then committed by one rename that carries the mtime
 * precondition — so the atomic publish and its check still sit adjacent, on the pod.
 *
 * The pod side (`fd-memory-fs.ts`) works from open descriptors like the workspace's; the daemon
 * side (`ShimMemoryFs`) is a pass-through that reassembles slices and chunks into the port's calls.
 *
 * The primitives are not memory's alone — `shim/workspace-fs-channel.ts` is a second caller, for the
 * worktree tree on the same mount. The `memory-` op names are the wire contract a running pod already
 * speaks and are left as they are; the prefix is that contract's history, not the channel's scope.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { REPLY_BUDGET, fitToBudget, utf8Boundary } from '../wire-slice.js'
import {
  MemoryConflictError,
  MemoryPathError,
  memoryRelSegments,
  type MemoryFs,
  type MemoryFsEncoding,
  type MemoryFsEntry,
  type MemoryFsFile,
  type MemoryFsFileStat,
  type MemoryFsWriteOptions
} from '../memory/fs.js'
import { createFdMemoryFsExecutor } from './fd-memory-fs.js'
import { DEFAULT_SHIM_WORKSPACE_ROOT } from './protocol.js'
import type { WorkspaceFsKind } from '../workspace/workspace-fs.js'
import type { ShimRequester } from './channels.js'

/** Absolute because it is a path in the POD's coordinates, and the shim's fence compares absolutes. */
const RootSchema = z.string().min(1).max(4096)
const RelSchema = z.string().max(4096)

export const MemoryFsPayloadSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('memory-read'),
    root: RootSchema,
    rel: RelSchema,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(REPLY_BUDGET),
    encoding: z.enum(['utf8', 'base64']).optional()
  }),
  z.object({
    op: z.literal('memory-append'),
    root: RootSchema,
    rel: RelSchema,
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    create: z.boolean(),
    mode: z.number().int().optional()
  }),
  z.object({
    op: z.literal('memory-commit'),
    root: RootSchema,
    rel: RelSchema,
    temp: RelSchema,
    ifMatchMtime: z.string().optional()
  }),
  z.object({ op: z.literal('memory-stat'), root: RootSchema, rel: RelSchema }),
  z.object({ op: z.literal('memory-readdir'), root: RootSchema, rel: RelSchema }),
  z.object({ op: z.literal('memory-mkdir'), root: RootSchema, rel: RelSchema }),
  z.object({ op: z.literal('memory-rmdir'), root: RootSchema, rel: RelSchema }),
  z.object({ op: z.literal('memory-rename'), root: RootSchema, from: RelSchema, to: RelSchema }),
  z.object({ op: z.literal('memory-rm'), root: RootSchema, rel: RelSchema }),
  z.object({ op: z.literal('memory-utimes'), root: RootSchema, rel: RelSchema, mtime: z.string() })
])
export type MemoryFsPayload = z.infer<typeof MemoryFsPayloadSchema>

/** Cheap discrimination for the exec handler, ahead of the full parse. */
export function isMemoryFsPayload(payload: unknown): boolean {
  const op = (payload as { op?: unknown } | null)?.op
  return typeof op === 'string' && op.startsWith('memory-')
}

const ReadReplySchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    size: z.number().int().nonnegative(),
    mtime: z.string(),
    content: z.string(),
    nextOffset: z.number().int().nonnegative()
  })
])
export type MemoryFsReadReply = z.infer<typeof ReadReplySchema>

const StatReplySchema = z.object({ size: z.number().int().nonnegative(), mtime: z.string() })
export const KindReplySchema = z.enum(['file', 'dir', 'missing', 'other'])
const EntriesReplySchema = z.array(
  z.object({
    name: z.string(),
    kind: z.enum(['file', 'dir', 'other']),
    size: z.number().int().nonnegative().optional(),
    mtime: z.string().optional()
  })
)

/** The reply, with the two typed refusals as data so they survive the channel as themselves. */
export const MemoryFsReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    refusal: z.object({ kind: z.enum(['path', 'conflict']), message: z.string().max(500) })
  })
])
export type MemoryFsReply = z.infer<typeof MemoryFsReplySchema>

/** The pod-side primitive set the payloads map onto. `rel` paths are relative to `root`. */
export interface MemoryFsExecutor {
  read(root: string, rel: string, offset: number, limit: number, encoding: MemoryFsEncoding): Promise<MemoryFsReadReply>
  append(root: string, rel: string, content: Buffer, create: boolean, mode?: number): Promise<{ size: number }>
  commit(root: string, rel: string, temp: string, ifMatchMtime?: string): Promise<MemoryFsFileStat>
  /** What one path IS, never following a symlink; `other` covers a link and every non-regular entry. */
  stat(root: string, rel: string): Promise<WorkspaceFsKind>
  readdir(root: string, rel: string): Promise<MemoryFsEntry[]>
  mkdir(root: string, rel: string): Promise<void>
  /** Remove `rel` only if it is an empty directory, answering whether it went. */
  rmdir(root: string, rel: string): Promise<boolean>
  rename(root: string, from: string, to: string): Promise<boolean>
  rm(root: string, rel: string): Promise<void>
  utimes(root: string, rel: string, mtime: string): Promise<void>
}

/** Apply one memory-fs operation inside the sandbox; `anchor` is the pod's workspace mount. */
export async function applyMemoryFsPayload(
  payload: unknown,
  anchor: string,
  executor: MemoryFsExecutor = createFdMemoryFsExecutor(anchor)
): Promise<MemoryFsReply> {
  const parsed = MemoryFsPayloadSchema.parse(payload)
  try {
    return { ok: true, value: await run(parsed, executor) }
  } catch (err) {
    if (err instanceof MemoryPathError)
      return { ok: false, refusal: { kind: 'path', message: err.message.slice(0, 500) } }
    if (err instanceof MemoryConflictError) {
      return { ok: false, refusal: { kind: 'conflict', message: err.message.slice(0, 500) } }
    }
    throw err
  }
}

function run(parsed: MemoryFsPayload, executor: MemoryFsExecutor): Promise<unknown> {
  // Lexical containment ahead of the executor: the same refusal whatever walks the tree.
  for (const rel of 'rel' in parsed ? [parsed.rel] : [parsed.from, parsed.to]) memoryRelSegments(rel)
  if (parsed.op === 'memory-commit') memoryRelSegments(parsed.temp)
  switch (parsed.op) {
    case 'memory-read':
      return executor.read(parsed.root, parsed.rel, parsed.offset, parsed.limit, parsed.encoding ?? 'utf8')
    case 'memory-append':
      return executor.append(
        parsed.root,
        parsed.rel,
        Buffer.from(parsed.content, parsed.encoding ?? 'utf8'),
        parsed.create,
        parsed.mode
      )
    case 'memory-commit':
      return executor.commit(parsed.root, parsed.rel, parsed.temp, parsed.ifMatchMtime)
    case 'memory-stat':
      return executor.stat(parsed.root, parsed.rel)
    case 'memory-readdir':
      return executor.readdir(parsed.root, parsed.rel)
    case 'memory-mkdir':
      return executor.mkdir(parsed.root, parsed.rel).then(() => null)
    case 'memory-rmdir':
      return executor.rmdir(parsed.root, parsed.rel)
    case 'memory-rename':
      return executor.rename(parsed.root, parsed.from, parsed.to)
    case 'memory-rm':
      return executor.rm(parsed.root, parsed.rel).then(() => null)
    case 'memory-utimes':
      return executor.utimes(parsed.root, parsed.rel, parsed.mtime).then(() => null)
  }
}

/** Raw bytes staged per append frame before the encoded-size fit; the fit only ever shrinks it. */
const WRITE_CHUNK_BYTES = 128 * 1024
/** How often a whole-file read restarts when the file changed underneath its slices. */
const READ_RESTARTS = 3

/** Raw bytes per base64 read chunk: fits `REPLY_BUDGET` after 4/3 expansion, and a multiple
 *  of 3 so every chunk encodes pad-free (decoded per chunk regardless — belt and braces). */
const BASE64_READ_LIMIT = Math.floor(REPLY_BUDGET / 4) * 3

/** A bound shim channel that knows which agent it serves (a `ShimSession`). */
export type ShimMemoryChannel = ShimRequester & { readonly agentId: string }

/** One channel round trip, with the two typed refusals rebuilt as the SAME classes the local port
 *  throws, so callers cannot tell the two trees apart. */
export async function requestMemoryFs<T>(
  channel: ShimMemoryChannel,
  payload: MemoryFsPayload,
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<T> {
  const raw = await channel.request('read', payload, { timeoutMs })
  const reply = MemoryFsReplySchema.parse(raw)
  if (!reply.ok) {
    if (reply.refusal.kind === 'conflict') throw new MemoryConflictError(reply.refusal.message)
    throw new MemoryPathError(reply.refusal.message)
  }
  return schema.parse(reply.value)
}

/**
 * The daemon's side: the port over an agent's bound shim channel. Every containment check and every
 * refusal happens on the pod, where the files are; this class only reassembles what one frame cannot
 * carry. `key` is per agent and root, so the daemon's locks and write ledger follow the tree across
 * channel renewals and rebinds.
 */
export class ShimMemoryFs implements MemoryFs {
  readonly key: string

  constructor(
    private readonly channel: ShimMemoryChannel,
    readonly root: string,
    private readonly timeoutMs = 30_000
  ) {
    this.key = `sandbox:${channel.agentId}:${root}`
  }

  subdir(rel: string): MemoryFs {
    return new ShimMemoryFs(this.channel, joinRel(this.root, rel), this.timeoutMs)
  }

  private run<T>(payload: MemoryFsPayload, schema: z.ZodType<T>): Promise<T> {
    return requestMemoryFs(this.channel, payload, schema, this.timeoutMs)
  }

  /**
   * The file's BYTES, chunked over the same read op with `encoding: 'base64'`.
   *
   * Two things the text read does not need: the per-chunk request is sized to
   * {@link BASE64_READ_LIMIT} raw bytes, because the POD base64-encodes exactly the
   * requested slice with no budget fitting of its own — a `REPLY_BUDGET` request would
   * expand 4/3 past the frame and lose the channel instead of refusing; and each chunk is
   * DECODED separately before concatenation, because independently-encoded slices carry
   * their own padding and their joined strings are not one valid base64 stream.
   *
   * `maxBytes` refuses from the FIRST reply's size — one frame, not a whole transfer.
   */
  async readFileBytes(
    rel: string,
    maxBytes: number
  ): Promise<{ bytes: Buffer; size: number; mtime: string } | { tooLarge: number } | null> {
    const read = (offset: number) =>
      this.run(
        { op: 'memory-read', root: this.root, rel, offset, limit: BASE64_READ_LIMIT, encoding: 'base64' },
        ReadReplySchema
      )
    for (let attempt = 0; attempt < READ_RESTARTS; attempt++) {
      const first = await read(0)
      if (!first.exists) return null
      if (first.size > maxBytes) return { tooLarge: first.size }
      const parts = [Buffer.from(first.content, 'base64')]
      let offset = first.nextOffset
      let stale = false
      while (offset < first.size) {
        const next = await read(offset)
        // A slice from a different version of the file would splice two files together: start over.
        if (!next.exists || next.mtime !== first.mtime || next.size !== first.size || next.nextOffset <= offset) {
          stale = true
          break
        }
        parts.push(Buffer.from(next.content, 'base64'))
        offset = next.nextOffset
      }
      if (!stale) return { bytes: Buffer.concat(parts), size: first.size, mtime: first.mtime }
    }
    throw new MemoryConflictError('the file kept changing while it was read')
  }

  async readFile(rel: string, encoding: MemoryFsEncoding = 'utf8'): Promise<MemoryFsFile | null> {
    const read = (offset: number) =>
      this.run({ op: 'memory-read', root: this.root, rel, offset, limit: REPLY_BUDGET, encoding }, ReadReplySchema)
    for (let attempt = 0; attempt < READ_RESTARTS; attempt++) {
      const first = await read(0)
      if (!first.exists) return null
      const parts = [first.content]
      let offset = first.nextOffset
      let stale = false
      while (offset < first.size) {
        const next = await read(offset)
        // A slice from a different version of the file would splice two files together: start over.
        if (!next.exists || next.mtime !== first.mtime || next.size !== first.size || next.nextOffset <= offset) {
          stale = true
          break
        }
        parts.push(next.content)
        offset = next.nextOffset
      }
      if (!stale) return { content: parts.join(''), size: first.size, mtime: first.mtime }
    }
    throw new MemoryConflictError('the memory file kept changing while it was read')
  }

  async writeFile(
    rel: string,
    content: string | Uint8Array,
    options: MemoryFsWriteOptions = {}
  ): Promise<MemoryFsFileStat> {
    const name = rel.split('/').filter(Boolean).pop()
    if (!name) throw new MemoryPathError('a file name is required')
    const temp = `${rel.slice(0, rel.length - name.length)}.agentconnect-memory-${randomUUID()}.tmp`
    // Bytes travel as base64 (no UTF-8 boundary to keep, ~4/3 the size); text as budget-fitted utf8.
    const bytes = typeof content === 'string' ? undefined : Buffer.from(content)
    const buf = bytes ?? Buffer.from(content as string, 'utf8')
    try {
      let offset = 0
      let create = true
      do {
        const slice = buf.subarray(offset, offset + WRITE_CHUNK_BYTES)
        const { end, content: chunk } = bytes
          ? { end: slice.length, content: slice.toString('base64') }
          : fitToBudget(slice, utf8Boundary(slice, slice.length))
        await this.run(
          {
            op: 'memory-append',
            root: this.root,
            rel: temp,
            content: chunk,
            ...(bytes ? { encoding: 'base64' as const } : {}),
            create,
            ...(options.mode === undefined ? {} : { mode: options.mode })
          },
          z.object({ size: z.number() })
        )
        create = false
        offset += end
      } while (offset < buf.length)
      return await this.run(
        {
          op: 'memory-commit',
          root: this.root,
          rel,
          temp,
          ...(options.ifMatchMtime ? { ifMatchMtime: options.ifMatchMtime } : {})
        },
        StatReplySchema
      )
    } catch (err) {
      await this.run({ op: 'memory-rm', root: this.root, rel: temp }, z.null()).catch(() => {})
      throw err
    }
  }

  readdir(rel: string): Promise<MemoryFsEntry[]> {
    return this.run({ op: 'memory-readdir', root: this.root, rel }, EntriesReplySchema)
  }

  async mkdir(rel: string): Promise<void> {
    await this.run({ op: 'memory-mkdir', root: this.root, rel }, z.null())
  }

  rename(from: string, to: string): Promise<boolean> {
    return this.run({ op: 'memory-rename', root: this.root, from, to }, z.boolean())
  }

  async rm(rel: string): Promise<void> {
    await this.run({ op: 'memory-rm', root: this.root, rel }, z.null())
  }

  async utimes(rel: string, mtime: string): Promise<void> {
    await this.run({ op: 'memory-utimes', root: this.root, rel, mtime }, z.null())
  }
}

/** POSIX join for a pod path — the root is in the pod's coordinates, never this host's. */
function joinRel(root: string, rel: string): string {
  const parts = rel.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new MemoryPathError('path escapes the memory root')
  return parts.length === 0 ? root : `${root.replace(/\/+$/, '')}/${parts.join('/')}`
}

/** The managed memory root on a sandbox volume: outside the user's checkout, on the same disk.
 *  Lives here rather than in `sandbox-paths.ts` because that module is imported by `tunnel.ts`,
 *  which `protocol.ts` needs — reaching back for `DEFAULT_SHIM_WORKSPACE_ROOT` closes a cycle and
 *  fails at load with a TDZ error rather than at type-check. */
export function sandboxMemoryRoot(workspaceRoot: string | undefined): string {
  return `${(workspaceRoot ?? DEFAULT_SHIM_WORKSPACE_ROOT).replace(/\/+$/, '')}/.agentconnect/memory`
}

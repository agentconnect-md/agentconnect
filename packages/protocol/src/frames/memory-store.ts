import { z } from 'zod'
import { REPLY_BUDGET } from '../wire.js'
import { MemoryFileHistoryEvent } from './memory.js'

// The managed memory tree's file-system op set as a wire contract (memory-evolution.md §3.2.1), spoken by two carriers.
// On the sandbox shim channel `root` is pod-absolute; on the `memory/store` pair below it is relative to the agent's tree.
const MemoryFsRoot = z.string().min(1).max(4096)
// A POSIX path under `root`; lexical containment is checked by whichever side holds the files, never by the sender.
const MemoryFsRel = z.string().max(4096)

// A read answers one budgeted slice at `offset`; a write is appended chunks into a sibling temp file, then one commit.
export const MemoryFsPayloadSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('memory-read'),
    root: MemoryFsRoot,
    rel: MemoryFsRel,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(REPLY_BUDGET),
    encoding: z.enum(['utf8', 'base64']).optional()
  }),
  z.object({
    op: z.literal('memory-append'),
    root: MemoryFsRoot,
    rel: MemoryFsRel,
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional(),
    create: z.boolean(),
    mode: z.number().int().optional()
  }),
  // Publish `temp` as `rel` by one rename; `ifMatchMtime` is the optimistic precondition checked in the same step.
  z.object({
    op: z.literal('memory-commit'),
    root: MemoryFsRoot,
    rel: MemoryFsRel,
    temp: MemoryFsRel,
    ifMatchMtime: z.string().optional()
  }),
  z.object({ op: z.literal('memory-create-commit'), root: MemoryFsRoot, rel: MemoryFsRel, temp: MemoryFsRel }),
  z.object({ op: z.literal('memory-stat'), root: MemoryFsRoot, rel: MemoryFsRel }),
  z.object({ op: z.literal('memory-readdir'), root: MemoryFsRoot, rel: MemoryFsRel }),
  z.object({ op: z.literal('memory-mkdir'), root: MemoryFsRoot, rel: MemoryFsRel }),
  z.object({ op: z.literal('memory-rmdir'), root: MemoryFsRoot, rel: MemoryFsRel }),
  z.object({ op: z.literal('memory-rename'), root: MemoryFsRoot, from: MemoryFsRel, to: MemoryFsRel }),
  z.object({ op: z.literal('memory-rm'), root: MemoryFsRoot, rel: MemoryFsRel }),
  z.object({ op: z.literal('memory-utimes'), root: MemoryFsRoot, rel: MemoryFsRel, mtime: z.string() })
])
export type MemoryFsPayload = z.infer<typeof MemoryFsPayloadSchema>

// `memory-read`: a missing file is data, not an error; `nextOffset` is authoritative for the next slice.
export const MemoryFsReadReplySchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    size: z.number().int().nonnegative(),
    mtime: z.string(),
    content: z.string(),
    nextOffset: z.number().int().nonnegative()
  })
])
export type MemoryFsReadReply = z.infer<typeof MemoryFsReadReplySchema>

/** `memory-append`: the staged file's size once the chunk landed. */
export const MemoryFsAppendReplySchema = z.object({ size: z.number().int().nonnegative() })
export type MemoryFsAppendReply = z.infer<typeof MemoryFsAppendReplySchema>

/** `memory-commit`: the published file's stat; its `mtime` is the token the next precondition compares. */
export const MemoryFsCommitReplySchema = z.object({ size: z.number().int().nonnegative(), mtime: z.string() })
export type MemoryFsCommitReply = z.infer<typeof MemoryFsCommitReplySchema>

/** `memory-stat`: what one path IS, never following a symlink; `other` covers a link and every non-regular entry. */
export const MemoryFsStatReplySchema = z.enum(['file', 'dir', 'missing', 'other'])
export type MemoryFsStatReply = z.infer<typeof MemoryFsStatReplySchema>

/** `memory-readdir`: the entries directly under `rel`. */
export const MemoryFsReaddirReplySchema = z.array(
  z.object({
    name: z.string(),
    kind: z.enum(['file', 'dir', 'other']),
    size: z.number().int().nonnegative().optional(),
    mtime: z.string().optional()
  })
)
export type MemoryFsReaddirReply = z.infer<typeof MemoryFsReaddirReplySchema>

// `memory-rename` and `memory-rmdir` answer whether anything moved or went; `mkdir`, `rm` and `utimes` answer null.
// The carrier's answer: `value` is the op's reply above, and the two typed refusals ride as data, not as an error.
export const MemoryFsReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    refusal: z.object({ kind: z.enum(['path', 'conflict']), message: z.string().max(500) })
  })
])
export type MemoryFsReply = z.infer<typeof MemoryFsReplySchema>

// D→C REQ `memory/store`: one op against the named agent's `control-plane` home; the REP is `MemoryFsReplySchema`.
// Error REPs: `SCOPE_DENIED` (agent not served here, or its home is not the CP), `BAD_PAYLOAD`, `INTERNAL`.
export const MemoryStoreReq = z.object({ agentId: z.string().uuid(), op: MemoryFsPayloadSchema }).strict()
export type MemoryStoreReq = z.infer<typeof MemoryStoreReq>

/** Records per change-log batch; the byte refinement on the request is the bound that keeps it in one frame. */
export const MEMORY_HISTORY_APPEND_MAX_RECORDS = 64

// D→C REQ `memory/history/append`: best-effort provenance for writes already made to one store (`root`), one frame.
// Error REPs as `memory/store`; the sender packs batches under `REPLY_BUDGET` and never reads the log back.
export const MemoryHistoryAppendReq = z
  .object({
    agentId: z.string().uuid(),
    root: MemoryFsRoot,
    records: z.array(MemoryFileHistoryEvent).min(1).max(MEMORY_HISTORY_APPEND_MAX_RECORDS)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > REPLY_BUDGET) {
      ctx.addIssue({ code: 'custom', path: ['records'], message: 'memory history batch exceeds the frame budget' })
    }
  })
export type MemoryHistoryAppendReq = z.infer<typeof MemoryHistoryAppendReq>

/** C→D REP `memory/history/append/ok`. */
export const MemoryHistoryAppendOk = z.object({ accepted: z.literal(true) })
export type MemoryHistoryAppendOk = z.infer<typeof MemoryHistoryAppendOk>

// D→C REQ `memory/home/migrated`: the one-way `daemon` → `control-plane` copy of this agent's tree is complete.
// Not a store op, because it is not a file operation. Error REPs: `SCOPE_DENIED`, `CONFLICT` (home is no longer the CP).
export const MemoryHomeMigratedReq = z.object({ agentId: z.string().uuid() }).strict()
export type MemoryHomeMigratedReq = z.infer<typeof MemoryHomeMigratedReq>

/** C→D REP `memory/home/migrated/ok`: the CP recorded the completion on the binding. */
export const MemoryHomeMigratedOk = z.object({ accepted: z.literal(true) })
export type MemoryHomeMigratedOk = z.infer<typeof MemoryHomeMigratedOk>

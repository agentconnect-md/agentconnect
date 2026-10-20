import { z } from 'zod'
import { REPLY_BUDGET } from '../wire.js'

// Computer use audit (computer-use.md §4.2, §8.2): what a desktop daemon reports per call; never typed text or screen bytes.

/** The CP stores the audit entries a desktop sends with `computer/audit`; a desktop sends none without it. */
export const COMPUTER_AUDIT_FEATURE = 'computer-audit-v1'

/** The `_meta` key an agent daemon puts on a `tools/call` to say how the call was approved. */
export const COMPUTER_APPROVAL_META_KEY = 'md.agentconnect/approval'

/** How a call was approved: no approval needed, a person allowed it, or an earlier "allow for this session" covered it. */
export const COMPUTER_APPROVAL_RESULTS = ['not_required', 'allowed', 'allowed_session'] as const
export type ComputerApprovalResult = (typeof COMPUTER_APPROVAL_RESULTS)[number]

/** The most entries one `computer/audit` frame carries. */
export const COMPUTER_AUDIT_BATCH_MAX = 100

/** The most encoded bytes of entries one `computer/audit` frame carries, so a full batch never exceeds the frame cap. */
export const COMPUTER_AUDIT_BATCH_BYTES = REPLY_BUDGET

/** The longest serialized argument summary an entry keeps; a longer one is replaced by a marker. */
export const COMPUTER_AUDIT_ARGS_MAX_CHARS = 2048

const AUDIT_STRING_MAX = 256
const AUDIT_DEPTH_MAX = 6
// Argument names whose string values are typed or written text: only their length is ever kept.
const TEXT_KEYS = new Set(['text', 'value'])
// Control characters other than tab and line breaks; PostgreSQL JSONB refuses NUL outright.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** A string as the audit stores it: control characters dropped and lone surrogates replaced, so every store accepts it. */
export function computerAuditText(value: string): string {
  return value.replace(CONTROL_CHARS, '').replace(LONE_SURROGATE, '\ufffd')
}

// Cleans every string, keys included, so no agent-supplied argument can make a batch unstorable.
function auditValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return computerAuditText(value.slice(0, AUDIT_STRING_MAX))
  if (value === null || typeof value !== 'object') return value
  if (depth >= AUDIT_DEPTH_MAX) return '[nested]'
  if (Array.isArray(value)) return value.map((item) => auditValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value))
    out[computerAuditText(key.slice(0, 64))] = auditValue(item, depth + 1)
  return out
}

/** A call's arguments as the audit keeps them: typed text by length only, strings cut and cleaned, the whole bounded. */
export function computerAuditArgs(args: Record<string, unknown>): {
  args: Record<string, unknown>
  textLength?: number
} {
  let textLength: number | undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (TEXT_KEYS.has(key) && typeof value === 'string') {
      textLength = (textLength ?? 0) + [...value].length
      continue
    }
    out[computerAuditText(key.slice(0, 64))] = auditValue(value, 1)
  }
  const bounded = JSON.stringify(out).length <= COMPUTER_AUDIT_ARGS_MAX_CHARS ? out : { truncated: true }
  return { args: bounded, ...(textLength !== undefined ? { textLength } : {}) }
}

/** One call a desktop daemon served, as it reports it to the CP. */
export const ComputerAuditEntry = z
  .object({
    // Idempotency: a batch resent after a lost ack does not duplicate rows.
    id: z.string().uuid(),
    at: z.string().datetime(),
    tool: z.string().min(1).max(128),
    // The lease holder name: `agentId/sessionId` for an agent session, else a local client or viewer name.
    client: z.string().min(1).max(512),
    agentId: z.string().uuid().optional(),
    sessionId: z.string().min(1).max(256).optional(),
    outcome: z.enum(['ok', 'error']),
    code: z.string().min(1).max(64).optional(),
    approval: z.enum(COMPUTER_APPROVAL_RESULTS).optional(),
    args: z
      .record(z.string().max(64), z.unknown())
      .refine((args) => JSON.stringify(args).length <= COMPUTER_AUDIT_ARGS_MAX_CHARS, 'audit args too large')
      .optional(),
    textLength: z.number().int().min(0).max(1_000_000).optional(),
    ms: z.number().int().min(0),
    // The stored screenshot this call returned (§9), as `sha256:<hex>`.
    screenshotRef: z.string().min(1).max(1024).optional()
  })
  .strict()
export type ComputerAuditEntry = z.infer<typeof ComputerAuditEntry>

// D→C REQ on the Computer channel, behind `computer-audit-v1`: a batch of audit entries, oldest first.
export const ComputerAuditReport = z.object({
  entries: z.array(ComputerAuditEntry).min(1).max(COMPUTER_AUDIT_BATCH_MAX)
})
export type ComputerAuditReport = z.infer<typeof ComputerAuditReport>

// C→D REP: the batch is stored; the desktop drops it from its queue.
export const ComputerAuditAck = z.object({ stored: z.number().int().min(0) })
export type ComputerAuditAck = z.infer<typeof ComputerAuditAck>

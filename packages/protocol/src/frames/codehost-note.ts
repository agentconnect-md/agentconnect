/**
 * Informational run-projection frames (gitlab-com-integration.md §16, §17.2).
 *
 * GitLab Free and Premium have no Check Run equivalent, so an agent run is
 * projected as ONE service-account note per
 * `(hook, project, merge-request IID, head SHA, projection epoch)`. The Control
 * Plane records the desired generation and sends the fixed control fields plus
 * the complete placement/effect/credential fence; the owning daemon is the only
 * provider writer and answers with the observed note identity.
 *
 * Neither frame can carry an agent reply, review body, issue/MR text, or
 * arbitrary Markdown: the only free text is a bounded normalized reason CODE.
 * Both are organization-scoped — neither joins the install-wide frame set.
 *
 * Deliberately not `.strict()`: the daemon reads Control-Plane-authored frames
 * tolerantly, so an additive field must not make the whole frame undecodable on
 * an older peer (§17.3). New ENUM or union values still need a feature string.
 */
import { z } from 'zod'
import { CodeHostExternalId, CodeHostProviderString } from '../code-host.js'
import { HookBigIntString, HookConfigSnapshot } from './hook.js'

/** The fixed lifecycle vocabulary a projected note may display (§16). */
export const CodeHostNoteState = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'skipped',
  // A newer head preempted this generation; the note names the re-request paths (§16.1).
  'superseded',
  // A handover terminalized the turn: nothing was judged and the same work can simply be run again.
  'interrupted'
])
export type CodeHostNoteState = z.infer<typeof CodeHostNoteState>

/** Short machine code only — the same discipline as HookReviewResult's code: raw provider
 *  or runtime exception text never reaches a projection. */
export const CodeHostNoteReason = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_:-]+$/)
export type CodeHostNoteReason = z.infer<typeof CodeHostNoteReason>

/** Body-free outcome the daemon reports for one desired generation. */
export const CodeHostNoteOutcome = z.enum([
  'written', // the note exists at the reported id and shows the desired state
  'skipped', // nothing to write (the daemon no longer owns the fence)
  'failed', // deterministic no-effect failure — safe to re-dispatch
  'ambiguous' // a started mutation with an unknown outcome — stays fail-closed on this writer
])
export type CodeHostNoteOutcome = z.infer<typeof CodeHostNoteOutcome>

/**
 * `codehost/note-desired` (C→D EVT) — the desired projection generation.
 *
 * `projectionKey` is the hidden stable marker the daemon reconciles a note by;
 * `writeMarker` is the per-attempt mutex it echoes on the result, so an
 * ambiguous mutation is reconciled rather than replayed. `snapshot` is the
 * complete §17.2 placement fence, `credentialEpoch` the purge fence a stale
 * effect lease loses against.
 */
export const CodeHostNoteDesired = z.object({
  projectionId: z.string().uuid(),
  provider: CodeHostProviderString,
  hookId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string().min(1).max(200), // fixed display name; never agent-authored output
  deliveryKey: z.string().min(1),
  // ── ordering fences ──
  generation: HookBigIntString,
  projectionEpoch: HookBigIntString,
  projectionKey: z.string().min(1).max(200),
  writeMarker: z.string().uuid(),
  // ── identifiers ──
  projectId: CodeHostExternalId,
  projectPath: z.string().min(1), // display only — never a match key
  mergeRequestIid: z.number().int().positive(),
  headSha: z.string().min(1),
  noteId: CodeHostExternalId.optional(), // present once observed: update that note in place
  // ── fixed state ──
  state: CodeHostNoteState,
  reason: CodeHostNoteReason.optional(),
  // ── timestamps ──
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  desiredAt: z.string().datetime(),
  // Ordinary authenticated Console URL: never a bearer token, webhook secret, or capability param.
  consoleUrl: z.string().url().optional(),
  // ── placement / effect / credential fence ──
  snapshot: HookConfigSnapshot,
  credentialEpoch: HookBigIntString,
  leaseUntil: z.string().datetime()
})
export type CodeHostNoteDesired = z.infer<typeof CodeHostNoteDesired>

/**
 * `codehost/note-result` (D→C REQ → `codehost/note-result/ok`) — the observed
 * outcome of exactly one desired generation, echoed by its write marker.
 */
export const CodeHostNoteResult = z
  .object({
    projectionId: z.string().uuid(),
    hookId: z.string().uuid(),
    generation: HookBigIntString, // the OBSERVED generation, not the daemon's latest
    writeMarker: z.string().uuid(),
    outcome: CodeHostNoteOutcome,
    noteId: CodeHostExternalId.optional(),
    observedState: CodeHostNoteState.optional(),
    code: CodeHostNoteReason.optional(),
    observedAt: z.string().datetime()
  })
  .superRefine((result, ctx) => {
    if (result.outcome === 'written' && (result.noteId === undefined || result.observedState === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [result.noteId === undefined ? 'noteId' : 'observedState'],
        message: 'a written projection reports the note id and the state it shows'
      })
    }
  })
export type CodeHostNoteResult = z.infer<typeof CodeHostNoteResult>

export const CodeHostNoteResultOk = z.object({ accepted: z.literal(true) })
export type CodeHostNoteResultOk = z.infer<typeof CodeHostNoteResultOk>

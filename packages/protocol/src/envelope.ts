import { z } from 'zod'

/**
 * The protocol envelope — every frame, both directions, is wrapped in this.
 * Mirrors daemon-cp-ws-protocol.md §1.1.
 *
 * `payload` is left as `unknown` here and validated by the per-type schema in
 * `frames/*` via `FRAME_SCHEMAS[type]` (see `frame.ts`). This two-step parse is
 * what lets the codec answer an unknown `type` with `UNKNOWN_FRAME` (a REP)
 * instead of a hard close — forward-compat, protocol §1.
 */
export const Envelope = z.object({
  v: z.literal(1), // protocol major; bump = breaking
  id: z.string().uuid(), // unique per frame (sender-generated)
  ts: z.string().datetime(), // RFC3339, sender clock (advisory only)
  type: z.string(), // frame discriminator, e.g. "register"
  corr: z.string().uuid().optional(), // correlation: set on a reply to the request's `id`
  orgId: z.string().min(1).max(64).optional(), // tenant context on an install-wide daemon connection
  payload: z.unknown() // validated by the per-type schema
})
export type Envelope = z.infer<typeof Envelope>

/**
 * Control-frame envelope extension — protocol §4.2.
 *
 * Fenced C→D frames carry this block alongside `payload`. It is the fencing
 * surface: `epoch` (sessionEpoch this frame was issued under), the `agentId` an
 * agent-scoped frame belongs to, and the `launchId` fence. Daemon validation
 * order: epoch → launchId.
 */
export const ControlExt = z.object({
  epoch: z.number().int(), // sessionEpoch this frame was issued under (§3.1 fencing)
  agentId: z.string().uuid().optional(), // present on agent-scoped frames
  launchId: z.string().uuid().optional() // per-launch fence, §4.4
})
export type ControlExt = z.infer<typeof ControlExt>

/** The all-zero UUID used when a frame is malformed past the point of reading `id`. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Builds the envelope schema for one frame `type` — the `type` literal plus the
 * typed payload — so a wire's discriminated union infers `payload` precisely.
 * Shared by the daemon↔CP union (`frame.ts`) and the relay wire unions
 * (`frames/relay-cp.ts` / `frames/relay-daemon.ts`), which are deliberately
 * SEPARATE unions over the same envelope shape (shared-bot-relay.md §8).
 */
export function frameSchema<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({
    v: z.literal(1),
    id: z.string().uuid(),
    ts: z.string().datetime(),
    type: z.literal(type),
    corr: z.string().uuid().optional(),
    orgId: z.string().min(1).max(64).optional(),
    payload
  })
}

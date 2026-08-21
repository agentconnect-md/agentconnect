import { z } from 'zod'
import { TunnelNameSchema } from './tunnel.js'

/** WS subprotocol and path the daemon uses when dialing the sandbox shim. */
export const SHIM_SUBPROTOCOL = 'agentconnect.shim.v1'
export const SHIM_WS_PATH = '/shim/v1'

/** Audience the projected ServiceAccount token is restricted to. A token minted for
 *  anything else must not authenticate here, which is what makes the pod's own
 *  credential safe to hand over: it is useless anywhere but this endpoint. */
export const SHIM_TOKEN_AUDIENCE = 'ac-daemon-callback'

/** Where the pod template projects that token, and where the shim reads it from. */
export const SHIM_IDENTITY_TOKEN_PATH = '/var/run/ac-identity/token'

/** Port the in-sandbox shim listens on for daemon dial-in. */
export const SHIM_LISTEN_PORT_ENV = 'AC_SHIM_PORT'
export const DEFAULT_SHIM_LISTEN_PORT = 8085

/** Root the sandbox permits filesystem work inside — the mounted agent volume. Also non-secret,
 *  and fixed by the image rather than chosen per request, since the shim uses it to refuse a
 *  cwd that escapes it. */
export const SHIM_WORKSPACE_ROOT_ENV = 'AC_SHIM_WORKSPACE_ROOT'

/** The shim's own fallback for that env, and the daemon's assumption for a legacy shim that
 *  predates workspace-root reporting — every such image mounted the volume here. */
export const DEFAULT_SHIM_WORKSPACE_ROOT = '/agent'

/** Operations the daemon may ask a bound shim to perform. Every one is authorized
 *  individually against the binding's grants — a channel is not a blanket permission.
 *  The bodies land in #814 / #815; this is the authorization vocabulary they use. */
export const ShimCapabilitySchema = z.enum([
  /** Write daemon-materialized files (secrets, config files) into the sandbox. */
  'materialize',
  /** Run a command in the sandbox and return a structured result (workspace git). */
  'exec',
  /** Read a bounded file back out (BFF workspace reads). */
  'read',
  /** Proxy an in-pod unix socket back to a daemon-side server (gitcred, gh, MCP). */
  'tunnel',
  /** Run the ACP runtime and relay its stdio as a stream (its own channel: ACP is already
   *  a complete protocol, and reinterpreting it here would add a second place to break). */
  'acp',
  /** Run the merge-when-ready watcher in the pod, so the armed set lives and dies with the
   *  sandbox. Its own capability rather than a widening of `exec`: that channel is git-only and
   *  enforced in-pod on purpose, and reaching `gh` through it would turn a deliberate boundary
   *  into an arbitrary-execution surface. */
  'automerge',
  /** Report which runtimes this image actually provides, by asking them. The daemon cannot learn
   *  this any other way: `--k8s` runs no local runtime, and anything it states from its own
   *  configuration is a claim about an image it never opened. */
  'probe'
])
export type ShimCapability = z.infer<typeof ShimCapabilitySchema>

/** The daemon opens a dial-in channel with the launch it expects to bind. */
export const ShimDialHelloSchema = z.object({
  type: z.literal('shim/hello'),
  agentId: z.string().min(1),
  generation: z.number().int().nonnegative()
})

/** The shim answers the dialer's hello by proving which pod accepted it. */
export const ShimIdentitySchema = z.object({
  type: z.literal('shim/identity'),
  /** Projected ServiceAccount token, audience-restricted to {@link SHIM_TOKEN_AUDIENCE}. */
  token: z.string().min(1),
  /** Shim build, for operator diagnosis only — never an authorization input. */
  shimVersion: z.string().max(64).optional(),
  /** This pod's workspace mount; absent on legacy shims means {@link DEFAULT_SHIM_WORKSPACE_ROOT}. */
  workspaceRoot: z.string().min(1).max(4096).optional()
})

/** The daemon's answer once the token is verified and mapped to a spawn record. */
export const ShimBoundSchema = z.object({
  type: z.literal('shim/bound'),
  /** Short-TTL credential for subsequent frames, bound to this pod and generation. */
  sessionCredential: z.string().min(1),
  /** Seconds until the credential must be re-obtained by re-handshaking. */
  expiresInSeconds: z.number().int().positive(),
  agentId: z.string().min(1),
  /** Monotonic per-agent spawn counter; frames from an older one are refused. */
  generation: z.number().int().nonnegative(),
  grants: z.array(ShimCapabilitySchema)
})

export const ShimRejectedSchema = z.object({
  type: z.literal('shim/rejected'),
  /** Coarse, non-probing reason: never leaks which of several checks failed. */
  reason: z.enum(['unauthenticated', 'unknown_pod', 'stale_generation', 'unavailable']),
  message: z.string().max(200)
})

/** Every post-binding frame carries the credential and the generation it was issued
 *  for, so a replayed frame from a previous pod incarnation is refused on arrival. */
export const ShimRequestSchema = z.object({
  type: z.literal('shim/request'),
  id: z.string().uuid(),
  sessionCredential: z.string().min(1),
  generation: z.number().int().nonnegative(),
  capability: ShimCapabilitySchema,
  /** Operation payload, shaped per capability by the channels that land later. */
  payload: z.unknown()
})

// Cancels an in-flight request by id. Carries credential and generation like every post-binding
// frame, so a replayed cancel from a previous incarnation cannot kill a live request.
export const ShimCancelSchema = z.object({
  type: z.literal('shim/cancel'),
  id: z.string().uuid(),
  sessionCredential: z.string().min(1),
  generation: z.number().int().nonnegative(),
  reason: z.string().max(200).optional()
})

export const ShimResponseSchema = z.object({
  type: z.literal('shim/response'),
  id: z.string().uuid(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z.string().max(500).optional()
})

/** A recurring event on an open stream. Unlike a response, many arrive per request: an ACP
 *  runtime emits stdout continuously and exits once, and neither fits one-shot correlation. */
export const ShimEventSchema = z.object({
  type: z.literal('shim/event'),
  /** The stream this belongs to: the request id that opened it, or — for a tunnel, whose
   *  connections are opened by a process inside the pod — an id the shim mints and announces. */
  streamId: z.string().uuid(),
  event: z.discriminatedUnion('kind', [
    /** A process in the sandbox connected to a tunnel's socket; the daemon dials its own end. */
    z.object({ kind: z.literal('connect'), tunnel: TunnelNameSchema }),
    z.object({ kind: z.literal('chunk'), data: z.string() }),
    z.object({
      kind: z.literal('exit'),
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
      error: z.string().max(500).optional()
    })
  ])
})

export const ShimFrameSchema = z.union([
  ShimDialHelloSchema,
  ShimIdentitySchema,
  ShimBoundSchema,
  ShimRejectedSchema,
  ShimRequestSchema,
  ShimCancelSchema,
  ShimResponseSchema,
  ShimEventSchema
])

export type ShimBound = z.infer<typeof ShimBoundSchema>
export type ShimRejected = z.infer<typeof ShimRejectedSchema>
export type ShimRequest = z.infer<typeof ShimRequestSchema>
export type ShimCancel = z.infer<typeof ShimCancelSchema>
export type ShimResponse = z.infer<typeof ShimResponseSchema>
export type ShimEvent = z.infer<typeof ShimEventSchema>
export type ShimFrame = z.infer<typeof ShimFrameSchema>
export type ShimDialHello = z.infer<typeof ShimDialHelloSchema>
export type ShimIdentity = z.infer<typeof ShimIdentitySchema>

/** Parse an inbound frame, returning undefined rather than throwing: a malformed frame
 *  from a half-trusted peer is a close-the-connection event, not an exception path. */
export function parseShimFrame(text: string): ShimFrame | undefined {
  try {
    const result = ShimFrameSchema.safeParse(JSON.parse(text))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

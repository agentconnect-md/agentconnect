import { z } from 'zod'
import { SANDBOX_TUNNEL_PATHS as SANDBOX_TUNNEL_PATH_SOURCE } from './sandbox-paths.js'

/** The daemon-side servers a sandbox may reach, a closed set so a compromised runtime reaches only these: agent and mcp as in-pod sockets, codehost and provider through one loopback proxy. */
export const TunnelNameSchema = z.enum(['agent', 'mcp', 'codehost', 'provider'])
export type TunnelName = z.infer<typeof TunnelNameSchema>

/** The tunnels a shim serves through its loopback proxy listener, each with its own routes and stream budget. */
export type ProxyTunnelName = 'codehost' | 'provider'

/** Whether a tunnel is served through the loopback proxy listener rather than at an in-pod socket. */
export function isProxyTunnel(tunnel: TunnelName): tunnel is ProxyTunnelName {
  return tunnel === 'codehost' || tunnel === 'provider'
}

/** Bytes per chunk in either direction. One `shim/request` or `shim/event` carries at most one
 *  chunk, so this has to leave room under `MAX_FRAME_BYTES` (256 KiB) after base64 expansion. */
export const MAX_TUNNEL_CHUNK_BYTES = 32 * 1024
/** The most authorities one `codehost` or `provider` listen forwards. */
export const MAX_CODEHOST_ROUTES = 64
/** Concurrent `codehost` streams per sandbox, apart from the helper tunnels' own budget so a busy clone cannot starve `mcp` or `agent`. */
export const MAX_CODEHOST_STREAMS = 16
/** Concurrent `provider` streams per sandbox, its own budget: each session holds a few long-lived model connections (subagents, pooled keep-alives), so it is wider than a clone burst's. */
export const MAX_PROVIDER_STREAMS = 64
/** Data frames one stream may have unacknowledged, in either direction, before its local socket is paused (8 × 32 KiB). */
export const MAX_IN_FLIGHT_FRAMES = 8
/** How many shim-sent chunks the daemon writes out before acknowledging them, so a paused stream always earns an ack. */
export const ACK_EVERY_FRAMES = MAX_IN_FLIGHT_FRAMES / 2
const MAX_TUNNEL_CHUNK_BASE64 = Math.ceil(MAX_TUNNEL_CHUNK_BYTES / 3) * 4

/**
 * Daemon → shim: serve this tunnel on its in-pod path. Idempotent per pod, because the
 * listener belongs to the POD and the channel does not — a credential renewal replaces the
 * socket underneath while every in-pod client keeps its connection.
 *
 * It deliberately does NOT name the path. Both sides already know {@link SANDBOX_TUNNEL_PATHS},
 * and a daemon-supplied path would have to be validated against that map on arrival anyway — so
 * the field would carry no information while widening what a compromised daemon could ask the
 * shim to create.
 */
export const TunnelListenSchema = z.object({
  op: z.literal('listen'),
  tunnel: TunnelNameSchema,
  // `codehost` and `provider` only: the `host:port` authorities the listener forwards into this tunnel, and the CA the session trusts for them.
  routes: z.array(z.string().min(1).max(270)).max(MAX_CODEHOST_ROUTES).optional(),
  ca: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional(),
  // The daemon acknowledges this tunnel's shim-sent chunks; an older shim strips the field and is never sent an `ack`.
  acks: z.boolean().optional()
})
/** What the daemon sends with a `codehost` or `provider` listen: the routes, and the CA certificate alone, which the shim merges with its own machine's roots. */
export type TunnelListenOptions = { routes: string[]; ca: string }

/**
 * Bytes toward one in-pod connection. The daemon sends these as requests; the shim reports the
 * opposite direction as `shim/event` chunks on the same stream id, which is the only way round:
 * requests flow daemon → shim only, and a tunnel connection is opened by a process inside the
 * pod, so the shim has to announce it.
 */
export const TunnelDataSchema = z.object({
  op: z.literal('data'),
  streamId: z.string().uuid(),
  /** base64 because the frame is JSON text; the payload is opaque bytes either way. */
  chunk: z.string().max(MAX_TUNNEL_CHUNK_BASE64)
})

export const TunnelCloseSchema = z.object({
  op: z.literal('close'),
  streamId: z.string().uuid(),
  error: z.string().max(200).optional()
})

/** Daemon → shim: how many of a stream's `chunk` events the daemon has written out, cumulative so a repeat is harmless. */
export const TunnelAckSchema = z.object({
  op: z.literal('ack'),
  streamId: z.string().uuid(),
  received: z.number().int().nonnegative()
})

export const TunnelPayloadSchema = z.discriminatedUnion('op', [
  TunnelListenSchema,
  TunnelDataSchema,
  TunnelCloseSchema,
  TunnelAckSchema
])
export type TunnelPayload = z.infer<typeof TunnelPayloadSchema>

/** What a `listen` reports back: the path the pod serves, and for `codehost` or `provider` the loopback proxy a session is pointed at. */
export const TunnelListeningSchema = z.object({
  socketPath: z.string().min(1),
  proxy: z
    .object({
      port: z.number().int().min(1).max(65_535),
      token: z.string().min(16).max(128),
      trustBundle: z.string().min(1).max(4096)
    })
    .optional(),
  // The shim takes `ack`s and bounds this tunnel's streams by them; absent from an older shim, which is never sent one.
  acks: z.boolean().optional(),
  // `codehost` under `srt`: the names its boundary routes to the shim's codehost socket, which serves this listen's routes.
  srt: z.object({ domains: z.array(z.string().min(1).max(253)).max(MAX_CODEHOST_ROUTES) }).optional(),
  // `codehost`: the shim merges the trust files its seed names when a launch asks; absent from an older shim, whose hosted VM keeps the helper path.
  guestTrust: z.boolean().optional()
})
export type TunnelListening = z.infer<typeof TunnelListeningSchema>

/**
 * Which in-pod path each tunnel is served at. Fixed by the runtime image, not by the daemon's own
 * root, because the daemon's paths mean nothing inside the sandbox.
 *
 * Declared in `sandbox-paths.ts` — the credential helper needs the agent tunnel path and must not pull
 * this module's zod schemas into its own bundle — and re-exported here, typed against the enum
 * above so a name without a path (or a path without a name) fails to compile.
 */
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<TunnelName, string>> = SANDBOX_TUNNEL_PATH_SOURCE

import { z } from 'zod'
import { SANDBOX_TUNNEL_PATHS as SANDBOX_TUNNEL_PATH_SOURCE } from './sandbox-paths.js'

/** The daemon-side servers a sandbox may reach, a closed set so a compromised runtime reaches only these: gitcred and mcp as in-pod sockets, codehost as a loopback proxy. */
export const TunnelNameSchema = z.enum(['gitcred', 'mcp', 'codehost'])
export type TunnelName = z.infer<typeof TunnelNameSchema>

/** Bytes per chunk in either direction. One `shim/request` or `shim/event` carries at most one
 *  chunk, so this has to leave room under `MAX_FRAME_BYTES` (256 KiB) after base64 expansion. */
export const MAX_TUNNEL_CHUNK_BYTES = 32 * 1024
/** The most code-host authorities one agent's `codehost` listener forwards. */
export const MAX_CODEHOST_ROUTES = 64
/** Concurrent `codehost` streams per sandbox, apart from the helper tunnels' own budget so a busy clone cannot starve `mcp` or `gitcred`. */
export const MAX_CODEHOST_STREAMS = 16
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
  // `codehost` only: the `host:port` authorities its listener forwards to the daemon, and the CA the session trusts for them.
  routes: z.array(z.string().min(1).max(270)).max(MAX_CODEHOST_ROUTES).optional(),
  ca: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional()
})
/** What the daemon sends with a `codehost` listen: the routes, and the CA certificate alone, which the shim merges with its own machine's roots. */
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

export const TunnelPayloadSchema = z.discriminatedUnion('op', [TunnelListenSchema, TunnelDataSchema, TunnelCloseSchema])
export type TunnelPayload = z.infer<typeof TunnelPayloadSchema>

/** What a `listen` reports back: the path the pod serves, and for `codehost` the loopback proxy a session is pointed at. */
export const TunnelListeningSchema = z.object({
  socketPath: z.string().min(1),
  proxy: z
    .object({
      port: z.number().int().min(1).max(65_535),
      token: z.string().min(16).max(128),
      trustBundle: z.string().min(1).max(4096)
    })
    .optional()
})
export type TunnelListening = z.infer<typeof TunnelListeningSchema>

/**
 * Which in-pod path each tunnel is served at. Fixed by the runtime image, not by the daemon's own
 * root, because the daemon's paths mean nothing inside the sandbox.
 *
 * Declared in `sandbox-paths.ts` — the credential helper needs the gitcred path and must not pull
 * this module's zod schemas into its own bundle — and re-exported here, typed against the enum
 * above so a name without a path (or a path without a name) fails to compile.
 */
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<TunnelName, string>> = SANDBOX_TUNNEL_PATH_SOURCE

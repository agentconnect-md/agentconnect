import { z } from 'zod'

/**
 * Unix sockets the daemon exposes into a sandbox. Each is a daemon-side server the runtime
 * expects to find locally: the git-credential helper (which `gh`'s token helper shares) and
 * the MCP bridge. The shim listens on the in-pod path and proxies bytes back over the channel.
 *
 * The set is closed on purpose. A generic "tunnel any socket" capability would let a
 * compromised runtime reach whatever the daemon happens to be listening on; naming the
 * servers keeps the grant meaningful.
 */
export const TunnelNameSchema = z.enum(['gitcred', 'mcp'])
export type TunnelName = z.infer<typeof TunnelNameSchema>

/** Bytes per chunk in either direction. One `shim/request` or `shim/event` carries at most one
 *  chunk, so this has to leave room under `MAX_FRAME_BYTES` (256 KiB) after base64 expansion. */
export const MAX_TUNNEL_CHUNK_BYTES = 32 * 1024
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
  tunnel: TunnelNameSchema
})

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

/** What a `listen` reports back, so the daemon logs the path the pod actually serves. */
export const TunnelListeningSchema = z.object({ socketPath: z.string().min(1) })

/** Which in-pod path each tunnel is served at. Fixed by the runtime image, not by the
 *  daemon's own root, because the daemon's paths mean nothing inside the sandbox. */
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<TunnelName, string>> = Object.freeze({
  gitcred: '/run/agentconnect/gitcred.sock',
  mcp: '/run/agentconnect/mcp.sock'
})

import { z } from 'zod'

/**
 * Unix sockets the daemon exposes into a sandbox. Each is a daemon-side server the runtime
 * expects to find locally: the git-credential helper, the `gh` token helper, and the MCP
 * bridge. The shim listens on the in-pod path and proxies bytes back over the channel.
 *
 * The set is closed on purpose. A generic "tunnel any socket" capability would let a
 * compromised runtime reach whatever the daemon happens to be listening on; naming the
 * three keeps the grant meaningful.
 */
export const TunnelNameSchema = z.enum(['gitcred', 'gh-token', 'mcp'])
export type TunnelName = z.infer<typeof TunnelNameSchema>

export const TunnelOpenSchema = z.object({
  op: z.literal('open'),
  tunnel: TunnelNameSchema,
  /** Stream id, unique per channel; the shim rejects a reused one. */
  streamId: z.string().uuid(),
  /** Absolute in-pod path the shim must listen on for this tunnel. */
  socketPath: z.string().min(1)
})

export const TunnelDataSchema = z.object({
  op: z.literal('data'),
  streamId: z.string().uuid(),
  /** base64 because the frame is JSON text; the payload is opaque bytes either way. */
  chunk: z.string()
})

export const TunnelCloseSchema = z.object({
  op: z.literal('close'),
  streamId: z.string().uuid(),
  error: z.string().max(200).optional()
})

export const TunnelPayloadSchema = z.discriminatedUnion('op', [TunnelOpenSchema, TunnelDataSchema, TunnelCloseSchema])
export type TunnelPayload = z.infer<typeof TunnelPayloadSchema>

/** Which in-pod path each tunnel is served at. Fixed by the runtime image, not by the
 *  daemon's own root, because the daemon's paths mean nothing inside the sandbox. */
export const SANDBOX_TUNNEL_PATHS: Readonly<Record<TunnelName, string>> = Object.freeze({
  gitcred: '/run/agentconnect/gitcred.sock',
  'gh-token': '/run/agentconnect/gh-token.sock',
  mcp: '/run/agentconnect/mcp.sock'
})

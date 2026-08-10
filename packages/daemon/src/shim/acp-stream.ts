import { z } from 'zod'

/**
 * The ACP byte stream, carried over the shim channel.
 *
 * `AcpHost` wants a pair of byte streams and a lifecycle; locally those are a child's stdio.
 * Here the runtime is a process inside the sandbox, so the shim starts it and relays its
 * stdio. The framing is deliberately dumb — open, chunks both ways, close — because ACP is
 * already a complete protocol and re-interpreting it in the channel would add a second
 * place for it to go wrong.
 */
export const AcpOpenSchema = z.object({
  op: z.literal('open'),
  /** The runtime command to start inside the sandbox, resolved in ITS filesystem. */
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Complete child environment, decided by the daemon. */
  env: z.record(z.string(), z.string()),
  cwd: z.string().min(1).optional(),
  /** Env pointers the shim fills from its own PATH when unset (e.g. CLAUDE_CODE_EXECUTABLE). */
  hints: z.array(z.object({ envVar: z.string().min(1), command: z.string().min(1) })).optional()
})

export const AcpChunkSchema = z.object({
  op: z.literal('chunk'),
  /** base64: the frame is JSON text, the payload is opaque ND-JSON bytes. */
  data: z.string()
})

export const AcpCloseSchema = z.object({
  op: z.literal('close'),
  /** Graceful stop deadline before the shim escalates to a kill. */
  deadlineMs: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional()
})

export const AcpStreamPayloadSchema = z.discriminatedUnion('op', [AcpOpenSchema, AcpChunkSchema, AcpCloseSchema])
export type AcpStreamPayload = z.infer<typeof AcpStreamPayloadSchema>
export type AcpOpen = z.infer<typeof AcpOpenSchema>

/** Frames the shim emits back for a live ACP stream. */
export const AcpEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('chunk'), data: z.string() }),
  z.object({ event: z.literal('exit'), code: z.number().int().nullable(), signal: z.string().nullable() })
])
export type AcpEvent = z.infer<typeof AcpEventSchema>

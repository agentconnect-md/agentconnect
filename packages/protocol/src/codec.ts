import { FRAME_SCHEMAS, type AnyFrame, type FrameType } from './index.js'
import {
  MAX_FRAME_BYTES,
  buildEnvelopeRaw,
  decodeEnvelopeWith,
  type BuildOpts,
  type DecodeResultOf,
  type InboundControlExt
} from './wire.js'

/**
 * The daemon↔CP wire codec — the `FRAME_SCHEMAS` instantiation of the generic
 * envelope codec in `wire.ts`. The relay wires (`frames/relay-*.ts`) build their
 * own instantiations over their own schema maps; the unions never mix.
 */

export { MAX_FRAME_BYTES }
export type { BuildOpts, InboundControlExt }

export type DecodeResult = DecodeResultOf<AnyFrame>

export function decodeEnvelope(text: string): DecodeResult {
  return decodeEnvelopeWith<AnyFrame>(FRAME_SCHEMAS, text)
}

export function buildEnvelope<T extends FrameType>(type: T, payload: unknown, opts: BuildOpts = {}): AnyFrame {
  return buildEnvelopeRaw(type, payload, opts) as AnyFrame
}

function legacyRemoteMemoryConnection(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (record.transport !== 'streamable-http') return value
  const { transport: _transport, ...legacy } = record
  return legacy
}

/** Keep M-5A remote connection frames readable by pre-M-5D daemons. Local
 * stdio definitions retain their explicit discriminator and therefore require
 * an M-5D daemon. Decoding always normalizes both shapes. */
export function encode(frame: AnyFrame): string {
  if (frame.type === 'memoryconnection/upsert') {
    return JSON.stringify({ ...frame, payload: legacyRemoteMemoryConnection(frame.payload) })
  }
  if (frame.type === 'register/ok') {
    const payload = frame.payload as unknown as Record<string, unknown>
    if (Array.isArray(payload.memoryConnections)) {
      return JSON.stringify({
        ...frame,
        payload: {
          ...payload,
          memoryConnections: payload.memoryConnections.map(legacyRemoteMemoryConnection)
        }
      })
    }
  }
  return JSON.stringify(frame)
}

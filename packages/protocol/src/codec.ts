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

export function encode(frame: AnyFrame): string {
  return JSON.stringify(frame)
}

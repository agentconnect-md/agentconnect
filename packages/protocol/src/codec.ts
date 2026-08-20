import { FRAME_SCHEMAS, type AnyFrame, type FrameType } from './index.js'
import { tolerantSchemas } from './tolerant.js'
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
 *
 * Two readers, one union. The CP reads a daemon with `decodeEnvelope`, where a
 * strict payload keeps its unknown-key check on what a peer sends in. The daemon
 * reads the CP with `decodeCpEnvelope`, which strips unknown keys instead: the CP
 * upgrades first, and a daemon that fails `register/ok` over a field it predates
 * cannot finish a handshake until it is upgraded too (`tolerant.ts`).
 */

export { MAX_FRAME_BYTES }
export type { BuildOpts, InboundControlExt }

export type DecodeResult = DecodeResultOf<AnyFrame>

export function decodeEnvelope(text: string): DecodeResult {
  return decodeEnvelopeWith<AnyFrame>(FRAME_SCHEMAS, text)
}

// Built on first use, not at import: only a daemon-side reader pays for the rebuild.
let cpSchemas: typeof FRAME_SCHEMAS | undefined

/** Decode a CP-authored frame. Same union as `decodeEnvelope`, read tolerantly. */
export function decodeCpEnvelope(text: string): DecodeResult {
  cpSchemas ??= tolerantSchemas(FRAME_SCHEMAS)
  return decodeEnvelopeWith<AnyFrame>(cpSchemas, text)
}

export function buildEnvelope<T extends FrameType>(type: T, payload: unknown, opts: BuildOpts = {}): AnyFrame {
  return buildEnvelopeRaw(type, payload, opts) as AnyFrame
}

export function encode(frame: AnyFrame): string {
  return JSON.stringify(frame)
}

/**
 * The wire codec now lives in `@agentconnect.md/protocol` (single source of truth
 * for the wire — used by both the CP and the daemon). This module re-exports it
 * so existing CP imports (`./codec.js`) keep working unchanged.
 */
export {
  decodeEnvelope,
  buildEnvelope,
  encode,
  MAX_FRAME_BYTES,
  type DecodeResult,
  type BuildOpts,
  type InboundControlExt
} from '@agentconnect.md/protocol'

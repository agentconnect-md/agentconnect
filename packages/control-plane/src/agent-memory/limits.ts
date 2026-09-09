// The caps of a managed memory tree, the same numbers the daemon's `memory/store.ts` enforces on a `daemon` home.
import type { AgentMemoryHistoryRetention } from '../persistence/ports.js'

/** Hard cap on a single memory file; an append that would cross it is refused as `BAD_PAYLOAD`. */
export const MAX_MEMORY_FILE_BYTES = 256_000

/** Newest versions kept per file — the daemon's `MAX_HISTORY_VERSIONS_PER_FILE`. */
export const MAX_HISTORY_VERSIONS_PER_FILE = 100
/** Encoded bytes kept per store — the daemon's `MAX_HISTORY_FILE_BYTES`, the sidecar cap it replaces. */
export const MAX_HISTORY_FILE_BYTES = 2 * 1024 * 1024

export const HISTORY_RETENTION: AgentMemoryHistoryRetention = {
  maxVersionsPerFile: MAX_HISTORY_VERSIONS_PER_FILE,
  maxBytesPerRoot: MAX_HISTORY_FILE_BYTES
}

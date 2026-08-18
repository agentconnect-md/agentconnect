/**
 * `MemoryProvider` — the pluggable seam behind an agent's long-term memory.
 *
 * The daemon drives a provider at the existing hook points: it seeds/injects the
 * memory index at session start, exposes the memory tools, serves list/read/write
 * for both the agent (MCP tools) and the console, and contributes the runtime-env
 * delta that decides where the runtime's OWN memory lives. Making this a port lets
 * memory be backed three ways (design: docs/designs/memory-evolution.md):
 *
 *   - `managed`  — our directory (`<agent-root>/memory/`), the default. The runtime's
 *     own memory is DISABLED so there's one store.
 *   - `native`   — the runtime's own memory (Claude auto-memory / Codex memories),
 *     REDIRECTED under the agent root (via env) for per-agent isolation. We don't
 *     inject or expose tools — the runtime manages and loads it itself.
 *   - `external` — an out-of-process memory plugin (for example Mem0).
 *
 * Per-agent selection: each agent carries `memory.provider`. The daemon holds a
 * `DispatchingMemoryProvider` that routes every scope-bearing call to the agent's
 * configured concrete provider. The one non-scoped seam is `runtimeEnv` (it needs
 * the agent root + the concrete runtime), applied directly in `daemon.ts` where the
 * full agent is in hand — see `memoryProviderFor`.
 *
 * The CP frame path keeps its own byte-sliced reader (`cp/memory-reader.ts`): its
 * UTF-8-boundary + frame-budget slicing is a wire-transport concern that must not
 * leak into this storage-domain port. `read()` here is whole-file (MCP semantics).
 *
 * The implementations live one directory down (`memory/providers/`); this module is
 * the stable import surface every caller already uses.
 */
export type {
  FileMemoryAdmin,
  MemoryAdminSurface,
  MemoryEntry,
  MemoryExtractor,
  MemoryProvider,
  MemoryProviderKind,
  MemoryRecord,
  MemoryRecordHistoryPage,
  MemoryRecordPage,
  MemoryReadResult,
  MemoryScope,
  MemoryWriteResult,
  RecallPolicy,
  RecallRequest,
  RecordMemoryAdmin,
  TurnRecord
} from './types.js'
export { MemoryProviderUnavailableError } from './types.js'

export { ManagedMemoryProvider } from './providers/managed.js'
export { NoMemoryProvider } from './providers/none.js'
export { NativeMemoryProvider } from './providers/native.js'
export {
  ExternalMemoryProvider,
  type ExternalMemoryRuntimeDeps,
  type PreparedExternalMemoryCapture
} from './providers/external.js'
export { DispatchingMemoryProvider, type MemoryProviderDeps } from './providers/dispatching.js'
export {
  createManagedMemoryProvider,
  createMemoryProvider,
  memoryKindOf,
  memoryProviderFor
} from './providers/factory.js'

// The stable import surface for the per-agent memory seam (managed, native, external, none); implementations live in `memory/providers/`, design in docs/designs/memory-evolution.md.
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
  type MemoryCaptureEnqueueSink,
  type PreparedExternalMemoryCapture
} from './providers/external.js'
export { DispatchingMemoryProvider, type MemoryProviderDeps } from './providers/dispatching.js'
export {
  createManagedMemoryProvider,
  createMemoryProvider,
  memoryKindOf,
  memoryProviderFor
} from './providers/factory.js'

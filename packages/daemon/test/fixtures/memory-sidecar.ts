// Test convenience over ONE local tree: the sidecar inside it is the sink, named here once instead of at every call.
// Production callers name their sink through `resolveMemoryHomePorts` (memory-evolution.md §3.2.1); a test that is
// about the sink itself calls the store's functions directly with the sink it means.
import { sidecarMemoryHistory } from '../../src/memory/home.js'
import {
  listMemoryHistory,
  writeMemoryFile,
  type ManagedMemoryHistoryPage,
  type MemoryFs,
  type MemoryWriteSource
} from '../../src/memory/store.js'

/** `writeMemoryFile` on a local tree, its change log in the sidecar beside the store. */
export function writeWithSidecar(
  fs: MemoryFs,
  relPath: string,
  content: string,
  ifMatchMtime?: string,
  source: MemoryWriteSource = 'tool'
): Promise<{ size: number; mtime: string }> {
  return writeMemoryFile(fs, relPath, content, ifMatchMtime, source, sidecarMemoryHistory(fs))
}

/** `listMemoryHistory` over the sidecar inside a local tree. */
export function listSidecarHistory(
  fs: MemoryFs,
  relPath: string,
  cursor: string | undefined,
  limit: number
): Promise<ManagedMemoryHistoryPage> {
  return listMemoryHistory(sidecarMemoryHistory(fs), relPath, cursor, limit)
}

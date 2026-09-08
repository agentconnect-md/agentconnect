// Path containment for the table-backed memory home: the same lexical rules the daemon's `memoryRelSegments`
// applies, so a path one carrier refuses the other refuses too. A stored path is plain segments joined by `/`.

/** A path refusal — answered as the `path` refusal of `memory/store/ok`, never as an error REP. */
export class MemoryStorePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStorePathError'
  }
}

/** A failed `ifMatchMtime` precondition — the `conflict` refusal. */
export class MemoryStoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStoreConflictError'
  }
}

/** A write past `MAX_MEMORY_FILE_BYTES` — `BAD_PAYLOAD`, since the daemon's store refuses it first. */
export class MemoryStoreTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryStoreTooLargeError'
  }
}

/** Split a root-relative path into plain components; `''` (or `.`) is the root itself. */
export function memoryPathSegments(rel: string): string[] {
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new MemoryStorePathError('absolute paths are not allowed')
  }
  const parts = rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..' || part.includes('\0'))) {
    throw new MemoryStorePathError('path escapes the memory root')
  }
  return parts
}

/** The stored path of `(root, rel)`, both relative to the agent's tree; `''` is the tree root. */
export function memoryStorePath(root: string, rel: string): string {
  return [...memoryPathSegments(root), ...memoryPathSegments(rel)].join('/')
}

/** The same, for an op that needs a file name — the tree root itself is refused as the disk ports refuse it. */
export function memoryStoreLeafPath(root: string, rel: string): string {
  const path = memoryStorePath(root, rel)
  if (path === '') throw new MemoryStorePathError('a file name is required')
  return path
}

/** The parent of a stored path (`''` for a top-level name). */
export function memoryStoreParent(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

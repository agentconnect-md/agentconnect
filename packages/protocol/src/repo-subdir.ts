export const MAX_REPO_SUBDIR_LENGTH = 1024

export class RepoSubdirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepoSubdirError'
  }
}

/** Normalize a portable repository-relative working directory. Undefined means repo root. */
export function normalizeRepoSubdir(input: string | null | undefined): string | undefined {
  const trimmed = input?.trim() ?? ''
  if (!trimmed || trimmed === '/' || trimmed === '.' || trimmed === './') return undefined

  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  if (normalized.length > MAX_REPO_SUBDIR_LENGTH) {
    throw new RepoSubdirError(`working subdirectory must be at most ${MAX_REPO_SUBDIR_LENGTH} characters`)
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new RepoSubdirError('working subdirectory must be relative to the repository')
  }
  if (normalized.includes('\\')) {
    throw new RepoSubdirError('working subdirectory must use forward slashes')
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RepoSubdirError('working subdirectory must not contain control characters')
  }

  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new RepoSubdirError('working subdirectory must not contain empty, ".", or ".." path segments')
  }
  return normalized
}

// Resolvable ref spellings (source-cache.md §5), a leaf module so provider members import it without a cycle.
import { assertBranchRef } from '../source-cache/keys.js'

export type RepositoryRefSpec =
  | { kind: 'branch'; name: string }
  | { kind: 'tag'; name: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'default' }

const COMMIT_SHA = /^[0-9a-f]{40}$/i

/** `refs/heads/<b>`, `refs/tags/<t>`, `HEAD` (the default branch) or a 40-hex commit (lower-cased); undefined otherwise. */
export function parseResolvableRef(ref: string): RepositoryRefSpec | undefined {
  if (COMMIT_SHA.test(ref)) return { kind: 'commit', sha: ref.toLowerCase() }
  if (ref === 'HEAD') return { kind: 'default' }
  // A tag name obeys the same check-ref-format rules a branch name does.
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined
  try {
    assertBranchRef(tag !== undefined ? `refs/heads/${tag}` : ref)
  } catch {
    return undefined
  }
  return tag !== undefined ? { kind: 'tag', name: tag } : { kind: 'branch', name: ref.slice('refs/heads/'.length) }
}

/** The full ref a resolvable spec names, `HEAD` for the default branch, the SHA for a commit. */
export function resolvableRefName(ref: RepositoryRefSpec): string {
  if (ref.kind === 'commit') return ref.sha
  if (ref.kind === 'default') return 'HEAD'
  return `refs/${ref.kind === 'tag' ? 'tags' : 'heads'}/${ref.name}`
}

/** The branch or tag a non-commit spec reads, the host's default branch standing in for `HEAD`; undefined when unusable. */
export function concreteRef(
  ref: Exclude<RepositoryRefSpec, { kind: 'commit' }>,
  defaultBranch: string | undefined
): { kind: 'branch' | 'tag'; name: string; fullName: string } | undefined {
  if (ref.kind !== 'default') return { ...ref, fullName: resolvableRefName(ref) }
  if (defaultBranch === undefined) return undefined
  const parsed = parseResolvableRef(`refs/heads/${defaultBranch}`)
  return parsed?.kind === 'branch' ? { ...parsed, fullName: `refs/heads/${parsed.name}` } : undefined
}

/** A skill entry's ref as resolvable forms in the order to try: a bare name is a branch first, then a tag. */
export function normalizeSkillRef(ref: string | undefined): readonly string[] {
  if (ref === undefined || ref === '' || ref === 'HEAD') return ['HEAD']
  if (COMMIT_SHA.test(ref)) return [ref.toLowerCase()]
  if (ref.startsWith('refs/')) return [ref]
  return [`refs/heads/${ref}`, `refs/tags/${ref}`]
}

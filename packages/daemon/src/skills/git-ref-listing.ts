// Which full ref a skill entry's ref spelling selects in one scoped `git ls-remote` listing (source-cache.md §5); pure, no I/O.
import { parseResolvableRef } from '../codehost/ref-spec.js'

const OID = /^[0-9a-f]{40}$/

/** The full ref the entry's name selects with its commit (peeled for an annotated tag), or why none is named. */
export type GitSkillRefNaming =
  { kind: 'named'; ref: string; commit: string } | { kind: 'unnamed'; reason: 'ambiguous' | 'absent' | 'invalid' }

/** The `ls-remote` pattern arguments (after `--` and the URL) for a name; undefined when the name cannot be listed safely. */
export function refListingPatterns(name: string | undefined): { symref: boolean; patterns: string[] } | undefined {
  if (name === undefined) return { symref: true, patterns: ['HEAD'] }
  // A full name lists exactly itself; a valid refname has no glob characters, so no pattern can widen the listing.
  if (name.startsWith('refs/')) {
    const spec = parseResolvableRef(name)
    if (spec?.kind === 'branch') return { symref: false, patterns: [name] }
    if (spec?.kind === 'tag') return { symref: false, patterns: [name, `${name}^{}`] }
    return undefined
  }
  if (parseResolvableRef(`refs/heads/${name}`)?.kind !== 'branch') return undefined
  return { symref: false, patterns: [`refs/heads/${name}`, `refs/tags/${name}`, `refs/tags/${name}^{}`] }
}

/** Read a listing: no name is the default branch; a full name is itself; a short name must be exactly one branch or tag. */
export function namingFromListing(stdout: string, name: string | undefined): GitSkillRefNaming {
  // Patterns tail-match, so only exact names count.
  const oids = new Map<string, string>()
  let symref: string | undefined
  for (const line of stdout.split('\n')) {
    const [left, right] = line.trim().split('\t')
    if (left === undefined || right === undefined) continue
    if (left.startsWith('ref: ')) {
      if (right === 'HEAD') symref = left.slice('ref: '.length).trim()
    } else if (OID.test(left.toLowerCase())) oids.set(right, left.toLowerCase())
  }
  if (name === undefined) {
    const commit = oids.get('HEAD')
    if (symref === undefined || commit === undefined) return { kind: 'unnamed', reason: 'absent' }
    return parseResolvableRef(symref)?.kind === 'branch'
      ? { kind: 'named', ref: symref, commit }
      : { kind: 'unnamed', reason: 'invalid' }
  }
  if (name.startsWith('refs/')) {
    const commit = oids.get(`${name}^{}`) ?? oids.get(name)
    return commit === undefined ? { kind: 'unnamed', reason: 'absent' } : { kind: 'named', ref: name, commit }
  }
  const head = `refs/heads/${name}`
  const tag = `refs/tags/${name}`
  const branch = oids.get(head)
  const tagged = oids.get(`${tag}^{}`) ?? oids.get(tag)
  // A name that is both a branch and a tag is left unnamed rather than guessed.
  if (branch !== undefined && tagged !== undefined) return { kind: 'unnamed', reason: 'ambiguous' }
  if (branch !== undefined) return { kind: 'named', ref: head, commit: branch }
  if (tagged !== undefined) return { kind: 'named', ref: tag, commit: tagged }
  return { kind: 'unnamed', reason: 'absent' }
}

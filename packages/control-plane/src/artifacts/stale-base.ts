// What a `stale-base` refusal tells the agent about the revision that got there first (artifacts.md §5.6).
import { ARTIFACT_STALE_PATHS_MAX, type ArtifactStaleBase } from '@agentconnect.md/protocol'
import type { ArtifactManifest } from '../persistence/ports.js'

type Changes = NonNullable<ArtifactStaleBase['changes']>

/** Paths added, changed (another SHA-256) and removed from `base` to `latest`, sorted, at most `cap` in that order. */
export function manifestChanges(
  base: ArtifactManifest,
  latest: ArtifactManifest,
  cap: number = ARTIFACT_STALE_PATHS_MAX
): Changes {
  const before = new Map(base.files.map((file) => [file.path, file.sha256]))
  const after = new Map(latest.files.map((file) => [file.path, file.sha256]))
  const sorted = (paths: string[]) => paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const added = sorted([...after.keys()].filter((path) => !before.has(path)))
  const changed = sorted(
    [...after].filter(([path, sha]) => before.has(path) && before.get(path) !== sha).map(([p]) => p)
  )
  const removed = sorted([...before.keys()].filter((path) => !after.has(path)))
  let room = cap
  const take = (paths: string[]) => {
    const kept = paths.slice(0, room)
    room -= kept.length
    return kept
  }
  const out = { added: take(added), changed: take(changed), removed: take(removed) }
  return { ...out, omitted: added.length + changed.length + removed.length - (cap - room) }
}

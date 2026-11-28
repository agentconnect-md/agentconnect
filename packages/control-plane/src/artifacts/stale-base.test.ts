import { describe, expect, it } from 'vitest'
import { ARTIFACT_STALE_PATHS_MAX } from '@agentconnect.md/protocol'
import { manifestChanges } from './stale-base.js'
import type { ArtifactManifest } from '../persistence/ports.js'

const manifest = (...files: Array<[string, string]>): ArtifactManifest => ({
  entry: files[0]![0],
  files: files.map(([path, sha]) => ({ path, sha256: sha.repeat(64), bytes: 1, mediaType: 'text/plain' }))
})

describe('manifestChanges', () => {
  it('lists paths added, changed by digest and removed, each sorted', () => {
    const base = manifest(['index.html', 'a'], ['old.css', 'b'], ['same.js', 'c'], ['b.txt', 'd'])
    const latest = manifest(['index.html', 'e'], ['same.js', 'c'], ['z.css', 'f'], ['new.css', 'f'], ['b.txt', '0'])
    expect(manifestChanges(base, latest)).toEqual({
      added: ['new.css', 'z.css'],
      changed: ['b.txt', 'index.html'],
      removed: ['old.css'],
      omitted: 0
    })
  })

  it('reports nothing between identical manifests', () => {
    const same = manifest(['index.html', 'a'])
    expect(manifestChanges(same, same)).toEqual({ added: [], changed: [], removed: [], omitted: 0 })
  })

  it('stops at the cap, filling added, then changed, then removed, and counts what it left out', () => {
    const base = manifest(['c1', '1'], ['c2', '1'], ['r1', '1'])
    const latest = manifest(['a1', '1'], ['a2', '1'], ['c1', '2'], ['c2', '2'])
    expect(manifestChanges(base, latest, 3)).toEqual({ added: ['a1', 'a2'], changed: ['c1'], removed: [], omitted: 2 })
    expect(manifestChanges(base, latest, 0)).toEqual({ added: [], changed: [], removed: [], omitted: 5 })
  })

  it('caps at ARTIFACT_STALE_PATHS_MAX by default', () => {
    const latest = manifest(...Array.from({ length: 80 }, (_, i): [string, string] => [`f${i}`, '1']))
    const out = manifestChanges(manifest(['x', '1']), latest)
    expect(out.added.length + out.changed.length + out.removed.length).toBe(ARTIFACT_STALE_PATHS_MAX)
    expect(out.omitted).toBe(81 - ARTIFACT_STALE_PATHS_MAX)
  })
})

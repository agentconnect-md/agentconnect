import { describe, expect, it } from 'vitest'
import { artifactStandalonePath, readArtifactViewer, writeArtifactViewer } from './artifact-viewer-url'

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'

describe('readArtifactViewer', () => {
  it('reads the artifact, revision, site page and the dock as the default place', () => {
    expect(
      readArtifactViewer(new URLSearchParams(`artifact=${ID}&artifactRevision=3&artifactPath=%2Fdocs%2Fa.html`))
    ).toEqual({
      artifactId: ID,
      revision: 3,
      path: '/docs/a.html',
      placement: 'dock'
    })
  })

  it('reads the left pane only from its own value', () => {
    expect(readArtifactViewer(new URLSearchParams(`artifact=${ID}&artifactIn=pane`))?.placement).toBe('pane')
    expect(readArtifactViewer(new URLSearchParams(`artifact=${ID}&artifactIn=elsewhere`))?.placement).toBe('dock')
  })

  it('names no viewer without a well-formed id, and drops a malformed revision or path', () => {
    expect(readArtifactViewer(new URLSearchParams(''))).toBeNull()
    expect(readArtifactViewer(new URLSearchParams('artifact=not-an-id'))).toBeNull()
    expect(
      readArtifactViewer(new URLSearchParams(`artifact=${ID}&artifactRevision=0&artifactPath=%2F__ac%2Fshim.js`))
    ).toEqual({ artifactId: ID, path: null, placement: 'dock' })
  })
})

describe('writeArtifactViewer', () => {
  it('keeps the other parameters and round-trips through the reader', () => {
    const state = { artifactId: ID, revision: 2, path: '/a%20b/c.html?x=1#y', placement: 'pane' as const }
    const next = writeArtifactViewer('thread=root-1&file=a.md', state)
    expect(next.get('thread')).toBe('root-1')
    expect(next.get('file')).toBe('a.md')
    expect(readArtifactViewer(next)).toEqual(state)
  })

  it('writes nothing for the defaults and removes every viewer parameter on close', () => {
    const open = writeArtifactViewer('', { artifactId: ID, path: null, placement: 'dock' })
    expect(open.toString()).toBe(`artifact=${ID}`)
    const closed = writeArtifactViewer(
      `thread=t&artifact=${ID}&artifactRevision=2&artifactPath=%2Fa&artifactIn=pane`,
      null
    )
    expect(closed.toString()).toBe('thread=t')
  })
})

describe('artifactStandalonePath', () => {
  it('carries the revision and site page to the standalone page', () => {
    expect(artifactStandalonePath({ artifactId: ID })).toBe(`/artifacts/${ID}`)
    expect(artifactStandalonePath({ artifactId: ID, revision: 2 })).toBe(`/artifacts/${ID}?revision=2`)
    expect(artifactStandalonePath({ artifactId: ID, revision: 2, path: '/a b.html' })).toBe(
      `/artifacts/${ID}?revision=2&path=%2Fa+b.html`
    )
    expect(artifactStandalonePath({ artifactId: ID, path: '/x' })).toBe(`/artifacts/${ID}?path=%2Fx`)
  })
})

// An in-memory ArtifactSourceTree for the artifact tool tests.
import type { ArtifactSourceTree } from '../src/artifacts/manifest.js'

export type FakeNode = string | Buffer | { link: true } | Record<string, unknown>

/** A tree over nested objects: a string or Buffer is a file, `{link: true}` a symlink, any other object a directory. */
export function fakeTree(root: FakeNode): ArtifactSourceTree & { reads: string[] } {
  const reads: string[] = []
  const at = (rel: string): FakeNode | undefined => {
    let node: FakeNode | undefined = root
    for (const part of rel === '' ? [] : rel.split('/')) {
      if (typeof node !== 'object' || Buffer.isBuffer(node) || 'link' in node) return undefined
      node = (node as Record<string, FakeNode>)[part]
    }
    return node
  }
  return {
    reads,
    async stat(rel) {
      const node = at(rel)
      if (node === undefined) return 'missing'
      if (typeof node === 'string' || Buffer.isBuffer(node)) return 'file'
      return 'link' in node ? 'other' : 'dir'
    },
    async readdir(rel) {
      return Object.keys(at(rel) as Record<string, FakeNode>)
    },
    async read(rel, maxBytes) {
      reads.push(rel)
      const node = at(rel)
      if (typeof node !== 'string' && !Buffer.isBuffer(node)) return undefined
      const bytes = Buffer.from(node)
      return bytes.byteLength > maxBytes ? { tooLarge: bytes.byteLength } : { bytes }
    }
  }
}

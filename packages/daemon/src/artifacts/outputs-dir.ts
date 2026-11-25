// A fetched revision lands as one `outputs/<dir>/` (artifacts.md §7.1), staged beside it and swapped in whole.
import { randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { dirname, join } from 'node:path'
import { sessionFileName } from '@agentconnect.md/protocol'
import { DirHandle, UnsafePathError, withDescent } from '../shim/safe-descent.js'
import { containedWorkspacePath, WorkspaceViolationError } from '../workspace/workspace-files.js'
import { removeTree } from '../workspace/remove-tree.js'
import type { SaveAttachmentTarget } from '../mcp/ops/save-attachment.js'

const OUTPUTS = 'outputs'

/** Hands one file of the revision to the staging directory; `path` is a checked manifest path. */
export type ArtifactFilePut = (path: string, bytes: Buffer) => Promise<void>

export type ReplaceOutputsResult =
  { ok: true; path: string; name: string } | { ok: false; reason: 'escape' | 'write-failed'; detail?: string }

/** Write a revision into `outputs/<dirName>/`, replacing what an earlier fetch left there only once every file landed. */
export async function replaceOutputsDir(
  target: SaveAttachmentTarget,
  dirName: string,
  fill: (put: ArtifactFilePut) => Promise<void>
): Promise<ReplaceOutputsResult> {
  const segments = [...target.segments, OUTPUTS]
  const staging = `.${dirName}.fetch-${randomUUID().slice(0, 8)}`
  const done: ReplaceOutputsResult = {
    ok: true,
    path: join(target.root, ...segments, dirName),
    name: sessionFileName(OUTPUTS, dirName)
  }
  if (target.kind === 'pinned') {
    try {
      await withDescent(target.root, segments, (outputs) => replacePinned(outputs, staging, dirName, fill), {
        createMissing: true
      })
      return done
    } catch (err) {
      if (err instanceof UnsafePathError) return { ok: false, reason: 'escape' }
      throw err
    }
  }

  const { fs, root } = target
  let outputs: string
  try {
    outputs = containedWorkspacePath(root, segments.join('/'))
  } catch (err) {
    if (err instanceof WorkspaceViolationError) return { ok: false, reason: 'escape' }
    throw err
  }
  await fs.mkdir(outputs)
  // The local fallback proves the area is where it is named before writing under it; the pod's descent does that itself.
  if (target.canonicalDir) {
    if ((await fs.stat(outputs)) !== 'dir') return { ok: false, reason: 'escape' }
    const canon = await target.canonicalDir(root, segments.join('/')).catch(() => null)
    if (canon !== outputs) return { ok: false, reason: 'escape' }
  }
  const stagingPath = join(outputs, staging)
  try {
    await fs.mkdir(stagingPath)
    await fill(async (path, bytes) => {
      const file = containedWorkspacePath(stagingPath, path)
      await fs.mkdir(dirname(file))
      await fs.writeFile(file, bytes)
    })
    await fs.rmTree(join(outputs, dirName))
    await fs.rename(stagingPath, join(outputs, dirName))
    return done
  } catch (err) {
    await fs.rmTree(stagingPath).catch(() => undefined)
    throw err
  }
}

/** The Linux local arm: every name resolved from a descriptor the descent validated, so a planted link is refused, not followed. */
async function replacePinned(
  outputs: DirHandle,
  staging: string,
  dirName: string,
  fill: (put: ArtifactFilePut) => Promise<void>
): Promise<void> {
  const stage = await outputs.childDirOrCreate(staging)
  try {
    await fill(async (path, bytes) => {
      const parts = path.split('/')
      const leaf = parts.pop()!
      const open: DirHandle[] = []
      try {
        let dir = stage
        for (const part of parts) {
          dir = await dir.childDirOrCreate(part)
          open.push(dir)
        }
        await nodeFs.writeFile(dir.childPath(leaf), bytes, { flag: 'wx', mode: 0o600 })
      } finally {
        for (const handle of open.reverse()) await handle.close()
      }
    })
  } catch (err) {
    await stage.close()
    await removeTree(outputs.childPath(staging)).catch(() => undefined)
    throw err
  }
  await stage.close()
  await removeTree(outputs.childPath(dirName))
  await nodeFs.rename(outputs.childPath(staging), outputs.childPath(dirName))
}

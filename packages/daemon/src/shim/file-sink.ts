import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'

/**
 * Where daemon-decided files get written. `LocalFileSink` writes this daemon's own disk;
 * the cluster driver's sink pushes the same operations through the shim into the sandbox.
 *
 * The split matters because the *decision* is policy and the *write* is placement: which
 * secrets become files is the daemon's business either way, but only the driver knows
 * whose filesystem the runtime will read.
 */
export interface FileSink {
  /** Replace the directory's contents, retaining the root inode. */
  clear(root: string): Promise<string | undefined>
  /** Write one file with 0600, creating parents. */
  write(root: string, relPath: string[], content: string): Promise<void>
}

/** Relative path segments, rejecting anything that could escape the root. */
export const SinkRelPathSchema = z
  .array(z.string().min(1).max(255))
  .min(1)
  .max(8)
  .refine(
    (segments) =>
      segments.every(
        (segment) => segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\')
      ),
    { message: 'path segments must be plain names' }
  )

export const MaterializePayloadSchema = z.object({
  op: z.literal('write'),
  root: z.string().min(1),
  relPath: SinkRelPathSchema,
  content: z.string()
})

export const ClearPayloadSchema = z.object({ op: z.literal('clear'), root: z.string().min(1) })

export const FileSinkPayloadSchema = z.discriminatedUnion('op', [MaterializePayloadSchema, ClearPayloadSchema])
export type FileSinkPayload = z.infer<typeof FileSinkPayloadSchema>

/** Resolve a sink path and refuse anything that leaves the root, whichever side runs it. */
export function resolveSinkPath(root: string, relPath: string[]): string {
  if (!isAbsolute(root)) throw new Error(`sink root must be absolute: ${root}`)
  const base = resolve(root)
  const target = normalize(join(base, ...relPath))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('sink path escapes its root')
  }
  return target
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
  } catch {
    /* best-effort */
  }
}

/** Today's behaviour: write the daemon's own disk. */
export class LocalFileSink implements FileSink {
  async clear(root: string): Promise<string | undefined> {
    const dir = resolve(root)
    try {
      for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT') return undefined
      return `config files could not be cleared (${(err as Error).message})`
    }
    return undefined
  }

  async write(root: string, relPath: string[], content: string): Promise<void> {
    const file = resolveSinkPath(root, relPath)
    const dir = resolve(root)
    if (dirname(file) !== dir) mkdirPrivate(dirname(file))
    else mkdirPrivate(dir)
    writeFileSync(file, content, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Apply a sink operation inside the sandbox. The shim re-validates the path itself rather
 * than trusting that the daemon already did: a check on the other side of a channel is not
 * a check on this side, and the shim is the half that touches the filesystem.
 */
export async function applyFileSinkPayload(payload: unknown, sink: FileSink = new LocalFileSink()): Promise<void> {
  const parsed = FileSinkPayloadSchema.parse(payload)
  if (parsed.op === 'clear') {
    const error = await sink.clear(parsed.root)
    if (error) throw new Error(error)
    return
  }
  resolveSinkPath(parsed.root, parsed.relPath)
  await sink.write(parsed.root, parsed.relPath, parsed.content)
}

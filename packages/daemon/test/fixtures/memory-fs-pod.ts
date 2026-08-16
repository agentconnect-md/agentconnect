import { expect } from 'vitest'
import { constants, promises as fsp, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MemoryConflictError } from '../../src/agents/memory-fs.js'
import {
  ShimMemoryFs,
  applyMemoryFsPayload,
  isMemoryFsPayload,
  type MemoryFsExecutor
} from '../../src/shim/memory-fs-channel.js'
import type { ShimRequester } from '../../src/shim/channels.js'
import { fitToBudget, utf8Boundary } from '../../src/wire-slice.js'

/**
 * A path-based executor for the pod side, so the daemon-side pass-through can be exercised on any
 * platform; the descriptor-bound one is covered on Linux below. It honours the same reply shapes.
 */
export function pathExecutor(): MemoryFsExecutor {
  const abs = (root: string, rel: string) => join(root, ...rel.split('/').filter(Boolean))
  return {
    async read(root, rel, offset, limit, encoding) {
      let handle
      try {
        handle = await fsp.open(abs(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
        throw err
      }
      try {
        const st = await handle.stat()
        const want = Math.min(limit, Math.max(0, st.size - offset))
        const buf = Buffer.alloc(want)
        const { bytesRead } = want > 0 ? await handle.read(buf, 0, want, offset) : { bytesRead: 0 }
        const slice = buf.subarray(0, bytesRead)
        const { end, content } =
          encoding === 'base64'
            ? { end: slice.length, content: slice.toString('base64') }
            : fitToBudget(slice, utf8Boundary(slice, slice.length))
        return { exists: true, size: st.size, mtime: st.mtime.toISOString(), content, nextOffset: offset + end }
      } finally {
        await handle.close()
      }
    },
    async append(root, rel, content, create, mode) {
      const target = abs(root, rel)
      if (create) await fsp.mkdir(dirname(target), { recursive: true })
      await fsp.appendFile(target, content, { flag: create ? 'ax' : 'a', mode: mode ?? 0o644 })
      return { size: (await fsp.stat(target)).size }
    },
    async commit(root, rel, temp, ifMatchMtime) {
      const target = abs(root, rel)
      if (ifMatchMtime) {
        let current
        try {
          current = await fsp.lstat(target)
        } catch {
          throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
        }
        if (current.mtime.toISOString() !== ifMatchMtime) {
          await fsp.rm(abs(root, temp), { force: true })
          throw new MemoryConflictError('the memory file changed since it was read; reload and retry')
        }
      }
      await fsp.rename(abs(root, temp), target)
      const st = await fsp.stat(target)
      return { size: st.size, mtime: st.mtime.toISOString() }
    },
    async readdir(root, rel) {
      let dirents
      try {
        dirents = await fsp.readdir(abs(root, rel), { withFileTypes: true })
      } catch {
        return []
      }
      const entries = []
      for (const d of dirents) {
        const kind = d.isDirectory() ? ('dir' as const) : d.isFile() ? ('file' as const) : ('other' as const)
        const st = kind === 'file' ? await fsp.lstat(join(abs(root, rel), d.name)) : undefined
        entries.push({ name: d.name, kind, ...(st ? { size: st.size, mtime: st.mtime.toISOString() } : {}) })
      }
      return entries
    },
    async mkdir(root, rel) {
      await fsp.mkdir(abs(root, rel), { recursive: true })
    },
    async rename(root, from, to) {
      try {
        await fsp.lstat(abs(root, from))
      } catch {
        return false
      }
      await fsp.mkdir(dirname(abs(root, to)), { recursive: true })
      await fsp.rename(abs(root, from), abs(root, to))
      return true
    },
    async rm(root, rel) {
      await fsp.rm(abs(root, rel), { recursive: true, force: true })
    },
    async utimes(root, rel, mtime) {
      await fsp.lutimes(abs(root, rel), new Date(mtime), new Date(mtime)).catch(() => {})
    }
  }
}

/** A requester that answers `read`-capability frames the way a bound shim would, counting them. */
export function shimRequester(
  anchor: string,
  executor: MemoryFsExecutor
): ShimRequester & { agentId: string; frames: string[] } {
  const frames: string[] = []
  return {
    agentId: 'bot-a',
    frames,
    async request(capability, payload) {
      expect(capability).toBe('read')
      expect(isMemoryFsPayload(payload)).toBe(true)
      frames.push((payload as { op: string }).op)
      return applyMemoryFsPayload(payload, anchor, executor)
    }
  }
}

/** A "pod": the mount is the anchor, the memory root sits beside the checkout under `.agentconnect`. */
export function pod(): { mount: string; root: string; fs: ShimMemoryFs; requester: ReturnType<typeof shimRequester> } {
  const mount = mkdtempSync(join(tmpdir(), 'ac-pod-'))
  const root = join(mount, '.agentconnect', 'memory')
  const requester = shimRequester(mount, pathExecutor())
  return { mount, root, fs: new ShimMemoryFs(requester, root), requester }
}

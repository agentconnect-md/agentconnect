/**
 * `WorkspaceReader` — the read-only seam answering the CP's `workspace/list` and
 * `workspace/read` REQs from the agent's local workspace directory. File bytes
 * live only on the daemon (§1/§12); this streams single pages/slices to the CP,
 * never whole trees or files.
 *
 * Containment is to `workspace.path` EXACTLY — the parent directory holds
 * `agent.json` and other daemon-local secrets/state, so escaping even one level
 * is a secret leak.
 * Every request path is (1) rejected if absolute, (2) lexically resolved against
 * the root and prefix-checked, then (3) canonicalised with `realpath` and
 * re-verified so symlinks (including an intermediate directory component swapped
 * to a symlink after the check) cannot smuggle a target outside the root; all
 * I/O runs on the canonical path. Violations throw `WorkspaceViolationError`,
 * which the dispatcher maps to a `BAD_PAYLOAD` error frame; missing paths are
 * data (`exists:false`), not errors. Never log file contents.
 *
 * Frame-size safety: every REP must serialise under the 256 KiB wire cap. JSON
 * escaping of control bytes is a 6× blowup, so `read` bounds the slice by the
 * *encoded* reply size (not the raw byte `limit`) and `list` stops a page early
 * when the encoded entries would overflow — both leave headroom for the envelope.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type {
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceEntry
} from '@agentconnect.md/protocol'
import { REPLY_BUDGET, encodedBytes, utf8Boundary, fitToBudget } from './wire-slice.js'

/** Bytes sniffed from the head of a file for binary (NUL byte) detection. */
const SNIFF_BYTES = 8192

/** Path-containment / bad-request violation → `BAD_PAYLOAD` on the wire. */
export class WorkspaceViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceViolationError'
  }
}

export interface WorkspaceReader {
  list(req: WorkspaceListReq): Promise<WorkspaceListPage>
  read(req: WorkspaceReadReq): Promise<WorkspaceReadContent>
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

function under(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep)
}

export function createWorkspaceReader(workspaceRootByAgent: (agentId: string) => string | undefined): WorkspaceReader {
  function rootFor(agentId: string): string {
    const root = workspaceRootByAgent(agentId)
    if (!root) throw new WorkspaceViolationError(`unknown agent "${agentId}"`)
    return root
  }

  /**
   * Lexical containment. Rejects absolute paths and `..` escapes; returns the
   * lexically-resolved path plus the canonical (realpath'd) root, or `null` for
   * `realRoot` when the root does not exist yet (callers report `exists:false`).
   */
  async function resolveContained(
    root: string,
    relPath: string
  ): Promise<{ resolved: string; realRoot: string | null }> {
    if (path.isAbsolute(relPath)) throw new WorkspaceViolationError('absolute paths are not allowed')
    const resolved = path.resolve(root, relPath)
    if (!under(root, resolved)) throw new WorkspaceViolationError('path escapes the workspace root')
    try {
      return { resolved, realRoot: await fs.realpath(root) }
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { resolved, realRoot: null } // no root ⇒ nothing to escape
      throw err
    }
  }

  /** Canonicalise an existing target and re-verify containment on the REAL path,
   *  closing the check-vs-use gap (a symlinked intermediate component resolves
   *  out and is rejected here). Returns the canonical path used for I/O. */
  async function canonicalUnder(realRoot: string, abs: string): Promise<string> {
    const canon = await fs.realpath(abs)
    if (!under(realRoot, canon)) throw new WorkspaceViolationError('path resolves outside the workspace root')
    return canon
  }

  return {
    async list(req) {
      const root = rootFor(req.agentId)
      const { resolved, realRoot } = await resolveContained(root, req.path)
      const notFound = { agentId: req.agentId, path: req.path, exists: false, entries: [] as WorkspaceEntry[] }
      if (realRoot === null) return notFound // workspace root missing

      let target: string
      try {
        target = await canonicalUnder(realRoot, resolved)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return notFound
        throw err
      }

      let dirents
      try {
        dirents = await fs.readdir(target, { withFileTypes: true })
      } catch (err) {
        // Missing dir or a non-directory target "does not exist" as a directory.
        if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return notFound
        throw err
      }

      const entries: WorkspaceEntry[] = []
      for (const d of dirents) {
        if (d.name === '.git') continue // git-repo mode internals
        const type: WorkspaceEntry['type'] = d.isDirectory()
          ? 'dir'
          : d.isFile()
            ? 'file'
            : d.isSymbolicLink()
              ? 'symlink'
              : 'other'
        const entry: WorkspaceEntry = { name: d.name, type }
        if (type === 'file') {
          // lstat (not stat): never follow symlinks for size/mtime.
          try {
            const st = await fs.lstat(path.join(target, d.name))
            entry.size = st.size
            entry.mtime = st.mtime.toISOString()
          } catch {
            // raced deletion — keep the name-only entry
          }
        }
        entries.push(entry)
      }
      entries.sort(compareEntries)

      // Opaque cursor = numeric index into the sorted listing. Page by BOTH the
      // count limit and an encoded-size budget (long/many names could overflow
      // the frame); always emit ≥1 entry so a pathological name still makes
      // progress rather than wedging the cursor.
      const start = req.cursor !== undefined && /^\d+$/.test(req.cursor) ? Number(req.cursor) : 0
      const page: WorkspaceEntry[] = []
      let acc = 0
      for (let i = start; i < entries.length && page.length < req.limit; i++) {
        const e = entries[i]!
        const enc = encodedBytes(e) + 1 // + array separator
        if (page.length > 0 && acc + enc > REPLY_BUDGET) break
        page.push(e)
        acc += enc
      }
      const consumed = start + page.length
      return {
        agentId: req.agentId,
        path: req.path,
        exists: true,
        entries: page,
        ...(consumed < entries.length ? { nextCursor: String(consumed) } : {})
      }
    },

    async read(req) {
      const root = rootFor(req.agentId)
      const { resolved, realRoot } = await resolveContained(root, req.path)
      const notFound = { agentId: req.agentId, path: req.path, exists: false }
      if (realRoot === null) return notFound

      // lstat the lexical target first: this rejects a FINAL-component symlink
      // (isFile() is false) before we canonicalise.
      let st
      try {
        st = await fs.lstat(resolved)
      } catch (err) {
        if (isErrno(err, 'ENOENT')) return notFound
        throw err
      }
      if (!st.isFile()) throw new WorkspaceViolationError('not a regular file')

      // Canonicalise and re-verify (catches an intermediate component swapped to
      // a symlink after resolveContained), then read the canonical path.
      const target = await canonicalUnder(realRoot, resolved)
      const size = st.size
      const mtime = st.mtime.toISOString()
      const fh = await fs.open(target, 'r')
      try {
        // Binary detection: NUL byte anywhere in the first 8 KiB ⇒ no content.
        const sniffLen = Math.min(SNIFF_BYTES, size)
        if (sniffLen > 0) {
          const sniff = Buffer.alloc(sniffLen)
          const { bytesRead } = await fh.read(sniff, 0, sniffLen, 0)
          if (sniff.subarray(0, bytesRead).includes(0)) {
            return { agentId: req.agentId, path: req.path, exists: true, size, mtime, encoding: 'none' as const }
          }
        }

        // Read up to the requested byte count, then shrink so the JSON-escaped
        // reply fits the frame budget and ends on a UTF-8 boundary. `limit` is a
        // ceiling; the slice may be shorter. `nextOffset` (not a client-side
        // recount of `content`) is the authoritative next offset.
        const want = Math.min(req.limit, Math.max(0, size - req.offset))
        let slice = Buffer.alloc(0)
        if (want > 0) {
          const buf = Buffer.alloc(want)
          const { bytesRead } = await fh.read(buf, 0, want, req.offset)
          slice = buf.subarray(0, bytesRead)
        }

        let end = utf8Boundary(slice, slice.length)
        // Control-byte-heavy content can escape past the budget; shrink to fit.
        const fitted = fitToBudget(slice, end)
        end = fitted.end
        const content = fitted.content

        const nextOffset = req.offset + end
        return {
          agentId: req.agentId,
          path: req.path,
          exists: true,
          size,
          mtime,
          encoding: 'utf8' as const,
          content,
          offset: req.offset,
          nextOffset,
          truncated: nextOffset < size
        }
      } finally {
        await fh.close()
      }
    }
  }
}

/** dirs first, then case-insensitive alphabetical (stable within the page). */
function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  const aDir = a.type === 'dir' ? 0 : 1
  const bDir = b.type === 'dir' ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  const al = a.name.toLowerCase()
  const bl = b.name.toLowerCase()
  if (al !== bl) return al < bl ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

import { z } from 'zod'

/**
 * Agent workspace files (C→D REQ → REP) — the console's on-demand access.
 *
 * The CP stores NO workspace data — directory listings and file bytes are pulled
 * live from the owning daemon and proxied to the console, never persisted
 * (body-locality). Missing paths are DATA (`exists:false`), not errors; only
 * path-containment violations (`BAD_PAYLOAD`) and unexpected fs failures
 * (`INTERNAL`) come back as `error` frames.
 *
 * - `workspace/list`: one cursor-paginated page of a directory's entries.
 * - `workspace/read`: one byte slice of a file. `limit` is only a ceiling — the
 *   daemon returns FEWER bytes when needed to keep the JSON-escaped REP under the
 *   256 KiB frame cap (control bytes escape to `\uXXXX`, a 6× blowup), and always
 *   ends the slice on a UTF-8 character boundary. `nextOffset` is the authoritative
 *   byte offset to request next — callers must NOT recompute it from the decoded
 *   `content` (a split multi-byte char would make the byte count drift).
 * - `workspace/write`: create a text file when `ifMatchMtime` is absent, or
 *   replace one when it matches the last read. Content is base64 so arbitrary
 *   UTF-8 text has a predictable wire size.
 */

/** Raw UTF-8 ceiling for one console workspace-file edit. Base64 expansion still
 * leaves enough envelope headroom under the shared 256 KiB frame cap. */
export const MAX_WORKSPACE_EDIT_BYTES = 180_000

/** One directory entry in a workspace listing (name-only; not a full path). */
export const WorkspaceEntry = z.object({
  name: z.string(),
  type: z.enum(['dir', 'file', 'symlink', 'other']),
  size: z.number().int().nonnegative().optional(), // regular files only
  mtime: z.string().optional() // RFC3339
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>

/** C→D REQ: list one page of a directory in the agent's workspace. */
export const WorkspaceListReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  path: z.string().default(''), // workspace-relative POSIX path; '' ⇒ workspace root
  cursor: z.string().optional(), // opaque; omit ⇒ first page
  limit: z.number().int().positive().max(500).default(200)
})
export type WorkspaceListReq = z.infer<typeof WorkspaceListReq>

/** D→C REP (corr = the req id): a page of entries + the cursor for the next page. */
export const WorkspaceListPage = z.object({
  agentId: z.string(),
  path: z.string(),
  exists: z.boolean(), // false ⇒ workspace root or the dir does not exist (NOT an error)
  entries: z.array(WorkspaceEntry),
  nextCursor: z.string().optional() // absent ⇒ no more entries
})
export type WorkspaceListPage = z.infer<typeof WorkspaceListPage>

/** C→D REQ: read one byte slice of a file in the agent's workspace. */
export const WorkspaceReadReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  path: z.string().min(1), // workspace-relative POSIX path to a file
  offset: z.number().int().nonnegative().default(0), // byte offset
  limit: z.number().int().positive().max(65536).default(65536) // byte count per slice (64 KiB, see docblock)
})
export type WorkspaceReadReq = z.infer<typeof WorkspaceReadReq>

/** D→C REP (corr = the req id): the file slice (or `exists:false` / binary-detected). */
export const WorkspaceReadContent = z.object({
  agentId: z.string(),
  path: z.string(),
  exists: z.boolean(), // false ⇒ the file does not exist (NOT an error)
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(), // RFC3339
  encoding: z.enum(['utf8', 'none']).optional(), // 'none' ⇒ binary detected, content omitted
  content: z.string().optional(), // utf8 text slice
  offset: z.number().int().nonnegative().optional(), // byte offset this slice starts at
  nextOffset: z.number().int().nonnegative().optional(), // byte offset to request next (offset + bytes in this slice)
  truncated: z.boolean().optional() // true ⇒ nextOffset < size (more bytes remain)
})
export type WorkspaceReadContent = z.infer<typeof WorkspaceReadContent>

const CanonicalBase64 = z
  .string()
  .max(Math.ceil(MAX_WORKSPACE_EDIT_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

/** C→D REQ: atomically create or replace one scratch-workspace text file.
 * Omitting `ifMatchMtime` is an exclusive create; supplying it is an optimistic
 * replace, so neither operation silently overwrites a concurrent change. */
export const WorkspaceWriteReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  path: z.string().min(1).max(4096), // workspace-relative POSIX path to a regular file
  contentBase64: CanonicalBase64, // complete new UTF-8 contents
  ifMatchMtime: z.string().datetime().optional()
})
export type WorkspaceWriteReq = z.infer<typeof WorkspaceWriteReq>

/** D→C REP (corr = the req id): the atomically written file state. */
export const WorkspaceWriteOk = z.object({
  agentId: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string()
})
export type WorkspaceWriteOk = z.infer<typeof WorkspaceWriteOk>

/**
 * Agent workspace git ops (C→D REQ → REP) — the console's on-demand controls for
 * a git-repo workspace. Like list/read these run daemon-local; the CP proxies the
 * outcome and stores nothing.
 *
 * These are DATA-oriented: a non-repo workspace (`isRepo:false`), a dirty tree,
 * or a pull that can't fast-forward (offline, diverged, local edits) all come
 * back as a normal REP — NOT an `error` frame. Only an unknown agent
 * (`BAD_PAYLOAD`) or an unexpected git/fs failure (`INTERNAL`) is an error.
 */

/** C→D REQ: report `git status` of the agent's workspace (is it clean?). */
export const WorkspaceGitStatusReq = z.object({
  agentId: z.string().min(1) // local agent id (NOT a wire UUID)
})
export type WorkspaceGitStatusReq = z.infer<typeof WorkspaceGitStatusReq>

/** One changed path in a `git status`. `index`/`workingDir` are git's per-file XY
 *  status chars (' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', …). */
export const WorkspaceGitFile = z.object({
  path: z.string(),
  index: z.string(), // staged (X) status char
  workingDir: z.string() // unstaged (Y) status char
})
export type WorkspaceGitFile = z.infer<typeof WorkspaceGitFile>

/** The HEAD commit of the checkout. */
export const WorkspaceGitCommit = z.object({
  sha: z.string(), // full 40-hex commit hash
  shortSha: z.string(), // abbreviated hash (7 hex) for display
  subject: z.string(), // first line of the commit message
  committedAt: z.string() // RFC3339 committer date
})
export type WorkspaceGitCommit = z.infer<typeof WorkspaceGitCommit>

/** D→C REP (corr = the req id): the working-tree status. */
export const WorkspaceGitStatus = z.object({
  agentId: z.string(),
  isRepo: z.boolean(), // false ⇒ from-scratch workspace (no .git) — git ops are N/A
  clean: z.boolean(), // true ⇒ no staged / unstaged / untracked changes
  branch: z.string().optional(), // current branch (absent ⇒ detached / unknown)
  tracking: z.string().optional(), // upstream ref, if the branch tracks one
  ahead: z.number().int().nonnegative().optional(), // commits ahead of upstream
  behind: z.number().int().nonnegative().optional(), // commits behind upstream
  files: z.array(WorkspaceGitFile).optional(), // changed paths (bounded; see `truncated`)
  truncated: z.boolean().optional(), // true ⇒ the `files` list was capped
  lastCommit: WorkspaceGitCommit.optional(), // HEAD commit (absent ⇒ empty repo / no commits yet)
  lastFetchAt: z.string().optional() // RFC3339 mtime of .git/FETCH_HEAD — when the repo last fetched/pulled
})
export type WorkspaceGitStatus = z.infer<typeof WorkspaceGitStatus>

/** C→D REQ: force a fast-forward-only `git pull` in the agent's workspace now. */
export const WorkspaceGitPullReq = z.object({
  agentId: z.string().min(1) // local agent id (NOT a wire UUID)
})
export type WorkspaceGitPullReq = z.infer<typeof WorkspaceGitPullReq>

/** D→C REP (corr = the req id): the pull outcome. A failed pull is DATA
 *  (`ok:false` + `detail`), not an error frame (see the section docblock). */
export const WorkspaceGitPullResult = z.object({
  agentId: z.string(),
  isRepo: z.boolean(), // false ⇒ from-scratch workspace (no .git) — nothing to pull
  ok: z.boolean(), // true ⇒ pull succeeded (fast-forwarded or already up to date)
  detail: z.string().optional(), // human summary or failure reason (host paths stripped)
  changed: z.number().int().nonnegative().optional(), // files changed by the pull
  insertions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional()
})
export type WorkspaceGitPullResult = z.infer<typeof WorkspaceGitPullResult>

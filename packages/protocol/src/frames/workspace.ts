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
 * - `workspace/read`: one byte slice of a file. A DIRECTORY is DATA too
 *   (`type:'dir'`, no `content`) — a path naming a directory is a fact about the
 *   path, not a transport failure. Any other non-regular target (a symlink out of
 *   the workspace, a device) stays a containment violation. `limit` is only a ceiling — the
 *   daemon returns FEWER bytes when needed to keep the JSON-escaped REP under the
 *   256 KiB frame cap (control bytes escape to `\uXXXX`, a 6× blowup), and always
 *   ends the slice on a UTF-8 character boundary. `nextOffset` is the authoritative
 *   byte offset to request next — callers must NOT recompute it from the decoded
 *   `content` (a split multi-byte char would make the byte count drift).
 * - `workspace/write`: create a text file when `ifMatchMtime` is absent, or
 *   replace one when it matches the last read. Content is base64 so arbitrary
 *   UTF-8 text has a predictable wire size.
 * - `workspace/delete`: delete one regular file when its mtime still matches the
 *   last read, so a console action never removes a newer agent revision.
 */

/** Machine-readable `reason` on a workspace `BAD_PAYLOAD` / `CONFLICT` error
 * frame's `details`, so the CP can answer a bad request with a status and a code
 * the console can branch on instead of the 503 that reads as an offline daemon.
 * A closed vocabulary: both sides agree on it, and the messages beside it stay
 * hand-written and host-path-free. */
export const WorkspaceErrorReason = z.enum([
  'unknown-agent', // no such agent on this daemon (or no worktree for that sessionId)
  'path-escape', // absolute path, or one resolving outside the workspace root
  'git-internals', // the path reaches into `.git`
  'not-a-file', // the path exists but is not a regular file (mutations only; reads report it as DATA)
  'not-a-directory', // a parent component of a write target is not a directory
  'read-only-workspace', // edits are scratch-workspace only
  'too-large', // the edit exceeds MAX_WORKSPACE_EDIT_BYTES
  'binary', // the target is not UTF-8 text
  'not-utf8', // the supplied content is not valid UTF-8
  'stale' // optimistic-concurrency failure (CONFLICT)
])
export type WorkspaceErrorReason = z.infer<typeof WorkspaceErrorReason>

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
  /** ACP session id selecting that session's isolated Git worktree. Omit for the
   * agent's primary checkout. The CP authorizes the session before forwarding. */
  sessionId: z.string().min(1).optional(),
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
  /** ACP session id selecting that session's isolated Git worktree. */
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1), // workspace-relative POSIX path to a file
  offset: z.number().int().nonnegative().default(0), // byte offset
  limit: z.number().int().positive().max(65536).default(65536) // byte count per slice (64 KiB, see docblock)
})
export type WorkspaceReadReq = z.infer<typeof WorkspaceReadReq>

/** D→C REP (corr = the req id): the file slice (or `exists:false` / binary-detected
 *  / `type:'dir'`). */
export const WorkspaceReadContent = z.object({
  agentId: z.string(),
  path: z.string(),
  exists: z.boolean(), // false ⇒ the file does not exist (NOT an error)
  type: z.enum(['file', 'dir']).optional(), // what the path IS; 'dir' ⇒ no content (absent from an older daemon)
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

/** C→D REQ: delete one scratch-workspace file if it still matches the last read. */
export const WorkspaceDeleteReq = z.object({
  agentId: z.string().min(1),
  path: z.string().min(1).max(4096),
  ifMatchMtime: z.string().datetime()
})
export type WorkspaceDeleteReq = z.infer<typeof WorkspaceDeleteReq>

/** D→C REP (corr = the req id): the deleted file identity. */
export const WorkspaceDeleteOk = z.object({
  agentId: z.string(),
  path: z.string()
})
export type WorkspaceDeleteOk = z.infer<typeof WorkspaceDeleteOk>

/**
 * Agent workspace git ops (C→D REQ → REP) — the console's on-demand controls for
 * a git-repo workspace. Like list/read these run daemon-local; the CP proxies the
 * outcome and stores nothing.
 *
 * These are DATA-oriented: a non-repo workspace (`isRepo:false`), a dirty tree,
 * or a pull that can't fast-forward (offline, diverged, local edits) all come
 * back as a normal REP — NOT an `error` frame. Only an unknown agent
 * (`BAD_PAYLOAD`) or an unexpected git/fs failure (`INTERNAL`) is an error.
 *
 * - `workspace/gitstatus`: the working tree. Per-file `additions`/`deletions` are
 *   `git diff HEAD --numstat` counts — staged AND unstaged, i.e. what the file
 *   changed vs HEAD. Optional: an untracked file has no counts, and an older
 *   daemon reports none at all.
 * - `workspace/gitdiff`: unified-diff text for ONE path, bounded like
 *   `workspace/read` (the daemon shrinks the slice until the JSON-escaped REP
 *   fits the 256 KiB frame cap and flags `truncated`). A binary path, a path with
 *   no changes and a non-repo workspace are all DATA.
 * - `workspace/gitlog`: the newest commits of the checked-out branch, each marked
 *   `pushed` when the branch's upstream ref already contains it.
 */

/** C→D REQ: report `git status` of the agent's workspace (is it clean?). */
export const WorkspaceGitStatusReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  /** ACP session id selecting that session's isolated Git worktree. */
  sessionId: z.string().min(1).optional()
})
export type WorkspaceGitStatusReq = z.infer<typeof WorkspaceGitStatusReq>

/** One changed path in a `git status`. `index`/`workingDir` are git's per-file XY
 *  status chars (' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', …). */
export const WorkspaceGitFile = z.object({
  path: z.string(),
  index: z.string(), // staged (X) status char
  workingDir: z.string(), // unstaged (Y) status char
  additions: z.number().int().nonnegative().optional(), // `git diff HEAD --numstat` lines added (absent ⇒ untracked / binary / older daemon)
  deletions: z.number().int().nonnegative().optional() // …and lines removed
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

/** C→D REQ: unified-diff text for ONE workspace path, staged or unstaged. */
export const WorkspaceGitDiffReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  /** ACP session id selecting that session's isolated Git worktree. */
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1).max(4096), // workspace-relative POSIX path (a directory diffs its subtree)
  staged: z.boolean().default(false) // true ⇒ index vs HEAD (`--cached`); false ⇒ worktree vs index
})
export type WorkspaceGitDiffReq = z.infer<typeof WorkspaceGitDiffReq>

/** D→C REP (corr = the req id): the unified diff, or the DATA that says why there
 *  is none. `diff` absent with `exists:true` and no `binary` ⇒ this path has no
 *  changes in the requested scope. */
export const WorkspaceGitDiffResult = z.object({
  agentId: z.string(),
  path: z.string(),
  isRepo: z.boolean(), // false ⇒ from-scratch workspace (no .git) — nothing to diff
  exists: z.boolean(), // false ⇒ the path is neither changed nor present in the workspace
  diff: z.string().optional(), // unified-diff text as git emits it (bounded; see `truncated`)
  binary: z.boolean().optional(), // true ⇒ git reports a binary change, so there is no text to show
  truncated: z.boolean().optional() // true ⇒ `diff` is only the head of a bigger diff
})
export type WorkspaceGitDiffResult = z.infer<typeof WorkspaceGitDiffResult>

/** Display ceilings for one `workspace/gitlog` row. 50 commits × (200 + 100)
 * characters stay under MAX_FRAME_BYTES even at JSON's 6× control-byte escape
 * blowup (50 × 300 × 6 ≈ 90 KB), so the REP can never overflow the frame. */
export const MAX_WORKSPACE_LOG_COMMITS = 50
export const MAX_WORKSPACE_COMMIT_SUBJECT = 200
export const MAX_WORKSPACE_COMMIT_AUTHOR = 100

/** C→D REQ: the newest commits of the workspace's checked-out branch. */
export const WorkspaceGitLogReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  /** ACP session id selecting that session's isolated Git worktree. */
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(MAX_WORKSPACE_LOG_COMMITS).default(20) // commits per REP
})
export type WorkspaceGitLogReq = z.infer<typeof WorkspaceGitLogReq>

/** One commit in the log. `pushed` is reachability from the branch's upstream ref:
 *  false means "not known to be on a remote", which is also what every commit
 *  reports when the branch tracks nothing (`tracking` absent on the REP). */
export const WorkspaceGitLogCommit = WorkspaceGitCommit.extend({
  subject: z.string().max(MAX_WORKSPACE_COMMIT_SUBJECT), // first line of the message (display-capped)
  author: z.string().max(MAX_WORKSPACE_COMMIT_AUTHOR), // commit author name (display-capped)
  pushed: z.boolean()
})
export type WorkspaceGitLogCommit = z.infer<typeof WorkspaceGitLogCommit>

/** D→C REP (corr = the req id): newest-first commits. An empty repo is DATA
 *  (`commits: []`), not an error frame. */
export const WorkspaceGitLog = z.object({
  agentId: z.string(),
  isRepo: z.boolean(), // false ⇒ from-scratch workspace (no .git) — no log
  commits: z.array(WorkspaceGitLogCommit).max(MAX_WORKSPACE_LOG_COMMITS),
  truncated: z.boolean(), // true ⇒ the branch has more commits than `limit`
  tracking: z.string().optional() // upstream ref `pushed` was computed against (absent ⇒ tracks nothing)
})
export type WorkspaceGitLog = z.infer<typeof WorkspaceGitLog>

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

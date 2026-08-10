/**
 * Pure parsers for the machine-readable git output behind the console's git
 * review reads (`workspace/gitstatus` counts, `workspace/gitdiff`,
 * `workspace/gitlog`). Split out of {@link WorkspaceGit} so the formats can be
 * tested against recorded git bytes AND against a real fixture repo without a
 * daemon, a CP or a socket.
 *
 * Everything here reads `-z` output: NUL-delimited fields never need git's
 * c-style path quoting, so a path containing a space, a quote, a tab or a
 * newline parses exactly like any other — and a repository cannot smuggle a
 * field separator through a filename or an author name.
 */
import { MAX_WORKSPACE_COMMIT_AUTHOR, MAX_WORKSPACE_COMMIT_SUBJECT } from '@agentconnect.md/protocol'

/** `git log` pretty format: NUL between fields, and `-z` puts a NUL after each
 *  commit, so the stream is a flat run of 5-token records. */
export const LOG_FORMAT = '%H%x00%h%x00%an%x00%cI%x00%s'

/** One `--numstat` row. Absent counts ⇒ git reported `-` `-`, i.e. a binary change. */
export interface NumstatEntry {
  path: string
  from?: string // rename source, when git detected one
  additions?: number
  deletions?: number
}

/** One parsed `git log` record, before the `pushed` marker is joined on. */
export interface LogEntry {
  sha: string
  shortSha: string
  subject: string
  author: string
  committedAt: string
}

const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.*)$/s

/**
 * Parse `git diff --numstat -z`. Each record is `<add>\t<del>\t<path>NUL`, except
 * a detected rename, which git writes as `<add>\t<del>\tNUL<old>NUL<new>NUL` — so
 * an empty third field means the next two tokens are the rename's two paths and
 * the CURRENT path (the one `git status` reports) is the second of them.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0')
  const entries: NumstatEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const row = NUMSTAT_ROW.exec(token)
    if (!row) continue // not a numstat row (a stray warning line) — ignore rather than guess
    const counts = {
      ...(row[1] === '-' ? {} : { additions: Number(row[1]) }),
      ...(row[2] === '-' ? {} : { deletions: Number(row[2]) })
    }
    if (row[3] !== '') {
      entries.push({ path: row[3]!, ...counts })
      continue
    }
    const from = tokens[i + 1]
    const to = tokens[i + 2]
    if (!from || !to) break // truncated rename record — a path is never empty
    i += 2
    entries.push({ path: to, from, ...counts })
  }
  return entries
}

/** Index a numstat listing by path for the `git status` join. Later rows win, so
 *  a path appearing twice reports its last counts rather than throwing away both. */
export function numstatByPath(entries: NumstatEntry[]): Map<string, NumstatEntry> {
  return new Map(entries.map((e) => [e.path, e]))
}

/** Parse `git log -z --format=LOG_FORMAT` — a flat run of 5 NUL-separated fields
 *  per commit. A NUL cannot occur inside any of them, so the record boundary is
 *  the field count, not a guess. A trailing partial record is dropped. */
export function parseLogZ(out: string): LogEntry[] {
  const tokens = out.split('\0')
  if (tokens.at(-1) === '') tokens.pop() // the final commit's own terminator
  const commits: LogEntry[] = []
  for (let i = 0; i + 4 < tokens.length; i += 5) {
    const [sha, shortSha, author, committedAt, subject] = tokens.slice(i, i + 5) as [
      string,
      string,
      string,
      string,
      string
    ]
    if (!sha) continue
    commits.push({
      sha,
      shortSha,
      subject: capText(subject, MAX_WORKSPACE_COMMIT_SUBJECT),
      author: capText(author, MAX_WORKSPACE_COMMIT_AUTHOR),
      committedAt
    })
  }
  return commits
}

/** Cut worktree-controlled display text to its wire cap. The caps are what make
 *  a full log page provably fit the frame, so this is enforcement, not cosmetics. */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

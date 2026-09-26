import { decisionTextPrefix } from '../decisions/state.js'

export const PULL_CONTEXT_FILE_LIMIT = 100
export const PULL_CONTEXT_DIFF_MAX_BYTES = 12 * 1024

export interface PullRequestFile {
  path: string
  previousPath?: string
  status: string
  additions?: number
  deletions?: number
  diff: string
  diffTruncated: boolean
  diffUnavailable?: true
}

// Both GitHub and Gitea publish this changed-file shape; missing patches remain explicitly unavailable.
export function restPullRequestFile(row: Record<string, unknown>): PullRequestFile | undefined {
  if (typeof row.filename !== 'string' || !row.filename) return undefined
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const additions = count(row.additions)
  const deletions = count(row.deletions)
  const file: PullRequestFile = {
    path: row.filename,
    ...(typeof row.previous_filename === 'string' && row.previous_filename
      ? { previousPath: row.previous_filename }
      : {}),
    status: row.status === 'removed' ? 'deleted' : typeof row.status === 'string' ? row.status : 'unknown',
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    diff: typeof row.patch === 'string' ? row.patch : '',
    diffTruncated: false,
    ...(typeof row.patch === 'string' ? {} : { diffUnavailable: true })
  }
  if (!file.diffUnavailable) file.diffTruncated = missingDiffLines(file)
  return file
}

// Count only hunk lines, before any local truncation; unavailable provider patches have unknown counts.
export function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let hunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) hunk = true
    else if (hunk && line.startsWith('+')) additions++
    else if (hunk && line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function missingDiffLines(file: PullRequestFile): boolean {
  const counts = diffLineCounts(file.diff)
  return (
    (file.additions !== undefined && counts.additions < file.additions) ||
    (file.deletions !== undefined && counts.deletions < file.deletions)
  )
}

// Redistribute spare bytes from short patches so every file can retain a useful prefix.
export function trimFileDiffs(files: PullRequestFile[], maxBytes: number): boolean {
  const lengths = files.map((file) => ({ file, bytes: Buffer.byteLength(file.diff) })).sort((a, b) => a.bytes - b.bytes)
  let remaining = maxBytes
  let trimmed = false
  for (const [index, { file, bytes }] of lengths.entries()) {
    const limit = Math.floor(remaining / (lengths.length - index))
    if (bytes > limit) {
      file.diff = decisionTextPrefix(file.diff, limit)
      file.diffTruncated = true
      trimmed = true
    }
    remaining -= Buffer.byteLength(file.diff)
  }
  return trimmed
}

// Git quotes paths using C escapes and octal UTF-8 bytes.
function gitPath(path: string): string {
  if (!path.startsWith('"')) return path
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 }
  const bytes = Buffer.from(path.slice(1, -1)).toString('latin1')
  return Buffer.from(
    bytes.replace(/\\([0-7]{3}|[abfnrtv"\\])/g, (_, value: string) =>
      String.fromCharCode(value.length === 3 ? Number.parseInt(value, 8) : escapes[value]!)
    ),
    'latin1'
  ).toString('utf8')
}

// A provider with metadata-only file rows supplies a bounded raw diff alongside that independent list.
export function attachRawFileDiffs(files: PullRequestFile[], raw: { text: string; truncated: boolean }): void {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const byHeader = new Map(files.map((file) => [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`, file]))
  const blocks = raw.text.split(/(?=^diff --git )/m)
  for (const [index, block] of blocks.entries()) {
    const header = block.split('\n', 1)[0]!
    const paths = /^diff --git ("(?:\\.|[^"])*"|a\/.*) ("(?:\\.|[^"])*"|b\/.*)$/.exec(header)
    const file = byHeader.get(header) ?? (paths ? byPath.get(gitPath(paths[2]!).slice(2)) : undefined)
    if (!file) continue
    file.diff = block
    file.diffTruncated = (raw.truncated && index === blocks.length - 1) || missingDiffLines(file)
    delete file.diffUnavailable
  }
}

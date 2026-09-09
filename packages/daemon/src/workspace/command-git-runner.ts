import { z } from 'zod'
import { type GitLogEntry, type GitPullSummary, type GitRunner, type GitStatusSummary } from './git-runner.js'

// The argv-only request shared by sandbox Git executors.
export const GitExecPayloadSchema = z.object({
  tool: z.literal('git'),
  cwd: z.string().min(1).optional(),
  args: z.array(z.string()).min(1).max(64),
  // The child deadline is shorter than its carrier deadline.
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  // The supplied environment replaces ambient variables.
  env: z.record(z.string(), z.string()).optional()
})
export type GitExecPayload = z.infer<typeof GitExecPayloadSchema>

export const GitExecResultSchema = z.object({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string()
})
export type GitExecResult = z.infer<typeof GitExecResultSchema>

// Parse porcelain v2 with NUL-delimited paths, including renames and conflicts.
export function parsePorcelainV2(stdout: string): GitStatusSummary {
  const summary: GitStatusSummary = { current: null, tracking: null, ahead: 0, behind: 0, files: [], clean: true }
  const entries = stdout.split('\0')
  const push = (path: string, xy: string): void => {
    summary.files.push({
      path,
      index: xy[0] === '.' ? ' ' : (xy[0] ?? ' '),
      working_dir: xy[1] === '.' ? ' ' : (xy[1] ?? ' ')
    })
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.startsWith('# branch.head ')) {
      const head = entry.slice('# branch.head '.length).trim()
      // A detached HEAD reports `(detached)`, which is not a branch name.
      summary.current = head === '(detached)' ? null : head
      continue
    }
    if (entry.startsWith('# branch.upstream ')) {
      summary.tracking = entry.slice('# branch.upstream '.length).trim()
      continue
    }
    if (entry.startsWith('# branch.ab ')) {
      const [ahead, behind] = entry.slice('# branch.ab '.length).trim().split(' ')
      summary.ahead = Math.abs(Number(ahead ?? 0)) || 0
      summary.behind = Math.abs(Number(behind ?? 0)) || 0
      continue
    }
    if (entry.startsWith('# ')) continue
    const fields = entry.split(' ')
    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — eight fields, then the path.
    if (entry.startsWith('1 ')) {
      push(fields.slice(8).join(' '), fields[1] ?? '..')
      continue
    }
    // Renames include a ninth field and a separate NUL-delimited original path.
    if (entry.startsWith('2 ')) {
      push(fields.slice(9).join(' '), fields[1] ?? '..')
      index += 1
      continue
    }
    // Include conflicts so an unmerged tree cannot appear clean.
    if (entry.startsWith('u ')) {
      push(fields.slice(10).join(' '), fields[1] ?? 'UU')
      continue
    }
    if (entry.startsWith('? ')) push(entry.slice(2), '??')
  }
  summary.clean = summary.files.length === 0
  return summary
}

// Parse the fixed shortstat fields.
export function parseShortstat(stdout: string): { insertions: number; deletions: number } {
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout)
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout)
  return { insertions: Number(insertions?.[1] ?? 0), deletions: Number(deletions?.[1] ?? 0) }
}

// A nonzero Git exit remains distinct from a transport failure.
export class GitExecError extends Error {
  constructor(
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
    args: string[]
  ) {
    super(`git ${args[0] ?? ''} failed with code ${code}: ${stderr.trim() || stdout.trim()}`)
    this.name = 'GitExecError'
  }
}

// The executor changes with the sandbox; Git parsing and environment replacement remain shared.
export type GitCommandExecutor = (payload: GitExecPayload) => Promise<GitExecResult>

export class CommandGitRunner implements GitRunner {
  constructor(
    private readonly execute: GitCommandExecutor,
    private readonly cwd?: string,
    private readonly env?: Record<string, string>
  ) {}

  withEnv(env: Record<string, string>): GitRunner {
    return new CommandGitRunner(this.execute, this.cwd, { ...env })
  }

  async raw(args: string[]): Promise<string> {
    const result = await this.exec(args)
    return result.stdout
  }

  async clone(repo: string, target: string, options: string[] = []): Promise<void> {
    await this.exec(['clone', ...options, repo, target])
  }

  async pull(remote: string, branch: string, options: string[] = []): Promise<GitPullSummary> {
    // Obtain paths separately from the fixed shortstat fields.
    const before = await this.exec(['rev-parse', 'HEAD']).then(
      (result) => result.stdout.trim(),
      () => ''
    )
    await this.exec(['pull', ...options, remote, branch])
    const after = (await this.exec(['rev-parse', 'HEAD'])).stdout.trim()
    if (!before || before === after) return { files: [], insertions: 0, deletions: 0 }
    const names = await this.exec(['diff', '--name-only', `${before}..${after}`])
    const shortstat = await this.exec(['diff', '--shortstat', `${before}..${after}`])
    return {
      files: names.stdout.split('\n').filter((line) => line.trim().length > 0),
      ...parseShortstat(shortstat.stdout)
    }
  }

  async status(): Promise<GitStatusSummary> {
    // NUL delimiters preserve filenames; -u matches the local runner for nested untracked files.
    const result = await this.exec(['status', '--porcelain=v2', '--branch', '-u', '-z'])
    return parsePorcelainV2(result.stdout)
  }

  async readBounded(args: string[], maxBytes: number): Promise<{ out: Buffer; overflow: boolean }> {
    // The transport bounds output before this caller-specific truncation.
    let result
    try {
      result = await this.exec(args)
    } catch (err) {
      // A transport overflow may leave no partial output to return.
      if (err instanceof Error && /more than \d+ bytes on one stream/.test(err.message)) {
        return { out: Buffer.alloc(0), overflow: true }
      }
      throw err
    }
    const full = Buffer.from(result.stdout, 'utf8')
    if (full.byteLength <= maxBytes) return { out: full, overflow: false }
    return { out: full.subarray(0, maxBytes), overflow: true }
  }

  async log(options: { maxCount: number }): Promise<GitLogEntry[]> {
    // Strict ISO dates and a field separator match the local Git log contract.
    const SEP = '\u001f'
    const result = await this.exec(['log', `--max-count=${options.maxCount}`, `--format=%H%x1f%cI%x1f%s`])
    return result.stdout
      .split('\n')
      .filter((line) => line.includes(SEP))
      .map((line) => {
        const [hash, committedAt, subject] = line.split(SEP)
        return { hash: hash ?? '', committedAt: committedAt ?? '', subject: subject ?? '' }
      })
  }

  private async exec(args: string[]): Promise<GitExecResult> {
    const timeoutMs = ['clone', 'fetch', 'pull', 'push'].includes(args[0] ?? '') ? 600_000 : 120_000
    const result = GitExecResultSchema.parse(
      await this.execute({
        tool: 'git',
        args,
        timeoutMs,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.env !== undefined ? { env: this.env } : {})
      })
    )
    if (result.code !== 0) throw new GitExecError(result.code, result.stdout, result.stderr, args)
    return result
  }
}

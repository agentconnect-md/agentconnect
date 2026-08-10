import { z } from 'zod'
import type { GitLogEntry, GitPullSummary, GitRunner, GitStatusSummary } from '../workspace/git-runner.js'
import type { ShimRequester } from './channels.js'

/**
 * The `exec` payload for a git invocation inside the sandbox.
 *
 * argv only, never a composed shell string: the arguments are assembled from workspace
 * configuration that a repository can influence, and a shell would turn that into an
 * injection surface. `cwd` is validated on the shim side too — a daemon-side check says
 * nothing about the filesystem the shim is standing on.
 */
export const GitExecPayloadSchema = z.object({
  tool: z.literal('git'),
  cwd: z.string().min(1).optional(),
  args: z.array(z.string()).min(1).max(64),
  /** The COMPLETE environment for this invocation, replacing rather than extending whatever
   *  the sandbox has. Callers build it by sanitizing (stripping host GIT_CONFIG_*, protocol
   *  allowances and so on), so merging would defeat that; the shim must apply it as given.
   *  Scoped to the request, so a runtime cannot read the credential pointers back out of its
   *  own process environment afterwards. */
  env: z.record(z.string(), z.string()).optional()
})
export type GitExecPayload = z.infer<typeof GitExecPayloadSchema>

export const GitExecResultSchema = z.object({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string()
})
export type GitExecResult = z.infer<typeof GitExecResultSchema>

/**
 * Parse `git status --porcelain=v2 --branch -z` into the fields the daemon reads.
 *
 * The three changed-entry record types have DIFFERENT field counts before the path, and an
 * earlier version of this treated them alike: a staged rename came back with its similarity
 * score and original path glued into `path`, and an unmerged record was dropped entirely — so
 * a conflicted tree looked clean to any caller deriving cleanliness from `files.length`.
 *
 * `-z` rather than newlines because paths are NUL-terminated verbatim; the default format
 * C-quotes unusual filenames, which would diverge from what the local runner reports.
 */
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
    // `2 <XY> ... <X><score> <path>` — NINE fields (the extra is the rename score), and with
    // -z the ORIGINAL path follows as its own entry, which must be consumed, not parsed.
    if (entry.startsWith('2 ')) {
      push(fields.slice(9).join(' '), fields[1] ?? '..')
      index += 1
      continue
    }
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — ten fields. Dropping these is
    // what made a conflicted workspace look clean.
    if (entry.startsWith('u ')) {
      push(fields.slice(10).join(' '), fields[1] ?? 'UU')
      continue
    }
    if (entry.startsWith('? ')) push(entry.slice(2), '??')
  }
  summary.clean = summary.files.length === 0
  return summary
}

/** `N files changed, N insertions(+), N deletions(-)` — a fixed shape, unlike --stat prose. */
export function parseShortstat(stdout: string): { insertions: number; deletions: number } {
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout)
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout)
  return { insertions: Number(insertions?.[1] ?? 0), deletions: Number(deletions?.[1] ?? 0) }
}

/** A git failure that carries what the sandbox reported, so a caller can act on it. */
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

/**
 * Runs the daemon's git operations inside the sandbox over the shim's exec channel.
 *
 * The orchestration — which clone, which worktree, which reset — stays in the daemon. Moving
 * that logic into the shim would look like reuse and would actually relocate the trust
 * boundary, since the shim is the half-trusted side.
 */
export class ShimGitRunner implements GitRunner {
  constructor(
    private readonly requester: ShimRequester,
    private readonly cwd?: string,
    private readonly env?: Record<string, string>
  ) {}

  withEnv(env: Record<string, string>): GitRunner {
    // Carry `env` itself, NOT merged over any previous one. simple-git's second .env() call
    // replaces the first, so merging here would let a variable the new sanitized environment
    // intentionally omitted survive on the remote runner alone — a divergence in exactly the
    // direction that matters, since those omissions are the sanitization.
    return new ShimGitRunner(this.requester, this.cwd, { ...env })
  }

  async raw(args: string[]): Promise<string> {
    const result = await this.exec(args)
    return result.stdout
  }

  async clone(repo: string, target: string, options: string[] = []): Promise<void> {
    await this.exec(['clone', ...options, repo, target])
  }

  async pull(remote: string, branch: string, options: string[] = []): Promise<GitPullSummary> {
    // `--stat=...` would need parsing prose; the shortstat line has a fixed shape, and the
    // changed-file list comes from a name-only diff against the pre-pull HEAD.
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
    // porcelain=v2 rather than simple-git's own parse: the format is documented and stable,
    // which is what makes parsing it on this side of the channel safe. -z keeps unusual
    // filenames verbatim instead of C-quoted.
    // `-u` matches what the pinned simple-git runs (`status --porcelain -b -u --null`). Without
    // it git collapses an untracked nested file to `nested/`, while the local runner reports
    // `nested/file.txt` — the file list would differ by runner for the same tree.
    const result = await this.exec(['status', '--porcelain=v2', '--branch', '-u', '-z'])
    return parsePorcelainV2(result.stdout)
  }

  async log(options: { maxCount: number }): Promise<GitLogEntry[]> {
    // %cI is git's strict-ISO committer date, matching what the local runner asks simple-git
    // for; a unit separator keeps subjects that contain spaces or tabs intact.
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
    const payload: GitExecPayload = {
      tool: 'git',
      args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      // Present whenever an environment was set, including an explicitly EMPTY one: "run with
      // nothing" is a meaningful instruction and must not be indistinguishable from "unset".
      ...(this.env !== undefined ? { env: this.env } : {})
    }
    const raw = await this.requester.request('exec', payload)
    const result = GitExecResultSchema.parse(raw)
    if (result.code !== 0) throw new GitExecError(result.code, result.stdout, result.stderr, args)
    return result
  }
}

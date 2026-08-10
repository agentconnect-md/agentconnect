import { z } from 'zod'
import type { GitRunner, GitStatusSummary } from '../workspace/git-runner.js'
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
  /** Extra environment for THIS invocation only — the credential-helper pointers among it.
   *  Scoped to the request rather than set on the sandbox, so a runtime cannot read it back
   *  out of its own process environment later. */
  env: z.record(z.string(), z.string()).optional()
})
export type GitExecPayload = z.infer<typeof GitExecPayloadSchema>

export const GitExecResultSchema = z.object({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string()
})
export type GitExecResult = z.infer<typeof GitExecResultSchema>

/** Parse a `git status --porcelain=v2 --branch` payload into the fields the daemon reads. */
export function parsePorcelainV2(stdout: string): GitStatusSummary {
  const summary: GitStatusSummary = { current: null, tracking: null, ahead: 0, behind: 0, files: [] }
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      // A detached HEAD reports `(detached)`, which is not a branch name.
      summary.current = head === '(detached)' ? null : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      summary.tracking = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).trim().split(' ')
      summary.ahead = Math.abs(Number(ahead ?? 0)) || 0
      summary.behind = Math.abs(Number(behind ?? 0)) || 0
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // `1 XY ... <path>` (ordinary) / `2 XY ... <path><sep><origPath>` (renamed).
      const fields = line.split(' ')
      const xy = fields[1] ?? '..'
      const path =
        line
          .slice(line.indexOf(' ', line.indexOf(' ') + 1))
          .trim()
          .split('\t')[0] ?? ''
      summary.files.push({
        path: fields.slice(8).join(' ') || path,
        index: xy[0] === '.' ? ' ' : (xy[0] ?? ' '),
        working_dir: xy[1] === '.' ? ' ' : (xy[1] ?? ' ')
      })
      continue
    }
    if (line.startsWith('? ')) {
      summary.files.push({ path: line.slice(2), index: '?', working_dir: '?' })
    }
  }
  return summary
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
    return new ShimGitRunner(this.requester, this.cwd, { ...this.env, ...env })
  }

  async raw(args: string[]): Promise<string> {
    const result = await this.exec(args)
    return result.stdout
  }

  async clone(repo: string, target: string, options: string[] = []): Promise<void> {
    await this.exec(['clone', ...options, repo, target])
  }

  async pull(remote: string, branch: string, options: string[] = []): Promise<void> {
    await this.exec(['pull', ...options, remote, branch])
  }

  async status(): Promise<GitStatusSummary> {
    // porcelain=v2 rather than simple-git's own parse: the format is documented and stable,
    // which is what makes parsing it on this side of the channel safe.
    const result = await this.exec(['status', '--porcelain=v2', '--branch'])
    return parsePorcelainV2(result.stdout)
  }

  async log(options: { maxCount: number }): Promise<Array<{ hash: string; message: string }>> {
    const result = await this.exec(['log', `--max-count=${options.maxCount}`, '--format=%H%x1f%s'])
    return result.stdout
      .split('\n')
      .filter((line) => line.includes(''))
      .map((line) => {
        const [hash, message] = line.split('')
        return { hash: hash ?? '', message: message ?? '' }
      })
  }

  private async exec(args: string[]): Promise<GitExecResult> {
    const payload: GitExecPayload = {
      tool: 'git',
      args,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.env && Object.keys(this.env).length > 0 ? { env: this.env } : {})
    }
    const raw = await this.requester.request('exec', payload)
    const result = GitExecResultSchema.parse(raw)
    if (result.code !== 0) throw new GitExecError(result.code, result.stdout, result.stderr, args)
    return result
  }
}

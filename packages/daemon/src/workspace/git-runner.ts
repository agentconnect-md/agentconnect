import type { SimpleGit } from 'simple-git'

/**
 * The git operations the daemon actually performs on a workspace — a frozen inventory, not a
 * general-purpose git wrapper.
 *
 * It exists because a cluster-backed agent's workspace lives on the sandbox pod's volume, so
 * the daemon cannot reach it: the orchestration logic stays here and only the *execution*
 * moves. Deriving the interface from what the code already calls (rather than from what git
 * can do) is what keeps that move mechanical — the remote side has a closed list to
 * implement, and re-creating simple-git's surface across a channel is explicitly not the job.
 *
 * Adding a member is a deliberate act: it widens what a half-trusted sandbox will execute.
 */
export interface GitRunner {
  /**
   * A runner whose invocations use `env` as their COMPLETE environment, replacing rather than
   * extending the ambient one.
   *
   * Every existing call site threads env per invocation, and replacement is the point: callers
   * build it by sanitizing (`workspaceGitLocalEnv` strips host `GIT_CONFIG_*`, clears protocol
   * allowances, injects config pairs), so merging would quietly undo that sanitization. A
   * caller therefore supplies a whole environment, including identity, not a few overrides.
   *
   * Remotely the environment travels with the request rather than being set on the sandbox, so
   * a runtime cannot read the credential-helper pointers back out of its own env afterwards.
   */
  withEnv(env: Record<string, string>): GitRunner
  /** Run a git subcommand with argv, never a composed shell string. */
  raw(args: string[]): Promise<string>
  clone(repo: string, target: string, options?: string[]): Promise<void>
  pull(remote: string, branch: string, options?: string[]): Promise<void>
  status(): Promise<GitStatusSummary>
  /** Commit subjects, newest first, bounded by `maxCount`. */
  log(options: { maxCount: number }): Promise<Array<{ hash: string; message: string }>>
}

/** The status fields the daemon reads; simple-git returns many more. */
export interface GitStatusSummary {
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
  files: Array<{ path: string; index: string; working_dir: string }>
}

/** Factory for a runner bound to one working directory. */
export type GitRunnerFor = (cwd?: string, abort?: AbortSignal) => GitRunner

/**
 * Today's behaviour: run git in this daemon's own filesystem through simple-git.
 *
 * A thin delegation on purpose — the point of the seam is that the local path keeps its exact
 * semantics (including simple-git's argument handling and its abort-kills-the-child plugin),
 * so a cluster agent and a self-hosted agent differ in where git runs and in nothing else.
 */
export class LocalGitRunner implements GitRunner {
  constructor(private readonly git: SimpleGit) {}

  withEnv(env: Record<string, string>): GitRunner {
    // simple-git's own env chaining, so the local path keeps its exact semantics.
    return new LocalGitRunner(this.git.env(env))
  }

  async raw(args: string[]): Promise<string> {
    return this.git.raw(args)
  }

  async clone(repo: string, target: string, options: string[] = []): Promise<void> {
    await this.git.clone(repo, target, options)
  }

  async pull(remote: string, branch: string, options: string[] = []): Promise<void> {
    await this.git.pull(remote, branch, options)
  }

  async status(): Promise<GitStatusSummary> {
    const summary = await this.git.status()
    return {
      current: summary.current ?? null,
      tracking: summary.tracking ?? null,
      ahead: summary.ahead,
      behind: summary.behind,
      files: summary.files.map((file) => ({
        path: file.path,
        index: file.index,
        working_dir: file.working_dir
      }))
    }
  }

  async log(options: { maxCount: number }): Promise<Array<{ hash: string; message: string }>> {
    const result = await this.git.log({ maxCount: options.maxCount })
    return result.all.map((entry) => ({ hash: entry.hash, message: entry.message }))
  }
}

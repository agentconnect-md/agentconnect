import { execFile } from 'node:child_process'
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
  /** Pull, returning what the console reports: which files moved and by how much. */
  pull(remote: string, branch: string, options?: string[]): Promise<GitPullSummary>
  status(): Promise<GitStatusSummary>
  /** Commits newest first, bounded by `maxCount`. */
  log(options: { maxCount: number }): Promise<GitLogEntry[]>
  /**
   * Run a read-only subcommand with a HARD ceiling on the bytes it returns, and report
   * whether that ceiling was hit.
   *
   * Distinct from {@link raw} because `raw` accumulates the whole child stdout: one
   * `git diff` on a large change, or a numstat over a tens-of-thousands-of-files dirty
   * tree, is orders of magnitude larger than the wire frame it is being read for. The
   * console's review surface asks for a head slice and nothing more, and it asks on
   * every session page view, so the bound belongs in the contract rather than at each
   * call site — a remote implementation must honour it too, or a sandbox can stream an
   * unbounded reply back across the channel.
   *
   * `overflow: true` means the child was killed at `maxBytes` and `out` is the head
   * slice, which is the answer this seam wants: the caller reports it as truncated.
   */
  readBounded(args: string[], maxBytes: number): Promise<{ out: Buffer; overflow: boolean }>
}

/** The pull result the BFF surfaces to the console; nothing here is decorative. */
export interface GitPullSummary {
  files: string[]
  insertions: number
  deletions: number
}

/** A commit as the workspace views consume it — the committer date included, because the
 *  console shows when HEAD last moved and an interface without it cannot serve that. */
export interface GitLogEntry {
  hash: string
  subject: string
  /** Strict-ISO committer date (`%cI`), empty when the runtime reported none. */
  committedAt: string
}

/** The status fields the daemon reads; simple-git returns many more. */
export interface GitStatusSummary {
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
  files: Array<{ path: string; index: string; working_dir: string }>
  /** Whether the tree has no changes. Taken from simple-git locally rather than re-derived,
   *  so the local answer stays authoritative; the remote side derives it and the contract test
   *  is what establishes the two agree, including on a conflicted tree. */
  clean: boolean
}

/** A local diff/log/numstat never touches the network, so it either answers quickly or the
 *  checkout is wedged (an index.lock holder, a dead fsmonitor). */
const READ_TIMEOUT_MS = 15_000

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
  // `cwd` and `env` are carried alongside the handle because `readBounded` spawns its own
  // child and cannot ask simple-git what it was configured with.
  // `cwd` is REQUIRED, not optional: `readBounded` spawns its own child and cannot ask
  // simple-git where it was pointed, and a site that forgets runs git in the daemon's own
  // directory instead of the workspace — which happened twice while this was optional and
  // read as a passing test. Required makes the compiler find every site.
  constructor(
    private readonly git: SimpleGit,
    private readonly cwd: string | undefined,
    private readonly env: Record<string, string> = {}
  ) {}

  withEnv(env: Record<string, string>): GitRunner {
    // simple-git's own env chaining, so the local path keeps its exact semantics.
    return new LocalGitRunner(this.git.env(env), this.cwd, env)
  }

  async raw(args: string[]): Promise<string> {
    return this.git.raw(args)
  }

  readBounded(args: string[], maxBytes: number): Promise<{ out: Buffer; overflow: boolean }> {
    // `execFile` rather than the simple-git handle, which is the whole reason this member
    // exists: `maxBuffer` and `timeout` are what bound it, and simple-git exposes neither.
    // The env and cwd come from the same places the handle's do, so the two paths differ in
    // the ceiling and in nothing else.
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          ...(this.cwd ? { cwd: this.cwd } : {}),
          env: { ...this.env },
          encoding: 'buffer',
          maxBuffer: maxBytes,
          timeout: READ_TIMEOUT_MS,
          windowsHide: true
        },
        (err, stdout) => {
          if (!err) return resolve({ out: stdout, overflow: false })
          // The ceiling was hit: the child is already dead and `stdout` holds the head slice.
          if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return resolve({ out: stdout, overflow: true })
          }
          reject(err)
        }
      )
    })
  }

  async clone(repo: string, target: string, options: string[] = []): Promise<void> {
    await this.git.clone(repo, target, options)
  }

  async pull(remote: string, branch: string, options: string[] = []): Promise<GitPullSummary> {
    const result = await this.git.pull(remote, branch, options)
    return {
      files: [...result.files],
      insertions: result.summary.insertions,
      deletions: result.summary.deletions
    }
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
      })),
      clean: summary.isClean()
    }
  }

  async log(options: { maxCount: number }): Promise<GitLogEntry[]> {
    const result = await this.git.log({
      maxCount: options.maxCount,
      format: { hash: '%H', date: '%cI', subject: '%s' }
    })
    return result.all.map((entry) => ({
      hash: entry.hash,
      subject: entry.subject ?? '',
      committedAt: entry.date ?? ''
    }))
  }
}

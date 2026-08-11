/**
 * `WorkspaceGit` — the seam answering the CP's `workspace/gitstatus`,
 * `workspace/gitdiff`, `workspace/gitlog` and `workspace/gitpull` REQs against an
 * agent's local git-repo workspace. Sibling to {@link WorkspaceReader}: git runs
 * daemon-local and only the outcome is proxied to the console (§1/§12), never the
 * repo.
 *
 * DATA vs error: a from-scratch workspace (`isRepo:false`), a dirty tree, a path
 * with no changes, a binary change, or a pull that can't fast-forward (offline,
 * diverged, would clobber local edits) are all normal REPs — the caller renders
 * them. Only an unknown agentId or a path escaping the workspace throws
 * ({@link WorkspaceViolationError} → `BAD_PAYLOAD` + a machine-readable reason);
 * an unexpected git/fs failure propagates (→ `INTERNAL`). Git-provided text is
 * scrubbed of the absolute workspace path before it leaves the daemon (raw git
 * errors embed host paths that must not reach the CP/UI).
 *
 * Every read here is bounded: `status` caps its file list, `log` caps commits and
 * their display text, and `diff` caps the bytes git may return (see {@link gitRead}).
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { join } from 'node:path'
import {
  normalizeGithubRepoUrl,
  type WorkspaceGitStatus,
  type WorkspaceGitDiffReq,
  type WorkspaceGitDiffResult,
  type WorkspaceGitLogReq,
  type WorkspaceGitLog,
  type WorkspaceGitPullResult,
  type WorkspaceGitFile,
  type WorkspaceGitCommit
} from '@agentconnect.md/protocol'
import {
  assertSafeWorkspaceGitConfig,
  gitFor,
  pullWorkspaceRef,
  workspaceGitLocalEnv,
  workspaceGitPullTarget
} from '../workspace/git-injection.js'
import { LocalGitRunner, type GitRunner } from '../workspace/git-runner.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { canonicalWorkspacePath, containedWorkspacePath, WorkspaceViolationError } from './workspace-reader.js'
import { LOG_FORMAT, numstatByPath, parseLogZ, parseNumstatZ } from './workspace-git-parse.js'
import { REPLY_BUDGET, fitToBudget, utf8Boundary } from './wire-slice.js'

/** On-demand pull is interactive, so allow more headroom than the 4.5s
 *  best-effort pull at session start (workspace-manager.ts). */
const PULL_TIMEOUT_MS = 20_000

/** A local diff/log/numstat never touches the network, so it either answers
 *  quickly or the checkout is wedged (an index.lock holder, a dead fsmonitor). */
const READ_TIMEOUT_MS = 15_000

/** Cap the changed-file list so a huge working tree can't overflow the frame. */
/** Where this surface gets its git. A cluster-backed workspace substitutes a shim-backed
 *  runner here; the questions asked, and the answers' shape, do not change. */
function runnerFor(cwd: string, abort?: AbortSignal): GitRunner {
  // `cwd` travels alongside the handle so `readBounded`, which spawns its own child, runs in the same directory simple-git was pointed at.
  return new LocalGitRunner(gitFor(cwd, abort), cwd)
}

const MAX_STATUS_FILES = 500

/** Ceiling on the bytes one metadata read (numstat, log page, rev-list) may return.
 *  The wire caps a log page at 50 commits × (200 + 100) display characters, so 64 KiB
 *  is generous for real subjects and paths while still bounding a repository that
 *  commits megabyte-long subject lines. */
const METADATA_OUTPUT_BUDGET = 64 * 1024

/** Ceiling on the bytes `git diff` may return: exactly the encoded-reply budget.
 *  Reading more could never help — JSON escaping only ever expands, so the REP can
 *  carry at most REPLY_BUDGET raw bytes of diff text no matter how much git wrote. */
const DIFF_OUTPUT_BUDGET = REPLY_BUDGET

export interface WorkspaceGit {
  status(agentId: string, sessionId?: string): Promise<WorkspaceGitStatus>
  diff(req: WorkspaceGitDiffReq): Promise<WorkspaceGitDiffResult>
  log(req: WorkspaceGitLogReq): Promise<WorkspaceGitLog>
  pull(agentId: string): Promise<WorkspaceGitPullResult>
}

export interface WorkspaceGitTarget {
  repo: string
  branch: string
  githubApp: boolean
}

export function createWorkspaceGit(
  workspaceRootByAgent: (agentId: string, sessionId?: string) => string | undefined,
  credentialEnvByAgent: (agentId: string) => Record<string, string> = () => ({}),
  workspaceTargetByAgent: (agentId: string) => WorkspaceGitTarget | undefined = () => undefined
): WorkspaceGit {
  function rootFor(agentId: string, sessionId?: string): string {
    const root = workspaceRootByAgent(agentId, sessionId)
    if (!root) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return root
  }

  /** A git-repo workspace has a `.git` at its root; from-scratch does not. */
  function isRepo(root: string): boolean {
    return existsSync(join(root, '.git'))
  }

  /** Strip the absolute workspace path out of git-provided text so no host path
   *  leaks to the CP/UI. Repo-relative paths in the message are kept. */
  function scrub(root: string, msg: string): string {
    return msg.split(root).join('<workspace>').trim()
  }

  function safeExplicitOrigin(input: string): string | undefined {
    const raw = input.trim()
    if (!/^(?:https|ssh):\/\//i.test(raw) && !/^[\w.-]+@[\w.-]+:/.test(raw)) return undefined
    try {
      return authorizeWorkspaceGitUrl(raw)
    } catch {
      return undefined
    }
  }

  return {
    async status(agentId, sessionId) {
      const root = rootFor(agentId, sessionId)
      if (!isRepo(root)) return { agentId, isRepo: false, clean: true }

      // Status is read-only and the daemon policy already disables hooks and
      // fsmonitor at command scope. Repository hook/include configuration must
      // not make an otherwise usable workspace disappear from the console.
      // Through the runner, so a cluster-backed workspace answers the same question by running
      // git in its own sandbox rather than on a disk this daemon cannot see.
      const git = runnerFor(root).withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
      const s = await git.status()
      // Join the numstat AFTER the cap: a 10k-file tree must not pay for counts on
      // rows that get dropped anyway.
      const capped = s.files.slice(0, MAX_STATUS_FILES)
      const counts = capped.length ? await numstatVsHead(git) : new Map()
      const files: WorkspaceGitFile[] = capped.map((f) => {
        const n = counts.get(f.path)
        return {
          path: f.path,
          index: f.index,
          workingDir: f.working_dir,
          ...(n?.additions !== undefined ? { additions: n.additions } : {}),
          ...(n?.deletions !== undefined ? { deletions: n.deletions } : {})
        }
      })
      const [lastCommit, lastFetchAt] = await Promise.all([headCommit(git), fetchHeadMtime(root)])
      return {
        agentId,
        isRepo: true,
        clean: s.clean,
        ...(s.current ? { branch: s.current } : {}),
        ...(s.tracking ? { tracking: s.tracking } : {}),
        ahead: s.ahead,
        behind: s.behind,
        ...(files.length ? { files } : {}),
        ...(s.files.length > files.length ? { truncated: true } : {}),
        ...(lastCommit ? { lastCommit } : {}),
        ...(lastFetchAt ? { lastFetchAt } : {})
      }
    },

    async diff(req) {
      const root = rootFor(req.agentId, req.sessionId)
      if (!isRepo(root)) return { agentId: req.agentId, path: req.path, isRepo: false, exists: false }
      // Through the runner, so a cluster-backed workspace answers by running git in its own sandbox rather than on a disk this daemon cannot see.
      const git = runnerFor(root).withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })

      // Containment first: an unchecked pathspec would diff (and therefore print) files outside the workspace — the parent dir holds agent.json.
      // CANONICAL, not merely lexical: `lstat` follows intermediate components, so a symlinked directory inside the workspace would otherwise make `exists` below a true/false oracle for arbitrary host paths — the very check `workspace/read` canonicalises to enforce. `null` means absent, which is data: a deleted-but-tracked path still has a diff.
      const resolved = containedWorkspacePath(root, req.path)
      const canonical = await canonicalWorkspacePath(root, req.path)
      const rel = path.relative(root, resolved).split(path.sep).join('/')
      // `:(literal)` disables pathspec magic and globbing, so a path containing `*`,
      // `:` or a leading `!` names exactly the file it looks like. An empty relative
      // path IS the workspace root — diff the whole tree.
      const pathspec = rel === '' ? [] : ['--', `:(literal)${rel}`]
      const scope = req.staged ? ['--cached'] : []

      const counted = await git.readBounded(['diff', ...scope, '--numstat', '-z', ...pathspec], METADATA_OUTPUT_BUDGET)
      const rows = parseNumstatZ(counted.out.toString('utf8'))
      if (rows.length === 0) {
        // No change in this scope: the path either exists (unchanged, or untracked —
        // `git diff` never shows an untracked file) or it does not. Both are DATA.
        return { agentId: req.agentId, path: req.path, isRepo: true, exists: canonical !== null }
      }
      // git itself reported `-` `-` for every row ⇒ nothing textual to render. A
      // truncated row list cannot support that claim, so it falls through to the text.
      if (!counted.overflow && rows.every((row) => row.additions === undefined && row.deletions === undefined)) {
        return { agentId: req.agentId, path: req.path, isRepo: true, exists: true, binary: true }
      }

      // --no-ext-diff / --no-textconv: a checkout's own diff driver or textconv
      // filter is a program, and a console read must never run repository code.
      const text = await git.readBounded(
        ['diff', ...scope, '--no-color', '--no-ext-diff', '--no-textconv', ...pathspec],
        DIFF_OUTPUT_BUDGET
      )
      const fitted = fitToBudget(text.out, utf8Boundary(text.out, text.out.length))
      return {
        agentId: req.agentId,
        path: req.path,
        isRepo: true,
        exists: true,
        diff: fitted.content,
        ...(text.overflow || fitted.end < text.out.length ? { truncated: true } : {})
      }
    },

    async log(req) {
      const root = rootFor(req.agentId, req.sessionId)
      if (!isRepo(root)) return { agentId: req.agentId, isRepo: false, commits: [], truncated: false }
      // Through the runner, so a cluster-backed workspace answers by running git in its own sandbox rather than on a disk this daemon cannot see.
      const git = runnerFor(root).withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })

      // One extra row proves there are more commits than the caller asked for.
      let parsed
      try {
        const out = await git.readBounded(
          ['log', '-z', `--format=${LOG_FORMAT}`, `-n`, String(req.limit + 1), 'HEAD'],
          METADATA_OUTPUT_BUDGET
        )
        parsed = parseLogZ(out.out.toString('utf8'))
      } catch (err) {
        // ONLY the unborn-HEAD case is an empty log. Swallowing everything here turned a
        // read timeout, a permission failure or a corrupt object into a confident
        // "No commits yet", which is a lie the reader cannot act on — those propagate to
        // INTERNAL and the panel says it could not read the history.
        if (!(await isUnbornHead(git))) throw err
        return { agentId: req.agentId, isRepo: true, commits: [], truncated: false }
      }

      // `pushed` = reachable from the branch's upstream ref. No upstream (or a
      // detached HEAD) ⇒ nothing is known to be on a remote, so every commit reports
      // false and `tracking` is absent to say why.
      const tracking = await upstreamRef(git)
      const unpushed = tracking ? await unpushedShas(git, tracking, req.limit + 1) : null
      const commits = parsed.slice(0, req.limit).map((c) => ({
        ...c,
        pushed: unpushed === null ? false : !unpushed.has(c.sha)
      }))
      return {
        agentId: req.agentId,
        isRepo: true,
        commits,
        truncated: parsed.length > req.limit,
        ...(tracking ? { tracking } : {})
      }
    },

    async pull(agentId) {
      const root = rootFor(agentId)
      if (!isRepo(root)) return { agentId, isRepo: false, ok: false, detail: 'workspace is not a git checkout' }

      // ff-only: an on-demand pull must never rewrite or clobber the agent's
      // working tree — a diverged branch / local edits surface as ok:false, not a
      // forced reset. Bounded by a timeout so an offline remote can't hang the REP.
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      try {
        const git = runnerFor(root, abort.signal).withEnv(workspaceGitLocalEnv())
        const target = workspaceTargetByAgent(agentId)
        let currentOrigin: string | undefined
        let expectedOrigin: string
        try {
          currentOrigin = safeExplicitOrigin(await git.raw(['remote', 'get-url', 'origin']))
          if (!target) throw new Error('workspace target is unavailable')
          expectedOrigin = authorizeWorkspaceGitUrl(
            target.githubApp ? normalizeGithubRepoUrl(target.repo) : target.repo
          )
        } catch {
          return { agentId, isRepo: true, ok: false, detail: 'workspace origin is not a safe remote' }
        }
        if (
          !currentOrigin ||
          (target.githubApp === true && currentOrigin.toLowerCase() !== expectedOrigin.toLowerCase())
        ) {
          return { agentId, isRepo: true, ok: false, detail: 'workspace origin is not a safe remote' }
        }
        await assertSafeWorkspaceGitConfig(runnerFor(root))
        const pullBranch = target.branch
        const pullTarget = workspaceGitPullTarget(expectedOrigin)
        timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
        const res = await pullWorkspaceRef(
          git.withEnv({
            ...workspaceGitLocalEnv(),
            ...pullTarget.env,
            ...credentialEnvByAgent(agentId),
            GIT_TERMINAL_PROMPT: '0'
          }),
          pullTarget.remote,
          pullBranch
        )
        const changed = res.files.length
        return {
          agentId,
          isRepo: true,
          ok: true,
          changed,
          insertions: res.insertions,
          deletions: res.deletions,
          detail:
            changed > 0 ? `Fast-forwarded — updated ${changed} file${changed === 1 ? '' : 's'}.` : 'Already up to date.'
        }
      } catch (err) {
        return { agentId, isRepo: true, ok: false, detail: scrub(root, (err as Error)?.message ?? 'pull failed') }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
}

/** Whether the checkout simply has no commit yet — the one `git log` failure that is an
 *  ordinary answer rather than a fault. `rev-parse --verify` alone cannot tell it apart
 *  from a corrupt object store (measured: both fail); `symbolic-ref` can, because an
 *  unborn branch still HAS a symbolic HEAD while a repository git considers unusable does
 *  not. Conservative on purpose: anything else propagates, so an unreadable history reads
 *  as unreadable instead of as empty. */
async function isUnbornHead(git: GitRunner): Promise<boolean> {
  try {
    await git.readBounded(['rev-parse', '--verify', '--quiet', 'HEAD'], METADATA_OUTPUT_BUDGET)
    return false // HEAD resolves, so whatever failed was not this
  } catch {
    try {
      await git.readBounded(['symbolic-ref', '-q', 'HEAD'], METADATA_OUTPUT_BUDGET)
      return true
    } catch {
      return false
    }
  }
}

/** Per-file added/removed line counts vs HEAD — staged AND unstaged, i.e. what the
 *  file changed since the last commit, which is what the console's `+128 −12` means.
 *  Renames key on the NEW path, matching what `git status` reports. Swallowed on
 *  failure (an empty repo has no HEAD): counts are optional on the wire. */
async function numstatVsHead(git: GitRunner): Promise<Map<string, { additions?: number; deletions?: number }>> {
  try {
    // `gitRead`, never simple-git's `raw`: simple-git buffers the whole child stdout with no ceiling and no timeout, and a dirty tree of tens of thousands of files writes megabytes here — on a path `workspace/gitstatus` takes on every session page view. `--no-relative` is belt-and-braces: `isRepo` requires `.git` directly under `root`, so this always runs AT the repo root and `diff.relative` cannot make these paths disagree with `git status --porcelain`'s repo-relative ones — but the flag costs nothing and the join silently empties if that ever stops holding.
    const counted = await git.readBounded(['diff', 'HEAD', '--numstat', '-z', '--no-relative'], METADATA_OUTPUT_BUDGET)
    return numstatByPath(parseNumstatZ(counted.out.toString('utf8')))
  } catch {
    return new Map()
  }
}

/** The current branch's upstream ref (`origin/main`), or null when the branch
 *  tracks nothing and when HEAD is detached — git fails the same way for both. */
async function upstreamRef(git: GitRunner): Promise<string | null> {
  try {
    const out = await git.readBounded(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 4096)
    const ref = out.out.toString('utf8').trim()
    return ref === '' ? null : ref
  } catch {
    return null
  }
}

/** The shas reachable from HEAD but NOT from the upstream ref — the unpushed set.
 *  Bounded by the same commit count the log page carries. Null when the set cannot be
 *  computed, which reports every commit as NOT known-pushed rather than claiming a
 *  remote already has work it may not have. */
async function unpushedShas(git: GitRunner, upstream: string, limit: number): Promise<Set<string> | null> {
  try {
    const out = await git.readBounded(
      ['rev-list', '-n', String(limit), 'HEAD', '--not', upstream],
      METADATA_OUTPUT_BUDGET
    )
    return new Set(
      out.out
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  } catch {
    return null
  }
}

/** The HEAD commit (sha / short sha / subject / committer date), or null for an
 *  empty repo with no commits yet. `%cI` is git's strict-ISO committer date. */
async function headCommit(git: GitRunner): Promise<WorkspaceGitCommit | null> {
  try {
    const [commit] = await git.log({ maxCount: 1 })
    if (!commit?.hash) return null
    return {
      sha: commit.hash,
      shortSha: commit.hash.slice(0, 7),
      subject: commit.subject,
      committedAt: commit.committedAt
    }
  } catch {
    return null // freshly-init'd repo with no commits ⇒ `git log` errors
  }
}

/** When the checkout last fetched/pulled, from `.git/FETCH_HEAD`'s mtime (git
 *  rewrites it on every fetch/pull). Null if it has never fetched. */
async function fetchHeadMtime(root: string): Promise<string | null> {
  try {
    const st = await fs.stat(join(root, '.git', 'FETCH_HEAD'))
    return st.mtime.toISOString()
  } catch {
    return null
  }
}

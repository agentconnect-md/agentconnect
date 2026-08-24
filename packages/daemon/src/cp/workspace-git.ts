/**
 * `WorkspaceGit` — the seam answering the CP's `workspace/gitstatus`,
 * `workspace/gitdiff`, `workspace/gitlog`, `workspace/gitpull` and the four write
 * REQs (`gitstage` / `gitunstage` / `gitcommit` / `gitpush`) against an agent's
 * git-repo workspace. Sibling to {@link WorkspaceReader}: git runs wherever that
 * workspace lives — this disk, or a cluster agent's sandbox pod — and only the
 * outcome is proxied to the console (§1/§12), never the repo.
 *
 * DATA vs error: a from-scratch workspace (`isRepo:false`), a dirty tree, a path
 * with no changes, a binary change, or a pull that can't fast-forward (offline,
 * diverged, would clobber local edits) are all normal REPs — the caller renders
 * them. So is every way a write can decline: nothing to stage, an empty index, no
 * registered commit identity, a detached HEAD, a branch with no upstream, a
 * rejected push. Only an unknown agentId, a path escaping the workspace, or a
 * sandbox workspace with no channel to reach it throws
 * ({@link WorkspaceViolationError} → `BAD_PAYLOAD` + a machine-readable reason);
 * an unexpected git/fs failure propagates (→ `INTERNAL`). Git-provided text is
 * scrubbed of the absolute workspace path before it leaves the daemon (raw git
 * errors embed host paths that must not reach the CP/UI).
 *
 * Every read here is bounded: `status` caps its file list, `log` caps commits and
 * their display text, and `diff` caps the bytes git may return (see {@link gitRead}).
 *
 * `workspace/gitmessage` is the odd one out: it writes nothing and runs a bounded model turn on the
 * AGENT's own runtime (the CP is never on the inference path — webchat-side-panels.md §2). The
 * session mechanics are injected as {@link CommitMessagePass}; this module owns the staged-diff read,
 * its cap, and turning every possible disappointment into DATA.
 *
 * Three properties the writes need and the reads do not: they go through the SAME
 * per-agent runner seam (a cluster agent's `git add` must land on its sandbox volume,
 * not this disk); the local config audit runs FIRST (`git add` executes a repository's
 * own `filter.*.clean` program); and runtime quiescence is the CALLER's job — the
 * daemon wraps each of them in `Daemon.withWorkspaceIndexWrite`.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { join } from 'node:path'
import {
  normalizeGithubRepoUrl,
  type GitCommitIdentity,
  type WorkspaceGitStatus,
  type WorkspaceGitDiffReq,
  type WorkspaceGitDiffResult,
  type WorkspaceGitLogReq,
  type WorkspaceGitLog,
  type WorkspaceGitPullResult,
  type WorkspaceGitFile,
  type WorkspaceGitCommit,
  type WorkspaceGitStageReq,
  type WorkspaceGitCommitReq,
  type WorkspaceGitCommitResult,
  type WorkspaceGitPushReq,
  type WorkspaceGitPushResult,
  type WorkspaceGitWriteReason,
  type WorkspaceGitMessageReq,
  type WorkspaceGitMessageResult
} from '@agentconnect.md/protocol'
import {
  assertSafeWorkspaceGitConfig,
  canonicalWorkspaceGitUrl,
  gitCommitIdentityEnv,
  GITHUB_CREDENTIAL_SCOPE,
  pullWorkspaceRef,
  workspaceGitLocalEnv,
  workspaceGitRemoteTarget,
  type ManagedCredentialScope
} from '../workspace/git-injection.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { canonicalWorkspacePath, containedWorkspacePath, WorkspaceViolationError } from './workspace-reader.js'
import {
  COMMIT_MESSAGE_SYSTEM_PROMPT,
  buildCommitMessagePrompt,
  sanitizeCommitMessage,
  type CommitMessageFile
} from '../workspace/commit-message.js'
import { LOG_FORMAT, numstatByPath, parseLogZ, parseNameStatusZ, parseNumstatZ } from './workspace-git-parse.js'
import { REPLY_BUDGET, fitToBudget, utf8Boundary } from '../wire-slice.js'

/** On-demand pull is interactive, so allow more headroom than the 4.5s
 *  best-effort pull at session start (workspace-manager.ts). */
const PULL_TIMEOUT_MS = 20_000

/** A local diff/log/numstat never touches the network, so it either answers
 *  quickly or the checkout is wedged (an index.lock holder, a dead fsmonitor). */
const READ_TIMEOUT_MS = 15_000

/** A push uploads objects to a remote, so it is bounded by the network like the pull and not by
 *  local work — with more headroom, because a first push of a branch can be large. */
const PUSH_TIMEOUT_MS = 60_000

/** Wall-clock ceiling on ONE commit-message pass, covering the staged-diff reads, a cold host start
 *  and the model turn. A reader pressed a button, so it must answer or give up; and the whole thing
 *  has to fit inside `WORKSPACE_GIT_MESSAGE_BUDGET_MS` (the CP's single-shot allowance) with room for
 *  the runtime's own cancel backstop, which the daemon arms on top of this abort. */
const COMMIT_MESSAGE_TIMEOUT_MS = 45_000

/** How much staged diff the model may see. Chosen for cost, not for the wire: ~32 KiB is roughly 8k
 *  tokens on an explicit, user-paid button press, and a subject line does not get better past it.
 *  Beyond the cap the diff is cut and the model is TOLD it was cut — plus it always receives the
 *  complete `--name-status` list, so even a truncated read yields an accurate subject and scope. */
const COMMIT_MESSAGE_DIFF_BUDGET = 32 * 1024

/** Staged paths listed in the prompt. A larger selection reports a count instead of more rows. */
const COMMIT_MESSAGE_MAX_FILES = 200

/** Pathspecs per `git add` / `git reset` invocation. The sandbox exec channel caps one git argv at
 *  64 elements, so a 500-path selection has to arrive as several invocations either way. */
const STAGE_PATHSPEC_CHUNK = 50

/** Cap the changed-file list so a huge working tree can't overflow the frame. */
/** Where this surface gets its git: the SAME per-agent resolution the workspace manager uses, so a
 *  cluster-backed workspace runs git in its own sandbox instead of on a disk this daemon cannot see
 *  — for a write, that is the difference between staging the agent's tree and mutating the wrong one.
 *
 *  The refusal rides on the RESOLUTION rather than being a check before it. Every operation below
 *  resolves exactly once and derives every other runner from that one, so this is also the whole of
 *  how an unreachable sandbox is detected: there is no window in which a check said "reachable" and a
 *  later resolution answered with this daemon's filesystem. */
function runnerFor(workspaces: WorkspaceManager, agentId: string, cwd: string, abort?: AbortSignal): GitRunner {
  const runner = workspaces.consoleWorkspaceGitRunner(agentId, cwd, abort)
  if (!runner) {
    throw new WorkspaceViolationError(
      `agent "${agentId}" has no running sandbox, so its workspace cannot be reached`,
      'sandbox-unavailable'
    )
  }
  return transient(agentId, runner)
}

/**
 * Surface "the invocation never reached git" as the TRANSIENT refusal, on every call this seam makes.
 *
 * One wrapper rather than a check per operation, because the failure it translates is routine: the
 * shim re-dials at half its credential TTL, and the retry inside the remote runner covers the reads
 * it can safely repeat but cannot cover a write. What must not happen is that such a failure reaches
 * a caller which reads a git error as an ANSWER — `isRepo` is the sharp one, and it would settle a
 * renewal as "not a git checkout" for a checkout that is there. The same reason the whole panel
 * already has copy for: the sandbox is not reachable this instant, and it comes back.
 */
function transient(agentId: string, runner: GitRunner): GitRunner {
  const unreachable = (err: GitTransportError): WorkspaceViolationError =>
    new WorkspaceViolationError(
      `agent "${agentId}" lost its sandbox channel, so its workspace could not be read: ${err.message}`,
      'sandbox-unavailable'
    )
  const translate = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (err) {
      throw err instanceof GitTransportError ? unreachable(err) : err
    }
  }
  const wrap = (inner: GitRunner): GitRunner => ({
    withEnv: (env) => wrap(inner.withEnv(env)),
    raw: (args) => translate(() => inner.raw(args)),
    clone: (repo, target, options) => translate(() => inner.clone(repo, target, options)),
    pull: (remote, branch, options) => translate(() => inner.pull(remote, branch, options)),
    status: () => translate(() => inner.status()),
    log: (options) => translate(() => inner.log(options)),
    readBounded: (args, maxBytes) => translate(() => inner.readBounded(args, maxBytes))
  })
  return wrap(runner)
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
  status(agentId: string, sessionId?: string, repo?: string): Promise<WorkspaceGitStatus>
  diff(req: WorkspaceGitDiffReq): Promise<WorkspaceGitDiffResult>
  log(req: WorkspaceGitLogReq): Promise<WorkspaceGitLog>
  pull(agentId: string, repo?: string): Promise<WorkspaceGitPullResult>
  /** Stage / unstage exactly these paths, answering with the FRESH status so the console never
   *  re-polls for the result of its own action. */
  stage(req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus>
  unstage(req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus>
  commit(req: WorkspaceGitCommitReq): Promise<WorkspaceGitCommitResult>
  push(req: WorkspaceGitPushReq): Promise<WorkspaceGitPushResult>
  /** Draft a commit message from the staged diff on the agent's own runtime. Writes NOTHING. */
  message(req: WorkspaceGitMessageReq): Promise<WorkspaceGitMessageResult>
}

/** One bounded, transcript-free model turn on the agent's OWN runtime, returning the answer text.
 *  Implemented by `Daemon.runCommitMessagePass` — this seam exists so the git side stays testable
 *  without an ACP adapter, and so the CP-never-calls-a-model rule has exactly one place to hold.
 *  Everything about it is the daemon's business: which host, a fresh session discarded after, the
 *  read-only gate, and honouring `signal` on the runtime's cancel path. */
export type CommitMessagePass = (
  agentId: string,
  systemPrompt: string,
  prompt: string,
  signal: AbortSignal
) => Promise<{ output: string; stopReason: string }>

export interface WorkspaceGitTarget {
  repo: string
  branch: string
  githubApp: boolean
  /** The managed host this scope's credential channel pins, resolved from the spec (§24.4). */
  managed?: ManagedCredentialScope
  /** Whose URL conventions this remote follows; absent ⇒ neither provider's (§24.4). */
  remoteProvider?: 'github' | 'gitlab'
}

export function createWorkspaceGit(
  workspaces: WorkspaceManager,
  workspaceRootByAgent: (agentId: string, sessionId?: string, repo?: string) => Promise<string | undefined>,
  /** The identity the daemon's git-credential helper answers as for the scope being operated on, or
   *  undefined when the daemon issues no credentials for it — that scope then reaches the remote on
   *  whatever ambient auth the host has, or fails as data. Scoped by `repo` for the same reason the
   *  target is: a secondary root is App-covered even when the primary workspace is not, so gating the
   *  helper on the primary's credential mode would leave its private clone anonymous. */
  credentialAgentIdFor: (agentId: string, repo?: string) => string | undefined = () => undefined,
  /** The origin and branch of the scope being operated on — the agent's primary workspace, or the
   *  secondary root `repo` names. A pull reaches THAT repository's remote, never the primary's. */
  workspaceTargetByAgent: (agentId: string, repo?: string) => Promise<WorkspaceGitTarget | undefined> = async () =>
    undefined,
  /** The identity the CP registered on `register/ok`. Absent ⇒ a console commit is REFUSED as
   *  data: git would otherwise guess the host operator's passwd identity and attribute the
   *  commit to them, which is worse than not committing. */
  commitIdentityByAgent: (agentId: string) => GitCommitIdentity | undefined = () => undefined,
  /** The daemon's model pass. Absent ⇒ the wand answers `ok:false` as data instead of pretending. */
  commitMessagePass?: CommitMessagePass
): WorkspaceGit {
  async function rootFor(agentId: string, sessionId?: string, repo?: string): Promise<string> {
    const root = await workspaceRootByAgent(agentId, sessionId, repo)
    if (!root) throw new WorkspaceViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return root
  }

  /** A git-repo workspace has a `.git` at its root; from-scratch does not. */
  // Asked THROUGH the runner, never of the daemon's own filesystem. A cluster-backed agent's
  // checkout lives on the sandbox pod's volume, so `existsSync` on the daemon path answers about a
  // directory that legitimately has no `.git` — and a false here refused every read and, once M3
  // landed, every write for those agents. `--is-inside-work-tree` is the question actually being
  // asked, and the runner is what knows where to ask it.
  async function isRepo(git: GitRunner): Promise<boolean> {
    try {
      // `--show-prefix`, not `--is-inside-work-tree`: the latter is true from every DESCENDANT of a
      // checkout, so a from-scratch workspace sitting under an unrelated ancestor repository would
      // pass — and then a commit or push here would operate on that ancestor, including whatever it
      // already had staged outside this workspace. `--show-prefix` is empty only AT the top level,
      // errors outside a repository, and stays empty for a linked worktree (whose `.git` is a file),
      // so it needs no path comparison to be right about all three. Measured, not assumed.
      const out = await git.readBounded(['rev-parse', '--show-prefix'], 4096)
      return out.out.toString('utf8').trim() === ''
    } catch (err) {
      // Only GIT's own answer makes this false. A request that never reached git — the shim's routine
      // half-TTL renewal fails the ones in flight — arrives here as the transient refusal, and
      // swallowing it would settle a renewal as "not a git checkout" for a checkout that is there:
      // the exact misleading outcome this seam exists to remove, reintroduced from the other end.
      if (err instanceof WorkspaceViolationError) throw err
      return false
    }
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

  /** The origin URL a network operation may reach plus the configured branch, or `undefined` when the
   *  checkout's own `origin` is not it (reported as the uninformative "not a safe remote"). Shared by
   *  pull and push: a second, weaker check on the write path is how a push reaches an unapproved remote. */
  async function authorizedTarget(
    agentId: string,
    git: GitRunner,
    repo?: string
  ): Promise<{ origin: string; branch: string; managed: ManagedCredentialScope } | undefined> {
    const target = await workspaceTargetByAgent(agentId, repo)
    let currentOrigin: string | undefined
    let expectedOrigin: string
    try {
      currentOrigin = safeExplicitOrigin(await git.raw(['remote', 'get-url', 'origin']))
      if (!target) throw new Error('workspace target is unavailable')
      // Canonicalization follows the remote's PROVIDER: only a gitlab project keeps its subgroups.
      const provider = target.remoteProvider
      const github = target.githubApp && provider !== 'gitlab'
      expectedOrigin = authorizeWorkspaceGitUrl(
        canonicalWorkspaceGitUrl(github ? normalizeGithubRepoUrl(target.repo) : target.repo, provider)
      )
    } catch {
      return undefined
    }
    if (!currentOrigin || (target.githubApp === true && currentOrigin.toLowerCase() !== expectedOrigin.toLowerCase())) {
      return undefined
    }
    return { origin: expectedOrigin, branch: target.branch, managed: target.managed ?? GITHUB_CREDENTIAL_SCOPE }
  }

  /** Shared by `status` and by both index writes, which answer with the fresh status. */
  // `bound` is the runner the CALLER already resolved, when there is one. An index write must answer
  // with the status of the checkout it just mutated: resolving again here means a shim that detached
  // between the write and the reply reads a daemon-local checkout, or answers `isRepo:false`, for a
  // mutation that landed in the sandbox.
  async function readStatus(
    agentId: string,
    sessionId?: string,
    repo?: string,
    bound?: { base: GitRunner; root: string }
  ): Promise<WorkspaceGitStatus> {
    const root = bound?.root ?? (await rootFor(agentId, sessionId, repo))
    // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
    // re-resolving would let a channel that drops in between prove the sandbox checkout and then
    // mutate this daemon's own disk. Every runner below derives from this one.
    const base = bound?.base ?? runnerFor(workspaces, agentId, root)
    if (!(await isRepo(base))) return { agentId, isRepo: false, clean: true }

    // Status is read-only and the daemon policy already disables hooks and
    // fsmonitor at command scope. Repository hook/include configuration must
    // not make an otherwise usable workspace disappear from the console.
    // Through the runner, so a cluster-backed workspace answers the same question by running
    // git in its own sandbox rather than on a disk this daemon cannot see.
    const git = base.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
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
    const [lastCommit, lastFetchAt] = await Promise.all([headCommit(git), fetchHeadMtime(workspaces, root)])
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
  }

  /** Repo-relative POSIX path for ONE requested path, after containment. Rejects an absolute
   *  path, a `..` escape and anything reaching into `.git` — a pathspec is trusted by git, so an
   *  unchecked one would stage a file outside the workspace (the parent dir holds agent.json). */
  function relativeWorkspacePath(root: string, requested: string): string {
    const resolved = containedWorkspacePath(root, requested)
    return path.relative(root, resolved).split(path.sep).join('/')
  }

  /** Stage or unstage exactly the requested paths, then answer with the fresh status. Only paths the
   *  checkout CURRENTLY reports with a change in the relevant direction reach git, which is what makes
   *  both operations total: an unmatched pathspec would otherwise be a `git add` failure, and a no-op
   *  is data here. The fresh status is the whole answer either way. */
  async function writeIndex(kind: 'stage' | 'unstage', req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus> {
    const root = await rootFor(req.agentId, req.sessionId, req.repo)
    // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
    // re-resolving would let a channel that drops in between prove the sandbox checkout and then
    // mutate this daemon's own disk. Every runner below derives from this one.
    const base = runnerFor(workspaces, req.agentId, root)
    if (!(await isRepo(base))) return { agentId: req.agentId, isRepo: false, clean: true }
    const wanted = new Set(req.paths.map((requested) => relativeWorkspacePath(root, requested)))
    if (wanted.size > 0) {
      // `git add` runs the repository's own clean filter, so the audit gates a stage like a fetch.
      await assertSafeWorkspaceGitConfig(base)
      const git = base.withEnv(workspaceGitLocalEnv())
      const changed = (await git.status()).files.filter((file) => wanted.has(file.path))
      // '?' is untracked: there is something to stage and nothing to unstage.
      const targets = changed
        .filter((file) => (kind === 'stage' ? file.working_dir !== ' ' : file.index !== ' ' && file.index !== '?'))
        .map((file) => `:(literal)${file.path}`)
      for (let at = 0; at < targets.length; at += STAGE_PATHSPEC_CHUNK) {
        const chunk = targets.slice(at, at + STAGE_PATHSPEC_CHUNK)
        // No commit operand: `reset HEAD -- <path>` fails on an unborn HEAD, the bare form does not.
        await git.raw([...(kind === 'stage' ? ['add', '--'] : ['reset', '-q', '--']), ...chunk])
      }
    }
    return readStatus(req.agentId, req.sessionId, req.repo, { base, root })
  }

  /** Refusals are DATA, so every early return of a write goes through one of these two shapes. */
  function commitRefusal(
    agentId: string,
    isRepo: boolean,
    reason: WorkspaceGitWriteReason,
    detail: string
  ): WorkspaceGitCommitResult {
    return { agentId, isRepo, ok: false, reason, detail }
  }

  function pushRefusal(
    agentId: string,
    isRepo: boolean,
    reason: WorkspaceGitWriteReason,
    detail: string,
    ahead?: number
  ): WorkspaceGitPushResult {
    return { agentId, isRepo, ok: false, reason, detail, ...(ahead !== undefined ? { ahead } : {}) }
  }

  return {
    status(agentId, sessionId, repo) {
      return readStatus(agentId, sessionId, repo)
    },

    stage(req) {
      return writeIndex('stage', req)
    },

    unstage(req) {
      return writeIndex('unstage', req)
    },

    async diff(req) {
      const root = await rootFor(req.agentId, req.sessionId, req.repo)
      // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
      // re-resolving would let a channel that drops in between prove the sandbox checkout and then
      // mutate this daemon's own disk. Every runner below derives from this one.
      const base = runnerFor(workspaces, req.agentId, root)
      if (!(await isRepo(base))) return { agentId: req.agentId, path: req.path, isRepo: false, exists: false }
      // Through the runner, so a cluster-backed workspace answers by running git in its own sandbox rather than on a disk this daemon cannot see.
      const git = base.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })

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
        // `canonical` is null for EVERY path in a sandbox workspace, so git answers there instead —
        // the difference between "no changes" and "no such file".
        const exists = workspaces.sandboxMode ? await pathExists(git, rel) : canonical !== null
        return { agentId: req.agentId, path: req.path, isRepo: true, exists }
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
      const root = await rootFor(req.agentId, req.sessionId, req.repo)
      // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
      // re-resolving would let a channel that drops in between prove the sandbox checkout and then
      // mutate this daemon's own disk. Every runner below derives from this one.
      const base = runnerFor(workspaces, req.agentId, root)
      if (!(await isRepo(base))) return { agentId: req.agentId, isRepo: false, commits: [], truncated: false }
      // Through the runner, so a cluster-backed workspace answers by running git in its own sandbox rather than on a disk this daemon cannot see.
      const git = base.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })

      // What a reader of THIS checkout is asking about: a session worktree on its own
      // `dev/<user>/<words>` wants the commits it adds over the base branch, not the repository's
      // history — the base's newest commit is not this session's work. On the base branch itself
      // there is nothing to exclude, so the full history stands (the agent workspace page's view).
      const baseRef = await logBaseRef(git, (await workspaceTargetByAgent(req.agentId, req.repo))?.branch)
      const range = baseRef ? `${baseRef}..HEAD` : 'HEAD'

      // One extra row proves there are more commits than the caller asked for.
      let parsed
      try {
        const out = await git.readBounded(
          ['log', '-z', `--format=${LOG_FORMAT}`, `-n`, String(req.limit + 1), range],
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
        ...(tracking ? { tracking } : {}),
        ...(baseRef ? { base: baseRef } : {})
      }
    },

    async pull(agentId, repo) {
      const root = await rootFor(agentId, undefined, repo)
      // ff-only: an on-demand pull must never rewrite or clobber the agent's working tree — a
      // diverged branch / local edits surface as ok:false, not a forced reset. Bounded by a timeout
      // so an offline remote can't hang the REP, and the controller is built BEFORE the resolution
      // so the one runner this request uses already carries the signal.
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
      // re-resolving would let a channel that drops in between prove the sandbox checkout and then
      // mutate this daemon's own disk.
      const base = runnerFor(workspaces, agentId, root, abort.signal)
      if (!(await isRepo(base))) return { agentId, isRepo: false, ok: false, detail: 'workspace is not a git checkout' }

      try {
        const git = base.withEnv(workspaceGitLocalEnv())
        const authorized = await authorizedTarget(agentId, git, repo)
        if (!authorized) {
          return { agentId, isRepo: true, ok: false, detail: 'workspace origin is not a safe remote' }
        }
        await assertSafeWorkspaceGitConfig(base)
        const pullBranch = authorized.branch
        const pullTarget = workspaceGitRemoteTarget(
          authorized.origin,
          credentialAgentIdFor(agentId, repo),
          authorized.managed
        )
        timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
        const res = await pullWorkspaceRef(
          git.withEnv({
            ...workspaceGitLocalEnv(),
            ...pullTarget.env
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
    },

    async commit(req) {
      const { agentId } = req
      const root = await rootFor(agentId, req.sessionId, req.repo)
      // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
      // re-resolving would let a channel that drops in between prove the sandbox checkout and then
      // mutate this daemon's own disk. Every runner below derives from this one.
      const base = runnerFor(workspaces, agentId, root)
      if (!(await isRepo(base))) return commitRefusal(agentId, false, 'not-a-repo', 'workspace is not a git checkout')
      const message = req.message.trim()
      if (!message) return commitRefusal(agentId, true, 'empty-message', 'The commit message is empty.')
      const identity = commitIdentityByAgent(agentId)
      // With no identity in the env and no readable config file, git falls back to the HOST's passwd entry.
      if (!identity) {
        return commitRefusal(
          agentId,
          true,
          'no-identity',
          'This daemon has no registered Git commit identity, so a console commit could not be attributed. Commit from the agent instead.'
        )
      }
      const git = base.withEnv({ ...workspaceGitLocalEnv(), ...gitCommitIdentityEnv(identity) })
      try {
        // A commit runs the checkout's own hooks and filters unless the command-scope policy holds.
        await assertSafeWorkspaceGitConfig(base)
      } catch {
        return commitRefusal(
          agentId,
          true,
          'unsafe-config',
          'This checkout carries a disallowed local Git override, so the daemon will not commit in it.'
        )
      }
      const staged = await git.readBounded(['diff', '--cached', '--name-only', '-z'], METADATA_OUTPUT_BUDGET)
      const stagedPaths = staged.out.toString('utf8').split('\0').filter(Boolean)
      if (!staged.overflow && stagedPaths.length === 0) {
        return commitRefusal(agentId, true, 'nothing-staged', 'Nothing is staged, so there is nothing to commit.')
      }
      try {
        // --no-verify states what the env's /dev/null hooksPath enforces; --no-gpg-sign so a
        // checkout-set commit.gpgSign cannot block on a key this daemon has no access to;
        // --cleanup=whitespace, not strip: strip DELETES every line beginning with `#`, so a
        // generated `## Why` heading silently vanishes from the commit the reader approved, and a
        // hand-typed `#123 fix the parser` leaves git aborting on an empty message while the box
        // still shows the text. `whitespace` is git's own default for -m and equally independent
        // of whatever the repository configured, which is the property this flag is here for.
        await git.raw(['commit', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '-m', message])
        const sha = (await git.raw(['rev-parse', 'HEAD'])).trim()
        const count = stagedPaths.length
        return {
          agentId,
          isRepo: true,
          ok: true,
          sha,
          detail: `Committed ${sha.slice(0, 7)} — ${count} file${count === 1 ? '' : 's'}.`
        }
      } catch (err) {
        return commitRefusal(agentId, true, 'failed', brief(scrub(root, (err as Error)?.message ?? 'commit failed')))
      }
    },

    async push(req) {
      const { agentId } = req
      const root = await rootFor(agentId, req.sessionId, req.repo)
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      // Resolved ONCE per request, with the signal already attached, and `runnerFor` refuses rather
      // than falling back in sandbox mode: re-resolving would let a channel that drops in between
      // prove the sandbox checkout and then mutate this daemon's own disk.
      const base = runnerFor(workspaces, agentId, root, abort.signal)
      if (!(await isRepo(base))) return pushRefusal(agentId, false, 'not-a-repo', 'workspace is not a git checkout')
      try {
        const git = base.withEnv(workspaceGitLocalEnv())
        const branch = await currentBranch(git)
        // A session worktree now checks out its own `dev/<user>/<words>` branch, so this
        // answers only a worktree created before that, or one the agent detached itself.
        if (!branch) {
          return pushRefusal(
            agentId,
            true,
            'detached-head',
            'This checkout has no branch checked out (detached HEAD), so there is no branch to push.'
          )
        }
        const upstream = await upstreamRef(git)
        if (!upstream) {
          return pushRefusal(
            agentId,
            true,
            'no-upstream',
            `Branch "${branch}" tracks no upstream, so the daemon has no ref to push it to.`
          )
        }
        // The authorized origin is resolved BEFORE `ahead` is trusted. `branch.<b>.remote` and
        // `branch.<b>.merge` are checkout-owned and are not in the disallowed-override list, so an
        // upstream can legitimately point at a remote that is NOT the one this daemon is allowed to
        // push to. Counting against that ref and finding nothing ahead used to answer
        // "Everything is already pushed" having sent nothing at all — a success report for a push
        // that never happened, which is the worst failure this button has available.
        const authorized = await authorizedTarget(agentId, git, req.repo)
        if (!authorized) {
          return pushRefusal(agentId, true, 'unsafe-origin', 'workspace origin is not a safe remote')
        }
        try {
          await assertSafeWorkspaceGitConfig(base)
        } catch {
          return pushRefusal(
            agentId,
            true,
            'unsafe-config',
            'This checkout carries a disallowed local Git override, so the daemon will not push from it.'
          )
        }
        // Whether the upstream this branch tracks IS the authorized origin. Only then does an
        // `ahead` of zero mean "the remote we are allowed to push to already has these commits".
        // The `ahead: 0` shortcut is only sound when the tracked ref IS the ref this push updates.
        // Validating the remote URL alone was not enough: local `feature` tracking `origin/main` is
        // on the authorized remote, so `ahead(origin/main)` could read zero while `origin/feature`
        // does not exist at all — and the button reported success for a branch it never sent.
        // Both halves must match, the remote AND the branch, or the shortcut is skipped and git
        // itself answers (a push with nothing to send is cheap and honest).
        const upstreamRemote = upstream.includes('/') ? upstream.slice(0, upstream.indexOf('/')) : null
        const upstreamBranch = upstreamRemote ? upstream.slice(upstreamRemote.length + 1) : null
        const upstreamOrigin = upstreamRemote ? await remoteUrl(git, upstreamRemote) : null
        const upstreamIsDestination =
          upstreamOrigin !== null &&
          upstreamOrigin.toLowerCase() === authorized.origin.toLowerCase() &&
          upstreamBranch === branch
        if (upstreamOrigin === null || upstreamOrigin.toLowerCase() !== authorized.origin.toLowerCase()) {
          return pushRefusal(
            agentId,
            true,
            'no-upstream',
            `Branch "${branch}" tracks "${upstream}", which is not the remote this workspace is authorized to push to.`
          )
        }
        const ahead = upstreamIsDestination ? await aheadCount(git, upstream) : null
        if (ahead === 0) {
          return { agentId, isRepo: true, ok: true, ahead: 0, detail: 'Everything is already pushed.' }
        }
        // check-ref-format so a checkout-chosen branch cannot read as an option or a second refspec.
        await git.raw(['check-ref-format', '--branch', branch])
        const pushTarget = workspaceGitRemoteTarget(
          authorized.origin,
          credentialAgentIdFor(agentId, req.repo),
          authorized.managed
        )
        timer = setTimeout(() => abort.abort(), PUSH_TIMEOUT_MS)
        // NEVER --force / --force-with-lease: a console push must not drop a commit the remote has
        // and this checkout does not — divergence is data that says "pull first". Both refspec sides
        // explicit so no checkout-owned push.default decides what travels.
        await base
          .withEnv(pushTarget.env)
          .raw(['push', '--porcelain', pushTarget.remote, `refs/heads/${branch}:refs/heads/${branch}`])
        // The push went to the unguessable daemon-owned remote, so nothing moved `origin/<branch>` —
        // without this the console keeps showing the commits it just pushed as unpushed.
        await git.raw(['update-ref', `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]).catch(() => undefined)
        return {
          agentId,
          isRepo: true,
          ok: true,
          ahead: 0,
          detail: ahead === null ? `Pushed ${branch}.` : `Pushed ${ahead} commit${ahead === 1 ? '' : 's'} to ${branch}.`
        }
      } catch (err) {
        const failure = classifyPushFailure(scrub(root, (err as Error)?.message ?? 'push failed'))
        return pushRefusal(agentId, true, failure.reason, failure.detail)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },

    async message(req) {
      const { agentId } = req
      const root = await rootFor(agentId, req.sessionId, req.repo)
      // Resolved ONCE per request, and `runnerFor` refuses rather than falling back in sandbox mode:
      // re-resolving would let a channel that drops in between prove the sandbox checkout and then
      // mutate this daemon's own disk. Every runner below derives from this one.
      const base = runnerFor(workspaces, agentId, root)
      if (!(await isRepo(base))) {
        return { agentId, ok: false, detail: 'This workspace is not a git checkout, so there is no staged diff.' }
      }
      if (!commitMessagePass) {
        return { agentId, ok: false, detail: 'This daemon cannot draft commit messages.' }
      }
      const git = base.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
      // The name list first: it is cheap, it is COMPLETE where the diff below may not be, and it is
      // what keeps the subject accurate when the cap cuts the diff. --no-ext-diff/--no-textconv for
      // the same reason the console's diff read uses them: a checkout's diff driver is a program.
      const named = await git.readBounded(
        ['diff', '--cached', '--no-ext-diff', '--name-status', '-z', '-M'],
        METADATA_OUTPUT_BUDGET
      )
      const staged = parseNameStatusZ(named.out.toString('utf8'))
      if (staged.length === 0) {
        return { agentId, ok: false, detail: 'Nothing is staged, so there is nothing to describe.' }
      }
      const files: CommitMessageFile[] = staged.slice(0, COMMIT_MESSAGE_MAX_FILES).map((entry) => ({
        status: entry.status,
        path: entry.from ? `${entry.from} -> ${entry.path}` : entry.path
      }))
      const text = await git.readBounded(
        ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '-M'],
        COMMIT_MESSAGE_DIFF_BUDGET
      )
      // Cut on a UTF-8 boundary: half a multi-byte character in the prompt is garbage to the model.
      const diff = fitToBudget(text.out, utf8Boundary(text.out, text.out.length))
      const prompt = buildCommitMessagePrompt({
        files,
        diff: diff.content,
        truncated: text.overflow || diff.end < text.out.length,
        ...(staged.length > files.length ? { omittedFiles: staged.length - files.length } : {})
      })
      // A reader is watching a spinner, so the pass is bounded here and not by the runtime's goodwill.
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), COMMIT_MESSAGE_TIMEOUT_MS)
      try {
        const answer = await commitMessagePass(agentId, COMMIT_MESSAGE_SYSTEM_PROMPT, prompt, abort.signal)
        const draft = sanitizeCommitMessage(answer.output)
        if (draft.ok) return { agentId, ok: true, message: draft.message }
        return { agentId, ok: false, detail: stopReasonDetail(answer) ?? draft.detail }
      } catch {
        if (abort.signal.aborted) {
          return {
            agentId,
            ok: false,
            detail: `The runtime did not answer within ${Math.round(COMMIT_MESSAGE_TIMEOUT_MS / 1000)}s. Try again, or write the message yourself.`
          }
        }
        // Deliberately NOT the error text: a host-start failure carries adapter argv and host paths
        // that `scrub` (which only knows the workspace root) would not remove.
        return { agentId, ok: false, detail: 'This agent runtime could not draft a commit message.' }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** Name the runtime's own terminal reason when it produced NO usable text, so the reader is told
 *  "declined" or "cut off" instead of the sanitiser's generic "returned no message". A non-empty but
 *  unusable answer keeps the sanitiser's reason: what came back is the more specific fact. */
function stopReasonDetail(answer: { output: string; stopReason: string }): string | undefined {
  if (answer.output.trim() !== '') return undefined
  switch (answer.stopReason) {
    case 'refusal':
      return 'The runtime declined to draft a commit message for this diff.'
    case 'cancelled':
      return 'Message generation was canceled before the runtime answered.'
    case 'max_tokens':
    case 'max_turn_requests':
      return 'The runtime ran out of budget before writing a commit message.'
    default:
      return undefined
  }
}

/** The checked-out branch, or null when HEAD is detached. */
async function currentBranch(git: GitRunner): Promise<string | null> {
  try {
    const out = await git.readBounded(['rev-parse', '--abbrev-ref', 'HEAD'], 4096)
    const branch = out.out.toString('utf8').trim()
    return branch === '' || branch === 'HEAD' ? null : branch
  } catch {
    return null
  }
}

/** The ref a log listing excludes so it shows what THIS checkout adds, or null for the whole history.
 *
 * The configured branch's remote-tracking ref, because that is what a session worktree is created
 * from (`refs/remotes/origin/<branch>`) and what its work will be reviewed against. Null in the three
 * cases where excluding anything would be wrong or a guess: no configured branch, HEAD is already
 * that branch (nothing to compare — the primary checkout's own history is the answer), or the ref is
 * absent from this checkout (never fetched), where `<missing>..HEAD` would fail the read outright. */
async function logBaseRef(git: GitRunner, configuredBranch: string | undefined): Promise<string | null> {
  if (!configuredBranch) return null
  const head = await currentBranch(git)
  if (head === configuredBranch) return null
  const ref = `origin/${configuredBranch}`
  try {
    await git.readBounded(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], 4096)
    return ref
  } catch {
    return null
  }
}

/** Commits on HEAD the upstream ref lacks. Null when uncomputable (an upstream configured but never
 *  fetched), which pushes anyway rather than refusing on the strength of a failed read. */
async function aheadCount(git: GitRunner, upstream: string): Promise<number | null> {
  try {
    const out = await git.readBounded(['rev-list', '--count', `${upstream}..HEAD`], 4096)
    const count = Number(out.out.toString('utf8').trim())
    return Number.isInteger(count) ? count : null
  } catch {
    return null
  }
}

/** First line of git's complaint, bounded: a REP carries a sentence, not a wall of hints. Already
 *  scrubbed of the workspace path by the caller. */
function brief(text: string): string {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return (line ?? 'git reported no detail').slice(0, 400)
}

/** Map a failed `git push` onto DATA the console can act on. Three shapes, three next actions: the
 *  remote is ahead (pull first), the remote refused the ref (nothing the console can do), the
 *  credentials were refused (an access tier or installation problem). Else git's scrubbed sentence. */
function classifyPushFailure(text: string): { reason: WorkspaceGitWriteReason; detail: string } {
  if (/non-fast-forward|fetch first|Updates were rejected/i.test(text)) {
    return { reason: 'diverged', detail: 'Rejected — the remote has commits this branch does not. Pull, then push.' }
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|403 |denied to /i.test(text)) {
    return {
      reason: 'rejected',
      detail: 'The remote refused these credentials — this agent may not have write access.'
    }
  }
  if (/remote rejected|pre-receive hook declined|protected branch|\[rejected\]/i.test(text)) {
    return { reason: 'rejected', detail: `The remote refused the push: ${brief(text)}` }
  }
  return { reason: 'failed', detail: brief(text) }
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

/** Whether the checkout HAS this path, asked of git rather than of a filesystem — the answer the
 *  local seam reads with `realpath`, for a workspace this daemon cannot see. `--cached` covers a
 *  tracked path (including one deleted from the worktree, whose change is still real) and `--others`
 *  an untracked one; an ignored file is the single case this reports as absent. An empty `rel` IS
 *  the workspace root, which exists whenever the checkout does. */
async function pathExists(git: GitRunner, rel: string): Promise<boolean> {
  if (rel === '') return true
  try {
    const out = await git.readBounded(
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `:(literal)${rel}`],
      METADATA_OUTPUT_BUDGET
    )
    return out.out.length > 0
  } catch {
    return false
  }
}

/** One remote's fetch URL, authorized through the same policy the origin goes through, or null
 *  when it does not exist or is not a URL this daemon may talk to. */
async function remoteUrl(git: GitRunner, remote: string): Promise<string | null> {
  try {
    const raw = (await git.readBounded(['remote', 'get-url', remote], 4096)).out.toString('utf8').trim()
    if (raw === '') return null
    return authorizeWorkspaceGitUrl(raw)
  } catch {
    return null
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
 *  rewrites it on every fetch/pull). Null if it has never fetched — and null for a
 *  sandbox workspace, whose mtime no git subcommand reports and whose path names a
 *  filesystem this process cannot see. Restoring it needs a shim stat, not an argv. */
async function fetchHeadMtime(workspaces: WorkspaceManager, root: string): Promise<string | null> {
  if (workspaces.sandboxMode) return null
  try {
    const st = await fs.stat(join(root, '.git', 'FETCH_HEAD'))
    return st.mtime.toISOString()
  } catch {
    return null
  }
}

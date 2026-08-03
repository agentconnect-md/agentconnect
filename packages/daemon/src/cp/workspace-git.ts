/**
 * `WorkspaceGit` — the seam answering the CP's `workspace/gitstatus` and
 * `workspace/gitpull` REQs against an agent's local git-repo workspace. Sibling
 * to {@link WorkspaceReader}: git runs daemon-local and only the outcome is
 * proxied to the console (§1/§12), never the repo.
 *
 * DATA vs error: a from-scratch workspace (`isRepo:false`), a dirty tree, or a
 * pull that can't fast-forward (offline, diverged, would clobber local edits) are
 * all normal REPs — the caller renders them. Only an unknown agentId throws
 * ({@link WorkspaceViolationError} → `BAD_PAYLOAD`); an unexpected git/fs failure
 * on `status` propagates (→ `INTERNAL`). Git-provided text is scrubbed of the
 * absolute workspace path before it leaves the daemon (raw git errors embed host
 * paths that must not reach the CP/UI).
 */
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SimpleGit } from 'simple-git'
import {
  normalizeGithubRepoUrl,
  type WorkspaceGitStatus,
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
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { WorkspaceViolationError } from './workspace-reader.js'

/** On-demand pull is interactive, so allow more headroom than the 4.5s
 *  best-effort pull at session start (workspace-manager.ts). */
const PULL_TIMEOUT_MS = 20_000

/** Cap the changed-file list so a huge working tree can't overflow the frame. */
const MAX_STATUS_FILES = 500

export interface WorkspaceGit {
  status(agentId: string): Promise<WorkspaceGitStatus>
  pull(agentId: string): Promise<WorkspaceGitPullResult>
}

export interface WorkspaceGitTarget {
  repo: string
  branch: string
  githubApp: boolean
}

export function createWorkspaceGit(
  workspaceRootByAgent: (agentId: string) => string | undefined,
  credentialEnvByAgent: (agentId: string) => Record<string, string> = () => ({}),
  workspaceTargetByAgent: (agentId: string) => WorkspaceGitTarget | undefined = () => undefined
): WorkspaceGit {
  function rootFor(agentId: string): string {
    const root = workspaceRootByAgent(agentId)
    if (!root) throw new WorkspaceViolationError(`unknown agent "${agentId}"`)
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
    async status(agentId) {
      const root = rootFor(agentId)
      if (!isRepo(root)) return { agentId, isRepo: false, clean: true }

      // Status is read-only and the daemon policy already disables hooks and
      // fsmonitor at command scope. Repository hook/include configuration must
      // not make an otherwise usable workspace disappear from the console.
      const git = gitFor(root).env({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
      const s = await git.status()
      const files: WorkspaceGitFile[] = s.files
        .slice(0, MAX_STATUS_FILES)
        .map((f) => ({ path: f.path, index: f.index, workingDir: f.working_dir }))
      const [lastCommit, lastFetchAt] = await Promise.all([headCommit(git), fetchHeadMtime(root)])
      return {
        agentId,
        isRepo: true,
        clean: s.isClean(),
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

    async pull(agentId) {
      const root = rootFor(agentId)
      if (!isRepo(root)) return { agentId, isRepo: false, ok: false, detail: 'workspace is not a git checkout' }

      // ff-only: an on-demand pull must never rewrite or clobber the agent's
      // working tree — a diverged branch / local edits surface as ok:false, not a
      // forced reset. Bounded by a timeout so an offline remote can't hang the REP.
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      try {
        const git = gitFor(root, abort.signal).env(workspaceGitLocalEnv())
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
        await assertSafeWorkspaceGitConfig(root)
        const pullBranch = target.branch
        const pullTarget = workspaceGitPullTarget(expectedOrigin)
        timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
        const res = await pullWorkspaceRef(
          git.env({
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
          insertions: res.summary.insertions,
          deletions: res.summary.deletions,
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

/** The HEAD commit (sha / short sha / subject / committer date), or null for an
 *  empty repo with no commits yet. `%cI` is git's strict-ISO committer date. */
async function headCommit(git: SimpleGit): Promise<WorkspaceGitCommit | null> {
  try {
    const log = await git.log({ maxCount: 1, format: { hash: '%H', date: '%cI', subject: '%s' } })
    const c = log.latest
    if (!c?.hash) return null
    return { sha: c.hash, shortSha: c.hash.slice(0, 7), subject: c.subject ?? '', committedAt: c.date }
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

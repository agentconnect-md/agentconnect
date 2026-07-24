import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { normalizeGitUrl, normalizeRepoSubdir } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import {
  cloneGitEnv,
  gitCredentialEnv,
  gitEnvBase,
  gitFor,
  preWarmGitCred,
  writeRepoHelperConfig
} from './git-injection.js'

const PULL_TIMEOUT_MS = 4500
const MATERIALIZATION_FILE = 'workspace-materialization.json'

// Single-flight clone lock keyed by the absolute cwd. Two concurrent sessions
// (especially multiple agents sharing one repo checkout) must not race into the
// same dir — the second awaits the first's in-flight clone instead of re-cloning.
const cloneInFlight = new Map<string, Promise<void>>()

function usesGithubApp(agent: Agent): boolean {
  return agent.workspace.mode === 'git-repo' && agent.workspace.gitCredential === 'github-app'
}

async function convergeGithubAppOrigin(agent: Agent, cwd = agent.workspace.path): Promise<void> {
  if (!usesGithubApp(agent)) return
  const clone = cloneInFlight.get(cwd)
  if (clone) await clone
  if (!existsSync(join(cwd, '.git'))) return
  const expected = normalizeGitUrl(agent.workspace.gitRepo ?? '')
  if (!expected) return
  const git = gitFor(cwd)
  const current = (await git.raw(['remote', 'get-url', 'origin'])).trim()
  if (normalizeGitUrl(current).toLowerCase() !== expected.toLowerCase()) {
    await git.raw(['remote', 'set-url', 'origin', expected])
  }
}

function materializationKey(agent: Agent): string {
  if (agent.workspace.mode === 'from-scratch') return JSON.stringify({ mode: 'scratch' })
  return JSON.stringify({
    mode: 'github',
    repo: normalizeGitUrl(agent.workspace.gitRepo ?? '').toLowerCase(),
    branch: agent.workspace.gitBranch
  })
}

function materializationFile(agent: Agent): string {
  const cwd = agent.workspace.path
  return join(dirname(cwd), `.${basename(cwd)}.${MATERIALIZATION_FILE}`)
}

function readMaterialization(agent: Agent): string | undefined {
  try {
    const value = JSON.parse(readFileSync(materializationFile(agent), 'utf8')) as { key?: unknown }
    return typeof value.key === 'string' ? value.key : undefined
  } catch {
    return undefined
  }
}

/** Snapshot the currently-live workspace definition before a cold detach. */
export function recordWorkspaceMaterialization(agent: Agent): void {
  const file = materializationFile(agent)
  const temp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, key: materializationKey(agent) }, null, 2) + '\n')
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** Converge the durable identity and remote of an App-backed checkout after a
 * canonical GitHub rename. Record the new materialization first: a failed
 * best-effort origin update may safely retry later, while a stale marker could
 * make a subsequent preservation-only edit replace local files. */
export async function convergeGithubAppWorkspaceRename(agent: Agent): Promise<void> {
  if (!usesGithubApp(agent)) return
  recordWorkspaceMaterialization(agent)
  await convergeGithubAppOrigin(agent)
}

/** Seed the marker for a pre-v2 workspace without overwriting an earlier
 * materialization. The on-disk spec may already be the target after a crash,
 * while the checkout still belongs to the recorded source. */
export function ensureWorkspaceMaterialization(agent: Agent): void {
  if (!existsSync(materializationFile(agent))) recordWorkspaceMaterialization(agent)
}

function restoreWorkspaceMaterialization(agent: Agent, key: string | undefined): void {
  if (key === undefined) {
    rmSync(materializationFile(agent), { force: true })
    return
  }
  const file = materializationFile(agent)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, key }, null, 2) + '\n')
}

export async function prepareWorkspace(agent: Agent): Promise<string> {
  const cwd = agent.workspace.path
  // Fail unsafe lexical config before any clone/pull or filesystem mutation.
  const agentDir = agent.workspace.mode === 'git-repo' ? normalizeRepoSubdir(agent.workspace.agentDir) : undefined
  mkdirSync(cwd, { recursive: true })

  if (agent.workspace.mode === 'from-scratch') {
    // The agent's memory file lives at the agent ROOT (outside the workspace) and
    // is seeded separately (see agents/memory.ts `ensureMemory`), so from-scratch
    // just needs the (empty) workspace dir to exist.
    return cwd
  }

  // git-repo, first session: no checkout yet → clone. Unlike pull, a clone has no
  // on-disk fallback, so on failure we THROW (the session creation fails + the error
  // surfaces) rather than silently proceeding with an empty dir (design §4.3).
  if (!existsSync(join(cwd, '.git'))) {
    await cloneRepo(agent)
    return resolveAcpCwd(cwd, agentDir)
  }

  // git-repo, existing checkout: the repo-local helper pin may carry a previous
  // agent generation's id (agent deleted + recreated under the same name adopts
  // the surviving checkout) — re-pin so agent-run git presents a live identity
  // even where the env channel doesn't reach. Best-effort: a locked .git/config
  // must not block the session; the session-env channel still covers this run.
  if (usesGithubApp(agent)) {
    // The CP follows repository renames by numeric repo id. Repoint the existing
    // checkout instead of treating that canonical URL refresh as a new workspace.
    await convergeGithubAppOrigin(agent, cwd).catch(() => undefined)
    await writeRepoHelperConfig(cwd, agent.id).catch(() => undefined)
  }

  // Best-effort ff-only pull; never block/throw on offline (design §4.3) —
  // proceed with the on-disk checkout.
  if (agent.workspace.pullOnNewSession) {
    // github-app: warm the credential cache OUTSIDE the pull budget — a cold
    // cache means a CP round trip that would otherwise eat the whole 4.5s.
    if (usesGithubApp(agent)) await preWarmGitCred(agent.id, 'pull').catch(() => undefined)
    // Abort-driven budget: the signal makes simple-git KILL the git child at
    // the deadline. A bare Promise.race would abandon it still running — a
    // wedged pull (network black hole) then holds .git/index.lock into the
    // next session's pull.
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
    try {
      await gitFor(cwd, abort.signal)
        .env({
          ...gitEnvBase(),
          ...(usesGithubApp(agent) ? gitCredentialEnv(agent.id) : {}),
          GIT_TERMINAL_PROMPT: '0'
        })
        .pull(['--ff-only'])
    } catch {
      // offline / timed out / non-fast-forward: proceed with the on-disk checkout
    } finally {
      clearTimeout(timer)
    }
  }
  return resolveAcpCwd(cwd, agentDir)
}

/** Resolve the checked path ACP receives, closing symlink and prefix-containment gaps. */
function resolveAcpCwd(workspaceRoot: string, agentDir: string | undefined): string {
  const canonicalRoot = realpathSync(workspaceRoot)
  if (agentDir === undefined) return canonicalRoot

  let canonicalCandidate: string
  try {
    canonicalCandidate = realpathSync(join(workspaceRoot, ...agentDir.split('/')))
  } catch {
    throw new Error(`workspace working subdirectory "${agentDir}" does not exist`)
  }
  if (!statSync(canonicalCandidate).isDirectory()) {
    throw new Error(`workspace working subdirectory "${agentDir}" is not a directory`)
  }

  const rel = relative(canonicalRoot, canonicalCandidate)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`workspace working subdirectory "${agentDir}" resolves outside the repository`)
  }
  return canonicalCandidate
}

/** True only when the daemon-owned working directory has no entries. Missing
 *  directories count as empty. Callers that need a race-free answer must first
 *  gate/drain the agent (workspace conversion does this through agent/detach). */
export function isWorkspaceEmpty(agent: Agent): boolean {
  const cwd = agent.workspace.path
  return !existsSync(cwd) || readdirSync(cwd).length === 0
}

const STAGED_CLONE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Best-effort startup GC for hard-crash leftovers from workspace conversion.
 *  Match only the exact daemon-owned `<workspace>.clone-<uuid>` siblings so a
 *  similarly named operator directory is never treated as disposable. */
export function cleanupStaleWorkspaceClones(agent: Agent): number {
  const cwd = agent.workspace.path
  const parent = dirname(cwd)
  if (!existsSync(parent)) return 0

  const prefix = `${basename(cwd)}.clone-`
  let removed = 0
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    if (!STAGED_CLONE_ID.test(entry.name.slice(prefix.length))) continue
    rmSync(join(parent, entry.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

/**
 * Materialize a staged cold workspace edit.
 *
 * A daemon-owned marker records the last committed mode/repo/branch. Matching
 * materializations preserve current files (access and agentDir edits); changed
 * materializations clone first when needed, then replace the workspace.
 * Rollback restores a correct empty base for the old definition to re-clone,
 * but deliberately cannot restore files discarded by an acknowledged replace.
 */
export async function prepareWorkspaceForActivation(
  agent: Agent,
  {
    allowExistingCheckout = true,
    reconcileMaterialization = false
  }: { allowExistingCheckout?: boolean; reconcileMaterialization?: boolean } = {}
): Promise<() => void> {
  const cwd = agent.workspace.path
  mkdirSync(cwd, { recursive: true })
  const previousMaterialization = reconcileMaterialization ? readMaterialization(agent) : undefined
  const targetMaterialization = materializationKey(agent)
  const replace = reconcileMaterialization && previousMaterialization !== targetMaterialization
  const restoreMarker = () => {
    if (reconcileMaterialization) restoreWorkspaceMaterialization(agent, previousMaterialization)
  }

  if (agent.workspace.mode === 'from-scratch') {
    if (replace) {
      rmSync(cwd, { recursive: true, force: true })
      mkdirSync(cwd, { recursive: true })
    }
    if (reconcileMaterialization) recordWorkspaceMaterialization(agent)
    return () => {
      if (replace) {
        rmSync(cwd, { recursive: true, force: true })
        mkdirSync(cwd, { recursive: true })
      }
      restoreMarker()
    }
  }
  if (existsSync(join(cwd, '.git'))) {
    if (!replace) {
      if (!allowExistingCheckout) {
        throw new Error('workspace changed after its empty check; retry after making it empty')
      }
      resolveAcpCwd(cwd, normalizeRepoSubdir(agent.workspace.agentDir))
      if (reconcileMaterialization) recordWorkspaceMaterialization(agent)
      return restoreMarker
    }
    // A different repo/branch is cloned below before the old checkout is
    // removed, so network/auth failures leave the current workspace intact.
  }
  if (!replace && !isWorkspaceEmpty(agent)) {
    throw new Error('workspace is not empty; remove or move its files before converting')
  }

  const staged = `${cwd}.clone-${randomUUID()}`
  mkdirSync(staged, { recursive: true })
  try {
    await cloneRepoAt(agent, staged)
    resolveAcpCwd(staged, normalizeRepoSubdir(agent.workspace.agentDir))
    if (replace) {
      rmSync(cwd, { recursive: true, force: true })
      renameSync(staged, cwd)
      try {
        recordWorkspaceMaterialization(agent)
      } catch (err) {
        rmSync(cwd, { recursive: true, force: true })
        mkdirSync(cwd, { recursive: true })
        restoreMarker()
        throw err
      }
      return () => {
        rmSync(cwd, { recursive: true, force: true })
        mkdirSync(cwd, { recursive: true })
        restoreMarker()
      }
    }
    // The agent is gated, but an operator can still write directly on disk.
    // Re-check at the swap boundary and fail without touching either tree.
    if (!isWorkspaceEmpty(agent)) {
      throw new Error('workspace changed while conversion was cloning; retry after making it empty')
    }
    try {
      // POSIX directory replacement is atomic when the destination is still
      // empty. If an operator writes into cwd after the check above, rename
      // fails with the original tree untouched instead of deleting that data.
      renameSync(staged, cwd)
    } catch (err) {
      if (!isWorkspaceEmpty(agent)) {
        throw new Error('workspace changed while conversion was cloning; retry after making it empty', {
          cause: err
        })
      }
      throw err
    }
  } catch (err) {
    rmSync(staged, { recursive: true, force: true })
    throw err
  }

  if (reconcileMaterialization) recordWorkspaceMaterialization(agent)

  return () => {
    rmSync(cwd, { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
    restoreMarker()
  }
}

/**
 * Eagerly clone a git-repo workspace that has no checkout yet — for reconcile-time
 * prefetch so the repo is warm before the first message arrives. No-op for
 * from-scratch or an already-cloned checkout (the session-time `prepareWorkspace`
 * stays authoritative and still owns pull + hard-fail). Reuses the single-flight
 * lock so a prefetch and a concurrent session-start clone never race into the same
 * dir. The caller invokes this fire-and-forget and logs any rejection — clone
 * failure here is non-fatal because `prepareWorkspace` re-clones (and hard-fails)
 * on the first session as the backstop.
 */
export async function prefetchWorkspace(agent: Agent): Promise<void> {
  if (agent.workspace.mode !== 'git-repo') return
  const cwd = agent.workspace.path
  if (existsSync(join(cwd, '.git'))) return
  mkdirSync(cwd, { recursive: true })
  await cloneRepo(agent)
}

/** Clone agent.workspace.gitRepo @ gitBranch into cwd, single-flight per cwd. */
async function cloneRepo(agent: Agent): Promise<void> {
  return cloneRepoAt(agent, agent.workspace.path)
}

async function cloneRepoAt(agent: Agent, cwd: string): Promise<void> {
  const inflight = cloneInFlight.get(cwd)
  if (inflight) return inflight

  // Stored value should already be a full address, but normalize defensively —
  // a hand-edited or pre-normalization agent.json may still say "org/repo",
  // which git would treat as a local path ("repository ... does not exist").
  const gitRepo = agent.workspace.gitRepo && normalizeGitUrl(agent.workspace.gitRepo)
  if (!gitRepo) throw new Error(`workspace clone: agent "${agent.id}" has git-repo mode but no gitRepo configured`)
  const branch = agent.workspace.gitBranch
  const githubApp = usesGithubApp(agent)

  const p = (async () => {
    // github-app: credentials ride the env-injected helper (no repo config exists
    // yet). SPREAD over process.env — simple-git's .env() REPLACES the child env.
    if (githubApp) await preWarmGitCred(agent.id, 'clone')
    const git = githubApp
      ? gitFor().env({ ...gitEnvBase(), ...cloneGitEnv(agent.id) })
      : gitFor().env({ ...gitEnvBase(), GIT_TERMINAL_PROMPT: '0' })
    try {
      await git.clone(gitRepo, cwd, ['--branch', branch, '--single-branch'])
    } catch (e) {
      // A failed clone leaves a half-written dir whose stray `.git` would make
      // every later attempt think the checkout exists — clean before rethrowing.
      rmSync(join(cwd, '.git'), { recursive: true, force: true })
      throw e
    }
    // Pin the repo-local helper so AGENT-run git in this checkout authenticates
    // through the daemon too — the "no credentials on the machine, but the agent
    // can still push" half of the design.
    if (githubApp) await writeRepoHelperConfig(cwd, agent.id)
  })().finally(() => {
    cloneInFlight.delete(cwd)
  })
  cloneInFlight.set(cwd, p)
  return p
}

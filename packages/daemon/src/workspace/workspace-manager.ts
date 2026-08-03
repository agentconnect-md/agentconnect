import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
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
import {
  normalizeGitCloneUrl,
  normalizeGithubRepoUrl,
  normalizeGitUrl,
  normalizeRepoSubdir,
  redactGitUrlSecrets
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { makeLogger } from '../log.js'
import { installSkills, type LocalSkillSource } from '../skills/install-skills.js'
import { acceptedDreamSkillSources } from '../skills/dream-skills.js'
import {
  assertSafeWorkspaceGitConfig,
  cloneGitEnv,
  gitCredentialEnv,
  gitFor,
  preWarmGitCred,
  pullWorkspaceRef,
  workspaceGitEnvBase,
  workspaceGitLocalEnv,
  workspaceGitPullTarget,
  writeRepoHelperConfig
} from './git-injection.js'
import { authorizeWorkspaceGitUrl } from './git-origin-policy.js'

const skillsLog = makeLogger('info')

/**
 * Post-clone skills step (docs/designs/shared-skills.md §6). Installs the agent's
 * enabled Git/managed/accepted-local skills into its resolved ACP cwd through
 * one exact pinned CLI + trusted receipt/reconcile wrapper, then returns that cwd.
 */
export interface PrepareWorkspaceOptions {
  /** Resolve centrally accepted immutable bundles from the daemon cache. Dream
   * skills and these sources are then reconciled in one ownership transaction. */
  managedSkills?: (agent: Agent) => Promise<LocalSkillSource[]>
  /** Trusted daemon-owned state root shared across agents/workspaces. */
  skillsStateDir?: string
  /** Audited `skills` CLI identity for the selected runtime. */
  skillsAgentId?: string | null
}

export interface GithubReviewWorkspaceRevision {
  pullNumber: number
  baseSha: string
  headSha: string
  mergeCommitSha?: string
}

export interface PrepareSessionWorkspaceRequest {
  sessionKey: string
  isolation: 'shared' | 'session'
  review?: GithubReviewWorkspaceRevision
}

async function withSkills(agent: Agent, acpCwd: string, opts: PrepareWorkspaceOptions): Promise<string> {
  // Resolving local sources (managed cache + accepted Dream) is best-effort: a
  // failure to read/validate them means we install none of THOSE sources, not
  // that the workspace fails to come up (git + messaging still have to work).
  let managedSkills: LocalSkillSource[] = []
  let acceptedSkills: LocalSkillSource[] = []
  const agentRoot = (agent as { dir?: string }).dir
  try {
    managedSkills = (await opts.managedSkills?.(agent)) ?? []
    acceptedSkills = agentRoot ? await acceptedDreamSkillSources({ dir: agentRoot }) : []
  } catch (err) {
    skillsLog.warn(`skills: local source resolution failed for "${agent.id}": ${(err as Error).message}`)
  }
  // installSkills fails closed: it degrades acquisition/CLI failures into
  // result.errors but THROWS a safety error when stale executable content cannot
  // be removed or the ledger cannot be proven coherent. Those must block host
  // startup rather than launch ACP with stale/incoherent executable skills, so
  // let them propagate (design: docs/designs/shared-skills.md §2).
  await installSkills(agent, acpCwd, {
    ...(opts.skillsStateDir ? { stateDir: opts.skillsStateDir } : {}),
    ...(opts.skillsAgentId === undefined ? {} : { skillsAgentId: opts.skillsAgentId }),
    localSkills: [...managedSkills, ...acceptedSkills],
    useGitCredential: usesGithubApp(agent),
    warn: (msg) => skillsLog.warn(msg)
  })
  return acpCwd
}

const PULL_TIMEOUT_MS = 4500
const REVIEW_FETCH_TIMEOUT_MS = 15_000
const MATERIALIZATION_FILE = 'workspace-materialization.json'
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i

// Single-flight clone lock keyed by the absolute cwd. Two concurrent sessions
// (especially multiple agents sharing one repo checkout) must not race into the
// same dir — the second awaits the first's in-flight clone instead of re-cloning.
const cloneInFlight = new Map<string, Promise<void>>()

function usesGithubApp(agent: Agent): boolean {
  return agent.workspace.mode === 'git-repo' && agent.workspace.gitCredential === 'github-app'
}

function gitRepoOf(agent: Agent): string {
  if (agent.workspace.mode !== 'git-repo' || !agent.workspace.gitRepo) {
    throw new Error(`workspace clone: agent "${agent.id}" has git-repo mode but no gitRepo configured`)
  }
  return authorizeWorkspaceGitUrl(
    usesGithubApp(agent) ? normalizeGithubRepoUrl(agent.workspace.gitRepo) : agent.workspace.gitRepo
  )
}

class UntrustedGithubWorkspaceOriginError extends Error {
  constructor(options?: ErrorOptions) {
    super('workspace origin is not a trusted GitHub remote', options)
    this.name = 'UntrustedGithubWorkspaceOriginError'
  }
}

function isTrustedGithubOrigin(input: string): boolean {
  const raw = input.trim()
  if (raw.includes('\\')) return false
  const scp = /^[\w.-]+@([\w.-]+):/.exec(raw)
  if (scp) return scp[1]!.toLowerCase() === 'github.com'
  if (!/^(?:https|ssh):\/\//i.test(raw)) return false
  try {
    return new URL(normalizeGitCloneUrl(redactGitUrlSecrets(raw))).hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

async function convergeWorkspaceOrigin(agent: Agent, cwd = agent.workspace.path): Promise<void> {
  const clone = cloneInFlight.get(cwd)
  if (clone) await clone
  if (!existsSync(join(cwd, '.git'))) return
  const expected = gitRepoOf(agent)
  const git = gitFor(cwd).env(workspaceGitLocalEnv())
  let current: string
  try {
    current = (await git.raw(['remote', 'get-url', 'origin'])).trim()
  } catch (cause) {
    if (usesGithubApp(agent)) throw new UntrustedGithubWorkspaceOriginError({ cause })
    return
  }
  if (usesGithubApp(agent) && !isTrustedGithubOrigin(current)) {
    throw new UntrustedGithubWorkspaceOriginError()
  }
  const normalizedCurrent = normalizeGitUrl(current)
  let unsafeCurrent = redactGitUrlSecrets(current) !== normalizedCurrent
  try {
    authorizeWorkspaceGitUrl(current)
    if (!/^(?:https|ssh):\/\//i.test(current) && !/^[\w.-]+@[\w.-]+:/.test(current)) unsafeCurrent = true
  } catch {
    unsafeCurrent = true
  }
  const mismatched = normalizedCurrent.toLowerCase() !== expected.toLowerCase()
  if ((!mismatched && !unsafeCurrent) || (!unsafeCurrent && !usesGithubApp(agent))) return
  // App-backed mismatches and unsafe anonymous origins must converge before
  // daemon-managed Git can proceed. A failed rewrite is fail-closed.
  await git.raw(['remote', 'set-url', 'origin', expected])
}

function materializationKey(agent: Agent): string {
  if (agent.workspace.mode === 'from-scratch') return JSON.stringify({ mode: 'scratch' })
  const repo = gitRepoOf(agent)
  return JSON.stringify({
    mode: 'github',
    // GitHub treats the conventional `.git` suffix as the same repository.
    // Ignoring it here prevents a harmless CP canonicalization from replacing
    // an existing checkout during an access/agentDir-only edit.
    repo: (usesGithubApp(agent) ? repo.replace(/\.git$/i, '') : repo).toLowerCase(),
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

function sameMaterialization(agent: Agent, previous: string | undefined, target: string): boolean {
  if (previous === target) return true
  if (!usesGithubApp(agent) || previous === undefined) return false
  try {
    const left = JSON.parse(previous) as { mode?: unknown; repo?: unknown; branch?: unknown }
    const right = JSON.parse(target) as { mode?: unknown; repo?: unknown; branch?: unknown }
    if (
      left.mode !== 'github' ||
      right.mode !== 'github' ||
      typeof left.repo !== 'string' ||
      typeof right.repo !== 'string'
    ) {
      return false
    }
    return (
      left.repo.replace(/\.git$/i, '').toLowerCase() === right.repo.replace(/\.git$/i, '').toLowerCase() &&
      left.branch === right.branch
    )
  } catch {
    return false
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
 * canonical GitHub rename. Advance the marker first within this update so
 * origin convergence is fail-closed and retryable while the target marker holds. */
export async function convergeGithubAppWorkspaceRename(agent: Agent): Promise<void> {
  if (!usesGithubApp(agent)) return
  recordWorkspaceMaterialization(agent)
  await convergeWorkspaceOrigin(agent)
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

export async function prepareWorkspace(agent: Agent, opts: PrepareWorkspaceOptions = {}): Promise<string> {
  const cwd = agent.workspace.path
  // Fail unsafe config before using either a fresh or existing checkout.
  const agentDir = agent.workspace.mode === 'git-repo' ? normalizeRepoSubdir(agent.workspace.agentDir) : undefined
  if (agent.workspace.mode === 'git-repo') gitRepoOf(agent)
  mkdirSync(cwd, { recursive: true })

  if (agent.workspace.mode === 'from-scratch') {
    // The agent's memory file lives at the agent ROOT (outside the workspace) and
    // is seeded separately (see agents/memory.ts `ensureMemory`), so from-scratch
    // just needs the (empty) workspace dir to exist.
    return withSkills(agent, cwd, opts)
  }

  // git-repo, first session: no checkout yet → clone. Unlike pull, a clone has no
  // on-disk fallback, so on failure we THROW (the session creation fails + the error
  // surfaces) rather than silently proceeding with an empty dir (design §4.3).
  if (!existsSync(join(cwd, '.git'))) {
    await cloneRepo(agent)
    return withSkills(agent, resolveAcpCwd(cwd, agentDir), opts)
  }

  // git-repo, existing checkout: the repo-local helper pin may carry a previous
  // agent generation's id (agent deleted + recreated under the same name adopts
  // the surviving checkout) — re-pin so agent-run git presents a live identity
  // even where the env channel doesn't reach. Best-effort: a locked .git/config
  // must not block the session; the session-env channel still covers this run.
  if (usesGithubApp(agent)) {
    // The CP follows repository renames by numeric repo id. Repoint the existing
    // checkout instead of treating that canonical URL refresh as a new workspace.
    await convergeWorkspaceOrigin(agent, cwd)
    await writeRepoHelperConfig(cwd, agent.id).catch(() => undefined)
  } else {
    // Historical anonymous checkouts may still have credential-bearing or
    // disallowed origins even after their CP row has been sanitized.
    await convergeWorkspaceOrigin(agent, cwd)
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
      const repository = gitRepoOf(agent)
      await assertSafeWorkspaceGitConfig(cwd)
      const pullTarget = workspaceGitPullTarget(repository)
      const git = gitFor(cwd, abort.signal).env({
        ...pullTarget.env,
        ...(usesGithubApp(agent) ? gitCredentialEnv(agent.id) : {}),
        GIT_TERMINAL_PROMPT: '0'
      })
      await pullWorkspaceRef(git, pullTarget.remote, agent.workspace.gitBranch)
    } catch {
      // offline / timed out / non-fast-forward: proceed with the on-disk checkout
    } finally {
      clearTimeout(timer)
    }
  }
  return withSkills(agent, resolveAcpCwd(cwd, agentDir), opts)
}

/** Daemon-owned parent for logical-session worktrees. It sits beside the main
 * checkout so both stay inside one agent's filesystem/sandbox boundary. */
export function sessionWorktreeRoot(agent: Agent): string {
  const agentRoot = (agent as { dir?: string }).dir ?? dirname(agent.workspace.path)
  return join(agentRoot, 'worktrees')
}

function prepareSessionWorktreeRoot(agent: Agent): string {
  const agentRoot = realpathSync((agent as { dir?: string }).dir ?? dirname(agent.workspace.path))
  const root = sessionWorktreeRoot(agent)
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error('session worktree root must not be a symlink')
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const canonicalRoot = realpathSync(root)
  const rel = relative(agentRoot, canonicalRoot)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('session worktree root resolves outside the agent directory')
  }
  return canonicalRoot
}

function clearSessionWorktrees(agent: Agent): void {
  rmSync(sessionWorktreeRoot(agent), { recursive: true, force: true })
}

function sessionWorktreeId(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)
}

function exactObjectId(value: string, label: string): string {
  if (!GIT_OBJECT_ID.test(value)) throw new Error(`github review ${label} is not a Git object id`)
  return value.toLowerCase()
}

async function revParse(cwd: string, ref: string): Promise<string> {
  return (
    await gitFor(cwd)
      .env(workspaceGitLocalEnv())
      .raw(['rev-parse', '--verify', `${ref}^{commit}`])
  ).trim()
}

async function fetchReviewRevision(
  agent: Agent,
  worktreeId: string,
  review: GithubReviewWorkspaceRevision
): Promise<{ base: string; head: string; checkout: string }> {
  const base = exactObjectId(review.baseSha, 'base SHA')
  const head = exactObjectId(review.headSha, 'head SHA')
  if (!Number.isSafeInteger(review.pullNumber) || review.pullNumber <= 0) {
    throw new Error('github review pull number is invalid')
  }
  const root = `refs/agentconnect/reviews/${worktreeId}`
  const baseRef = `${root}/base`
  const headRef = `${root}/head`
  const mergeRef = `${root}/merge`
  const repository = gitRepoOf(agent)
  await assertSafeWorkspaceGitConfig(agent.workspace.path)
  if (usesGithubApp(agent)) await preWarmGitCred(agent.id, 'pull')
  const pullTarget = workspaceGitPullTarget(repository)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REVIEW_FETCH_TIMEOUT_MS)
  try {
    const git = gitFor(agent.workspace.path, abort.signal).env({
      ...pullTarget.env,
      ...(usesGithubApp(agent) ? gitCredentialEnv(agent.id) : {}),
      GIT_TERMINAL_PROMPT: '0'
    })
    await git.raw([
      'fetch',
      '--force',
      '--no-tags',
      '--no-recurse-submodules',
      pullTarget.remote,
      `+${base}:${baseRef}`,
      `+refs/pull/${review.pullNumber}/head:${headRef}`
    ])
    if ((await revParse(agent.workspace.path, baseRef)).toLowerCase() !== base) {
      throw new Error('github review base ref did not resolve to the requested SHA')
    }
    if ((await revParse(agent.workspace.path, headRef)).toLowerCase() !== head) {
      throw new Error('github review head ref did not resolve to the requested SHA')
    }

    // A conflicted PR has no merge ref. Head remains an exact, reviewable
    // checkout; when GitHub does provide a merge ref, trust it only after proving
    // both parents are the exact base/head pair carried by the hook.
    await git.raw(['update-ref', '-d', mergeRef]).catch(() => undefined)
    try {
      await git.raw([
        'fetch',
        '--force',
        '--no-tags',
        '--no-recurse-submodules',
        pullTarget.remote,
        `+refs/pull/${review.pullNumber}/merge:${mergeRef}`
      ])
      const merge = (await revParse(agent.workspace.path, mergeRef)).toLowerCase()
      const expectedMerge = review.mergeCommitSha ? exactObjectId(review.mergeCommitSha, 'merge SHA') : undefined
      const parents = (
        await gitFor(agent.workspace.path)
          .env(workspaceGitLocalEnv())
          .raw(['rev-list', '--parents', '-n', '1', mergeRef])
      )
        .trim()
        .toLowerCase()
        .split(/\s+/)
      if (
        (!expectedMerge || merge === expectedMerge) &&
        parents.length === 3 &&
        parents[1] === base &&
        parents[2] === head
      ) {
        return { base, head, checkout: merge }
      }
    } catch {
      // Exact head/base refs above are authoritative; merge is optional.
    }
    return { base, head, checkout: head }
  } finally {
    clearTimeout(timer)
  }
}

/** Prepare the stable cwd for one logical session. Ordinary worktrees preserve
 * their working state between turns. Review worktrees are daemon-owned snapshots
 * and are reset on every delivery after an exact remote fetch. */
export async function prepareSessionWorkspace(
  agent: Agent,
  request: PrepareSessionWorkspaceRequest,
  opts: PrepareWorkspaceOptions = {}
): Promise<string> {
  const primary = await prepareWorkspace(agent, opts)
  if (agent.workspace.mode !== 'git-repo' || request.isolation === 'shared') return primary

  const id = sessionWorktreeId(request.sessionKey)
  const root = prepareSessionWorktreeRoot(agent)
  const cwd = join(root, id)
  if (existsSync(cwd) && lstatSync(cwd).isSymbolicLink()) {
    throw new Error('session worktree path must not be a symlink')
  }
  const review = request.review ? await fetchReviewRevision(agent, id, request.review) : undefined
  const target = review?.checkout ?? `refs/remotes/origin/${agent.workspace.gitBranch}`
  let attached = existsSync(join(cwd, '.git'))
  if (attached) {
    try {
      await revParse(cwd, 'HEAD')
    } catch {
      attached = false
      rmSync(cwd, { recursive: true, force: true })
    }
  }
  if (!attached) {
    rmSync(cwd, { recursive: true, force: true })
    await gitFor(agent.workspace.path).env(workspaceGitLocalEnv()).raw(['worktree', 'prune'])
    await gitFor(agent.workspace.path).env(workspaceGitLocalEnv()).raw(['worktree', 'add', '--detach', cwd, target])
  } else if (review) {
    const worktreeGit = gitFor(cwd).env(workspaceGitLocalEnv())
    await worktreeGit.raw(['reset', '--hard', target])
    await worktreeGit.raw(['clean', '-ffd'])
  }
  if (review && (await revParse(cwd, 'HEAD')).toLowerCase() !== review.checkout) {
    throw new Error('github review worktree HEAD does not match the verified revision')
  }
  const agentDir = normalizeRepoSubdir(agent.workspace.agentDir)
  return withSkills(agent, resolveAcpCwd(cwd, agentDir), opts)
}

/** Resolve the already-prepared ACP cwd without pulling, acquiring sources, or
 * reconciling skills. The daemon cold-host gate calls prepareWorkspace before
 * spawn; SessionManager uses this pure follow-up to consume that same result
 * instead of triggering a second preparation after the host starts. */
export function resolvePreparedWorkspaceCwd(agent: Agent): string {
  const agentDir = agent.workspace.mode === 'git-repo' ? normalizeRepoSubdir(agent.workspace.agentDir) : undefined
  return resolveAcpCwd(agent.workspace.path, agentDir)
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
  let replace = reconcileMaterialization && !sameMaterialization(agent, previousMaterialization, targetMaterialization)
  const restoreMarker = () => {
    if (reconcileMaterialization) restoreWorkspaceMaterialization(agent, previousMaterialization)
  }

  if (agent.workspace.mode === 'from-scratch') {
    if (replace) {
      clearSessionWorktrees(agent)
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
      try {
        await convergeWorkspaceOrigin(agent, cwd)
      } catch (err) {
        if (!(reconcileMaterialization && err instanceof UntrustedGithubWorkspaceOriginError)) throw err
        // A historical App-backed checkout from a non-GitHub origin cannot be
        // trusted merely by rewriting .git/config: replace its working tree
        // from the installation-authorized GitHub repository.
        replace = true
      }
      if (!replace) {
        resolveAcpCwd(cwd, normalizeRepoSubdir(agent.workspace.agentDir))
        if (reconcileMaterialization) recordWorkspaceMaterialization(agent)
        return restoreMarker
      }
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
      clearSessionWorktrees(agent)
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
  gitRepoOf(agent)
  if (existsSync(join(cwd, '.git'))) {
    await convergeWorkspaceOrigin(agent, cwd)
    return
  }
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

  // Validate again at the execution boundary: a hand-edited/legacy agent.json
  // must not turn daemon-managed git into a local-path or remote-helper launcher.
  const gitRepo = gitRepoOf(agent)
  const branch = agent.workspace.gitBranch
  const githubApp = usesGithubApp(agent)

  const p = (async () => {
    // github-app: credentials ride the env-injected helper (no repo config exists
    // yet). SPREAD over process.env — simple-git's .env() REPLACES the child env.
    if (githubApp) await preWarmGitCred(agent.id, 'clone')
    const git = githubApp
      ? gitFor().env({ ...workspaceGitEnvBase(gitRepo), ...cloneGitEnv(agent.id, gitRepo) })
      : gitFor().env({ ...workspaceGitEnvBase(gitRepo), GIT_TERMINAL_PROMPT: '0' })
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

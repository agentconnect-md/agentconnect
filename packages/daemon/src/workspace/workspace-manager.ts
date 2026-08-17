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
import { LocalGitRunner, type GitRunner } from './git-runner.js'
import { authorizeWorkspaceGitUrl } from './git-origin-policy.js'
import { isSessionBranch, sessionBranchName } from './session-branch.js'
import { DEFAULT_SHIM_WORKSPACE_ROOT } from '../shim/protocol.js'
import { SANDBOX_CHECKOUT_DIR } from '../shim/sandbox-paths.js'

const skillsLog = makeLogger('info')
const workspaceLog = makeLogger('info')

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
  /** Display label of the user who OPENED this logical session — it names the
   * worktree's branch. Presentation only; never an identity or auth input. */
  initiatedBy?: string
  review?: GithubReviewWorkspaceRevision
  /** Use an empty daemon-owned cwd when an exact local review checkout is
   * unavailable. The model must inspect the trusted revision through GitHub. */
  githubReviewRevisionOnly?: true
}

const PULL_TIMEOUT_MS = 4500
const REVIEW_FETCH_TIMEOUT_MS = 15_000
const MATERIALIZATION_FILE = 'workspace-materialization.json'
const CONVERSION_FILE = 'workspace-conversion.json'
/** Word-pair branch names to try before falling back to a random suffix. */
const SESSION_BRANCH_DRAWS = 5
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/i

// The per-daemon execution plane every workspace operation resolves through: where an agent's git
// runs, how a path this process cannot see gets emptied, whether workspaces live in sandboxes at
// all, and the clone single-flight that coalesces concurrent sessions.
//
// Instance state, not module state, because a process can hold more than one daemon — the test
// suite routinely does, and a k8s daemon and a local one disagree on every field here. While these
// were module-level bindings the second daemon in a process silently inherited the first's plane.
export class WorkspaceManager {
  // Single-flight clone lock. Two concurrent sessions (especially multiple agents sharing one repo
  // checkout) must not race into the same dir — the second awaits the first's in-flight clone.
  readonly cloneInFlight = new Map<string, Promise<void>>()
  private gitRunnerResolver: WorkspaceGitRunnerResolver | undefined
  private pathClearer: WorkspacePathClearer | undefined
  private workspacesLiveInSandboxes = false

  setGitRunnerResolver(resolver: WorkspaceGitRunnerResolver | undefined): void {
    this.gitRunnerResolver = resolver
  }

  setPathClearer(clearer: WorkspacePathClearer | undefined): void {
    this.pathClearer = clearer
  }

  setSandboxMode(enabled: boolean): void {
    this.workspacesLiveInSandboxes = enabled
  }

  get sandboxMode(): boolean {
    return this.workspacesLiveInSandboxes
  }

  /** The agent's own runner; undefined means its workspace is reachable locally. */
  resolveGitRunner(agentId: string, cwd?: string, abort?: AbortSignal): GitRunner | undefined {
    return this.gitRunnerResolver?.(agentId, cwd, abort)
  }

  /** The clearer's error message, or undefined when it succeeded or none is registered. */
  async clearPath(agentId: string, root: string): Promise<string | undefined> {
    return await this.pathClearer?.(agentId, root).catch((err: unknown) => (err as Error).message)
  }

  // The key is the cwd for a local workspace, where sharing a path means sharing a checkout and
  // coalescing is the intent. For a cluster workspace the same path is a DIFFERENT filesystem per
  // agent, so coalescing there would hand one agent the other's clone; the agent id disambiguates.
  cloneKey(agentId: string, cwd: string): string {
    return this.gitRunnerResolver?.(agentId, cwd) ? `${agentId}\u0000${cwd}` : cwd
  }

  async withSkills(agent: Agent, acpCwd: string, opts: PrepareWorkspaceOptions): Promise<string> {
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
      useGitCredential: this.usesGithubApp(agent),
      warn: (msg) => skillsLog.warn(msg)
    })
    return acpCwd
  }

  usesGithubApp(agent: Agent): boolean {
    return agent.workspace.mode === 'git-repo' && agent.workspace.gitCredential === 'github-app'
  }

  gitRepoOf(agent: Agent): string {
    if (agent.workspace.mode !== 'git-repo' || !agent.workspace.gitRepo) {
      throw new Error(`workspace clone: agent "${agent.id}" has git-repo mode but no gitRepo configured`)
    }
    return authorizeWorkspaceGitUrl(
      this.usesGithubApp(agent) ? normalizeGithubRepoUrl(agent.workspace.gitRepo) : agent.workspace.gitRepo
    )
  }

  isTrustedGithubOrigin(input: string): boolean {
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

  runnerFor(agentId: string, cwd?: string, abort?: AbortSignal): GitRunner {
    return (
      this.resolveGitRunner(agentId, cwd, abort) ??
      new LocalGitRunner(gitFor(cwd, abort), cwd, (env) => gitFor(cwd, abort).env(env))
    )
  }

  async clearSandboxPath(agentId: string, root: string): Promise<void> {
    const error = await this.clearPath(agentId, root)
    if (error) {
      workspaceLog.warn(`workspace: could not empty ${root} for agent "${agentId}" after a failed clone (${error})`)
    }
  }

  async requireEmptiedSandboxPath(agentId: string, root: string): Promise<void> {
    const error = await this.clearPath(agentId, root)
    if (error) throw new Error(`workspace: could not replace ${root} for agent "${agentId}" (${error})`)
  }

  consoleWorkspaceGitRunner(agentId: string, cwd?: string, abort?: AbortSignal): GitRunner | undefined {
    const remote = this.resolveGitRunner(agentId, cwd, abort)
    if (remote) return remote
    if (this.sandboxMode) return undefined
    return new LocalGitRunner(gitFor(cwd, abort), cwd, (env) => gitFor(cwd, abort).env(env))
  }

  async convergeWorkspaceOrigin(agent: Agent, cwd = agent.workspace.path): Promise<void> {
    const clone = this.cloneInFlight.get(this.cloneKey(agent.id, cwd))
    if (clone) await clone
    if (!existsSync(join(cwd, '.git'))) return
    await this.convergeOriginInPlace(agent, cwd)
  }

  markerAttestsRepository(previous: string | undefined, target: string): boolean {
    if (previous === undefined) return false
    const repoOf = (raw: string): string | undefined => {
      try {
        const parsed = JSON.parse(raw) as { repo?: unknown }
        return typeof parsed.repo === 'string' ? parsed.repo.replace(/\.git$/i, '').toLowerCase() : undefined
      } catch {
        return undefined
      }
    }
    const left = repoOf(previous)
    const right = repoOf(target)
    return left !== undefined && right !== undefined && left === right
  }

  async clusterCheckoutBranch(agentId: string, checkout: string): Promise<string> {
    try {
      const head = await this.runnerFor(agentId, checkout)
        .withEnv(workspaceGitLocalEnv())
        .raw(['rev-parse', '--abbrev-ref', 'HEAD'])
      return head.trim()
    } catch {
      return ''
    }
  }

  async convergeOriginInPlace(agent: Agent, cwd: string): Promise<void> {
    const expected = this.gitRepoOf(agent)
    const git = this.runnerFor(agent.id, cwd).withEnv(workspaceGitLocalEnv())
    let current: string
    try {
      current = (await git.raw(['remote', 'get-url', 'origin'])).trim()
    } catch (cause) {
      if (this.usesGithubApp(agent)) throw new UntrustedGithubWorkspaceOriginError({ cause })
      return
    }
    if (this.usesGithubApp(agent) && !this.isTrustedGithubOrigin(current)) {
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
    if ((!mismatched && !unsafeCurrent) || (!unsafeCurrent && !this.usesGithubApp(agent))) return
    // App-backed mismatches and unsafe anonymous origins must converge before
    // daemon-managed Git can proceed. A failed rewrite is fail-closed.
    await git.raw(['remote', 'set-url', 'origin', expected])
  }

  materializationKey(agent: Agent): string {
    if (agent.workspace.mode === 'from-scratch') return JSON.stringify({ mode: 'scratch' })
    const repo = this.gitRepoOf(agent)
    return JSON.stringify({
      mode: 'github',
      // GitHub treats the conventional `.git` suffix as the same repository.
      // Ignoring it here prevents a harmless CP canonicalization from replacing
      // an existing checkout during an access/agentDir-only edit.
      repo: (this.usesGithubApp(agent) ? repo.replace(/\.git$/i, '') : repo).toLowerCase(),
      branch: agent.workspace.gitBranch
    })
  }

  materializationFile(agent: Agent): string {
    const cwd = agent.workspace.path
    return join(dirname(cwd), `.${basename(cwd)}.${MATERIALIZATION_FILE}`)
  }

  readMaterialization(agent: Agent): string | undefined {
    try {
      const value = JSON.parse(readFileSync(this.materializationFile(agent), 'utf8')) as { key?: unknown }
      return typeof value.key === 'string' ? value.key : undefined
    } catch {
      return undefined
    }
  }

  conversionFile(agent: Agent): string {
    const cwd = agent.workspace.path
    return join(dirname(cwd), `.${basename(cwd)}.${CONVERSION_FILE}`)
  }

  readPendingConversion(agent: Agent): string | undefined {
    try {
      const value = JSON.parse(readFileSync(this.conversionFile(agent), 'utf8')) as { key?: unknown }
      return typeof value.key === 'string' ? value.key : undefined
    } catch {
      return undefined
    }
  }

  writePendingConversion(agent: Agent, key: string | undefined): void {
    const file = this.conversionFile(agent)
    if (key === undefined) {
      rmSync(file, { force: true })
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, key }, null, 2) + '\n')
  }

  clusterConversionDue(agent: Agent, stored: string | undefined, target: string): boolean {
    if (this.sameMaterialization(agent, stored, target)) return false
    return this.readPendingConversion(agent) !== undefined
  }

  sameMaterialization(agent: Agent, previous: string | undefined, target: string): boolean {
    if (previous === target) return true
    if (!this.usesGithubApp(agent) || previous === undefined) return false
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

  recordWorkspaceMaterialization(agent: Agent): void {
    const file = this.materializationFile(agent)
    const temp = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, key: this.materializationKey(agent) }, null, 2) + '\n')
      renameSync(temp, file)
    } catch (err) {
      rmSync(temp, { force: true })
      throw err
    }
  }

  async convergeGithubAppWorkspaceRename(agent: Agent): Promise<void> {
    if (!this.usesGithubApp(agent)) return
    this.recordWorkspaceMaterialization(agent)
    await this.convergeWorkspaceOrigin(agent)
  }

  ensureWorkspaceMaterialization(agent: Agent): void {
    if (!existsSync(this.materializationFile(agent))) this.recordWorkspaceMaterialization(agent)
  }

  forgetWorkspaceMaterialization(agent: Agent): void {
    rmSync(this.materializationFile(agent), { force: true })
  }

  restoreWorkspaceMaterialization(agent: Agent, key: string | undefined): void {
    if (key === undefined) {
      rmSync(this.materializationFile(agent), { force: true })
      return
    }
    const file = this.materializationFile(agent)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, key }, null, 2) + '\n')
  }

  async prepareWorkspace(agent: Agent, opts: PrepareWorkspaceOptions = {}): Promise<string> {
    const cwd = agent.workspace.path
    // Fail unsafe config before using either a fresh or existing checkout.
    const agentDir = agent.workspace.mode === 'git-repo' ? normalizeRepoSubdir(agent.workspace.agentDir) : undefined
    if (agent.workspace.mode === 'git-repo') this.gitRepoOf(agent)
    mkdirSync(cwd, { recursive: true })

    if (agent.workspace.mode === 'from-scratch') {
      // The agent's memory file lives at the agent ROOT (outside the workspace) and
      // is seeded separately (see memory/store.ts `ensureMemory`), so from-scratch
      // just needs the (empty) workspace dir to exist.
      return this.withSkills(agent, cwd, opts)
    }

    // git-repo, first session: no checkout yet → clone. Unlike pull, a clone has no
    // on-disk fallback, so on failure we THROW (the session creation fails + the error
    // surfaces) rather than silently proceeding with an empty dir (design §4.3).
    if (!existsSync(join(cwd, '.git'))) {
      await this.cloneRepo(agent)
      return this.withSkills(agent, this.resolveAcpCwd(cwd, agentDir), opts)
    }

    // git-repo, existing checkout: the repo-local helper pin may carry a previous
    // agent generation's id (agent deleted + recreated under the same name adopts
    // the surviving checkout) — re-pin so agent-run git presents a live identity
    // even where the env channel doesn't reach. Best-effort: a locked .git/config
    // must not block the session; the session-env channel still covers this run.
    if (this.usesGithubApp(agent)) {
      // The CP follows repository renames by numeric repo id. Repoint the existing
      // checkout instead of treating that canonical URL refresh as a new workspace.
      await this.convergeWorkspaceOrigin(agent, cwd)
      await writeRepoHelperConfig(this.runnerFor(agent.id, cwd), agent.id).catch(() => undefined)
    } else {
      // Historical anonymous checkouts may still have credential-bearing or
      // disallowed origins even after their CP row has been sanitized.
      await this.convergeWorkspaceOrigin(agent, cwd)
    }

    // Best-effort ff-only pull; never block/throw on offline (design §4.3) —
    // proceed with the on-disk checkout.
    if (agent.workspace.pullOnNewSession) {
      // github-app: warm the credential cache OUTSIDE the pull budget — a cold
      // cache means a CP round trip that would otherwise eat the whole 4.5s.
      if (this.usesGithubApp(agent)) await preWarmGitCred(agent.id, 'pull').catch(() => undefined)
      // Abort-driven budget: the signal makes simple-git KILL the git child at
      // the deadline. A bare Promise.race would abandon it still running — a
      // wedged pull (network black hole) then holds .git/index.lock into the
      // next session's pull.
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
      try {
        const repository = this.gitRepoOf(agent)
        await assertSafeWorkspaceGitConfig(this.runnerFor(agent.id, cwd))
        const pullTarget = workspaceGitPullTarget(repository)
        const git = this.runnerFor(agent.id, cwd, abort.signal).withEnv({
          ...workspaceGitLocalEnv(),
          ...pullTarget.env,
          ...(this.usesGithubApp(agent) ? gitCredentialEnv(agent.id) : {}),
          GIT_TERMINAL_PROMPT: '0'
        })
        await pullWorkspaceRef(git, pullTarget.remote, agent.workspace.gitBranch)
      } catch {
        // offline / timed out / non-fast-forward: proceed with the on-disk checkout
      } finally {
        clearTimeout(timer)
      }
    }
    return this.withSkills(agent, this.resolveAcpCwd(cwd, agentDir), opts)
  }

  sessionWorktreeRoot(agent: Agent): string {
    const agentRoot = (agent as { dir?: string }).dir ?? dirname(agent.workspace.path)
    return join(agentRoot, 'worktrees')
  }

  validateSessionWorktreeRoot(agent: Agent, root: string): string {
    if (lstatSync(root).isSymbolicLink()) {
      throw new Error('session worktree root must not be a symlink')
    }
    const agentRoot = realpathSync((agent as { dir?: string }).dir ?? dirname(agent.workspace.path))
    const canonicalRoot = realpathSync(root)
    const rel = relative(agentRoot, canonicalRoot)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error('session worktree root resolves outside the agent directory')
    }
    return canonicalRoot
  }

  prepareSessionWorktreeRoot(agent: Agent): string {
    const root = this.sessionWorktreeRoot(agent)
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error('session worktree root must not be a symlink')
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return this.validateSessionWorktreeRoot(agent, root)
  }

  clearSessionWorktrees(agent: Agent): void {
    rmSync(this.sessionWorktreeRoot(agent), { recursive: true, force: true })
  }

  sessionWorktreeId(sessionKey: string): string {
    return createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)
  }

  sessionWorktreePath(agent: Agent, sessionKey: string): string {
    return join(this.sessionWorktreeRoot(agent), this.sessionWorktreeId(sessionKey))
  }

  async removeSessionWorktree(agent: Agent, sessionKey: string): Promise<SessionWorktreeRemoval> {
    const id = this.sessionWorktreeId(sessionKey)
    const primaryGit = () => this.runnerFor(agent.id, agent.workspace.path).withEnv(workspaceGitLocalEnv())
    // Drop the stale Git registration and this worktree's daemon-owned review refs.
    // Ref deletion is best-effort: most worktrees never had review refs.
    const cleanupRegistrations = async () => {
      await primaryGit().raw(['worktree', 'prune'])
      for (const name of ['base', 'head', 'merge']) {
        await primaryGit()
          .raw(['update-ref', '-d', `refs/agentconnect/reviews/${id}/${name}`])
          .catch(() => undefined)
      }
    }
    try {
      if (agent.workspace.mode !== 'git-repo') throw new Error('agent workspace is not a Git repository')
      const rootPath = this.sessionWorktreeRoot(agent)
      if (!existsSync(rootPath)) {
        // No root ⇒ no worktree directory can exist; Git may still hold a stale
        // registration/review refs for it.
        await cleanupRegistrations()
        return { outcome: 'absent' }
      }
      // Re-derive cwd from the CANONICAL root: a symlinked root (or symlinked
      // ancestor) must never redirect the destructive branches below outside the
      // agent directory.
      const cwd = join(this.validateSessionWorktreeRoot(agent, rootPath), id)
      if (existsSync(cwd) && lstatSync(cwd).isSymbolicLink()) throw new Error('session worktree path is a symlink')
      if (!existsSync(cwd)) {
        await cleanupRegistrations()
        return { outcome: 'absent' }
      }
      if (!existsSync(join(cwd, '.git'))) {
        // The `.git` marker is gone, so Git no longer considers this a worktree —
        // but a NONEMPTY directory may hold exactly the untracked work this GC
        // promises never to auto-delete (`status` can't run without the marker).
        // Reclaim only a provably empty leftover; report anything else.
        if (readdirSync(cwd).length > 0) return { outcome: 'retained', reason: 'dirty' }
        rmSync(cwd, { recursive: true, force: true })
        await cleanupRegistrations()
        return { outcome: 'removed' }
      }
      const worktreeGit = this.runnerFor(agent.id, cwd).withEnv(workspaceGitLocalEnv())
      if ((await worktreeGit.raw(['status', '--porcelain'])).trim() !== '') {
        return { outcome: 'retained', reason: 'dirty' }
      }
      // The generated branch this worktree checks out, read BEFORE the removal that
      // unregisters it. Empty for a worktree created before session branches existed.
      const branch = (await worktreeGit.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
      // A session branch tracks nothing, so there is no upstream to compare against:
      // a commit is "unique" when no remote ref (and no fetched review ref of this
      // worktree) can reach it.
      const unique = (
        await worktreeGit.raw([
          'rev-list',
          '--count',
          'HEAD',
          '--not',
          '--remotes',
          `--glob=refs/agentconnect/reviews/${id}`
        ])
      ).trim()
      if (unique !== '0') return { outcome: 'retained', reason: 'unique-commits' }
      // No --force: if the tree went dirty between the check and here, Git refuses
      // and the failure keeps the session.
      await primaryGit().raw(['worktree', 'remove', cwd])
      await cleanupRegistrations()
      // Only a branch this daemon generated for a session worktree, and only after
      // the check above proved every commit on it is reachable from a remote — so
      // the forced delete can drop no work. Best-effort: a surviving ref is clutter,
      // not a reason to report a removed worktree as retained.
      if (isSessionBranch(branch)) {
        await primaryGit()
          .raw(['branch', '-D', branch])
          .catch(() => undefined)
      }
      return { outcome: 'removed' }
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message }
    }
  }

  exactObjectId(value: string, label: string): string {
    if (!GIT_OBJECT_ID.test(value)) throw new Error(`github review ${label} is not a Git object id`)
    return value.toLowerCase()
  }

  async revParse(agentId: string, cwd: string, ref: string): Promise<string> {
    return (
      await this.runnerFor(agentId, cwd)
        .withEnv(workspaceGitLocalEnv())
        .raw(['rev-parse', '--verify', `${ref}^{commit}`])
    ).trim()
  }

  async fetchReviewRevision(
    agent: Agent,
    worktreeId: string,
    review: GithubReviewWorkspaceRevision
  ): Promise<{ base: string; head: string; checkout: string }> {
    const base = this.exactObjectId(review.baseSha, 'base SHA')
    const head = this.exactObjectId(review.headSha, 'head SHA')
    if (!Number.isSafeInteger(review.pullNumber) || review.pullNumber <= 0) {
      throw new Error('github review pull number is invalid')
    }
    const root = `refs/agentconnect/reviews/${worktreeId}`
    const baseRef = `${root}/base`
    const headRef = `${root}/head`
    const mergeRef = `${root}/merge`
    const repository = this.gitRepoOf(agent)
    await assertSafeWorkspaceGitConfig(this.runnerFor(agent.id, agent.workspace.path))
    if (this.usesGithubApp(agent)) await preWarmGitCred(agent.id, 'pull')
    const pullTarget = workspaceGitPullTarget(repository)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REVIEW_FETCH_TIMEOUT_MS)
    try {
      const git = this.runnerFor(agent.id, agent.workspace.path, abort.signal).withEnv({
        ...pullTarget.env,
        ...(this.usesGithubApp(agent) ? gitCredentialEnv(agent.id) : {}),
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
      if ((await this.revParse(agent.id, agent.workspace.path, baseRef)).toLowerCase() !== base) {
        throw new Error('github review base ref did not resolve to the requested SHA')
      }
      if ((await this.revParse(agent.id, agent.workspace.path, headRef)).toLowerCase() !== head) {
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
        const merge = (await this.revParse(agent.id, agent.workspace.path, mergeRef)).toLowerCase()
        const expectedMerge = review.mergeCommitSha ? this.exactObjectId(review.mergeCommitSha, 'merge SHA') : undefined
        const parents = (
          await this.runnerFor(agent.id, agent.workspace.path)
            .withEnv(workspaceGitLocalEnv())
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

  prepareGithubRevisionOnlyWorkspace(agent: Agent, id: string): string {
    const root = this.prepareSessionWorktreeRoot(agent)
    const cwd = join(root, id)
    if (existsSync(cwd) && lstatSync(cwd).isSymbolicLink()) {
      throw new Error('github review workspace path must not be a symlink')
    }
    const staged = `${cwd}.review-${randomUUID()}`
    mkdirSync(staged, { recursive: true, mode: 0o700 })
    try {
      rmSync(cwd, { recursive: true, force: true })
      renameSync(staged, cwd)
    } catch (err) {
      rmSync(staged, { recursive: true, force: true })
      throw err
    }
    return realpathSync(cwd)
  }

  async addSessionWorktree(agent: Agent, cwd: string, target: string, initiatedBy?: string): Promise<void> {
    const git = () => this.runnerFor(agent.id, agent.workspace.path).withEnv(workspaceGitLocalEnv())
    let branch = ''
    for (let attempt = 0; ; attempt++) {
      branch = sessionBranchName(initiatedBy, attempt >= SESSION_BRANCH_DRAWS)
      if (attempt >= SESSION_BRANCH_DRAWS) break
      const taken = await git()
        .raw(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
        .then(() => true)
        .catch(() => false)
      if (!taken) break
    }
    // --no-track: the start point is a remote-tracking ref, so git's own `branch.autoSetupMerge`
    // would otherwise make `origin/<base>` this branch's upstream. That upstream is what the console's
    // push authorizes against — it would turn the push button into a remote-branch creator — and it
    // leaves a plain `git push` failing under push.default=simple on the name mismatch.
    await git().raw(['worktree', 'add', '-b', branch, '--no-track', cwd, target])
  }

  async prepareSessionWorkspace(
    agent: Agent,
    request: PrepareSessionWorkspaceRequest,
    opts: PrepareWorkspaceOptions = {}
  ): Promise<string> {
    if (request.githubReviewRevisionOnly) {
      if (agent.workspace.mode !== 'git-repo' || request.isolation !== 'session' || request.review) {
        throw new Error('github revision-only workspace requires an isolated git-repo review session')
      }
      return this.prepareGithubRevisionOnlyWorkspace(agent, this.sessionWorktreeId(request.sessionKey))
    }
    const primary = await this.prepareWorkspace(agent, opts)
    if (agent.workspace.mode !== 'git-repo' || request.isolation === 'shared') return primary

    const id = this.sessionWorktreeId(request.sessionKey)
    const root = this.prepareSessionWorktreeRoot(agent)
    const cwd = join(root, id)
    if (existsSync(cwd) && lstatSync(cwd).isSymbolicLink()) {
      throw new Error('session worktree path must not be a symlink')
    }
    const review = request.review ? await this.fetchReviewRevision(agent, id, request.review) : undefined
    const target = review?.checkout ?? `refs/remotes/origin/${agent.workspace.gitBranch}`
    let attached = existsSync(join(cwd, '.git'))
    if (attached) {
      try {
        await this.revParse(agent.id, cwd, 'HEAD')
      } catch {
        attached = false
        rmSync(cwd, { recursive: true, force: true })
      }
    }
    if (!attached) {
      rmSync(cwd, { recursive: true, force: true })
      await this.runnerFor(agent.id, agent.workspace.path).withEnv(workspaceGitLocalEnv()).raw(['worktree', 'prune'])
      // prepareWorkspace's pull is best-effort (and may be disabled), but this
      // checkout runs in the daemon process. Unsafe executable config must gate
      // the worktree operation itself instead of being swallowed as a pull error.
      await assertSafeWorkspaceGitConfig(this.runnerFor(agent.id, agent.workspace.path))
      await this.addSessionWorktree(agent, cwd, target, request.initiatedBy)
    } else if (review) {
      // Re-audit at the checkout boundary rather than relying on the earlier
      // network fetch audit; repository config may have changed while fetching.
      await assertSafeWorkspaceGitConfig(this.runnerFor(agent.id, agent.workspace.path))
      const worktreeGit = this.runnerFor(agent.id, cwd).withEnv(workspaceGitLocalEnv())
      await worktreeGit.raw(['reset', '--hard', target])
      await worktreeGit.raw(['clean', '-ffdx'])
    }
    if (review && (await this.revParse(agent.id, cwd, 'HEAD')).toLowerCase() !== review.checkout) {
      throw new Error('github review worktree HEAD does not match the verified revision')
    }
    const agentDir = normalizeRepoSubdir(agent.workspace.agentDir)
    return this.withSkills(agent, this.resolveAcpCwd(cwd, agentDir), opts)
  }

  clusterWorkspaceCwd(
    agent: Agent,
    runtimeRoot: string | undefined,
    request?: Pick<PrepareSessionWorkspaceRequest, 'isolation'>
  ): string {
    this.refuseSessionIsolationInCluster(agent, request)
    const checkout = this.clusterWorkspaceCheckout(agent, runtimeRoot)
    if (agent.workspace.mode === 'from-scratch') return checkout
    // The configured working subdirectory is applied LEXICALLY here: validating it means resolving
    // symlinks and stat-ing, which only means something in the filesystem that holds it — so the shim
    // does that when it refuses a cwd outside its own root.
    const agentDir = normalizeRepoSubdir(agent.workspace.agentDir)
    return agentDir === undefined ? checkout : join(checkout, ...agentDir.split('/'))
  }

  refuseSessionIsolationInCluster(agent: Agent, request?: Pick<PrepareSessionWorkspaceRequest, 'isolation'>): void {
    if (request?.isolation === 'session') {
      throw new Error(`session-isolated workspaces are not supported with --k8s yet (agent "${agent.id}")`)
    }
  }

  clusterWorkspaceCheckout(agent: Agent, runtimeRoot: string | undefined): string {
    const root = runtimeRoot ?? DEFAULT_SHIM_WORKSPACE_ROOT
    return agent.workspace.mode === 'from-scratch' ? root : join(root, SANDBOX_CHECKOUT_DIR)
  }

  consoleWorkspaceRoot(
    agent: Agent,
    local: string | undefined,
    runtimeRoot: string | undefined,
    request?: Pick<PrepareSessionWorkspaceRequest, 'isolation'>
  ): string | undefined {
    if (local === undefined || !this.sandboxMode) return local
    this.refuseSessionIsolationInCluster(agent, request)
    return this.clusterWorkspaceCheckout(agent, runtimeRoot)
  }

  async prepareClusterWorkspace(
    agent: Agent,
    runtimeRoot: string | undefined,
    request?: Pick<PrepareSessionWorkspaceRequest, 'isolation'>
  ): Promise<string> {
    const acpCwd = this.clusterWorkspaceCwd(agent, runtimeRoot, request)
    const root = runtimeRoot ?? DEFAULT_SHIM_WORKSPACE_ROOT
    const checkout = join(root, SANDBOX_CHECKOUT_DIR)
    const targetMarker = this.materializationKey(agent)
    const stored = this.readMaterialization(agent)
    // The acknowledged edit's replacement, executed here because this is the only code that reaches
    // the volume. Emptying the checkout IS the replacement: a git-repo target then clones below, and a
    // from-scratch one is simply the absence of it. Fail-closed — a clear that did not happen would
    // otherwise leave the previous repository's tree serving as the new workspace.
    //
    // The marker is dropped FIRST, and that order is the whole safety property. Everything from the
    // clear to the proof can fail — the clone, its helper pin, the marker write itself — and a marker
    // left describing the emptied workspace would tell the CP's rollback that nothing changed, so it
    // would repoint the rejected tree and ACK an agent running the wrong repository. Unproven instead:
    // whichever definition arrives next re-materializes the volume before anything runs on it.
    const conversionDue = this.clusterConversionDue(agent, stored, targetMarker)
    if (conversionDue) {
      this.forgetWorkspaceMaterialization(agent)
      await this.requireEmptiedSandboxPath(agent.id, checkout)
    }

    if (agent.workspace.mode === 'from-scratch') {
      // Provable by construction: the checkout is gone, so the volume holds exactly the scratch
      // workspace the configuration asks for. Recording it is what ends the conversion.
      if (conversionDue) this.recordMaterializationBestEffort(agent)
      return acpCwd
    }
    // Validated at the execution boundary, exactly as the local path does: a hand-edited agent.json
    // must not turn daemon-managed git into a local-path or remote-helper launcher.
    const repository = this.gitRepoOf(agent)
    const githubApp = this.usesGithubApp(agent)

    // Whether the volume can be PROVEN to hold what the marker would claim. A fresh clone can, by
    // construction (`--branch` at clone time). An existing one has to be interrogated.
    let volumeMatchesConfig = false
    // A conversion just emptied the checkout, so nothing the old marker attested survives it.
    const repositoryAttested = !conversionDue && this.markerAttestsRepository(stored, targetMarker)
    if (!(await this.clusterCheckoutExists(agent.id, checkout))) {
      await this.cloneRepoInSandbox(agent, root, repository)
      volumeMatchesConfig = true
    } else {
      // A resumed volume carries the PREVIOUS launch's checkout, so the same two things the local
      // path does to one: follow a repository rename onto the canonical URL (and refuse an origin
      // that is not a trusted GitHub remote, which is fail-closed), and re-pin the helper line in
      // `.git/config`, whose agent id goes stale when an agent is recreated over a surviving volume.
      await this.convergeOriginInPlace(agent, checkout)
      if (githubApp) {
        await writeRepoHelperConfig(this.runnerFor(agent.id, checkout), agent.id).catch(() => undefined)
      }
    }

    let pulled = false
    if (agent.workspace.pullOnNewSession) {
      if (githubApp) await preWarmGitCred(agent.id, 'pull').catch(() => undefined)
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), PULL_TIMEOUT_MS)
      try {
        await assertSafeWorkspaceGitConfig(this.runnerFor(agent.id, checkout))
        const pullTarget = workspaceGitPullTarget(repository)
        const git = this.runnerFor(agent.id, checkout, abort.signal).withEnv({
          ...workspaceGitLocalEnv(),
          ...pullTarget.env,
          ...(githubApp ? gitCredentialEnv(agent.id) : {}),
          GIT_TERMINAL_PROMPT: '0'
        })
        await pullWorkspaceRef(git, pullTarget.remote, agent.workspace.gitBranch)
        pulled = true
      } catch {
        // offline / timed out / non-fast-forward: proceed with the checkout on the volume, which is
        // the same degradation the local path accepts.
      } finally {
        clearTimeout(timer)
      }
    }
    // The marker records what the VOLUME holds, and this is the only place that knows — but ONLY when
    // that can be proven, because a marker that overstates is worse than one that lags.
    //
    // The case that made this precise: a volume on branch A, a configuration that now says a divergent
    // branch B. `pullWorkspaceRef` pulls INTO the current branch rather than switching, so its ff-only
    // pull fails, the failure is swallowed as ordinary offline degradation, and the volume stays on A.
    // Recording B there tells every later activation that nothing changed, and the agent runs the
    // wrong branch indefinitely — silently, which is the property that makes it expensive.
    //
    // Provable means: a fresh clone (its `--branch` decided HEAD), or an existing checkout whose HEAD
    // IS the configured branch AND whose tree is attributable to the configured repository — either
    // because a stored marker already attests it, or because a pull from it just succeeded. A rewritten
    // origin says nothing about the tree that was already there, and a branch name can match in both
    // repositories, so without one of those two the volume is simply unproven.
    //
    // Anything else leaves the marker alone, so a later activation still sees the change and refuses it
    // with a message naming what to do.
    if (!volumeMatchesConfig) {
      const head = await this.clusterCheckoutBranch(agent.id, checkout)
      volumeMatchesConfig = head === agent.workspace.gitBranch && (repositoryAttested || pulled)
    }
    if (!volumeMatchesConfig) {
      workspaceLog.warn(
        `workspace: the volume for agent "${agent.id}" does not provably hold ${repository} @ ` +
          `${agent.workspace.gitBranch} — leaving its materialization marker unchanged`
      )
      return acpCwd
    }
    this.recordMaterializationBestEffort(agent)
    return acpCwd
  }

  recordMaterializationBestEffort(agent: Agent): void {
    try {
      this.recordWorkspaceMaterialization(agent)
      this.writePendingConversion(agent, undefined)
    } catch (err) {
      workspaceLog.warn(
        `workspace: could not record the materialization marker for agent "${agent.id}" (${(err as Error).message})`
      )
    }
  }

  async clusterCheckoutExists(agentId: string, checkout: string): Promise<boolean> {
    try {
      await this.runnerFor(agentId, checkout).withEnv(workspaceGitLocalEnv()).raw(['rev-parse', '--git-dir'])
      return true
    } catch {
      // Missing directory, empty directory, or a partial clone — all "clone it".
      return false
    }
  }

  async cloneRepoInSandbox(agent: Agent, root: string, repository: string): Promise<void> {
    const checkout = join(root, SANDBOX_CHECKOUT_DIR)
    // Single-flight like the local clone. Per-agent workspace preparation is already serialized by the
    // daemon's own queue, so this is the belt to that braces: two clones into one volume would be a
    // half-written checkout, and the cost of preventing it is a map lookup.
    //
    // The key is captured ONCE and reused for get/set/delete. `cloneKey` is deliberately
    // state-dependent — it includes the agent id only while a sandbox runner is attached — so a clone
    // that fails BECAUSE the channel dropped would otherwise compute a different key on the way out,
    // delete nothing, and leave its own rejection cached under the old one. Every retry after
    // reattachment would then re-await that dead promise until the daemon restarted.
    const key = this.cloneKey(agent.id, checkout)
    const inflight = this.cloneInFlight.get(key)
    if (inflight) return await inflight
    const started = this.cloneInSandbox(agent, root, repository, checkout).finally(() => {
      this.cloneInFlight.delete(key)
    })
    this.cloneInFlight.set(key, started)
    return await started
  }

  async cloneInSandbox(agent: Agent, root: string, repository: string, checkout: string): Promise<void> {
    const githubApp = this.usesGithubApp(agent)
    if (githubApp) await preWarmGitCred(agent.id, 'clone')
    const env = githubApp
      ? { ...workspaceGitEnvBase(repository), ...cloneGitEnv(agent.id, repository) }
      : { ...workspaceGitEnvBase(repository), GIT_TERMINAL_PROMPT: '0' }
    try {
      await this.runnerFor(agent.id, root)
        .withEnv(env)
        .clone(repository, SANDBOX_CHECKOUT_DIR, ['--branch', agent.workspace.gitBranch, '--single-branch'])
    } catch (err) {
      // A partial checkout would fail the probe above forever after, since git refuses to clone into
      // a non-empty directory. Emptying it is the pod's own job — there is no rmSync to reach it.
      await this.clearSandboxPath(agent.id, checkout)
      throw err
    }
    if (githubApp) await writeRepoHelperConfig(this.runnerFor(agent.id, checkout), agent.id)
  }

  resolvePreparedWorkspaceCwd(agent: Agent): string {
    const agentDir = agent.workspace.mode === 'git-repo' ? normalizeRepoSubdir(agent.workspace.agentDir) : undefined
    return this.resolveAcpCwd(agent.workspace.path, agentDir)
  }

  additionalWorkspaceDirectories(
    agent: Agent,
    cwd: string,
    request?: Pick<PrepareSessionWorkspaceRequest, 'sessionKey' | 'isolation'>
  ): string[] {
    if (agent.workspace.mode !== 'git-repo') return []
    if (this.sandboxMode) {
      // `cwd` is in the POD's coordinates, which this daemon cannot `realpathSync` — the path exists
      // on no filesystem it can see, so the check below throws on the workspace it was handed. Undo
      // the lexical join `clusterWorkspaceCwd` made instead; the shim re-checks containment itself.
      const agentDir = normalizeRepoSubdir(agent.workspace.agentDir)
      if (agentDir === undefined) return []
      return [agentDir.split('/').reduce((path) => dirname(path), cwd)]
    }
    const expectedRoot =
      request?.isolation === 'session' ? this.sessionWorktreePath(agent, request.sessionKey) : agent.workspace.path
    const root = realpathSync(expectedRoot)
    const canonicalCwd = realpathSync(cwd)
    const rel = relative(root, canonicalCwd)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`prepared workspace cwd "${cwd}" resolves outside its checkout root`)
    }
    return root === canonicalCwd ? [] : [root]
  }

  resolveAcpCwd(workspaceRoot: string, agentDir: string | undefined): string {
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

  isWorkspaceEmpty(agent: Agent): boolean {
    const cwd = agent.workspace.path
    return !existsSync(cwd) || readdirSync(cwd).length === 0
  }

  cleanupStaleWorkspaceClones(agent: Agent): number {
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

  async prepareWorkspaceForActivation(
    agent: Agent,
    {
      allowExistingCheckout = true,
      reconcileMaterialization = false
    }: { allowExistingCheckout?: boolean; reconcileMaterialization?: boolean } = {}
  ): Promise<() => void> {
    const cwd = agent.workspace.path
    const previousMaterialization = reconcileMaterialization ? this.readMaterialization(agent) : undefined
    const targetMaterialization = this.materializationKey(agent)
    let replace =
      reconcileMaterialization && !this.sameMaterialization(agent, previousMaterialization, targetMaterialization)
    const restoreMarker = () => {
      if (reconcileMaterialization) this.restoreWorkspaceMaterialization(agent, previousMaterialization)
    }

    // A cluster agent's checkout is on its pod volume, so this function has nothing local to do — and
    // the one case that would need to do something, replacing an existing checkout, cannot be done
    // from here at all: it needs a staged clone beside the target, `renameSync` for an atomic swap,
    // `readdirSync` to prove the destination is still empty, and a rollback that restores the previous
    // tree. The shim offers none of those, and this runs BEFORE the CP has acknowledged the edit, so
    // anything destructive here would have to survive a rollback that cannot restore it.
    //
    // So activation records the intent and returns. `prepareClusterWorkspace` carries it out on the
    // volume — after the acknowledgement, inside a bound sandbox, where a failed clone is retried like
    // any other and an empty checkout is the recovery state, not a lost one.
    //
    // The marker is deliberately NOT advanced. For a cluster agent it means "the volume held this",
    // and writing the TARGET here would say it about a volume nothing has inspected — which cluster
    // preparation then reads back as proof of the repository, in a circle. Seeding at detach is a
    // different thing and stays: it names the definition the agent has been RUNNING on.
    if (this.sandboxMode) {
      // Set, never taken back — not by the else branch of this condition, and not by the rollback
      // below, which is why there is nothing to roll back. `ensureHostAsync` runs before the ACK, so
      // preparation may already be replacing the volume when this activation is rejected, and no
      // rollback reaches a pod's tree to undo it. Withdrawing the intent (or restoring the marker)
      // there would tell the CP's restored definition that nothing changed, and it would be ACKed onto
      // the rejected tree. Left standing, the pair says the volume is unattributable and whichever
      // definition arrives next re-materializes it — so recovery needs no rollback to run at all.
      // A stale intent costs nothing: a marker that proves the target ends the conversion.
      //
      // No previous marker means no proven volume to replace, so nothing is asked for — the pod either
      // has no checkout, which preparation clones, or has one that convergence fixes.
      if (reconcileMaterialization && replace && previousMaterialization !== undefined) {
        this.writePendingConversion(agent, targetMaterialization)
      }
      return () => {}
    }
    mkdirSync(cwd, { recursive: true })

    if (agent.workspace.mode === 'from-scratch') {
      if (replace) {
        this.clearSessionWorktrees(agent)
        rmSync(cwd, { recursive: true, force: true })
        mkdirSync(cwd, { recursive: true })
      }
      if (reconcileMaterialization) this.recordWorkspaceMaterialization(agent)
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
          await this.convergeWorkspaceOrigin(agent, cwd)
        } catch (err) {
          if (!(reconcileMaterialization && err instanceof UntrustedGithubWorkspaceOriginError)) throw err
          // A historical App-backed checkout from a non-GitHub origin cannot be
          // trusted merely by rewriting .git/config: replace its working tree
          // from the installation-authorized GitHub repository.
          replace = true
        }
        if (!replace) {
          this.resolveAcpCwd(cwd, normalizeRepoSubdir(agent.workspace.agentDir))
          if (reconcileMaterialization) this.recordWorkspaceMaterialization(agent)
          return restoreMarker
        }
      }
      // A different repo/branch is cloned below before the old checkout is
      // removed, so network/auth failures leave the current workspace intact.
    }
    if (!replace && !this.isWorkspaceEmpty(agent)) {
      throw new Error('workspace is not empty; remove or move its files before converting')
    }

    const staged = `${cwd}.clone-${randomUUID()}`
    mkdirSync(staged, { recursive: true })
    try {
      await this.cloneRepoAt(agent, staged)
      this.resolveAcpCwd(staged, normalizeRepoSubdir(agent.workspace.agentDir))
      if (replace) {
        this.clearSessionWorktrees(agent)
        rmSync(cwd, { recursive: true, force: true })
        renameSync(staged, cwd)
        try {
          this.recordWorkspaceMaterialization(agent)
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
      if (!this.isWorkspaceEmpty(agent)) {
        throw new Error('workspace changed while conversion was cloning; retry after making it empty')
      }
      try {
        // POSIX directory replacement is atomic when the destination is still
        // empty. If an operator writes into cwd after the check above, rename
        // fails with the original tree untouched instead of deleting that data.
        renameSync(staged, cwd)
      } catch (err) {
        if (!this.isWorkspaceEmpty(agent)) {
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

    if (reconcileMaterialization) this.recordWorkspaceMaterialization(agent)

    return () => {
      rmSync(cwd, { recursive: true, force: true })
      mkdirSync(cwd, { recursive: true })
      restoreMarker()
    }
  }

  async prefetchWorkspace(agent: Agent): Promise<void> {
    if (agent.workspace.mode !== 'git-repo') return
    const cwd = agent.workspace.path
    this.gitRepoOf(agent)
    if (existsSync(join(cwd, '.git'))) {
      await this.convergeWorkspaceOrigin(agent, cwd)
      return
    }
    mkdirSync(cwd, { recursive: true })
    await this.cloneRepo(agent)
  }

  async cloneRepo(agent: Agent): Promise<void> {
    return this.cloneRepoAt(agent, agent.workspace.path)
  }

  async cloneRepoAt(agent: Agent, cwd: string): Promise<void> {
    const key = this.cloneKey(agent.id, cwd)
    const inflight = this.cloneInFlight.get(key)
    if (inflight) return inflight

    // Validate again at the execution boundary: a hand-edited/legacy agent.json
    // must not turn daemon-managed git into a local-path or remote-helper launcher.
    const gitRepo = this.gitRepoOf(agent)
    const branch = agent.workspace.gitBranch
    const githubApp = this.usesGithubApp(agent)

    const p = (async () => {
      // github-app: credentials ride the env-injected helper (no repo config exists
      // yet). SPREAD over process.env — withEnv REPLACES the child env, as .env() did.
      if (githubApp) await preWarmGitCred(agent.id, 'clone')
      const git = githubApp
        ? this.runnerFor(agent.id).withEnv({ ...workspaceGitEnvBase(gitRepo), ...cloneGitEnv(agent.id, gitRepo) })
        : this.runnerFor(agent.id).withEnv({ ...workspaceGitEnvBase(gitRepo), GIT_TERMINAL_PROMPT: '0' })
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
      if (githubApp) await writeRepoHelperConfig(this.runnerFor(agent.id, cwd), agent.id)
    })().finally(() => {
      this.cloneInFlight.delete(key)
    })
    this.cloneInFlight.set(key, p)
    return p
  }
}

class UntrustedGithubWorkspaceOriginError extends Error {
  constructor(options?: ErrorOptions) {
    super('workspace origin is not a trusted GitHub remote', options)
    this.name = 'UntrustedGithubWorkspaceOriginError'
  }
}

// Resolves where one agent's git runs. Per-agent because a cluster workspace's runner is bound to
// that agent's own sandbox channel; undefined means local, so self-hosting needs no registration.
export type WorkspaceGitRunnerResolver = (agentId: string, cwd?: string, abort?: AbortSignal) => GitRunner | undefined

// Every git operation here routes through this: a direct gitFor still passes locally and then runs
// a cluster agent's git on the wrong filesystem.

/**
 * Empties a directory in the filesystem that agent's work happens in; undefined ⇒ this daemon's.
 *
 * Registered like the git runner above, and for the same reason: the one destructive path a cluster
 * workspace needs (a partial clone) cannot be an `rmSync`, because the directory is on a volume this
 * process cannot see.
 */
export type WorkspacePathClearer = (agentId: string, root: string) => Promise<string | undefined>

/**
 * Whether this daemon places workspaces in sandbox pods at all.
 *
 * Deliberately NOT `resolveGitRunner(id) !== undefined`: that answers per agent and is
 * false before a channel binds, so an operation guarded by it would take the local path for a
 * cluster agent that simply has no pod yet — and clone onto the daemon's disk.
 */

/** The same answer for callers OUTSIDE this module — a seam that would otherwise `stat` a workspace
 *  path that names a filesystem this process cannot see. */

/** Empty a path belonging to a cluster agent. A daemon with no clearer registered has no sandbox to
 *  reach, so there is nothing to empty — the local path never calls this. */

/** Empty a cluster path the caller cannot proceed without. A conversion that kept the old checkout
 *  would clone into a non-empty directory, or converge the new origin onto the previous tree. */

/**
 * The console git seam's runner: the agent's own, or — only when workspaces are not in sandboxes at
 * all — this daemon's. `undefined` means "on a sandbox volume, with no channel to reach it".
 *
 * Replaces the previous `workspaceGitRunnerFor`, whose local fallback applied in sandbox mode too.
 * ONE resolution, and that is the point rather than a detail: answering the reachability question
 * separately and resolving afterwards is check-then-use, and a routine detach between the two (the
 * shim re-dials at half the credential TTL) yields a local runner pointed at a path in the POD's
 * coordinates — so a read reports an empty workspace and a write mutates whatever is at that path on
 * this disk. The fallback is therefore not merely unhelpful in sandbox mode, it is refused, so no
 * caller can reintroduce it by ordering its own checks differently.
 */

/**
 * Whether a stored marker already attests that the volume's tree came from the configured
 * REPOSITORY.
 *
 * Durable on purpose. The obvious proxy — "did convergence just rewrite the origin?" — is per call,
 * while `remote set-url` persists: a second attempt after a failed pull finds the origin already
 * correct, concludes nothing was rewritten, and would record a marker for a repository no pull has
 * ever reached. Only something written down survives that, and the marker is the thing written down.
 *
 * Branch is deliberately not compared here; HEAD answers that directly. Absent or unparseable counts
 * as no attestation, so a pull has to prove it.
 */

/**
 * Which branch the pod's checkout is actually on.
 *
 * `pullWorkspaceRef` pulls INTO the current branch rather than switching to the configured one, so
 * this is the only thing that can tell a volume holding the requested branch from one that merely
 * fetched it. Empty when it cannot be established, which counts as "cannot prove it".
 */

/**
 * The convergence itself, for a checkout the caller has already established exists.
 *
 * Split out because establishing that is where the two filesystems differ: locally it is a file
 * test, and for a pod it is a question asked over the channel. What follows is identical, and has to
 * be — this is where a repository rename is followed and where an untrusted origin is refused.
 */

/**
 * That an edit asked this agent's POD volume to be replaced, and which workspace it asked for.
 *
 * A cluster conversion cannot happen where every other one does. The tree is in the pod, the shim
 * offers no rename and no rollback, and activation runs before the edit is even acknowledged — so
 * activation records the intent here and the pod's own preparation carries it out, inside a bound
 * sandbox, where a failed clone is retried like any other. It is deliberately NOT the marker: the
 * marker says what the volume HOLDS, and this says the volume is due to stop holding it.
 *
 * It also separates a conversion from a repository RENAME, which reaches this daemon as the same
 * changed URL but asks for the opposite treatment — repoint the checkout, never replace it. Only a
 * `reconcileWorkspace` activation writes this file, and a rename does not carry one.
 *
 * Its PRESENCE is what gates the replacement; the key it records is for diagnosis. A conversion
 * that cannot be attributed to a workspace is still a conversion — the volume is unattributable
 * from the moment its checkout is emptied until preparation proves the new one.
 */

/**
 * Whether the pod still has to replace its checkout: a replacement was asked for, and the marker
 * does not prove the volume already holds what this preparation is for.
 *
 * Deliberately not "the intent names THIS workspace". A conversion that emptied the checkout and
 * then failed — a clone that threw, its helper pin, even the marker write — leaves a volume no
 * marker can describe, and the definition that arrives next is as likely to be the CP's rollback as
 * a retry of the edit. Either one has to re-materialize, so presence is the gate and the marker is
 * the release: it is written only when preparation proved the volume, which is also when the intent
 * is cleared. That makes a leftover intent inert rather than a repeated wipe.
 */

/** Snapshot the currently-live workspace definition before a cold detach. */

/** Converge the durable identity and remote of an App-backed checkout after a
 * canonical GitHub rename. Advance the marker first within this update so
 * origin convergence is fail-closed and retryable while the target marker holds. */

/** Seed the marker for a pre-v2 workspace without overwriting an earlier
 * materialization. The on-disk spec may already be the target after a crash,
 * while the checkout still belongs to the recorded source. */

/** Say that nothing is known about the volume, for the stretch where nothing IS: a cluster
 *  conversion between emptying the checkout and proving its replacement. Throws rather than
 *  leaving a stale marker behind — the destructive step is ordered after it for that reason. */

/** Daemon-owned parent for logical-session worktrees. It sits beside the main
 * checkout so both stay inside one agent's filesystem/sandbox boundary. */

/** Canonicalize an EXISTING worktree root and prove it (and every ancestor
 * symlink it may hide behind) still resolves inside the agent directory. Every
 * destructive path must go through this — checking only the final entry misses
 * a symlinked `worktrees/` parent redirecting the whole tree elsewhere. */

/** The stable daemon-owned worktree directory for one logical session. Derived,
 * never stored — the id is a hex hash, so the path always sits under the agent's
 * worktrees root. */

export type SessionWorktreeRemoval =
  | { outcome: 'removed' }
  | { outcome: 'absent' }
  /** The worktree holds work the daemon must not discard — the caller keeps the session. */
  | { outcome: 'retained'; reason: 'dirty' | 'unique-commits' }
  | { outcome: 'failed'; error: string }

/** Retention GC (#485): remove one logical session's worktree, but only when it
 * is provably safe — no dirty/untracked files and no commit unreachable from
 * every remote ref (daemon-owned review refs count as remote-backed: they were
 * fetched verbatim). Safe candidates go through Git-aware cleanup
 * (`worktree remove` → `worktree prune`) and their review refs are deleted;
 * anything else is reported as retained/failed so the caller keeps the session.
 * The active-turn exclusion is the caller's job — this function only judges the
 * on-disk state. */

/** Replace any earlier checkout with an empty stable cwd. This lets a formal
 * review continue through revision-addressed GitHub tools without exposing a
 * stale or checkout-controlled local repository as evidence. */

/** Check out a session worktree on its OWN generated branch rather than at a
 * detached HEAD, so the work a session produces has a name it can be pushed and
 * reviewed under. A drawn name can already exist in the repository, which
 * `worktree add -b` refuses — so ask git first and draw again, then let random
 * bytes end the search rather than failing the session over a word pair. */

/** Prepare the stable cwd for one logical session. Ordinary worktrees preserve
 * their working state between turns. Review worktrees are daemon-owned snapshots
 * and are reset on every delivery after an exact remote fetch. */

/**
 * The ACP cwd for a CLUSTER agent, in the sandbox pod's own coordinates.
 *
 * `agent.workspace.path` names a directory on the DAEMON's filesystem and stays its
 * bookkeeping identity; the runtime and every shim-executed operation live in the pod,
 * whose volume mounts wherever the image says. Sending the daemon path across (which is
 * what happened before this split) hands the runtime a cwd that exists on no machine it
 * can see. The root comes from the bound shim's hello; a legacy shim that reported none
 * gets the one mount layout such images ever had.
 */

/** A logical-session worktree needs a daemon-owned parent beside the checkout, `worktree add` in the
 *  sandbox, and a retention GC that reads the pod's tree — a separate migration, and a clear error
 *  beats a mystery one from git inside the sandbox. */

/** Where a CLUSTER agent's tree ROOT is in the pod's coordinates: the mounted volume for a
 *  from-scratch workspace, and the checkout one level down (away from the runtime's HOME) for a
 *  git-repo one. The ACP cwd is derived from it; the console addresses it directly. */

/**
 * The root the CONSOLE's workspace surfaces work in: the CHECKOUT root, in the coordinates of the
 * filesystem that holds it. The panels went without one, so the git seam handed a ShimGitRunner
 * `agent.workspace.path`, the shim's cwd fence refused it, `isRepo` swallowed the refusal, and a
 * cluster agent's Git panel reported "not a git checkout" over a real checkout — while the file
 * reader listed an empty daemon-side directory for the same workspace.
 *
 * NOT {@link clusterWorkspaceCwd}, which is the RUNTIME's cwd and goes one level further in when
 * `agentDir` is configured. The distinction is the local path's, not a cluster nicety: locally the
 * console has always addressed `workspace.path` (the clone root) while the ACP cwd went to the
 * working subdirectory, because the console addresses the REPOSITORY — `isRepo` accepts only an
 * empty `--show-prefix`, `git status` paths are repo-relative, and the file tree browses from the
 * top. Routing the console through the ACP cwd instead put every `agentDir`-configured cluster agent
 * back on "not a git checkout", one level down from the answer.
 *
 * `local` still decides WHETHER there is a workspace to name — absent stays absent, so a
 * shared-workspace sessionId is refused as before — and only the coordinates change.
 */

/**
 * Prepare a CLUSTER agent's workspace on its sandbox pod's volume.
 *
 * A separate function from {@link prepareWorkspace} rather than a branch inside it, because the two
 * differ in every step that touches a filesystem: `existsSync(.git)` becomes a question asked of the
 * POD, `mkdirSync` is the mounted volume's job, and a failed clone cannot be cleaned up with
 * `rmSync`. Sharing the body would mean a conditional at each of those, and the local path — the one
 * every self-hosted daemon runs — is the one that must not acquire new ways to be wrong.
 *
 * Skills are NOT installed here. Their acquisition, ledger and executable-content removal are all
 * local-filesystem work, and pointing them at a pod path would write them onto this daemon's disk;
 * that migration is its own change, so a cluster agent runs with none.
 */

/** Cluster preparation's marker write: best-effort, because the volume IS prepared and failing a
 *  session over bookkeeping would trade a stale marker for no session at all. The pending
 *  conversion goes with it — the marker now says the volume holds what the edit asked for. */

/**
 * Whether the pod already holds a checkout — asked of the pod, because that is where it would be.
 *
 * `rev-parse --git-dir` rather than a file test: it is in the shim's permitted inventory, and it
 * answers the question that matters (a USABLE repository) instead of the one a `.git` entry answers.
 * A half-written clone has a `.git` and fails this, which is the case that would otherwise make
 * every later session believe the checkout exists.
 */

/**
 * Clone into the pod, with the target RELATIVE to the fenced working directory.
 *
 * That is what keeps it inside the sandbox: the shim validates the `cwd` it is given and refuses one
 * outside its workspace root, so a relative target cannot land anywhere else. An absolute target
 * would be argv the fence never looks at.
 */

/** Resolve the already-prepared ACP cwd without pulling, acquiring sources, or
 * reconciling skills. The daemon cold-host gate calls prepareWorkspace before
 * spawn; SessionManager uses this pure follow-up to consume that same result
 * instead of triggering a second preparation after the host starts. */

/** Return the checkout root that encloses an already-prepared ACP cwd.
 *
 * ACP keeps `cwd` at the configured working subdirectory so relative paths and
 * project instructions retain their existing meaning. Runtimes that support
 * additional workspace directories receive this enclosing root separately,
 * which lets repository-wide tools reach `.git` and sibling paths. */

/** Resolve the checked path ACP receives, closing symlink and prefix-containment gaps. */

/** True only when the daemon-owned working directory has no entries. Missing
 *  directories count as empty. Callers that need a race-free answer must first
 *  gate/drain the agent (workspace conversion does this through agent/detach). */

const STAGED_CLONE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Best-effort startup GC for hard-crash leftovers from workspace conversion.
 *  Match only the exact daemon-owned `<workspace>.clone-<uuid>` siblings so a
 *  similarly named operator directory is never treated as disposable. */

/**
 * Materialize a staged cold workspace edit.
 *
 * A daemon-owned marker records the last committed mode/repo/branch. Matching
 * materializations preserve current files (access and agentDir edits); changed
 * materializations clone first when needed, then replace the workspace.
 * Rollback restores a correct empty base for the old definition to re-clone,
 * but deliberately cannot restore files discarded by an acknowledged replace.
 */

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

/** Clone agent.workspace.gitRepo @ gitBranch into cwd, single-flight per cwd. */

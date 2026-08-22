/**
 * Git credential injection (docs/designs/github-app-git-credentials.md
 * §Git Operation Injection / §Subrepositories and Nested Repositories) — the TWO secret-free channels that point every git
 * process at `agentconnect git-credential`:
 *
 *  1. Repo-local `.git/config` (written post-clone and re-pinned on every
 *     prepareWorkspace of an existing checkout): covers agent-run git in the
 *     main checkout. The file carries the LAST writer's agentId — that id can
 *     go stale (agent deleted + recreated under the same name over a surviving
 *     checkout), so it is only the helper's FALLBACK identity: the env pair of
 *     channel 2 outranks it whenever present.
 *  2. Session-env `GIT_CONFIG_GLOBAL` pointing at a generated per-agent
 *     gitconfig (includes the host global config first; commit identity is
 *     pinned separately). Inherited by the WHOLE agent process tree —
 *     submodules and nested clones hit OUR
 *     helper (and get a clean denial) instead of leaking to a machine-global
 *     osxkeychain credential. NOT GIT_CONFIG_COUNT: the indexed env vars don't
 *     merge across processes, so any child that sets its own COUNT would
 *     silently drop the reset and reopen the leak.
 *
 * All config values single-quote the shim path (git runs `!`-helpers via
 * `sh -c` — a space in $HOME must not word-split), reset the helper list first
 * (empty entry) and set useHttpPath=true (git strips `path` from credential
 * lookups by default; the reset-list semantics for URL-scoped keys are
 * implementation behavior verified on git ≥2.32 — see the design doc).
 *
 * Everything written here is a POINTER to the daemon — never a secret.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GitPullSummary, GitRunner } from './git-runner.js'
import { simpleGit, type SimpleGit } from 'simple-git'
import { normalizeGitCloneUrl, type GitCommitIdentity } from '@agentconnect.md/protocol'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../cp/gitcred-server.js'
import { SANDBOX_GIT_CONFIG_DIR, SANDBOX_GIT_CREDENTIAL_HELPER } from '../shim/sandbox-paths.js'
import { SANDBOX_TUNNEL_PATHS } from '../shim/tunnel.js'

/**
 * simple-git ≥3.36 vulnerability-checks argv AND any child env passed via
 * `.env()` (blockUnsafeOperationsPlugin → @simple-git/argv-parser). Two
 * behaviors matter here:
 *
 *  - configuring `credential.helper` (any scope — argv `config` writes AND
 *    GIT_CONFIG_KEY_n pairs) and the GIT_CONFIG_COUNT env channel itself each
 *    need their own unsafe opt-in;
 *  - a NAME blocklist of editor/pager/ssh/askpass/exec-path env vars is
 *    refused outright, presence-based — the value is never read, so an empty
 *    string or the operator's login-shell EDITOR both throw.
 *
 * Our helper injection IS the feature — opt in to exactly the two categories
 * whose values the daemon constructs itself. The host-shell noise (EDITOR,
 * stray GIT_DIR, a host GIT_CONFIG_*) gets SANITIZED instead: none of it
 * belongs in a daemon-run git child.
 */
const UNSAFE_OPTS = {
  unsafe: {
    allowUnsafeCredentialHelper: true, // the daemon-built credential.https://github.com.helper pairs
    allowUnsafeConfigEnvCount: true, // the daemon-built GIT_CONFIG_COUNT/KEY_n/VALUE_n channel
    allowUnsafeConfigPaths: true, // the daemon-selected empty global/system config view
    allowUnsafeFsMonitor: true, // the daemon-built false override for checkout fsmonitor commands
    allowUnsafeHooksPath: true, // the daemon-built /dev/null hooks path for host-side Git
    allowUnsafeSshCommand: true // the daemon-built ssh command that ignores user routing config
  }
} as const

/**
 * simple-git bound to a cwd with the credential-helper opt-in. An `abort`
 * signal KILLS the spawned git child (abort-plugin) — pair budget timeouts
 * with it, or the abandoned child keeps running and holds .git locks
 * (index.lock) into the next session's pull.
 */
export function gitFor(cwd?: string, abort?: AbortSignal): SimpleGit {
  return simpleGit({
    ...(cwd ? { baseDir: cwd } : {}),
    ...(abort ? { abort } : {}),
    ...UNSAFE_OPTS
  })
}

// Every env var simple-git's checker refuses by NAME (it matches
// case-insensitively — mirror that) + repo-context overrides that must never
// leak into a clone/pull child. VISUAL rides along with the editor family.
const HOST_ENV_STRIP = new Set([
  GITCRED_CAPABILITY_ENV,
  GITCRED_AGENT_ENV,
  GITCRED_SOCKET_ENV,
  'EDITOR',
  'VISUAL',
  'PAGER',
  'PREFIX',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'GIT_TEMPLATE_DIR',
  // `git rev-parse --local-env-vars`: none of the caller's repository context
  // may redirect daemon-managed operations away from their explicit cwd.
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM'
])

/**
 * `process.env` minus host-shell git noise — the base for every daemon-run git
 * child. The host keeps its ambient capabilities (PATH, HOME → ~/.gitconfig
 * and ~/.ssh/config, SSH_AUTH_SOCK, proxies); what goes is anything the
 * checker blocks by name plus repo-context overrides. A host that truly needs
 * e.g. a custom ssh command can set core.sshCommand in ~/.gitconfig — config
 * FILES are honored as ever, only env-var overrides are dropped.
 */
export function gitEnvBase(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    const key = k.toUpperCase()
    if (HOST_ENV_STRIP.has(key)) continue
    if (key.startsWith('GIT_CONFIG_')) continue // stray host GIT_CONFIG_COUNT/KEY_n/VALUE_n
    env[k] = v
  }
  return env
}

const WORKSPACE_GIT_PROXY_ENV = /^(?:all|ftp|http|https|no)_proxy$/i
const EMPTY_GIT_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'
const WORKSPACE_SSH_COMMAND =
  'ssh -F none -o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no -o ClearAllForwardings=yes'
const UNSAFE_LOCAL_WORKSPACE_GIT_CONFIG =
  /^(?:url\..*\.insteadof|includeif\..*\.path|extensions\.worktreeconfig|http(?:\..*)?\.(?:proxy|curloptresolve)|remote\..*\.(?:proxy|uploadpack|receivepack|vcs)|core\.(?:sshcommand|worktree|alternaterefscommand|askpass|pager)|pager\..*|filter\..*\.(?:clean|smudge|process)|diff\.(?:external|.*\.(?:command|textconv))|merge\..*\.driver|submodule\..*\.update|fetch\.bundleuri)$/i
const WORKSPACE_GIT_CONTROLLED_ENV = new Set([
  'GIT_ALLOW_PROTOCOL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_NO_LAZY_FETCH',
  'GIT_SSH_VARIANT',
  'GIT_TERMINAL_PROMPT'
])

function workspaceGitProcessEnv(): Record<string, string> {
  const env = gitEnvBase()
  for (const key of Object.keys(env)) {
    if (WORKSPACE_GIT_PROXY_ENV.test(key) || WORKSPACE_GIT_CONTROLLED_ENV.has(key.toUpperCase())) delete env[key]
  }
  // Daemon-managed workspace Git must not inherit user-writable routing rules
  // from ~/.gitconfig or system config. Local checkout config is audited
  // separately before an existing workspace performs network I/O.
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = EMPTY_GIT_CONFIG
  // Repository-owned replacement refs can make a trusted object id materialize
  // another tree, while legacy grafts can rewrite verified commit parents.
  env.GIT_NO_REPLACE_OBJECTS = '1'
  env.GIT_GRAFT_FILE = EMPTY_GIT_CONFIG
  env.GIT_LFS_SKIP_SMUDGE = '1'
  env.GIT_NO_LAZY_FETCH = '1'
  return env
}

function workspaceGitConfigPairs(repository?: string): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [
    // Disable both default/custom hooks, fsmonitor commands, and partial-tree
    // materialization for every daemon-owned operation. Clear checkout-owned
    // credential helpers before an optional daemon helper is appended below.
    ['core.hooksPath', EMPTY_GIT_CONFIG],
    ['core.fsmonitor', 'false'],
    ['core.sparseCheckout', 'false'],
    ['core.sparseCheckoutCone', 'false'],
    ['credential.helper', ''],
    ['http.followRedirects', 'false'],
    // Disable checkout- or server-selected secondary download locations.
    ['fetch.bundleURI', ''],
    ['transfer.bundleURI', 'false'],
    ['fetch.uriProtocols', '']
  ]
  if (!repository) return pairs
  const normalized = normalizeGitCloneUrl(repository)
  // Pin the complete URL against broader url.*.insteadOf rules. Existing
  // checkout config is also audited because Git keeps the earlier value when
  // an untrusted rule has the same match length.
  pairs.push([`url.${normalized}.insteadOf`, normalized])
  if (normalized.toLowerCase().startsWith('https://')) {
    // URL-specific values outrank generic http.* values. Disable redirects,
    // proxies, and libcurl's host-to-address override for the explicit target.
    pairs.push([`http.${normalized}.followRedirects`, 'false'])
    pairs.push([`http.${normalized}.proxy`, ''])
    pairs.push([`http.${normalized}.curloptResolve`, ''])
  } else {
    // Ignore ~/.ssh/config and checkout-controlled core.sshCommand routing.
    pairs.push(['core.sshCommand', WORKSPACE_SSH_COMMAND])
    pairs.push(['ssh.variant', 'ssh'])
  }
  return pairs
}

function gitConfigEnv(pairs: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/** Workspace clone/pull policy. Keep this separate from `gitEnvBase`: skill
 * installation intentionally supports a broader set of operator-chosen sources. */
export function workspaceGitEnvBase(repository?: string): Record<string, string> {
  const env = workspaceGitProcessEnv()
  // Git applies this allowlist after url.*.insteadOf rewriting.
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  // Do not let an otherwise allowed HTTPS origin redirect daemon egress to a
  // second, unvalidated origin.
  return { ...env, ...gitConfigEnv(workspaceGitConfigPairs(repository)) }
}

/**
 * Bind a validated remote URL to an unguessable daemon-owned remote name, plus the credential
 * channel reaching it needs. Git otherwise resolves a URL-shaped argument as a checkout-defined
 * remote name first, which could replace the authorized target through remote.*.url.
 *
 * The helper pairs must come AFTER `workspaceGitConfigPairs`: its `credential.helper=''` is a
 * command-scope reset of the whole helper list, so a helper pinned earlier — including the
 * repo-local `credential.https://github.com.helper` written post-clone — never runs. `cloneGitEnv`
 * survives for exactly this reason. FETCH needs the pointer as much as push does: a public remote
 * answers an anonymous request, so a pull target that only carried the helper's env (identity and
 * capability, which nothing invokes without the config line) looked healthy against a public remote
 * and failed every remote that DEMANDS credentials with "could not read Username" — which is how a
 * formal review of such a repository lost its exact checkout and degraded to revision-only inspection.
 * One function for both directions so the two cannot drift apart again. `credentialAgentId` is
 * omitted for a workspace with no github-app credential, which then reaches the remote on whatever
 * ambient (ssh) auth the host provides.
 */
export function workspaceGitRemoteTarget(
  repository: string,
  credentialAgentId?: string
): { remote: string; env: Record<string, string> } {
  const normalized = normalizeGitCloneUrl(repository)
  const remote = `agentconnect-${randomUUID()}`
  const pairs = [
    ...workspaceGitConfigPairs(normalized),
    ...(credentialAgentId
      ? credentialConfigPairs(credentialAgentId, managedCredentialHostOf(normalized) ?? 'github.com')
      : []),
    // Never an empty value first: Git reads it as the first fetch URL and fails before the authorized target.
    [`remote.${remote}.url`, normalized] as const,
    [`remote.${remote}.proxy`, ''] as const
  ]
  const env = workspaceGitProcessEnv()
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  return {
    remote,
    env: {
      ...env,
      ...gitConfigEnv(pairs),
      ...(credentialAgentId ? gitCredentialEnv(credentialAgentId) : {}),
      // A missing credential must fail immediately rather than block on a prompt nobody answers.
      GIT_TERMINAL_PROMPT: '0'
    }
  }
}

/** Environment for workspace Git operations that must never contact a remote. */
export function workspaceGitLocalEnv(): Record<string, string> {
  return {
    ...workspaceGitProcessEnv(),
    GIT_ALLOW_PROTOCOL: '',
    ...gitConfigEnv(workspaceGitConfigPairs())
  }
}

/**
 * Reject checkout-owned routing and executable settings that remain effective
 * before daemon-run network or checkout operations. Unconditional includes are
 * expanded and their actual keys are audited instead of rejecting include.path
 * itself: a repository may legitimately include a shared hooksPath, and daemon
 * Git pins hooksPath/fsmonitor at command scope so neither can run. Conditional
 * includes remain disallowed because their activation can change between the
 * primary checkout used for this audit and a later linked worktree. The
 * separate worktree config scope is also disallowed because `--local` cannot
 * audit `.git/config.worktree`, while later daemon Git operations still read it.
 */
export async function assertSafeWorkspaceGitConfig(git: GitRunner): Promise<void> {
  // A runner, not a cwd: the audit must read the config the guarded git will read, which for a
  // cluster workspace is the sandbox's — auditing this disk would pass a check nothing performed.
  const names = await git
    .withEnv(workspaceGitLocalEnv())
    .raw(['config', '--local', '--includes', '--name-only', '-z', '--list'])
  if (names.split('\0').some((name) => UNSAFE_LOCAL_WORKSPACE_GIT_CONFIG.test(name))) {
    throw new Error('workspace Git configuration contains a disallowed network override or executable setting')
  }
}

/** Ambient Git policy inherited by every configured repository session. The
 * command-scope config outranks repo-local and included hooksPath/fsmonitor
 * values without rewriting the checkout's own config. A tool may still opt in
 * explicitly with a later `git -c` override when running a hook is the task. */
export function sessionGitPolicyEnv(): Record<string, string> {
  return gitConfigEnv([
    ['core.hooksPath', EMPTY_GIT_CONFIG],
    ['core.fsmonitor', 'false']
  ])
}

/**
 * Pull exactly the daemon-authorized repository and branch. Supplying both
 * operands keeps checkout-controlled branch.*.remote / branch.*.merge config
 * out of daemon-managed network selection; the explicit destination also keeps
 * origin/<branch> current for status. check-ref-format prevents a configured
 * branch from being interpreted as an option or refspec.
 */
export async function pullWorkspaceRef(git: GitRunner, remote: string, branch: string): Promise<GitPullSummary> {
  await git.raw(['check-ref-format', '--branch', branch])
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  return git.pull(remote, refspec, ['--ff-only', '--no-recurse-submodules'])
}

/** The managed-credential hosts the helper may answer for (§13.2: exact origins). */
export type ManagedCredentialHost = 'github.com' | 'gitlab.com'

/** Which managed host a workspace repository URL belongs to; undefined ⇒ neither. */
export function managedCredentialHostOf(repository: string | undefined): ManagedCredentialHost | undefined {
  if (!repository) return undefined
  try {
    const host = new URL(normalizeGitCloneUrl(repository)).host.toLowerCase()
    return host === 'github.com' ? 'github.com' : host === 'gitlab.com' ? 'gitlab.com' : undefined
  } catch {
    return undefined
  }
}

// The address daemon Git may dial: gitlab.com 301s the suffix-less HTTPS probe and we refuse redirects, so its remote carries `.git`.
export function canonicalWorkspaceGitUrl(repository: string): string {
  const normalized = normalizeGitCloneUrl(repository)
  if (managedCredentialHostOf(normalized) !== 'gitlab.com') return normalized
  if (!/^https:/i.test(normalized) || /\.git$/i.test(normalized)) return normalized
  return `${normalized}.git`
}

/**
 * Where the git that will READ these pointers runs.
 *
 * Every value this module writes is a path, and a path only means something in one filesystem. A
 * cluster agent's git runs in its sandbox pod, so a helper line derived from the daemon's own root
 * names an executable that pod has never had — the failure mode being an authentication error
 * rather than a missing file, which is why this is a type and not a convention.
 */
export interface GitCredentialTarget {
  /** `daemon` may write files as it goes; `sandbox` must be materialized through the shim. */
  kind: 'daemon' | 'sandbox'
  /** The credential-helper executable, in that filesystem. */
  helper: string
  /** Directory holding the per-agent gitconfig, in that filesystem. */
  configDir: string
  /** The daemon operator's own ~/.gitconfig, included first. Omitted for a sandbox: its git has
   *  never seen the daemon's home, and pointing at it would silently include nothing. */
  hostConfig?: string
  /** Socket the helper must dial, when it is not the one under the daemon's root. */
  socketPath?: string
}

/** Module-level init (workspace-manager is functional; mirrors cloneInFlight). */
let targetFor: ((agentId: string) => GitCredentialTarget) | undefined
let preWarm: ((agentId: string, reason: 'clone' | 'pull') => Promise<void>) | undefined
let capabilityFor: ((agentId: string) => string) | undefined

export function initGitInjection(opts: {
  /**
   * Resolves the filesystem an agent's git runs in.
   *
   * It has to answer with the SAME predicate `setWorkspaceGitRunnerResolver` uses, or the
   * environment and the execution disagree: a remote runner running with daemon-local pointers is
   * exactly the bug this seam exists to remove.
   */
  targetFor: (agentId: string) => GitCredentialTarget
  /** Warm the daemon credential cache BEFORE a timed git op (never inside its budget). */
  preWarm: (agentId: string, reason: 'clone' | 'pull') => Promise<void>
  /** Runtime-only local socket capability. Never written to a config file. */
  capabilityFor: (agentId: string) => string
}): void {
  targetFor = opts.targetFor
  preWarm = opts.preWarm
  capabilityFor = opts.capabilityFor
}

/** This daemon's own filesystem: the helper shim and run dir it (re)writes on every boot. */
export function daemonGitCredentialTarget(opts: { shimPath: string; runDir: string }): GitCredentialTarget {
  return {
    kind: 'daemon',
    helper: opts.shimPath,
    configDir: join(opts.runDir, 'gitcred'),
    hostConfig: join(homedir(), '.gitconfig')
  }
}

/** A sandbox pod: the image's fixed helper path, and the socket the shim tunnels to the daemon. */
export function sandboxGitCredentialTarget(): GitCredentialTarget {
  return {
    kind: 'sandbox',
    helper: SANDBOX_GIT_CREDENTIAL_HELPER,
    configDir: SANDBOX_GIT_CONFIG_DIR,
    socketPath: SANDBOX_TUNNEL_PATHS.gitcred
  }
}

function targetOf(agentId: string): GitCredentialTarget {
  if (!targetFor) throw new Error('git credential injection is not initialized')
  return targetFor(agentId)
}

/** Auth for helper subprocesses. Keep separate from the persisted config pointers.
 *  Identity and capability are minted as a PAIR: the helper prefers this env
 *  identity over the agentId baked into a `.git/config` helper line, so a stale
 *  repo-local pin (previous agent generation) can never desync the two.
 *  The socket rides along for a target that is not this daemon's filesystem: the helper cannot
 *  derive a daemon root it does not have. */
export function gitCredentialEnv(
  agentId: string,
  target: GitCredentialTarget = targetOf(agentId)
): Record<string, string> {
  if (!capabilityFor) throw new Error('git credential injection is not initialized')
  return {
    [GITCRED_CAPABILITY_ENV]: capabilityFor(agentId),
    [GITCRED_AGENT_ENV]: agentId,
    ...(target.socketPath ? { [GITCRED_SOCKET_ENV]: target.socketPath } : {})
  }
}

function quotedHelper(agentId: string, target: GitCredentialTarget = targetOf(agentId)): string {
  const { helper } = target
  return `!'${helper.replaceAll("'", "'\\''")}' ${agentId}`
}

/** The three host-scoped config pairs both channels share. The host defaults to
 *  github.com; a gitlab workspace pins gitlab.com instead (§13.2) — never both,
 *  so a non-gitlab agent keeps whatever machine gitlab credentials exist. */
function credentialConfigPairs(agentId: string, host: ManagedCredentialHost = 'github.com'): Array<[string, string]> {
  return [
    [`credential.https://${host}.helper`, ''], // reset: machine helpers must never answer for this host
    [`credential.https://${host}.helper`, quotedHelper(agentId)],
    [`credential.https://${host}.useHttpPath`, 'true'] // git strips `path` otherwise — the helper wants it
  ]
}

/**
 * Env for a DAEMON-RUN git process (clone — no repo config exists yet).
 * Spread over `process.env` by the caller: simple-git's `.env()` REPLACES the
 * child environment (v3.36 verified), a bare object would strip PATH/HOME.
 */
export function cloneGitEnv(agentId: string, repository?: string): Record<string, string> {
  const pairs = [
    ...workspaceGitConfigPairs(repository),
    ...credentialConfigPairs(agentId, managedCredentialHostOf(repository) ?? 'github.com')
  ]
  const env: Record<string, string> = {
    ...gitCredentialEnv(agentId),
    GIT_TERMINAL_PROMPT: '0',
    ...gitConfigEnv(pairs)
  }
  return env
}

/**
 * The session-env channel as DATA: where the per-agent gitconfig belongs, what goes in it, and the
 * env that points the agent's runtime at it.
 *
 * Separated from the write because only one of the two targets can be written by this process. A
 * sandbox's copy has to travel through the shim's materialize channel, and a `writeFileSync` to
 * `/run/agentconnect/git/...` would land on the DAEMON's disk — creating the file the check would
 * look for while the pod still has nothing.
 */
export function sessionGitConfig(
  agentId: string,
  commitIdentity?: GitCommitIdentity,
  // Explicit for a spawn that KNOWS where the runtime will run (a --k8s launch always lands in the
  // pod), so the env cannot depend on whether the shim channel happens to be attached right now.
  target: GitCredentialTarget = targetOf(agentId),
  host: ManagedCredentialHost = 'github.com'
): { path: string; content: string; env: Record<string, string> } {
  const file = join(target.configDir, `${agentId}.gitconfig`)
  const lines = [
    '# agentconnect session git config — regenerated on agent start; NO secrets.',
    `# Keeps non-identity host config, then pins ${host} credentials to the daemon helper.`,
    ...(target.hostConfig ? ['[include]', `\tpath = ${target.hostConfig}`] : []),
    `[credential "https://${host}"]`,
    '\thelper = ', // reset the accumulated helper list for this host
    `\thelper = ${quotedHelper(agentId, target)}`,
    '\tuseHttpPath = true',
    ''
  ]
  return {
    path: file,
    content: lines.join('\n'),
    env: {
      ...gitCredentialEnv(agentId, target),
      ...sessionGitPolicyEnv(),
      GIT_CONFIG_GLOBAL: file,
      GIT_TERMINAL_PROMPT: '0',
      ...(commitIdentity ? gitCommitIdentityEnv(commitIdentity) : {})
    }
  }
}

/**
 * Session-env channel: (re)write the per-agent gitconfig and return the env to
 * inject into the agent's ACP runtime process. Regenerated on every host spawn
 * (#251 retries rebuild the host ⇒ this re-runs).
 *
 * Refuses a sandbox target rather than writing one: this is a synchronous local write, and the
 * caller that owns a pod's files is the async materialization path.
 */
export function sessionGitEnv(
  agentId: string,
  commitIdentity?: GitCommitIdentity,
  host: ManagedCredentialHost = 'github.com'
): Record<string, string> {
  if (targetOf(agentId).kind !== 'daemon') {
    throw new Error(`agent ${agentId} runs its git in a sandbox — materialize its gitconfig instead of writing it`)
  }
  const { path: file, content, env } = sessionGitConfig(agentId, commitIdentity, targetOf(agentId), host)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, content, { mode: 0o644 })
  return env
}

/** The four env vars that make a commit's attribution explicit. The ONLY channel a daemon-run
 *  commit has: every workspace git env pins `GIT_CONFIG_GLOBAL=/dev/null` and
 *  `GIT_CONFIG_NOSYSTEM=1`, so no config file can supply `user.name`/`user.email` — and git would
 *  otherwise guess an identity from the host's passwd entry and commit as the operator. */
export function gitCommitIdentityEnv(identity: GitCommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email
  }
}

/** Post-clone: pin the repo-local helper so agent-run git in the checkout works. */
export async function writeRepoHelperConfig(
  runner: GitRunner,
  agentId: string,
  host: ManagedCredentialHost = 'github.com'
): Promise<void> {
  const git = runner.withEnv(workspaceGitLocalEnv())
  // `--replace-all` on the first write resets any stale helper list from a
  // previous agent generation; addConfig(append=true) accumulates the rest.
  await git.raw(['config', '--replace-all', `credential.https://${host}.helper`, ''])
  await git.raw(['config', '--add', `credential.https://${host}.helper`, quotedHelper(agentId)])
  await git.raw(['config', `credential.https://${host}.useHttpPath`, 'true'])
}

/** Pre-warm hook for workspace-manager (no-op until initialized). */
export async function preWarmGitCred(agentId: string, reason: 'clone' | 'pull'): Promise<void> {
  if (!preWarm) return
  await preWarm(agentId, reason)
}

// The session channel (GIT_CONFIG_GLOBAL) needs git ≥ 2.32 and DEGRADES
// SILENTLY below it — old git just ignores the variable and agent-run git
// falls through to whatever machine credentials exist. The clone channel
// (GIT_CONFIG_COUNT/KEY_n/VALUE_n) needs ≥ 2.31 and fails loudly instead.
const MIN_GIT: readonly [number, number] = [2, 32]

/** `git version 2.39.5 (Apple Git-154)` → [2, 39]; null when unparseable. */
export function parseGitVersion(raw: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(raw)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * Boot-time probe (fire-and-forget): a host below the floor would otherwise
 * only show up as a mysterious credential prompt / auth failure deep inside an
 * agent session — say it once, at startup, in plain words.
 */
export function probeGitVersion(warn: (msg: string) => void): void {
  execFile('git', ['--version'], { timeout: 5_000 }, (err, stdout) => {
    if (err) {
      warn('git probe: `git --version` failed — git workspaces will not work on this host')
      return
    }
    const v = parseGitVersion(String(stdout))
    if (!v) return // vendor-mangled banner — do not cry wolf
    const [major, minor] = v
    if (major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])) return
    const cloneToo = major < 2 || (major === 2 && minor < 31)
    warn(
      `git ${major}.${minor} found but github-app workspaces need git >= ${MIN_GIT[0]}.${MIN_GIT[1]}: ` +
        'this git silently ignores the session credential channel (GIT_CONFIG_GLOBAL)' +
        (cloneToo ? ' and clone-time injection (GIT_CONFIG_COUNT, needs >= 2.31) will fail' : '')
    )
  })
}

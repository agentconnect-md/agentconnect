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
import { join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { normalizeGitCloneUrl, type GitCommitIdentity } from '@agentconnect.md/protocol'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from '../cp/gitcred-server.js'

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
  /^(?:url\..*\.insteadof|include(?:if\..*)?\.path|http(?:\..*)?\.(?:proxy|curloptresolve)|remote\..*\.(?:proxy|uploadpack|receivepack|vcs)|core\.(?:sshcommand|hookspath|fsmonitor|worktree|alternaterefscommand|askpass|pager)|pager\..*|filter\..*\.(?:clean|smudge|process)|diff\.(?:external|.*\.(?:command|textconv))|merge\..*\.driver|submodule\..*\.update|fetch\.bundleuri)$/i
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
  env.GIT_LFS_SKIP_SMUDGE = '1'
  env.GIT_NO_LAZY_FETCH = '1'
  return env
}

function workspaceGitConfigPairs(repository?: string): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [
    // Disable both default/custom hooks and fsmonitor commands for every
    // daemon-owned operation. Clear checkout-owned credential helpers before
    // an optional daemon helper is appended below.
    ['core.hooksPath', EMPTY_GIT_CONFIG],
    ['core.fsmonitor', 'false'],
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
 * Bind a validated pull URL to an unguessable daemon-owned remote name.
 * Git otherwise resolves a URL-shaped argument as a checkout-defined remote
 * name first, which could replace the authorized target through remote.*.url.
 */
export function workspaceGitPullTarget(repository: string): {
  remote: string
  env: Record<string, string>
} {
  const normalized = normalizeGitCloneUrl(repository)
  const remote = `agentconnect-${randomUUID()}`
  const pairs = [
    ...workspaceGitConfigPairs(normalized),
    // An empty value clears lower-priority URL lists before the daemon target.
    [`remote.${remote}.url`, ''] as const,
    [`remote.${remote}.url`, normalized] as const,
    [`remote.${remote}.proxy`, ''] as const
  ]
  const env = workspaceGitProcessEnv()
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  return { remote, env: { ...env, ...gitConfigEnv(pairs) } }
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
 * Reject checkout-owned routing includes and URL rewrites before a daemon-run
 * pull. Git has no switch that disables only repository config, so inspect the
 * local/worktree keys with includes disabled, while global/system config is
 * already excluded by the environment above.
 */
export async function assertSafeWorkspaceGitConfig(cwd: string): Promise<void> {
  const names = await gitFor(cwd)
    .env(workspaceGitLocalEnv())
    .raw(['config', '--local', '--no-includes', '--name-only', '-z', '--list'])
  if (names.split('\0').some((name) => UNSAFE_LOCAL_WORKSPACE_GIT_CONFIG.test(name))) {
    throw new Error('workspace Git configuration contains a disallowed network override or executable setting')
  }
}

/**
 * Pull exactly the daemon-authorized repository and branch. Supplying both
 * operands keeps checkout-controlled branch.*.remote / branch.*.merge config
 * out of daemon-managed network selection; the explicit destination also keeps
 * origin/<branch> current for status. check-ref-format prevents a configured
 * branch from being interpreted as an option or refspec.
 */
export async function pullWorkspaceRef(git: SimpleGit, remote: string, branch: string) {
  await git.raw(['check-ref-format', '--branch', branch])
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  return git.pull(remote, refspec, ['--ff-only', '--no-recurse-submodules'])
}

/** Module-level init (workspace-manager is functional; mirrors cloneInFlight). */
let shimPath: string | undefined
let runDir: string | undefined
let preWarm: ((agentId: string, reason: 'clone' | 'pull') => Promise<void>) | undefined
let capabilityFor: ((agentId: string) => string) | undefined

export function initGitInjection(opts: {
  shimPath: string
  runDir: string
  /** Warm the daemon credential cache BEFORE a timed git op (never inside its budget). */
  preWarm: (agentId: string, reason: 'clone' | 'pull') => Promise<void>
  /** Runtime-only local socket capability. Never written to a config file. */
  capabilityFor: (agentId: string) => string
}): void {
  shimPath = opts.shimPath
  runDir = opts.runDir
  preWarm = opts.preWarm
  capabilityFor = opts.capabilityFor
}

/** Auth for helper subprocesses. Keep separate from the persisted config pointers.
 *  Identity and capability are minted as a PAIR: the helper prefers this env
 *  identity over the agentId baked into a `.git/config` helper line, so a stale
 *  repo-local pin (previous agent generation) can never desync the two. */
export function gitCredentialEnv(agentId: string): Record<string, string> {
  if (!capabilityFor) throw new Error('git credential injection is not initialized')
  return { [GITCRED_CAPABILITY_ENV]: capabilityFor(agentId), [GITCRED_AGENT_ENV]: agentId }
}

function quotedHelper(agentId: string): string {
  if (!shimPath) throw new Error('git credential injection is not initialized')
  return `!'${shimPath.replaceAll("'", "'\\''")}' ${agentId}`
}

/** The three github.com-scoped config pairs both channels share. */
function credentialConfigPairs(agentId: string): Array<[string, string]> {
  return [
    ['credential.https://github.com.helper', ''], // reset: machine helpers must never answer for github.com
    ['credential.https://github.com.helper', quotedHelper(agentId)],
    ['credential.https://github.com.useHttpPath', 'true'] // git strips `path` otherwise — the helper wants it
  ]
}

/**
 * Env for a DAEMON-RUN git process (clone — no repo config exists yet).
 * Spread over `process.env` by the caller: simple-git's `.env()` REPLACES the
 * child environment (v3.36 verified), a bare object would strip PATH/HOME.
 */
export function cloneGitEnv(agentId: string, repository?: string): Record<string, string> {
  const pairs = [...workspaceGitConfigPairs(repository), ...credentialConfigPairs(agentId)]
  const env: Record<string, string> = {
    ...gitCredentialEnv(agentId),
    GIT_TERMINAL_PROMPT: '0',
    ...gitConfigEnv(pairs)
  }
  return env
}

/**
 * Session-env channel: (re)write the per-agent gitconfig and return the env to
 * inject into the agent's ACP runtime process. Regenerated on every host spawn
 * (#251 retries rebuild the host ⇒ this re-runs).
 */
export function sessionGitEnv(agentId: string, commitIdentity?: GitCommitIdentity): Record<string, string> {
  if (!runDir) throw new Error('git credential injection is not initialized')
  const dir = join(runDir, 'gitcred')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${agentId}.gitconfig`)
  const lines = [
    '# agentconnect session git config — regenerated on agent start; NO secrets.',
    '# Keeps non-identity host config, then pins github.com credentials to the daemon helper.',
    '[include]',
    `\tpath = ${join(homedir(), '.gitconfig')}`,
    '[credential "https://github.com"]',
    '\thelper = ', // reset the accumulated helper list for github.com
    `\thelper = ${quotedHelper(agentId)}`,
    '\tuseHttpPath = true',
    ''
  ]
  writeFileSync(file, lines.join('\n'), { mode: 0o644 })
  return {
    ...gitCredentialEnv(agentId),
    GIT_CONFIG_GLOBAL: file,
    GIT_TERMINAL_PROMPT: '0',
    ...(commitIdentity
      ? {
          GIT_AUTHOR_NAME: commitIdentity.name,
          GIT_AUTHOR_EMAIL: commitIdentity.email,
          GIT_COMMITTER_NAME: commitIdentity.name,
          GIT_COMMITTER_EMAIL: commitIdentity.email
        }
      : {})
  }
}

/** Post-clone: pin the repo-local helper so agent-run git in the checkout works. */
export async function writeRepoHelperConfig(cwd: string, agentId: string): Promise<void> {
  const git = gitFor(cwd).env(workspaceGitLocalEnv())
  // `--replace-all` on the first write resets any stale helper list from a
  // previous agent generation; addConfig(append=true) accumulates the rest.
  await git.raw(['config', '--replace-all', 'credential.https://github.com.helper', ''])
  await git.raw(['config', '--add', 'credential.https://github.com.helper', quotedHelper(agentId)])
  await git.raw(['config', 'credential.https://github.com.useHttpPath', 'true'])
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

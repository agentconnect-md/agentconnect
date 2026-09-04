import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sandboxBoundary, writeSandboxSettings, type SandboxMechanism } from '../acp/sandbox.js'
import { prepareSandboxTempDir, SANDBOX_TEMP_DIR_ENV } from '../acp/sandbox-temp.js'
import { hostKeyDirName, hostKeySessionKey, type HostKey } from '../acp/host-key.js'
import type { RuntimeDef } from '../config/config-schema.js'
import { compactReadRoots } from '../runtimes/read-roots.js'
import { prepareSharedRuntimeCredentials, sharedCredentialProfile } from '../runtimes/runtime-credentials.js'
import {
  hostPackageCacheEnv,
  prepareRuntimeHome,
  runtimeHomeEnvironment,
  runtimeHomePath
} from '../runtimes/runtime-home.js'
import { RUNTIME_STATE_LOCATIONS, runtimeStateLocations } from '../runtimes/probe.js'
import { primaryCheckoutIn, secondaryCheckoutsIn } from '../workspace/secondary-layout.js'
import { confinedSessionDirIn, sessionGitDirsIn, sessionHomeIn } from '../workspace/session-layout.js'
import {
  CLAUDE_PROFILE_ENV,
  claudeProtectedSettings,
  claudeProviderCredentialFiles,
  isClaudeRuntimeDef,
  type ClaudeProtectedSettings
} from '../runtime-defs/claude-runtime.js'
import {
  CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV,
  codexConfigWithoutPermissionOverrides,
  codexPermissionProfileConfig,
  type CodexPermissionProfileOptions
} from '../acp/codex-permission-profiles.js'

/** Canonicalize the deepest existing prefix, so a path below a symlink still reads as the kernel sees it. */
function existingRealpath(path: string): string {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Every `.git` DIRECTORY this agent's checkouts own — where a worktree's index, refs, and objects land. */
function gitMetadataDirsIn(agentRoot: string, primaryCheckout: string): string[] {
  return [primaryCheckout, ...secondaryCheckoutsIn(agentRoot)]
    .map((checkout) => join(checkout, '.git'))
    .filter((gitDir) => existsSync(gitDir) && lstatSync(gitDir).isDirectory())
}

/** The session directory a confined session host launches for (git-workspace-model §11) — the SAME record preparation reads, so the two tiers cannot disagree; undefined for the shared host, and for a session host with no clones (a dream, a model session). */
function confinedSessionDirOf(agentRoot: string, hostKey: HostKey | undefined): string | undefined {
  const sessionKey = hostKey === undefined ? undefined : hostKeySessionKey(hostKey)
  return sessionKey === undefined ? undefined : confinedSessionDirIn(agentRoot, sessionKey)
}

/** The private HOME a host launches with: a confined session's under its own directory (§11), any other host's under the agent dir. */
export function privateRuntimeHomeFor(scopeDir: string, hostKey: HostKey | undefined): string {
  const sessionDir = confinedSessionDirOf(existingRealpath(scopeDir), hostKey)
  return sessionDir === undefined ? runtimeHomePath(scopeDir) : sessionHomeIn(sessionDir)
}

/** The same roots with NO outer boundary: a confined session's clones own theirs (§11) and the agent's checkouts are not its, while one escaping the agent tree is left protected, not refused. */
function unsandboxedGitMetadataRoots(scopeDir: string, trustedPrimaryCheckout?: string, sessionDir?: string): string[] {
  const agentRoot = existingRealpath(scopeDir)
  const primaryCheckout = existingRealpath(trustedPrimaryCheckout ?? primaryCheckoutIn(agentRoot))
  const gitDirs =
    sessionDir === undefined ? gitMetadataDirsIn(agentRoot, primaryCheckout) : sessionGitDirsIn(sessionDir)
  return compactReadRoots(
    gitDirs.map((gitDir) => realpathSync(gitDir)).filter((gitDir) => gitDir !== agentRoot && inside(agentRoot, gitDir))
  )
}

function applyCodexPermissionProfile(
  env: Record<string, string>,
  opts: CodexPermissionProfileOptions,
  inheritedCodexConfig?: string
): void {
  const profileConfig = codexPermissionProfileConfig(opts)
  if (!profileConfig) return

  const codexConfig = codexConfigWithoutPermissionOverrides(env.CODEX_CONFIG ?? inheritedCodexConfig)
  if (codexConfig !== undefined) env.CODEX_CONFIG = codexConfig
  env[CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV] = JSON.stringify(profileConfig)
}

function disabledClaudeProfileRoot(scopeDir: string): string {
  const root = realpathSync(resolve(scopeDir))
  const target = join(root, '.agentconnect', 'runtime-policy', 'claude-profile-disabled')
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`disabled Claude profile path is not a real directory: ${current}`)
      }
      continue
    }
    mkdirSync(current, { mode: 0o700 })
  }
  if (readdirSync(target).length > 0) {
    throw new Error(`disabled Claude profile directory is not empty: ${target}`)
  }
  chmodSync(target, 0o500)
  return realpathSync(target)
}

/** Ambient desktop/session IPC must not reconnect a sandboxed runtime to host
 * services merely because the daemon inherited a pointer to their socket. */
const HOST_SOCKET_POINTER_ENV = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'PULSE_SERVER',
  'PIPEWIRE_REMOTE',
  'GPG_AGENT_INFO',
  'GNOME_KEYRING_CONTROL',
  'SESSION_MANAGER',
  'TMUX',
  'VSCODE_IPC_HOOK_CLI',
  'NOTIFY_SOCKET',
  'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE'
] as const

const LOCAL_CONTAINER_ENDPOINT_ENV = ['DOCKER_HOST', 'CONTAINER_HOST', 'BUILDKIT_HOST', 'PODMAN_HOST'] as const
function isLocalSocketEndpoint(value: string): boolean {
  const endpoint = value.trim().toLowerCase()
  return endpoint.startsWith('/') || /^(?:unix|npipe|fd):/.test(endpoint)
}

function isolateHostSocketEnvironment(env: Record<string, string>, runtimeHome: string): void {
  const runtimeDir = join(runtimeHome, '.run')
  if (existsSync(runtimeDir)) {
    const stat = lstatSync(runtimeDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`private XDG runtime path must be a real directory: ${runtimeDir}`)
    }
  }
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  chmodSync(runtimeDir, 0o700)

  for (const name of HOST_SOCKET_POINTER_ENV) delete env[name]
  for (const name of LOCAL_CONTAINER_ENDPOINT_ENV) {
    if (env[name] && isLocalSocketEndpoint(env[name])) delete env[name]
  }
  env.XDG_RUNTIME_DIR = realpathSync(runtimeDir)
}

/** Point the confined child's temp state at this host's own `<agentDir>/t/<8 hex>` and return it. The private HOME is the wrong home for it: SRT's multiplexer socket lives directly under TMPDIR, and a per-session HOME made that socket path overflow `sun_path` (#1763). */
function isolateSandboxTempEnvironment(env: Record<string, string>, scopeDir: string, hostKey: HostKey | undefined) {
  const tempDir = prepareSandboxTempDir(scopeDir, hostKey)
  env.TMPDIR = tempDir
  env.CLAUDE_CODE_TMPDIR = tempDir
  env.CLAUDE_TMPDIR = tempDir
  // The provider reads this one and drops it before wrapping, so the daemon decides the path instead of recomputing it from HOME.
  env[SANDBOX_TEMP_DIR_ENV] = tempDir
  return tempDir
}

export interface PreparedRuntimeLaunch {
  env: Record<string, string>
  /** Sandboxed launches carry a sanitized environment; unsandboxed launches inherit the daemon environment. */
  inheritProcessEnv: boolean
  /** The `.git` directories this launch reopened for the runtime's Git writes — empty when nothing
   *  was confined or nothing was found. Logged at spawn so a stale grant is visible after the fact. */
  gitMetadataWriteRoots: string[]
  runtimeHome?: string
  sandbox?: {
    mechanism: SandboxMechanism
    writable: string[]
    settingsPath: string
    cwd: string
    denyReadRoots: string[]
    allowReadRoots: string[]
    /** Credential paths deliberately exposed to the trusted runtime parent but
     * denied again inside a runtime-native tool sandbox. */
    protectedCredentialRoots: string[]
    /** A daemon-owned model-side Unix channel deliberately exposed to the
     * runtime, currently the agent-scoped GitHub credential socket. */
    allowModelToolUnixSockets?: boolean
    /** Highest-precedence Claude settings that keep project/local settings from
     * redirecting the trusted parent to an attacker-selected credential profile. */
    claudeProtectedSettings?: ClaudeProtectedSettings
  }
}

/** Daemon policy overrides the per-agent preference. Without an available host
 * mechanism, an optional sandbox request is ineffective. An externalExecution
 * runtime downgrades an optional request (its execution lives outside any local
 * sandbox), while requireSandbox stays true so the launch is refused loudly. */
export function effectiveRunInSandbox(
  requireSandbox: boolean,
  requested: boolean,
  mechanism: SandboxMechanism | undefined,
  runtime?: Pick<RuntimeDef, 'externalExecution'>
): boolean {
  return requireSandbox || (requested && mechanism !== undefined && runtime?.externalExecution !== true)
}

/** Prepare one ACP adapter launch. A private HOME is normally part of sandbox
 * isolation, but security probes and runtimes with generated private policy may
 * request the same environment isolation without an OS sandbox. */
export function prepareRuntimeLaunch(opts: {
  runtimeId: string
  runtime?: RuntimeDef
  scopeDir: string
  cwd: string
  /** Which host this launch is for; its sandbox policy lives in a per-host directory. Absent only for
   *  a single-launch scope such as a probe, which then takes the shared host's leaf. */
  hostKey?: HostKey
  runInSandbox: boolean
  isolateHome?: boolean
  explicitEnv?: Record<string, string>
  /** Host state roots used only to seed the private HOME. Probe launches keep
   * these separate from their deliberately tiny child environment. */
  stateSourceEnv?: NodeJS.ProcessEnv
  hostEnv?: NodeJS.ProcessEnv
  /** True when the runtime will run in a sandbox pod rather than on this host. */
  k8s?: boolean
  /** Trusted daemon root. Required for an enforced sandbox so all daemon-owned
   * state is hidden before current-agent surfaces are carved back. */
  daemonRoot?: string
  /** Configured agents directory when it is outside daemonRoot. */
  agentsRoot?: string
  /** Daemon/registry-owned executable and package roots needed to start the
   * runtime and its configured stdio children. Never derive this from agent env. */
  trustedRuntimeReadRoots?: string[]
  /** Additional daemon-derived workspace parents (for session worktrees).
   * Every entry is revalidated as a strict descendant of scopeDir. */
  trustedWorkspaceWriteRoots?: string[]
  trustedPrimaryCheckout?: string
  /** Operator-declared host dirs (`security.sandboxWriteRoots`) reopened writable: a shared package store, never the daemon's own. */
  trustedOperatorWriteRoots?: string[]
  /** Test seam. Shared login remains Linux-only with the sandbox rollout. */
  credentialPlatform?: NodeJS.Platform
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
  /** Permit the runtime-native tool sandbox to reach a daemon-owned Unix
   * channel. An enabled outer sandbox remains the surrounding boundary. */
  allowModelToolUnixSockets?: boolean
  /** Probe launches only: keep npx/uvx on the HOST package cache (see
   * hostPackageCacheEnv). A probe never runs a model turn; an agent launch must not
   * get this, so its confined tool use cannot write another runtime's install tree. */
  hostPackageCache?: boolean
}): PreparedRuntimeLaunch {
  const credentialProfile = sharedCredentialProfile(opts.runtimeId, opts.runtime)
  // A confined session's own directory (§11), read before anything branches: the tier is the session's and
  // does not follow the boundary, so an unsandboxed launch of one still runs against its clones, not the agent's.
  const sessionDir = confinedSessionDirOf(existingRealpath(opts.scopeDir), opts.hostKey)
  const sessionHome = sessionDir === undefined ? undefined : sessionHomeIn(sessionDir)
  if (!opts.runInSandbox && !opts.isolateHome) {
    const env = { ...(opts.explicitEnv ?? {}) }
    // No outer boundary here: the Codex profile must both reopen the Git metadata and close hooks/config.
    const gitMetadataWriteRoots =
      credentialProfile === 'codex'
        ? unsandboxedGitMetadataRoots(opts.scopeDir, opts.trustedPrimaryCheckout, sessionDir)
        : []
    if (credentialProfile === 'codex') {
      applyCodexPermissionProfile(
        env,
        {
          protectedRoots: [],
          // A session's clones take the exact per-clone entries; an owner checkout's `.git` takes the worktree ones.
          ...(sessionDir === undefined
            ? { writableGitMetadataRoots: gitMetadataWriteRoots }
            : { sessionGitMetadataRoots: gitMetadataWriteRoots }),
          allowModelToolUnixSockets: opts.allowModelToolUnixSockets === true
        },
        (opts.hostEnv ?? process.env).CODEX_CONFIG
      )
    }
    // NOT in k8s: the runtime runs in a sandbox pod, so the daemon's own environment describes a
    // different machine. Inheriting it sent this daemon's HOME across, and the runtime then tried
    // to open its state under a path that exists only here. The pod supplies its own basics.
    return { env, inheritProcessEnv: opts.k8s !== true, gitMetadataWriteRoots }
  }
  if (opts.runInSandbox && opts.runtime?.externalExecution) {
    throw new Error(
      `runtime "${opts.runtimeId}" executes in an external machine-local service the OS sandbox cannot contain — it can only launch unconfined`
    )
  }
  if (opts.runInSandbox && !opts.sandboxMechanism) {
    throw new Error('OS sandbox requested but this host has no supported Linux SRT/bwrap mechanism')
  }
  if (opts.runInSandbox && !opts.daemonRoot) {
    throw new Error('OS sandbox requested without the trusted AgentConnect daemon root')
  }

  const stateSourceEnv = opts.stateSourceEnv ?? opts.hostEnv ?? process.env
  const safeRoot = (path: string, label: string): string => {
    if (!isAbsolute(path)) throw new Error(`unsafe ${label} for sandboxing: ${path}`)
    const real = existingRealpath(path)
    if (real === sep) throw new Error(`unsafe ${label} for sandboxing: ${path}`)
    return real
  }

  // Validate every broad boundary and the current-agent layout before touching
  // host credentials. A bad daemon root or escaping workspace must fail without
  // partially migrating login state.
  let protectedRoots: string[] = []
  let protectedBoundaryRoots: string[] = []
  let protectedRuntimeStateRoots: string[] = []
  let denyReadRoots: string[] = []
  if (opts.runInSandbox) {
    sandboxBoundary({
      agentDir: opts.scopeDir,
      cwd: opts.cwd,
      runtimeHome: sessionHome ?? runtimeHomePath(opts.scopeDir)
    })
    const daemonRoot = safeRoot(opts.daemonRoot!, 'AgentConnect daemon root')
    const agentRoot = safeRoot(opts.scopeDir, 'agent root')
    const hostHomeRoots = compactReadRoots(
      [...new Set([stateSourceEnv.HOME, homedir()].filter((path): path is string => Boolean(path)))].map((path) =>
        safeRoot(path, 'host HOME')
      )
    )
    const sharedTempRoots = ['/tmp', '/var/tmp', stateSourceEnv.TMPDIR, stateSourceEnv.TMP, stateSourceEnv.TEMP]
      .filter((path): path is string => Boolean(path))
      .map((path) => safeRoot(path, 'shared temp root'))
    // Linux service sockets conventionally live below /run; /var/run resolves
    // there as well. The outer parent keeps AF_UNIX available for AgentConnect's
    // exact carve-backs, so mount visibility is the host-socket boundary.
    const hostSocketRoots = [safeRoot('/run', 'host socket root')]
    protectedRuntimeStateRoots = Object.keys(RUNTIME_STATE_LOCATIONS).flatMap((id) =>
      runtimeStateLocations(id, stateSourceEnv).map((location) => safeRoot(location.source, `${id} host state root`))
    )
    protectedBoundaryRoots = [
      daemonRoot,
      agentRoot,
      ...(opts.agentsRoot ? [safeRoot(opts.agentsRoot, 'agents root')] : []),
      ...hostHomeRoots,
      ...sharedTempRoots,
      ...hostSocketRoots
    ]
    protectedRoots = [...protectedBoundaryRoots, ...protectedRuntimeStateRoots]
    denyReadRoots = compactReadRoots(protectedRoots)
  }

  const validateException = (path: string, label: string): string => {
    const trusted = safeRoot(path, label)
    // An exception may sit below a hidden root, but must never equal or contain
    // one: that would reopen HOME, daemon state, temp, or an entire agent root.
    const broadened = protectedRoots.find((denied) => inside(trusted, denied))
    if (broadened) throw new Error(`${label} "${trusted}" would reopen protected path "${broadened}"`)
    return trusted
  }
  const trustedRuntimeReadRoots = compactReadRoots(
    (opts.trustedRuntimeReadRoots ?? [])
      .map((path) => validateException(path, 'trusted runtime read root'))
      // The root filesystem is already read-only. A carve-back is needed only
      // when a broad read deny would otherwise hide this installation path.
      .filter((trusted) => denyReadRoots.some((denied) => inside(denied, trusted)))
  )

  const credentials = prepareSharedRuntimeCredentials({
    runtimeId: opts.runtimeId,
    runtime: opts.runtime,
    hostEnv: stateSourceEnv,
    platform: opts.credentialPlatform
  })
  const runtimeHome = prepareRuntimeHome(
    opts.runtimeId,
    opts.scopeDir,
    stateSourceEnv,
    sessionHome,
    credentials?.seedExclusions
  )
  credentials?.preparePrivateHome(runtimeHome)
  const packageCacheEnv = opts.hostPackageCache ? hostPackageCacheEnv(opts.runtime?.command, stateSourceEnv) : {}
  const env = {
    ...runtimeHomeEnvironment(opts.runtimeId, runtimeHome, opts.explicitEnv, opts.hostEnv),
    ...packageCacheEnv,
    ...credentials?.env
  }

  let sandboxTempDir: string | undefined
  if (opts.runInSandbox) {
    isolateHostSocketEnvironment(env, runtimeHome)
    // NOT in k8s: a sandbox pod supplies its own temp dir, and this daemon must not name a path on a machine it is not on.
    if (opts.k8s !== true) sandboxTempDir = isolateSandboxTempEnvironment(env, opts.scopeDir, opts.hostKey)
  }

  if (!opts.runInSandbox) {
    const gitMetadataWriteRoots =
      credentialProfile === 'codex'
        ? unsandboxedGitMetadataRoots(opts.scopeDir, opts.trustedPrimaryCheckout, sessionDir)
        : []
    if (credentialProfile === 'codex') {
      const privateCodex = join(runtimeHome, '.codex')
      applyCodexPermissionProfile(env, {
        protectedRoots: existsSync(privateCodex) ? [realpathSync(privateCodex)] : [],
        // A session's clones take the exact per-clone entries and its own HOME (§11); an owner checkout's `.git` takes the worktree ones.
        ...(sessionDir === undefined
          ? { writableGitMetadataRoots: gitMetadataWriteRoots }
          : { sessionGitMetadataRoots: gitMetadataWriteRoots, sessionHomeRoot: existingRealpath(runtimeHome) }),
        allowModelToolUnixSockets: opts.allowModelToolUnixSockets === true
      })
    }
    return { env, inheritProcessEnv: false, runtimeHome, gitMetadataWriteRoots }
  }

  // PATH entries supplied by version managers are commonly symlinks below the
  // now-hidden host HOME. Resolve existing absolute entries while still outside
  // the namespace so runtime-spawned tools use the reviewed real installation.
  if (env.PATH) {
    env.PATH = env.PATH.split(delimiter)
      .map((entry) => {
        if (!isAbsolute(entry) || !existsSync(entry)) return entry
        try {
          return realpathSync(entry)
        } catch {
          return entry
        }
      })
      .join(delimiter)
  }
  const credentialWritableRoots = compactReadRoots(
    (credentials?.writablePaths ?? []).map((path) => {
      const trusted = safeRoot(path, 'shared credential write root')
      // A credential capability may equal one hidden runtime-state root (the
      // default Claude layout), but it must not contain another protected root
      // or reopen HOME, daemon state, an agent root, or shared temp wholesale.
      const broadened =
        protectedBoundaryRoots.find((denied) => inside(trusted, denied)) ??
        protectedRuntimeStateRoots.find((denied) => trusted !== denied && inside(trusted, denied))
      if (broadened) {
        throw new Error(`shared credential write root "${trusted}" would reopen protected path "${broadened}"`)
      }
      return trusted
    })
  )
  // npm/uv must WRITE their cache (tarballs, index, the npx install tree), so the
  // pinned host cache needs a write carve-back below the hidden host HOME. Same rule
  // as a shared credential root: it may sit under a protected root, never contain one.
  const packageCacheWriteRoots = compactReadRoots(
    Object.values(packageCacheEnv).map((path) => {
      const trusted = safeRoot(path, 'host package cache root')
      const broadened = protectedRoots.find((denied) => inside(trusted, denied))
      if (broadened) throw new Error(`host package cache root "${trusted}" would reopen protected path "${broadened}"`)
      return trusted
    })
  )
  // An operator write root follows the exception rule: it may sit below the hidden host HOME (a pnpm store does), never equal or contain HOME, daemon state, an agent root, or shared temp.
  const operatorWriteRoots = compactReadRoots(
    (opts.trustedOperatorWriteRoots ?? []).map((path) => validateException(path, 'security.sandboxWriteRoots entry'))
  )
  const agentRoot = safeRoot(opts.scopeDir, 'agent root')
  const trustedWorkspaceWriteRoots = compactReadRoots(
    (opts.trustedWorkspaceWriteRoots ?? []).map((path) => {
      const trusted = safeRoot(path, 'trusted workspace write root')
      if (trusted === agentRoot || !inside(agentRoot, trusted)) {
        throw new Error(`trusted workspace write root "${trusted}" is outside the agent root`)
      }
      return trusted
    })
  )
  // A confined session's clones own their `.git` (§11), so the primary's is never reopened for it; otherwise an isolated session's worktree keeps its index, refs and objects in the OWNER checkout's `.git`, which no other carve-back covers and which the daemon names (a locally authored agent may keep a path the layout does not).
  const primaryCheckout = opts.trustedPrimaryCheckout
    ? safeRoot(opts.trustedPrimaryCheckout, 'trusted primary checkout')
    : primaryCheckoutIn(agentRoot)
  if (primaryCheckout === agentRoot || !inside(agentRoot, primaryCheckout)) {
    throw new Error(`trusted primary checkout "${primaryCheckout}" is outside the agent root`)
  }
  const gitMetadataWriteRoots = compactReadRoots(
    (sessionDir === undefined ? gitMetadataDirsIn(agentRoot, primaryCheckout) : sessionGitDirsIn(sessionDir)).map(
      (gitDir) => {
        const trusted = safeRoot(gitDir, 'git metadata root')
        if (trusted === agentRoot || !inside(agentRoot, trusted)) {
          throw new Error(`git metadata root "${trusted}" is outside the agent root`)
        }
        return trusted
      }
    )
  )
  const claudeRuntime = Boolean(opts.runtime && isClaudeRuntimeDef(opts.runtime))
  if (claudeRuntime) {
    // Anthropic profile JSON may live in the agent-writable private HOME and may
    // reference arbitrary host paths. Fail closed instead of letting that mutable
    // input influence the trusted parent or outer sandbox. The fixed empty root is
    // daemon-owned and only read-exposed by sandboxBoundary; shared Claude /login
    // uses the separate daemon-managed secure-storage directory prepared above.
    for (const name of CLAUDE_PROFILE_ENV) delete env[name]
    env.ANTHROPIC_CONFIG_DIR = disabledClaudeProfileRoot(opts.scopeDir)
  }
  const protectedClaudeSettings = claudeRuntime ? claudeProtectedSettings(env) : undefined
  const providerCredentialFiles = claudeRuntime ? claudeProviderCredentialFiles(env, opts.cwd) : []
  const providerCredentialReadRoots = compactReadRoots(
    providerCredentialFiles.map(({ envName, path }) => {
      const canonical = validateException(path, 'Claude provider credential file')
      // The exception is canonical; point the trusted parent at that same path so
      // a credential symlink below a hidden HOME cannot become unreadable.
      if (envName) env[envName] = canonical
      return canonical
    })
  )
  // Claude user state is copied into the private HOME for the trusted parent.
  // It may contain settings.env secrets or MCP credentials, so deny every seeded
  // Claude state surface to the inner Bash sandbox without changing outer access.
  const privateClaudeStateRoots = claudeRuntime
    ? [join(runtimeHome, '.claude'), join(runtimeHome, '.claude.json')]
        .filter(existsSync)
        .map((path) => realpathSync(path))
    : []
  const privateCodexStateRoots = credentialProfile === 'codex' ? [realpathSync(join(runtimeHome, '.codex'))] : []

  const boundary = sandboxBoundary({
    agentDir: opts.scopeDir,
    cwd: opts.cwd,
    runtimeHome,
    mcpSocketPath: opts.mcpSocketPath,
    trustedReadRoots: [...trustedRuntimeReadRoots, ...providerCredentialReadRoots],
    trustedWriteRoots: [
      ...credentialWritableRoots,
      ...trustedWorkspaceWriteRoots,
      ...packageCacheWriteRoots,
      ...operatorWriteRoots,
      ...gitMetadataWriteRoots,
      // Inside the agent dir like every other writable root, so the agent-dir rule needs no exemption for it.
      ...(sandboxTempDir === undefined ? [] : [sandboxTempDir])
    ]
  })
  // SRT write roots must exist before spawn.
  // This also initializes workspace/memory for a newly-created agent.
  for (const path of boundary.writable) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
  }
  if (opts.runtime && isClaudeRuntimeDef(opts.runtime)) {
    // Both layers use SRT. If `.claude` itself is absent, the outer layer masks
    // that first missing component read-only while protecting nested Claude
    // config paths; Claude's inner bwrap can then no longer create its own
    // settings mountpoint. An empty directory is enough and produces no Git diff.
    const projectClaudeDir = join(boundary.gitSafeDirectories[0]!, '.claude')
    if (!existsSync(projectClaudeDir)) mkdirSync(projectClaudeDir, { mode: 0o700 })
  }
  const settingsPath = writeSandboxSettings(opts.scopeDir, hostKeyDirName(opts.hostKey), {
    writable: boundary.writable,
    // Host user data is default-denied. Re-open only the current agent surfaces
    // plus trusted executable/package roots above; never an agent-provided path.
    denyRead: denyReadRoots,
    allowRead: boundary.allowRead,
    // A Git metadata root is opened for the index, refs, and objects alone. SRT's own mandatory
    // protection only covers a `.git` DIRECTORY below the cwd, which an isolated worktree's link
    // file is not, so hooks and config are closed here instead.
    denyWrite: gitMetadataWriteRoots.flatMap((gitDir) => [join(gitDir, 'hooks'), join(gitDir, 'config')]),
    gitSafeDirectories: boundary.gitSafeDirectories
  })
  const protectedCredentialRoots = compactReadRoots([
    ...credentialWritableRoots,
    ...providerCredentialReadRoots,
    ...privateClaudeStateRoots,
    ...privateCodexStateRoots
  ])
  if (credentialProfile === 'codex') {
    // Codex's :workspace protects `.git` and pins writes to the cwd: re-open only what the outer sandbox already made writable.
    const outerWritable = (path: string): boolean => boundary.writable.some((root) => inside(root, path))
    const writableGitMetadataRoots = gitMetadataWriteRoots.filter(outerWritable)
    // A confined session's HOME is a SIBLING of the cwd (§11), so `:workspace` leaves it unwritable and no package manager can reach its own cache.
    const sessionHomeRoot = sessionDir === undefined ? undefined : existingRealpath(runtimeHome)
    applyCodexPermissionProfile(env, {
      protectedRoots: protectedCredentialRoots,
      // A session's clones take the exact per-clone entries; an owner checkout's `.git` takes the worktree ones.
      ...(sessionDir === undefined
        ? { writableGitMetadataRoots }
        : { sessionGitMetadataRoots: writableGitMetadataRoots }),
      ...(sessionHomeRoot !== undefined && outerWritable(sessionHomeRoot) ? { sessionHomeRoot } : {}),
      allowModelToolUnixSockets: opts.allowModelToolUnixSockets === true,
      disableUnifiedExec: true
    })
  }
  return {
    env,
    inheritProcessEnv: false,
    runtimeHome,
    gitMetadataWriteRoots,
    sandbox: {
      mechanism: opts.sandboxMechanism!,
      writable: boundary.writable,
      settingsPath,
      cwd: boundary.gitSafeDirectories[0]!,
      denyReadRoots,
      allowReadRoots: boundary.allowRead,
      protectedCredentialRoots,
      ...(opts.allowModelToolUnixSockets ? { allowModelToolUnixSockets: true } : {}),
      ...(protectedClaudeSettings ? { claudeProtectedSettings: protectedClaudeSettings } : {})
    }
  }
}

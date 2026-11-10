import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { parse } from 'smol-toml'

export const CODEX_ACP_PERMISSION_PROFILE_CONFIG_ENV = 'CODEX_ACP_PERMISSION_PROFILE_CONFIG'

const PROFILE_IDS = {
  'read-only': 'agentconnect-protected-read-only',
  agent: 'agentconnect-protected-workspace',
  'agent-full-access': 'agentconnect-protected-full-access'
} as const

export interface CodexPermissionProfileConfig {
  configOverrides: string[]
  modeProfiles: Record<keyof typeof PROFILE_IDS, string>
}

/** Reopen this session's exact admin directories, within the launcher's existing Git grants. */
export async function codexSessionPermissionProfiles(
  launchConfig: string,
  gitRoots: readonly string[],
  directories: readonly string[]
): Promise<Record<string, unknown> | undefined> {
  const config = JSON.parse(launchConfig) as CodexPermissionProfileConfig
  const profiles = parse(config.configOverrides.join('\n')).permissions as Record<
    string,
    { filesystem?: Record<string, string> }
  >
  const writableProfiles = [config.modeProfiles.agent, config.modeProfiles['agent-full-access']]
  let changed = false
  for (const directory of new Set(directories)) {
    const dotGit = join(directory, '.git')
    let target: string | undefined
    try {
      const stat = await lstat(dotGit)
      if (!stat.isFile() || stat.size > 8192) continue
      const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim()
      if (pointer) target = await realpath(resolve(directory, pointer))
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    if (!target) continue
    const root = gitRoots.find((candidate) => dirname(target) === join(candidate, 'worktrees'))
    if (!root) continue
    // Codex can protect a missing file, but a read-only directory must exist before sandbox setup.
    for (const gitDir of [root, target]) await mkdir(join(gitDir, 'hooks'), { recursive: true })
    for (const id of writableProfiles) {
      const filesystem = profiles[id]?.filesystem
      if (filesystem?.[root] !== 'write' || filesystem[`${join(root, 'worktrees')}/**`] !== 'write') continue
      filesystem[target] = 'write'
      for (const name of ['hooks', 'config', 'config.worktree']) filesystem[join(target, name)] = 'read'
      changed = true
    }
  }
  return changed ? profiles : undefined
}

export interface CodexPermissionProfileOptions {
  /** Denied outright: credentials, and the files and links that hold them. */
  protectedRoots: readonly string[]
  /** Runtime state the model's tools read back but must not change (a private `.codex`): `read` in every profile. */
  readOnlyRoots?: readonly string[]
  /** Owner checkouts' `.git`, whose `worktrees/**` hold the session worktrees' admin dirs. */
  writableGitMetadataRoots?: readonly string[]
  /** A session's own clones' `.git` (git-workspace-model §11): exact entries, nothing hangs off them. */
  sessionGitMetadataRoots?: readonly string[]
  /** A confined session's private HOME (§11) — a SIBLING of the cwd, so `:workspace` never reaches it. */
  sessionHomeRoot?: string
  /** Operator-declared writable `sandbox.mounts` the outer boundary already opened: a shared package store, outside the cwd. */
  sharedWriteRoots?: readonly string[]
  allowModelToolUnixSockets?: boolean
  disableUnifiedExec?: boolean
}

/** Prevent session config from redefining the daemon-owned profiles selected by
 * the adapter. Invalid/non-object input remains the adapter's responsibility. */
export function codexConfigWithoutPermissionOverrides(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return raw

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw

  const config = parsed as Record<string, unknown>
  let changed = false
  for (const key of Object.keys(config)) {
    if (
      key === 'permissions' ||
      key.startsWith('permissions.') ||
      key === 'default_permissions' ||
      key.startsWith('default_permissions.')
    ) {
      delete config[key]
      changed = true
    }
  }
  return changed ? JSON.stringify(config) : raw
}

/** Build the complete inner-tool policy from daemon-owned canonical paths. */
export function codexPermissionProfileConfig(
  opts: CodexPermissionProfileOptions
): CodexPermissionProfileConfig | undefined {
  const protectedRoots = [...new Set(opts.protectedRoots.map((root) => normalize(root)))]
  const writableGitMetadataRoots = [...new Set((opts.writableGitMetadataRoots ?? []).map((root) => normalize(root)))]
  const sessionGitMetadataRoots = [...new Set((opts.sessionGitMetadataRoots ?? []).map((root) => normalize(root)))]
  const sessionHomeRoot = opts.sessionHomeRoot === undefined ? undefined : normalize(opts.sessionHomeRoot)
  const sharedWriteRoots = [...new Set((opts.sharedWriteRoots ?? []).map((root) => normalize(root)))]
  // The session's own `.codex` is read-only by default, whatever the caller names: its HOME is writable, and the
  // ACP parent's state below it must not be. Read-only and not denied, because Codex execs its linux-sandbox helper
  // from `$CODEX_HOME/tmp/arg0` through its own bwrap, which masks a denied directory — in every profile, including
  // the read-only one automatic approval review runs under.
  const readOnlyRoots = [
    ...new Set([
      ...(opts.readOnlyRoots ?? []).map((root) => normalize(root)),
      ...(sessionHomeRoot === undefined ? [] : [join(sessionHomeRoot, '.codex')])
    ])
  ]
  const policyRoots = [
    ...protectedRoots,
    ...readOnlyRoots,
    ...writableGitMetadataRoots,
    ...sessionGitMetadataRoots,
    ...(sessionHomeRoot === undefined ? [] : [sessionHomeRoot]),
    ...sharedWriteRoots
  ]
  if (policyRoots.length === 0 && !opts.allowModelToolUnixSockets && !opts.disableUnifiedExec) return undefined
  if (policyRoots.some((root) => !isAbsolute(root))) {
    throw new Error('Codex permission roots must be absolute paths')
  }

  // A caller that cannot list the session's `.codex` (an executor's HOME, on another machine) denies it whole; Codex
  // then finds its linux-sandbox helper only through a WRITABLE carve-out, since its bwrap masks a denied directory
  // and reopens writable descendants alone. The read-only derivative approval review runs under keeps no write, so
  // only the read-only state directory above serves that review.
  const deniedCodexHome = sessionHomeRoot === undefined ? undefined : join(sessionHomeRoot, '.codex')
  const helperCarveOut: Array<[string, string]> =
    deniedCodexHome !== undefined && protectedRoots.includes(deniedCodexHome)
      ? [[join(deniedCodexHome, 'tmp', 'arg0'), 'write']]
      : []
  const readOnlyFilesystem =
    protectedRoots.length > 0
      ? [
          `permissions.${PROFILE_IDS['read-only']}.filesystem=${tomlInlineTable(
            protectedRoots.map((root): [string, string] => [root, 'deny'])
          )}`
        ]
      : []
  // Session setup adds exact worktree admin grants; hooks/config remain readable but protected.
  const agentFilesystemEntries: Array<[string, string]> = [
    ...writableGitMetadataRoots.map((root): [string, string] => [root, 'write']),
    ...writableGitMetadataRoots.flatMap((root): Array<[string, string]> => [
      // Codex strips only a literal `/**` suffix, so Windows' `\**` from join reads as a write glob and aborts its start.
      [`${join(root, 'worktrees')}/**`, 'write'],
      [join(root, 'hooks'), 'read'],
      [join(root, 'config'), 'read']
    ]),
    ...sessionGitMetadataRoots.flatMap((root): Array<[string, string]> => [
      [root, 'write'],
      [join(root, 'hooks'), 'read'],
      [join(root, 'config'), 'read']
    ]),
    // §11's per-session HOME holds the package caches and runtime state.
    ...(sessionHomeRoot === undefined ? [] : ([[sessionHomeRoot, 'write']] as Array<[string, string]>)),
    // Most specific wins: the private state is read-only below the writable HOME, and its credentials are denied below that.
    ...readOnlyRoots.map((root): [string, string] => [root, 'read']),
    // A shared store sits outside the cwd, so `:workspace` alone would refuse the very install it exists for; the read-only mode keeps refusing it.
    ...sharedWriteRoots.map((root): [string, string] => [root, 'write']),
    ...protectedRoots.map((root): [string, string] => [root, 'deny']),
    ...helperCarveOut
  ]
  const agentFilesystem =
    agentFilesystemEntries.length > 0
      ? [`permissions.${PROFILE_IDS.agent}.filesystem=${tomlInlineTable(agentFilesystemEntries)}`]
      : []
  // A writable `:root` beside a deny takes Codex's restricted Linux sandbox, whose root rebind remounts `/dev` nodev (openai/codex#16451), so with a deny full access keeps the workspace profile's writes.
  const fullAccessFilesystem =
    protectedRoots.length > 0 || readOnlyRoots.length > 0
      ? [
          `permissions.${PROFILE_IDS['agent-full-access']}.extends=":workspace"`,
          ...(agentFilesystemEntries.length > 0
            ? [`permissions.${PROFILE_IDS['agent-full-access']}.filesystem=${tomlInlineTable(agentFilesystemEntries)}`]
            : [])
        ]
      : [
          `permissions.${PROFILE_IDS['agent-full-access']}.filesystem=${tomlInlineTable([
            [':root', 'write'],
            ['/.git', 'write'],
            ['/.agents', 'write'],
            ['/.codex', 'write'],
            ...sharedWriteRoots.map((root): [string, string] => [root, 'write'])
          ])}`
        ]
  // On Linux Codex's restricted network seccomp permits AF_UNIX socket()
  // creation but rejects connect(). Enable the inner network layer only when
  // the daemon deliberately provides the agent-scoped GitHub credential
  // channel. When enabled, outer SRT remains the boundary; when disabled by the
  // operator, the launch is already explicitly unconfined.
  const credentialChannelNetwork = opts.allowModelToolUnixSockets
    ? [
        `permissions.${PROFILE_IDS['read-only']}.network.enabled=true`,
        `permissions.${PROFILE_IDS.agent}.network.enabled=true`
      ]
    : []

  return {
    configOverrides: [
      `default_permissions="${PROFILE_IDS.agent}"`,
      `permissions.${PROFILE_IDS['read-only']}.extends=":read-only"`,
      `permissions.${PROFILE_IDS.agent}.extends=":workspace"`,
      ...readOnlyFilesystem,
      ...agentFilesystem,
      ...credentialChannelNetwork,
      // Temporary until the bundled Codex includes the openai/codex#34115 fix:
      // Guardian approval can otherwise hide the canonical unified-exec process.
      ...(opts.disableUnifiedExec ? ['features.unified_exec=false'] : []),
      ...fullAccessFilesystem,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.enabled=true`,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.allow_local_binding=true`,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.dangerously_allow_all_unix_sockets=true`
    ],
    modeProfiles: { ...PROFILE_IDS }
  }
}

export function applyCodexPermissionProfile(
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

function tomlInlineTable(entries: Array<[string, string]>): string {
  return `{ ${[...new Map(entries)].map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }`
}

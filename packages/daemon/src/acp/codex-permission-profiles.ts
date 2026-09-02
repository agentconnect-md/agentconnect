import { isAbsolute, join, normalize } from 'node:path'

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

export interface CodexPermissionProfileOptions {
  protectedRoots: readonly string[]
  /** Owner checkouts' `.git`, whose `worktrees/**` hold the session worktrees' admin dirs. */
  writableGitMetadataRoots?: readonly string[]
  /** A session's own clones' `.git` (git-workspace-model §11): exact entries, nothing hangs off them. */
  sessionGitMetadataRoots?: readonly string[]
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
  const policyRoots = [...protectedRoots, ...writableGitMetadataRoots, ...sessionGitMetadataRoots]
  if (policyRoots.length === 0 && !opts.allowModelToolUnixSockets && !opts.disableUnifiedExec) return undefined
  if (policyRoots.some((root) => !isAbsolute(root))) {
    throw new Error('Codex permission roots must be absolute paths')
  }

  const readOnlyFilesystem =
    protectedRoots.length > 0
      ? [
          `permissions.${PROFILE_IDS['read-only']}.filesystem=${tomlInlineTable(
            protectedRoots.map((root): [string, string] => [root, 'deny'])
          )}`
        ]
      : []
  // Most-specific match wins; hooks/config get `read` (`deny` hides them, and Git needs its config); an owner `.git` names its `worktrees/**` because :workspace pins a worktree's admin dir read-only below the parent grant, while a session clone's `.git` (§11) is the exact pinned path and its entry alone reopens it.
  const agentFilesystemEntries: Array<[string, string]> = [
    ...writableGitMetadataRoots.map((root): [string, string] => [root, 'write']),
    ...writableGitMetadataRoots.flatMap((root): Array<[string, string]> => [
      [join(root, 'worktrees', '**'), 'write'],
      [join(root, 'hooks'), 'read'],
      [join(root, 'config'), 'read']
    ]),
    ...sessionGitMetadataRoots.flatMap((root): Array<[string, string]> => [
      [root, 'write'],
      [join(root, 'hooks'), 'read'],
      [join(root, 'config'), 'read']
    ]),
    ...protectedRoots.map((root): [string, string] => [root, 'deny'])
  ]
  const agentFilesystem =
    agentFilesystemEntries.length > 0
      ? [`permissions.${PROFILE_IDS.agent}.filesystem=${tomlInlineTable(agentFilesystemEntries)}`]
      : []
  const fullAccess = tomlInlineTable([
    [':root', 'write'],
    ['/.git', 'write'],
    ['/.agents', 'write'],
    ['/.codex', 'write'],
    ...protectedRoots.map((root): [string, string] => [root, 'deny'])
  ])
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
      `permissions.${PROFILE_IDS['agent-full-access']}.filesystem=${fullAccess}`,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.enabled=true`,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.allow_local_binding=true`,
      `permissions.${PROFILE_IDS['agent-full-access']}.network.dangerously_allow_all_unix_sockets=true`
    ],
    modeProfiles: { ...PROFILE_IDS }
  }
}

function tomlInlineTable(entries: Array<[string, string]>): string {
  return `{ ${[...new Map(entries)].map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ')} }`
}

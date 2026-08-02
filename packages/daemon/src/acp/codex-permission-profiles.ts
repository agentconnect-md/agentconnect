import { isAbsolute, normalize } from 'node:path'

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
  protectedRoots: readonly string[],
  allowModelToolUnixSockets = false
): CodexPermissionProfileConfig | undefined {
  const roots = [...new Set(protectedRoots.map((root) => normalize(root)))]
  if (roots.length === 0 && !allowModelToolUnixSockets) return undefined
  if (roots.some((root) => !isAbsolute(root))) {
    throw new Error('Codex protected permission roots must be absolute paths')
  }

  const deny = tomlInlineTable(roots.map((root): [string, string] => [root, 'deny']))
  const protectedFilesystem =
    roots.length > 0
      ? [
          `permissions.${PROFILE_IDS['read-only']}.filesystem=${deny}`,
          `permissions.${PROFILE_IDS.agent}.filesystem=${deny}`
        ]
      : []
  const fullAccess = tomlInlineTable([
    [':root', 'write'],
    ['/.git', 'write'],
    ['/.agents', 'write'],
    ['/.codex', 'write'],
    ...roots.map((root): [string, string] => [root, 'deny'])
  ])
  // On Linux Codex's restricted network seccomp permits AF_UNIX socket()
  // creation but rejects connect(). Enable the inner network layer only when
  // the daemon deliberately provides the agent-scoped GitHub credential
  // channel. When enabled, outer SRT remains the boundary; when disabled by the
  // operator, the launch is already explicitly unconfined.
  const credentialChannelNetwork = allowModelToolUnixSockets
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
      ...protectedFilesystem,
      ...credentialChannelNetwork,
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

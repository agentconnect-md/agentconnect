/**
 * Pure resolution of an agent's EFFECTIVE environment from its own variables and
 * secrets plus the organization entries assigned to it
 * (organization-secrets-and-variables.md §3.2).
 *
 * Resolution is by KEY FIRST — one deterministic winner per key — and only then
 * split into the two existing wire maps (`AgentSpec.env` / `AgentSpec.secrets`).
 * Deliberately stronger than leaning on the daemon's "secrets win over variables"
 * merge: an owner who assigns `API_KEY` gets one predictable result instead of a
 * result that depends on which map each side landed in.
 *
 * THE ONE SECURITY EXCEPTION: an organization VARIABLE may not override an agent
 * SECRET. That transition would move the effective key out of the write-only
 * `secrets` map into the ordinary `env` map — a silent declassification. Writes
 * that would create the combination are rejected ({@link crossKindConflicts}),
 * and any historical or partially-repaired occurrence resolves as a TOMBSTONE
 * (§9): the key leaves both maps, which also suppresses the same-key agent
 * fallback, so the value can never be downgraded while an operator repairs it.
 *
 * Everything here is synchronous and value-agnostic where possible so the same
 * code runs in three places: the transaction-time admission check, the human DTO
 * projection, and the wire assembly.
 */

export type OrganizationEnvironmentKind = 'variable' | 'secret'
export type OrganizationEnvironmentAudience = 'all' | 'selected'

/** What resolution needs to know about one assigned organization entry. */
export interface AssignedOrganizationEntry {
  key: string
  kind: OrganizationEnvironmentKind
  /**
   * False when the entry cannot supply material — a secret whose value row is
   * missing (§9). Such a key is tombstoned rather than treated as absent.
   */
  valid?: boolean
}

/** Where the effective value of one key comes from. */
export type EffectiveKeySource = 'agent' | 'organization'

export interface EffectiveKey {
  key: string
  source: EffectiveKeySource
  kind: OrganizationEnvironmentKind
  /** True when an agent-owned row with this key exists but is not effective. */
  overridden: boolean
}

export interface EffectiveKeyPlan {
  /** One entry per effective key, sorted by key. */
  keys: EffectiveKey[]
  /**
   * Assigned keys that resolve to NOTHING: an organization variable colliding
   * with an agent secret, or an organization secret with no material. They are
   * absent from both wire maps and suppress the same-key agent row.
   */
  tombstoned: string[]
}

/**
 * Organization keys whose assignment would declassify an agent secret. A write is
 * rejected when this is non-empty — from either direction (assigning the
 * variable, enrolling the agent, or adding the agent-local secret underneath).
 */
export function crossKindConflicts(
  agentSecretKeys: Iterable<string>,
  organizationEntries: Iterable<AssignedOrganizationEntry>
): string[] {
  const secretKeys = new Set(agentSecretKeys)
  const conflicts = new Set<string>()
  for (const entry of organizationEntries) {
    if (entry.kind === 'variable' && secretKeys.has(entry.key)) conflicts.add(entry.key)
  }
  return [...conflicts].sort()
}

/**
 * Decide the winner for every key without needing any value. Used by the
 * transaction-time admission check and by the human DTO (which marks an
 * inactive agent-owned row "Overridden by Organization").
 */
export function planEffectiveKeys(
  agentVariableKeys: Iterable<string>,
  agentSecretKeys: Iterable<string>,
  organizationEntries: Iterable<AssignedOrganizationEntry>
): EffectiveKeyPlan {
  const agentKinds = new Map<string, OrganizationEnvironmentKind>()
  for (const key of agentVariableKeys) agentKinds.set(key, 'variable')
  // An agent may not hold a variable and a secret with the same name in
  // practice, but if a legacy row pair exists the secret is the stricter
  // classification and must win the local side.
  for (const key of agentSecretKeys) agentKinds.set(key, 'secret')

  const effective = new Map<string, EffectiveKey>()
  for (const [key, kind] of agentKinds) effective.set(key, { key, source: 'agent', kind, overridden: false })

  const tombstoned = new Set<string>()
  for (const entry of organizationEntries) {
    const localKind = agentKinds.get(entry.key)
    // The declassification guard, and the missing-secret-material guard. Both
    // remove the key entirely — never fall back to the agent row, which is
    // exactly the value the organization entry was meant to replace.
    if ((entry.kind === 'variable' && localKind === 'secret') || entry.valid === false) {
      tombstoned.add(entry.key)
      effective.delete(entry.key)
      continue
    }
    // A tombstone from another assignment of the same key stays a tombstone.
    if (tombstoned.has(entry.key)) continue
    effective.set(entry.key, {
      key: entry.key,
      source: 'organization',
      kind: entry.kind,
      overridden: localKind !== undefined
    })
  }

  return {
    keys: [...effective.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    tombstoned: [...tombstoned].sort()
  }
}

/** The resolved values an organization contributes to one agent. */
export interface OrganizationEnvironmentValues {
  /** Assigned variables, key → value. */
  variables: Map<string, string>
  /** Assigned secrets, key → decrypted value. */
  secrets: Map<string, string>
  /** Assigned keys with no usable material (§9); never present in either map above. */
  invalidKeys: Set<string>
}

export function emptyOrganizationEnvironmentValues(): OrganizationEnvironmentValues {
  return { variables: new Map(), secrets: new Map(), invalidKeys: new Set() }
}

/** The two wire maps `AgentSpec` carries, complete and always emitted. */
export interface EffectiveEnvironment {
  env: Record<string, string>
  secrets: Record<string, string>
  /** Keys deliberately removed from both maps; reported (id/key only) by callers. */
  tombstoned: string[]
}

/**
 * Build the complete wire maps. `agentVariables` / `agentSecrets` are the agent's
 * own values; `organization` is what {@link OrganizationEnvironmentValues} resolved
 * for this agent.
 */
export function resolveEffectiveEnvironment(
  agentVariables: Record<string, string>,
  agentSecrets: Record<string, string>,
  organization: OrganizationEnvironmentValues
): EffectiveEnvironment {
  const entries: AssignedOrganizationEntry[] = [
    ...[...organization.variables.keys()].map((key) => ({ key, kind: 'variable' as const })),
    ...[...organization.secrets.keys()].map((key) => ({ key, kind: 'secret' as const })),
    ...[...organization.invalidKeys].map((key) => ({ key, kind: 'secret' as const, valid: false }))
  ]
  const plan = planEffectiveKeys(Object.keys(agentVariables), Object.keys(agentSecrets), entries)

  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const effectiveKey of plan.keys) {
    const value =
      effectiveKey.source === 'organization'
        ? effectiveKey.kind === 'secret'
          ? organization.secrets.get(effectiveKey.key)
          : organization.variables.get(effectiveKey.key)
        : effectiveKey.kind === 'secret'
          ? agentSecrets[effectiveKey.key]
          : agentVariables[effectiveKey.key]
    // Defensive: a key with no value on its winning side is not silently
    // downgraded to the losing side either.
    if (value === undefined) continue
    if (effectiveKey.kind === 'secret') secrets[effectiveKey.key] = value
    else env[effectiveKey.key] = value
  }
  return { env, secrets, tombstoned: plan.tombstoned }
}

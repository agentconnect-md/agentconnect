// Shared projection of an agent's Variables/Secrets lists across BOTH sources —
// the agent's own rows and the organization entries assigned to it
// (docs/designs/organization-secrets-and-variables.md §8.2).
//
// The precedence here mirrors the Control Plane's resolution: an assigned
// organization entry wins its key, and the shadowed agent row is RETAINED (it
// becomes effective again if the assignment goes away) but marked rather than
// shown as effective. The detail cards render the effective list; the editor keeps
// the local row visible with an "Overridden by Organization" note so its value
// never has to be re-entered.
//
// This is presentation only. The authoritative resolution — including the refusal
// to let an organization VARIABLE take over a key an agent holds as a SECRET —
// happens server-side; the console never has to reproduce that rule because such a
// combination cannot be saved.

import type { Agent } from '@/lib/data'

export interface EffectiveVariableRow {
  k: string
  v: string
  /** True for an organization-owned row: read-only, badged. */
  fromOrganization: boolean
}

export interface EffectiveSecretRow {
  k: string
  fromOrganization: boolean
}

/** The label shown on every inherited row. Kept in one place so the wording,
 *  spelling, and tooltip stay identical on the cards and in the editor. */
export function OrganizationRowBadge() {
  return (
    <span
      className="flex-none rounded border border-(--border-subtle) px-[5px] py-px font-sans text-[10px] font-medium leading-normal text-(--text-tertiary)"
      title="Defined for the whole organization — change it in Organization settings"
    >
      Organization
    </span>
  )
}

/** Variables that actually apply, organization rows last-write-wins by key. */
export function effectiveVariableRows(agent: Agent): EffectiveVariableRow[] {
  const organizationKeys = new Set(agent.organizationVariables.map((e) => e.k))
  // Also drop a local row shadowed by an organization SECRET: the effective key is
  // then write-only and belongs to the Secrets card, not this one.
  const organizationSecretKeys = new Set(agent.organizationSecretKeys)
  return [
    ...agent.env
      .filter((e) => !organizationKeys.has(e.k) && !organizationSecretKeys.has(e.k))
      .map((e) => ({ ...e, fromOrganization: false })),
    ...agent.organizationVariables.map((e) => ({ ...e, fromOrganization: true }))
  ]
}

/** Secret names that actually apply, from both sources. */
export function effectiveSecretRows(agent: Agent): EffectiveSecretRow[] {
  const organizationKeys = new Set(agent.organizationSecretKeys)
  return [
    ...agent.secretKeys.filter((k) => !organizationKeys.has(k)).map((k) => ({ k, fromOrganization: false })),
    ...agent.organizationSecretKeys.map((k) => ({ k, fromOrganization: true }))
  ]
}

/** Which of the agent's OWN keys are currently shadowed by an assigned entry —
 *  what the editor annotates "Overridden by Organization". */
export function overriddenLocalKeys(agent: Agent): Set<string> {
  const organizationKeys = new Set([...agent.organizationVariables.map((e) => e.k), ...agent.organizationSecretKeys])
  return new Set([...agent.env.map((e) => e.k), ...agent.secretKeys].filter((key) => organizationKeys.has(key)))
}

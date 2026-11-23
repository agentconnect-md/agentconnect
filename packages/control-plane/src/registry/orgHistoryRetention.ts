// Delivers each organization's history retention to the daemons serving its agents (org-session-policy.md, History retention).
import {
  CONFIG_KEY_ORG_HISTORY_RETENTION,
  ORG_HISTORY_RETENTION_FEATURE,
  type OrgHistoryRetention,
  type OrgHistoryRetentionSnapshot
} from '@agentconnect.md/protocol'
import { OrgId } from '../domain/ids.js'
import type { OrgSessionPolicyRepo } from '../persistence/ports.js'
import type { ResolvableAgent } from '../orchestrator/placementResolver.js'

type RetentionReader = Pick<OrgSessionPolicyRepo, 'historyRetention'>

/** Whether a daemon advertising these features reads the retention field and push key. */
export function readsOrgHistoryRetention(features: readonly string[] | undefined): boolean {
  return features?.includes(ORG_HISTORY_RETENTION_FEATURE) ?? false
}

/** The `register/ok` snapshot for these orgs: every one of them, and the stored policies among them. */
export async function orgHistoryRetentionSnapshot(
  policies: RetentionReader,
  orgIds: Iterable<string | null | undefined>
): Promise<OrgHistoryRetentionSnapshot> {
  const orgs = [...new Set([...orgIds].filter((id): id is string => typeof id === 'string' && id.length > 0))].sort()
  return { orgIds: orgs, entries: (await policies.historyRetention(orgs)).map(toWire) }
}

export interface OrgHistoryRetentionPushDeps {
  policies: RetentionReader
  agents: { list(orgId: OrgId): Promise<ResolvableAgent[]> }
  placement: { servingDaemons(agent: ResolvableAgent): Promise<string[]> }
  daemonConns: { get(daemonId: string): { state: string; capabilities?: { features: string[] } } | undefined }
  control: { configPush(daemonId: string, keys: Record<string, unknown>): void }
  log?: { warn(obj: unknown, msg?: string): void }
}

/** Push an org's stored retention to the READY daemons on this replica that serve its agents and read it; returns the daemons pushed to. */
export async function pushOrgHistoryRetention(deps: OrgHistoryRetentionPushDeps, orgId: string): Promise<string[]> {
  const [row] = await deps.policies.historyRetention([orgId])
  if (!row) return []
  const targets = new Set<string>()
  for (const agent of await deps.agents.list(OrgId(orgId))) {
    for (const daemonId of await deps.placement.servingDaemons(agent)) targets.add(daemonId)
  }
  const sent: string[] = []
  for (const daemonId of targets) {
    const conn = deps.daemonConns.get(daemonId)
    // A daemon on another replica, offline, or not reading the key converges from its next `register/ok`.
    if (conn?.state !== 'READY' || !readsOrgHistoryRetention(conn.capabilities?.features)) continue
    try {
      deps.control.configPush(daemonId, { [CONFIG_KEY_ORG_HISTORY_RETENTION]: toWire(row) })
      sent.push(daemonId)
    } catch (err) {
      deps.log?.warn({ err, daemonId, orgId }, 'org history retention: push failed; the next register/ok carries it')
    }
  }
  return sent
}

function toWire(row: { orgId: string; revision: number; historyRetentionDays: number | null }): OrgHistoryRetention {
  return { orgId: row.orgId, revision: row.revision, historyRetentionDays: row.historyRetentionDays }
}

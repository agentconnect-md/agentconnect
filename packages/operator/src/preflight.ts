import type { AgentConnectOrgApi } from './crd/api.js'

/** Hidden subcommand: the chart's pre-delete hook runs it, nobody types it. */
export const PREFLIGHT_UNINSTALL = 'preflight-uninstall'

/** What the uninstall guard found; a non-empty `remaining` must fail the hook. */
export interface PreflightResult {
  /** Names of the AgentConnectOrgs still living in the control namespace, sorted. */
  remaining: string[]
  /** The one line the hook prints — the only diagnosis a helm user gets. */
  message: string
}

// The operator is the only actor that runs the envelope finalizer: uninstalling it
// while CRs remain leaves every org stuck in Terminating with nothing left to clean up.
/** The check behind the chart's pre-delete hook: are there orgs this operator still owns? */
export async function preflightUninstall(api: AgentConnectOrgApi): Promise<PreflightResult> {
  const orgs = await api.list()
  const remaining = orgs.map((org) => org.metadata?.name ?? '<unnamed>').sort()
  if (remaining.length === 0) {
    return { remaining, message: `no AgentConnectOrg remains in ${api.namespace}; the operator can be removed` }
  }
  return {
    remaining,
    message:
      `refusing to uninstall: ${remaining.length} AgentConnectOrg(s) still in ${api.namespace} ` +
      `(${remaining.join(', ')}). Delete them and wait for their finalizers to complete first — ` +
      'removing the operator now would strand every envelope.'
  }
}

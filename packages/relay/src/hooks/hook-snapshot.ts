import type { HookConfigSnapshot, RcHookAssign } from '@agentconnect.md/protocol'

/**
 * Normalize a rolling-version compiled rule for an outbound delivery.
 *
 * Policies missing from an older CP are explicitly forced to the safe defaults.
 * The durable identity is all-or-nothing: never synthesize revisions or a
 * dispatch daemon, and never forward a mismatched daemon tuple. Daemon/CP
 * consumers therefore cannot mistake a partially rolled-out rule for an
 * authorizable HookConfigSnapshot.
 */
export function hookSnapshotForDelivery(rule: RcHookAssign): Partial<HookConfigSnapshot> {
  if (
    rule.configRevision === undefined ||
    rule.dispatchRevision === undefined ||
    rule.dispatchDaemonId === undefined ||
    rule.reviewPolicy === undefined ||
    rule.reportingMode === undefined ||
    rule.gateMode === undefined ||
    rule.dispatchDaemonId !== rule.daemonId
  ) {
    return { reviewPolicy: 'off', reportingMode: 'off', gateMode: 'informational' }
  }
  return {
    configRevision: rule.configRevision,
    dispatchRevision: rule.dispatchRevision,
    dispatchDaemonId: rule.dispatchDaemonId,
    reviewPolicy: rule.reviewPolicy,
    reportingMode: rule.reportingMode,
    gateMode: rule.gateMode
  }
}

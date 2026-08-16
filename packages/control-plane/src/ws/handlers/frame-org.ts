/**
 * The organization a dispatched frame acts in (k8s-daemon-pool.md M4).
 *
 * An install-wide pool member carries many orgs on one socket, so the org is the
 * frame's own (`frame.orgId`); an ordinary org-scoped daemon carries it on the
 * connection. `DaemonConnection.gateOrganization` has already refused a frame whose
 * org disagrees with the connection or with the resource it targets, so a handler
 * may fence its repository reads on this value — never on the org a row it read
 * unscoped happens to carry.
 */
import type { AnyFrame } from '@agentconnect.md/protocol'
import { OrgId } from '../../domain/ids.js'
import type { DaemonConnection } from '../connection.js'

export function frameOrgId(frame: AnyFrame, conn: DaemonConnection): OrgId | null {
  const orgId = frame.orgId ?? conn.orgId
  return orgId ? OrgId(orgId) : null
}

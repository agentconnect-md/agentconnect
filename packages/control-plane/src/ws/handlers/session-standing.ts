// Session-level grants under an enforced monthly session limit (org-session-policy.md, Enforcement).
import type { OrgId } from '../../domain/ids.js'
import type { DaemonWsDeps } from '../deps.js'

/** The refusal message a grant answers with for a session its organization never admitted. */
export const SESSION_NOT_ADMITTED_MESSAGE =
  'the session was never admitted under its organization monthly session limit'

/** Whether a grant may name this session: always without an admission store, else only an admitted or recorded one while enforcing. */
export async function sessionMayAct(
  orgId: OrgId,
  agentId: string,
  sessionId: string,
  deps: Pick<DaemonWsDeps, 'sessionAdmission'>
): Promise<boolean> {
  return deps.sessionAdmission ? deps.sessionAdmission.sessionMayAct(orgId, agentId, sessionId) : true
}

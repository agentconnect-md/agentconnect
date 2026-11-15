// The HTTP edge of the Cloud-compute standing gate (key-server.md §2.3): 402 for a suspended org, 503 when nobody can say.
import type { FastifyReply } from 'fastify'
import { DaemonId } from '../domain/ids.js'
import type { MemberSetRepo } from '../persistence/ports.js'
import { standingRefusal, type OrgStanding, type StandingRefusal } from '../key-server/org-standing.js'

export const ORG_SUSPENDED = 'ORG_SUSPENDED'
export const ORG_STANDING_UNAVAILABLE = 'ORG_STANDING_UNAVAILABLE'

/** A refusal as the console reads it: the key server's own words under a stable code. */
export function standingRefusalBody(refusal: StandingRefusal): {
  error: string
  statusCode: 402 | 503
  message: string
  code: string
} {
  return refusal.code === 'org_suspended'
    ? { error: 'Payment Required', statusCode: 402, message: refusal.message, code: ORG_SUSPENDED }
    : { error: 'Service Unavailable', statusCode: 503, message: refusal.message, code: ORG_STANDING_UNAVAILABLE }
}

/** Answers the request when the org may not start Cloud compute; true means the reply was sent. */
export async function refuseUnfundedCloud(
  standing: OrgStanding | undefined,
  orgId: string,
  reply: FastifyReply
): Promise<boolean> {
  const refusal = await standingRefusal(standing, orgId, reply.log)
  if (!refusal) return false
  const body = standingRefusalBody(refusal)
  void reply.code(body.statusCode).send(body)
  return true
}

/** Whether a placement runs on Cloud: the org-less pool, or a legacy pin to one of its members. Org sets are self-hosted. */
export async function placedOnCloud(
  memberSets: Pick<MemberSetRepo, 'get' | 'setIdOf'>,
  target: { setId?: string | null; daemonId?: string | null }
): Promise<boolean> {
  const setId = target.setId ?? (target.daemonId ? await memberSets.setIdOf(DaemonId(target.daemonId)) : null)
  return setId ? (await memberSets.get(setId))?.orgId === null : false
}

/** Refuses a start on a Cloud placement for an org that may not run it; self-hosted placements, and no gate, pass. */
export async function refuseUnfundedCloudPlacement(
  deps: { orgStanding?: OrgStanding; repos: { memberSet: Pick<MemberSetRepo, 'get' | 'setIdOf'> } },
  orgId: string,
  target: { setId?: string | null; daemonId?: string | null },
  reply: FastifyReply
): Promise<boolean> {
  if (!deps.orgStanding || !(await placedOnCloud(deps.repos.memberSet, target))) return false
  return await refuseUnfundedCloud(deps.orgStanding, orgId, reply)
}

/**
 * `http/routes/member-sets.ts` (docs/designs/daemon-groups.md §2, §3) — an organization's own
 * member sets: named sets of its daemons within which an agent's duty may be claimed. Pointing an
 * agent at a set instead of a machine is what gives self-hosted installs the lease-driven failover
 * the install-wide pool already has.
 *
 * The install-wide pool is NOT reachable here. It is the org-less set, it belongs to no
 * organization, and its membership is automatic (a Pod is enrolled when it authenticates), so
 * every route below is fenced on the path org and answers 404 for a set that is not this org's.
 *
 * The tenancy invariants are the repository's, not this file's (`member-set.repo.ts`): an org set
 * accepts only that org's daemons, and a `set`-placed agent may reference only the org-less set or
 * one of its own. What this file owns is the TRANSITION safety of §3 — a membership change moves
 * runtime authority, so each direction is admitted only from a state where nothing is being taken
 * away from a running machine:
 *
 * - _Join_ requires the daemon to have no directly placed agents. A set member serves only what it
 *   holds a lease for, so a machine that still has agents pinned to it would render them
 *   unservable the moment it enrolled. Move them onto the set first; the design's one-action
 *   version (the move convention applied per agent inside one fence) is a follow-up.
 * - _Leave_ requires the daemon to hold no LIVE duty lease. That is the design's "stop the old
 *   authority and confirm it stopped, then commit", satisfied by an existing primitive rather than
 *   a new one: drain the daemon (or let its leases lapse — a lapsed lease is strictly later than
 *   the daemon's own self-fence, so it has provably stopped serving), then leave.
 *
 * Either way the daemon learns its new set the way it learns any set — from `auth/ok` — so a
 * connected one is closed with `1012` and reads it on the reconnect. Membership is never
 * negotiated on the wire; the CP tells the daemon, the daemon does not tell.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { DaemonId, type OrgId } from '../../domain/ids.js'
import { MemberSetInUse, MemberSetTenancyMismatch } from '../../persistence/errors.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import {
  MemberSetBody,
  MemberSetDto,
  MemberSetListDto,
  MemberSetMemberParams,
  IdParam,
  ErrorDto
} from '../dto/index.js'

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'member set not found' })
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
}

export function memberSetRoutes(deps: HttpDeps) {
  /** One set plus its members and what is placed on it — the only projection these routes return. */
  const toDto = async (set: { id: string; name: string }) => {
    const [memberDaemonIds, agentCounts] = await Promise.all([
      deps.repos.memberSet.memberIdsOf(set.id),
      deps.repos.memberSet.agentCountsOf([set.id])
    ])
    return { setId: set.id, name: set.name, memberDaemonIds, agentCount: agentCounts.get(set.id) ?? 0 }
  }

  /** The list read, batched: one membership query and one count query for every set at once. */
  const toDtoList = async (sets: { id: string; name: string }[]) => {
    const agentCounts = await deps.repos.memberSet.agentCountsOf(sets.map((s) => s.id))
    return Promise.all(
      sets.map(async (set) => ({
        setId: set.id,
        name: set.name,
        memberDaemonIds: await deps.repos.memberSet.memberIdsOf(set.id),
        agentCount: agentCounts.get(set.id) ?? 0
      }))
    )
  }

  /** Resolve a path id to one of THIS org's sets. Null ⇒ 404, including for the org-less pool:
   *  it is not this organization's to see or change. */
  const ownSet = async (orgId: OrgId, setId: string) => {
    const set = await deps.repos.memberSet.get(setId)
    return set && set.orgId === orgId ? set : null
  }

  return async function memberSetRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/member-sets',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'List member sets',
          description:
            'The organization’s member sets — named sets of its daemons within which an agent’s duty may be claimed. The install-wide pool is not among them.',
          operationId: 'listMemberSets',
          response: { 200: MemberSetListDto }
        }
      },
      async (req) => toDtoList(await deps.repos.memberSet.listForOrg(orgOf(req)))
    )

    r.post(
      '/member-sets',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'Create a member set',
          description: 'Create an empty member set. Daemons join it afterwards, one set per daemon.',
          operationId: 'createMemberSet',
          body: MemberSetBody,
          response: { 201: MemberSetDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return reply
        const set = await deps.repos.memberSet.createForOrg(orgOf(req), req.body.name)
        return reply.code(201).send(await toDto(set))
      }
    )

    r.patch(
      '/member-sets/:id',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'Rename a member set',
          description: 'Change a member set’s display name. Membership and placements are untouched.',
          operationId: 'renameMemberSet',
          params: IdParam,
          body: MemberSetBody,
          response: { 200: MemberSetDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return reply
        const set = await deps.repos.memberSet.renameForOrg(orgOf(req), req.params.id, req.body.name)
        return set ? toDto(set) : notFound(reply)
      }
    )

    r.delete(
      '/member-sets/:id',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'Delete a member set',
          description:
            'Delete an EMPTY member set. A set that still has members, or agents placed on it, returns 409 — dropping it would silently unplace them.',
          operationId: 'deleteMemberSet',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return reply
        try {
          const deleted = await deps.repos.memberSet.deleteForOrg(orgOf(req), req.params.id)
          return deleted ? reply.code(204).send(null) : notFound(reply)
        } catch (err) {
          if (err instanceof MemberSetInUse) {
            return conflict(reply, 'remove its daemons and re-place its agents before deleting the set')
          }
          throw err
        }
      }
    )

    r.put(
      '/member-sets/:id/members/:daemonId',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'Enroll a daemon in a member set',
          description:
            'Add one of the organization’s daemons to the set. Refused (409) while the daemon still has agents pinned directly to it — a member serves only what it holds a duty lease for, so those agents must be placed on the set first — or while it is already in another set. A connected daemon reconnects to pick up its new set.',
          operationId: 'enrollDaemonInMemberSet',
          params: MemberSetMemberParams,
          response: { 200: MemberSetDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return reply
        const orgId = orgOf(req)
        const set = await ownSet(orgId, req.params.id)
        if (!set) return notFound(reply)
        const daemonId = DaemonId(req.params.daemonId)
        const daemon = await deps.registry.getAvailable(orgId, daemonId)
        if (!daemon) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (daemon.memberSetId === set.id) return toDto(set)
        if (daemon.memberSetId) return conflict(reply, 'the daemon is already in another member set')
        // A pinned agent on a machine that enforces duties is placed and unservable at once (§3).
        const pinned = await deps.repos.agent.listForDaemon(daemonId)
        if (pinned.length > 0) {
          return conflict(reply, `move this daemon's ${pinned.length} placed agent(s) onto a member set first`)
        }
        try {
          await deps.repos.memberSet.enroll(set.id, daemonId)
        } catch (err) {
          // The set's tenancy invariant, surfaced rather than swallowed: the daemon is not this
          // org's. The org-fenced read above already refuses that, so this is a concurrent change.
          if (err instanceof MemberSetTenancyMismatch) return conflict(reply, 'the daemon is not in this organization')
          throw err
        }
        deps.liveness.reconnectForMemberSet?.(daemonId)
        return toDto(set)
      }
    )

    r.delete(
      '/member-sets/:id/members/:daemonId',
      {
        schema: {
          tags: [Tag.MemberSets],
          summary: 'Withdraw a daemon from a member set',
          description:
            'Remove one daemon from the set. Refused (409) while it still holds a live duty lease: drain it first (or wait for its leases to lapse, which is strictly later than its own self-fence) so it has provably stopped serving before the duties re-grant elsewhere. The set’s agents stay placed on the set and re-grant to its remaining members.',
          operationId: 'withdrawDaemonFromMemberSet',
          params: MemberSetMemberParams,
          response: { 200: MemberSetDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return reply
        const orgId = orgOf(req)
        const set = await ownSet(orgId, req.params.id)
        if (!set) return notFound(reply)
        const daemonId = DaemonId(req.params.daemonId)
        const daemon = await deps.registry.getAvailable(orgId, daemonId)
        if (!daemon || daemon.memberSetId !== set.id) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon is not in this set' })
        }
        // Stop the old authority and CONFIRM it stopped, before committing the change (§3). A live
        // lease is exactly "it may still be serving"; a lapsed one is not, because the daemon's own
        // self-fence fires strictly before the CP's reassignment horizon.
        const now = new Date(deps.clock.now())
        const held = await deps.repos.dutyGroup.listHeldBy(daemonId)
        const live = held.filter((g) => g.expiresAt !== null && g.expiresAt > now)
        if (live.length > 0) {
          return conflict(reply, `drain this daemon first — it still holds ${live.length} duty group(s)`)
        }
        await deps.repos.memberSet.withdraw(daemonId)
        deps.liveness.reconnectForMemberSet?.(daemonId)
        return toDto(set)
      }
    )
  }
}

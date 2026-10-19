import { randomUUID } from 'node:crypto'
import { Prisma } from '../../generated/prisma/client.js'
import { dutyEligibility, type PlacementRef } from '../../domain/placement.js'
import type {
  AhpSessionBindingRecord,
  AhpSessionBindingRepo,
  AhpSessionReservationInput,
  AhpSessionWriteResult,
  AhpSessionWriter
} from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'

// Agent → duty → reservation: placement and lease changes serialize with every registry write.
async function lockWriter(
  tx: Prisma.TransactionClient,
  orgId: string,
  agentId: string,
  writer: AhpSessionWriter
): Promise<boolean> {
  const [agent] = await tx.$queryRaw<PlacementRef[]>(Prisma.sql`
    SELECT "placementKind", "daemonId", "setId" FROM "agent"
    WHERE "id" = ${agentId}::uuid AND "orgId" = ${orgId} FOR SHARE
  `)
  if (!agent) return false
  const target = dutyEligibility(agent)
  if (target.scope === 'daemon') return target.daemonId === writer.daemonId
  if (target.scope !== 'set' || !writer.duty) return false
  const holds = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT g.id FROM "duty_group" g JOIN "duty_group_member" m ON m."groupId" = g.id
    JOIN "member_set_member" member ON member."setId" = ${target.setId}::uuid
      AND member."daemonId" = ${writer.daemonId}::uuid
    WHERE m.kind = 'agent' AND m."refId" = ${agentId}::uuid AND m."orgId" = ${orgId}
      AND g.id = ${writer.duty.groupId}::uuid AND g."orgId" = ${orgId}
      AND g.holder = ${writer.daemonId}::uuid AND g.term = ${BigInt(writer.duty.term)}
      AND g."expiresAt" > clock_timestamp()
    FOR SHARE OF g, m, member
  `)
  return holds.length === 1
}

export class PgAhpSessionBindingRepo implements AhpSessionBindingRepo {
  constructor(private readonly db: PrismaLike) {}

  reserve(input: AhpSessionReservationInput): Promise<AhpSessionWriteResult> {
    return withAmbientTx(this.db, async (tx) => {
      if (!(await lockWriter(tx, input.orgId, input.agentId, input.writer))) return { ok: false, reason: 'unavailable' }
      // Lock both retry and public identities so a reused operation cannot allocate another URI.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ahp-op', input.orgId, input.operationId])}, 0))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ahp-uri', input.orgId, input.sessionUri])}, 0))`
      const previous = await tx.ahpSessionBinding.findUnique({
        where: { orgId_operationId: { orgId: input.orgId, operationId: input.operationId } }
      })
      if (previous) {
        const same =
          previous.agentId === input.agentId &&
          previous.userId === input.userId &&
          previous.sessionUri === input.sessionUri &&
          (!input.conversationId || previous.conversationId === input.conversationId)
        return same ? { ok: true, binding: previous } : { ok: false, reason: 'conflict' }
      }
      const occupied = await tx.ahpSessionBinding.findUnique({
        where: { orgId_sessionUri: { orgId: input.orgId, sessionUri: input.sessionUri } }
      })
      if (occupied) return { ok: false, reason: 'collision' }
      const conversationId = input.conversationId ?? randomUUID()
      if (input.conversationId) {
        const [conversation] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT c.id FROM "webchat_conversation" c
          JOIN "webchat_conversation_agent" p ON p."conversationId" = c.id
          WHERE c.id = ${conversationId}::uuid AND c."orgId" = ${input.orgId}
            AND p."agentId" = ${input.agentId}::uuid AND p."removedAt" IS NULL AND c."userId" = ${input.userId}
          FOR UPDATE OF c
        `)
        if (!conversation) return { ok: false, reason: 'unavailable' }
        const existing = await tx.ahpSessionBinding.findUnique({
          where: { orgId_conversationId_agentId: { orgId: input.orgId, conversationId, agentId: input.agentId } }
        })
        if (existing) return { ok: false, reason: 'conflict' }
      } else
        await tx.webchatConversation.create({
          data: {
            id: conversationId,
            orgId: input.orgId,
            agentId: input.agentId,
            userId: input.userId,
            apiKeyId: input.apiKeyId,
            participants: { create: { agentId: input.agentId, role: 'primary', ord: 0, addedByUserId: input.userId } }
          }
        })
      const binding = await tx.ahpSessionBinding.create({
        data: {
          reservationId: randomUUID(),
          orgId: input.orgId,
          agentId: input.agentId,
          userId: input.userId,
          operationId: input.operationId,
          sessionUri: input.sessionUri,
          conversationId
        }
      })
      return { ok: true, binding }
    })
  }

  finalize(input: Parameters<AhpSessionBindingRepo['finalize']>[0]): Promise<AhpSessionWriteResult> {
    return withAmbientTx(this.db, async (tx) => {
      if (!(await lockWriter(tx, input.orgId, input.agentId, input.writer))) return { ok: false, reason: 'unavailable' }
      const [binding] = await tx.$queryRaw<AhpSessionBindingRecord[]>(Prisma.sql`
        SELECT * FROM "ahp_session_binding"
        WHERE "reservationId" = ${input.reservationId}::uuid AND "orgId" = ${input.orgId}
          AND "agentId" = ${input.agentId}::uuid AND "userId" = ${input.userId} FOR UPDATE
      `)
      if (!binding) return { ok: false, reason: 'unavailable' }
      if (binding.sessionId !== null) {
        return binding.sessionId === input.sessionId ? { ok: true, binding } : { ok: false, reason: 'conflict' }
      }
      // An outward identity is immutable and cannot be attached to two public reservations.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ahp-id', input.orgId, input.sessionId])}, 0))`
      if (
        await tx.ahpSessionBinding.findUnique({
          where: { orgId_sessionId: { orgId: input.orgId, sessionId: input.sessionId } }
        })
      ) {
        return { ok: false, reason: 'conflict' }
      }
      return {
        ok: true,
        binding: await tx.ahpSessionBinding.update({
          where: { reservationId: input.reservationId },
          data: { sessionId: input.sessionId }
        })
      }
    })
  }

  get(orgId: string, sessionUri: string): Promise<AhpSessionBindingRecord | null> {
    return this.db.ahpSessionBinding.findUnique({ where: { orgId_sessionUri: { orgId, sessionUri } } })
  }

  forSession(orgId: string, sessionId: string): Promise<AhpSessionBindingRecord | null> {
    return this.db.ahpSessionBinding.findUnique({ where: { orgId_sessionId: { orgId, sessionId } } })
  }

  bindExisting(input: Parameters<AhpSessionBindingRepo['bindExisting']>[0]): Promise<AhpSessionWriteResult> {
    return withAmbientTx(this.db, async (tx) => {
      if (!(await lockWriter(tx, input.orgId, input.agentId, input.writer))) return { ok: false, reason: 'unavailable' }
      // A continuation's target and its peer must still share the exact physical conversation.
      const [conversation] = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        SELECT c."userId" FROM "webchat_conversation" c
        JOIN "session_meta" target ON target.id = c."targetSessionId"
        JOIN "session_meta" s ON s.id = ${input.sessionId} AND s."orgId" = c."orgId"
          AND s."agentId" = ${input.agentId}::uuid AND s."contentPurgedAt" IS NULL
        WHERE c.id = ${input.conversationId}::uuid AND c."orgId" = ${input.orgId}
          AND target."contentPurgedAt" IS NULL
          AND (target.id = s.id OR (target.platform = s.platform
            AND target."tenantScope" IS NOT DISTINCT FROM s."tenantScope"
            AND target.channel IS NOT DISTINCT FROM s.channel AND target.thread IS NOT DISTINCT FROM s.thread))
        FOR SHARE OF c, target, s
      `)
      if (!conversation) return { ok: false, reason: 'unavailable' }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ahp-id', input.orgId, input.sessionId])}, 0))`
      const existing = await tx.ahpSessionBinding.findUnique({
        where: { orgId_sessionId: { orgId: input.orgId, sessionId: input.sessionId } }
      })
      if (existing) return { ok: true, binding: existing }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['ahp-uri', input.orgId, input.sessionUri])}, 0))`
      const occupied = await tx.ahpSessionBinding.findUnique({
        where: { orgId_sessionUri: { orgId: input.orgId, sessionUri: input.sessionUri } }
      })
      if (occupied) return { ok: false, reason: 'collision' }
      const binding = await tx.ahpSessionBinding.create({
        data: {
          reservationId: randomUUID(),
          orgId: input.orgId,
          agentId: input.agentId,
          sessionUri: input.sessionUri,
          sessionId: input.sessionId,
          operationId: input.operationId,
          conversationId: input.conversationId,
          userId: conversation.userId
        }
      })
      return { ok: true, binding }
    })
  }

  forConversation(orgId: string, agentId: string, conversationId: string): Promise<AhpSessionBindingRecord | null> {
    return this.db.ahpSessionBinding.findUnique({
      where: { orgId_conversationId_agentId: { orgId, agentId, conversationId } }
    })
  }

  listOwned(input: Parameters<AhpSessionBindingRepo['listOwned']>[0]): Promise<AhpSessionBindingRecord[]> {
    return this.db.ahpSessionBinding.findMany({
      where: {
        orgId: input.orgId,
        agentId: input.agentId,
        userId: input.userId,
        sessionId: { not: null },
        ...(input.after ? { reservationId: { gt: input.after } } : {})
      },
      orderBy: { reservationId: 'asc' },
      take: Math.max(1, Math.min(100, input.limit))
    })
  }
}

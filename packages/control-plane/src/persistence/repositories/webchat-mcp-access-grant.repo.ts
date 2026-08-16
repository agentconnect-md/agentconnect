import { Prisma, type WebchatMcpAccessGrant } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  AcceptWebchatMcpGrantInput,
  IssueWebchatMcpGrantInput,
  RevokeWebchatMcpGrantsInput,
  WebchatMcpAccessGrantRecord,
  WebchatMcpAccessGrantRepo
} from '../ports.js'

const toRecord = (row: WebchatMcpAccessGrant): WebchatMcpAccessGrantRecord => ({ ...row })

export class PgWebchatMcpAccessGrantRepo implements WebchatMcpAccessGrantRepo {
  constructor(private readonly db: PrismaLike) {}

  async issue(input: IssueWebchatMcpGrantInput): Promise<WebchatMcpAccessGrantRecord | null> {
    return this.db.$transaction(async (tx) => {
      // No daemon predicate: which member may act for the agent is the placement resolver's
      // answer, checked live by the caller — this row is keyed on the agent, not on a member.
      const [authority] = await tx.$queryRaw<{ id: string; generation: number; conversationId: string }[]>(Prisma.sql`
        SELECT "id", "generation", "conversationId"
        FROM "webchat_mcp_delegation"
        WHERE "id" = ${input.authorityId}
          AND "revokedAt" IS NULL
          AND "expiresAt" > ${input.now}
        FOR UPDATE
      `)
      if (
        !authority ||
        authority.generation !== input.authorityGeneration ||
        authority.conversationId !== input.conversationId
      ) {
        return null
      }

      const latest = await tx.webchatMcpAccessGrant.findFirst({
        where: { descriptorInstanceId: input.descriptorInstanceId },
        orderBy: { grantRevision: 'desc' }
      })
      const grantRevision = (latest?.grantRevision ?? 0) + 1
      await tx.webchatMcpAccessGrant.updateMany({
        where: { descriptorInstanceId: input.descriptorInstanceId, status: 'pending' },
        data: { status: 'revoked', revokedAt: input.now, revokedReason: 'superseded' }
      })
      const created = await tx.webchatMcpAccessGrant.create({
        data: {
          authorityId: input.authorityId,
          descriptorInstanceId: input.descriptorInstanceId,
          grantRevision,
          tokenHash: input.tokenHash,
          pendingExpiresAt: input.pendingExpiresAt,
          expiresAt: input.expiresAt,
          createdAt: input.now
        }
      })
      return toRecord(created)
    })
  }

  async accept(input: AcceptWebchatMcpGrantInput): Promise<WebchatMcpAccessGrantRecord | null> {
    return this.db.$transaction(async (tx) => {
      const [grant] = await tx.$queryRaw<WebchatMcpAccessGrant[]>(Prisma.sql`
        SELECT g.*
        FROM "webchat_mcp_access_grant" g
        JOIN "webchat_mcp_delegation" a ON a."id" = g."authorityId"
        WHERE g."id" = ${input.grantId}
          AND g."authorityId" = ${input.authorityId}
          AND g."descriptorInstanceId" = ${input.descriptorInstanceId}
          AND g."grantRevision" = ${input.grantRevision}
          AND a."generation" = ${input.authorityGeneration}
          AND a."conversationId" = ${input.conversationId}
          AND a."revokedAt" IS NULL
          AND a."expiresAt" > ${input.now}
        FOR UPDATE
      `)
      if (!grant || grant.expiresAt <= input.now || grant.pendingExpiresAt <= input.now) return null
      if (grant.status === 'active') return toRecord(grant)
      if (grant.status !== 'pending') return null

      const newest = await tx.webchatMcpAccessGrant.findFirst({
        where: { descriptorInstanceId: input.descriptorInstanceId, status: 'pending' },
        orderBy: { grantRevision: 'desc' }
      })
      if (newest?.id !== grant.id) return null
      await tx.webchatMcpAccessGrant.updateMany({
        where: { descriptorInstanceId: input.descriptorInstanceId, status: 'active', id: { not: grant.id } },
        data: { status: 'revoked', revokedAt: input.now, revokedReason: 'rotated' }
      })
      const activated = await tx.webchatMcpAccessGrant.update({
        where: { id: grant.id },
        data: { status: 'active', activatedAt: input.now }
      })
      return toRecord(activated)
    })
  }

  async revokeAuthority(input: RevokeWebchatMcpGrantsInput): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const [authority] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "webchat_mcp_delegation"
        WHERE "id" = ${input.authorityId}
          AND "generation" = ${input.authorityGeneration}
          AND "conversationId" = ${input.conversationId}
        FOR UPDATE
      `)
      if (!authority) return false
      // Serialize with invocation claim, which locks the same active grant row.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "webchat_mcp_access_grant"
        WHERE "authorityId" = ${authority.id}
          AND "status" IN ('pending', 'active')
        FOR UPDATE
      `)
      await tx.webchatMcpAccessGrant.updateMany({
        where: { authorityId: authority.id, status: { in: ['pending', 'active'] } },
        data: { status: 'revoked', revokedAt: input.now, revokedReason: input.reason }
      })
      return true
    })
  }

  async getByTokenHash(tokenHash: string): Promise<WebchatMcpAccessGrantRecord | null> {
    const row = await this.db.webchatMcpAccessGrant.findUnique({ where: { tokenHash } })
    return row ? toRecord(row) : null
  }
}

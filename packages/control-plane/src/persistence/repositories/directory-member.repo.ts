/**
 * `PgDirectoryMemberRepo` — the membership changes an organization's directory makes (resource-visibility.md §8.8).
 *
 * The caller is the directory connection, never a person: each command is keyed by the directory's own id for the
 * member, repeats to the same result, and audits to the connection with no acting user.
 */
import { Prisma, withAmbientTx, type PrismaLike } from '../prisma.js'
import {
  isSyntheticEmail,
  type DirectoryMemberCommandResult,
  type DirectoryMemberRecord,
  type DirectoryMemberRepo,
  type DirectoryProvisionInput,
  type OrgMemberRole
} from '../ports.js'
import { auditMemberChange } from './user.repo.js'

type Row = Prisma.MembershipGetPayload<{ include: { user: true } }>

function toRecord(row: Row): DirectoryMemberRecord {
  return {
    userId: row.userId,
    // Set on every row these commands read.
    externalId: row.directoryExternalId!,
    email: isSyntheticEmail(row.user.email) ? null : row.user.email,
    displayName: row.user.displayName,
    role: row.role as OrgMemberRole,
    suspendedBy: row.suspendedAt === null ? null : row.suspendedBy
  }
}

const isP2002 = (err: unknown): boolean => (err as { code?: string }).code === 'P2002'

export class PgDirectoryMemberRepo implements DirectoryMemberRepo {
  constructor(private readonly db: PrismaLike) {}

  async provision(
    orgId: string,
    connectionId: string,
    input: DirectoryProvisionInput
  ): Promise<DirectoryMemberCommandResult> {
    const email = input.email.trim().toLowerCase()
    // A placeholder address names nobody, so it cannot be what a directory provisions.
    if (!email || isSyntheticEmail(email)) return { outcome: 'conflict' }
    // The unique address may be created under us by an invite or a first sign-in: read again, a few times at most.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withAmbientTx(this.db, (tx) => this.provisionTx(tx, orgId, connectionId, { ...input, email }))
      } catch (err) {
        if (!isP2002(err)) throw err
      }
    }
    return { outcome: 'conflict' }
  }

  private async provisionTx(
    tx: Prisma.TransactionClient,
    orgId: string,
    connectionId: string,
    input: DirectoryProvisionInput
  ): Promise<DirectoryMemberCommandResult> {
    const known = await this.find(tx, orgId, input.externalId)
    // A repeat names the member it made the first time; the address is evidence for the first binding only.
    if (known) return { outcome: 'unchanged', member: toRecord(known) }

    const holder = await tx.user.findUnique({ where: { email: input.email } })
    if (holder && holder.kind !== 'human') return { outcome: 'conflict' }
    // The person may already be here by invitation, or under another directory id: neither is this command's to take over.
    if (holder && (await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId: holder.id } } }))) {
      return { outcome: 'conflict' }
    }
    // An address that already has an account gains a membership only: accounts are never created twice or merged here.
    const user =
      holder ??
      (await tx.user.create({
        data: { email: input.email, ...(input.displayName ? { displayName: input.displayName } : {}) }
      }))
    const row = await tx.membership.create({
      data: { orgId, userId: user.id, role: input.role, managedBy: 'directory', directoryExternalId: input.externalId },
      include: { user: true }
    })
    await auditMemberChange(tx, orgId, null, 'member_added', {
      userId: user.id,
      role: input.role,
      source: 'directory',
      connectionId
    })
    return { outcome: 'changed', member: toRecord(row) }
  }

  async setSuspended(
    orgId: string,
    connectionId: string,
    externalId: string,
    suspended: boolean
  ): Promise<DirectoryMemberCommandResult> {
    return withAmbientTx(this.db, async (tx) => {
      const row = await this.find(tx, orgId, externalId, true)
      if (!row) return { outcome: 'not_found' }
      // Already as asked, by whoever: a suspension an owner made is not relabelled as the directory's.
      if ((row.suspendedAt !== null) === suspended) return { outcome: 'unchanged', member: toRecord(row) }
      // The directory lifts only its own suspension; one an owner made stays until an owner lifts it.
      if (!suspended && row.suspendedBy !== 'directory') return { outcome: 'held', member: toRecord(row) }
      const updated = await tx.membership.update({
        where: { id: row.id },
        // No owner check: the directory may suspend the last owner; a refusal would only make it retry without end.
        data: suspended
          ? { suspendedAt: new Date(), suspendedBy: 'directory' }
          : { suspendedAt: null, suspendedBy: null },
        include: { user: true }
      })
      await auditMemberChange(tx, orgId, null, suspended ? 'member_suspended' : 'member_restored', {
        userId: row.userId,
        source: 'directory',
        connectionId
      })
      return { outcome: 'changed', member: toRecord(updated) }
    })
  }

  async setRole(
    orgId: string,
    connectionId: string,
    externalId: string,
    role: OrgMemberRole
  ): Promise<DirectoryMemberCommandResult> {
    return withAmbientTx(this.db, async (tx) => {
      const row = await this.find(tx, orgId, externalId, true)
      if (!row) return { outcome: 'not_found' }
      if (row.role === role) return { outcome: 'unchanged', member: toRecord(row) }
      // No owner check, as for a suspension: the directory decides the roles of the members it manages.
      const updated = await tx.membership.update({ where: { id: row.id }, data: { role }, include: { user: true } })
      await auditMemberChange(tx, orgId, null, 'role_changed', {
        userId: row.userId,
        role,
        previousRole: row.role,
        source: 'directory',
        connectionId
      })
      return { outcome: 'changed', member: toRecord(updated) }
    })
  }

  /** The member the directory knows by this id, locked when the caller is about to change it. */
  private async find(
    tx: Prisma.TransactionClient,
    orgId: string,
    externalId: string,
    lock = false
  ): Promise<Row | null> {
    if (lock) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "membership" WHERE "orgId" = ${orgId} AND "directoryExternalId" = ${externalId} FOR UPDATE`
      )
    }
    return tx.membership.findUnique({
      where: { orgId_directoryExternalId: { orgId, directoryExternalId: externalId } },
      include: { user: true }
    })
  }
}

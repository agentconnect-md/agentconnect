// The reference fence of an Azure DevOps binding (azure-devops-integration.md §5): a referencing write locks the row SHARED, a removal EXCLUSIVELY.
import type { Prisma } from '../../generated/prisma/client.js'
import { AzureDevOpsBindingUnavailable } from '../errors.js'

/** Commit a workspace or grant that names this binding only while it exists; the composite foreign key backs this up. */
export async function joinAzureDevOpsBindingFence(
  tx: Prisma.TransactionClient,
  orgId: string,
  connectionId: string,
  repoId: bigint
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "azure_devops_repository_binding"
     WHERE "orgId" = ${orgId} AND "connectionId" = ${connectionId}::uuid AND "identityId" = ${repoId.toString()}::bigint
       FOR SHARE`
  if (rows.length === 0) throw new AzureDevOpsBindingUnavailable(repoId)
}

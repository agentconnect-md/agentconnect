/**
 * The Gitea half of the deployment-wide host-axis fence (gitea-integration.md §3): the same
 * advisory key `gitlab-axis.ts` takes, joined SHARED by every transaction that creates Gitea
 * state, which then proves the persisted axis still selects the instance its operation addressed.
 */
import { Prisma } from '../../generated/prisma/client.js'
import { GiteaAxisRetargeted } from '../errors.js'
import { effectiveGiteaBaseUrl, parseDeploymentConfigValues } from '../deployment-config.js'
import { DEPLOYMENT_CONFIG_ID, DEPLOYMENT_CONFIG_LOCK_KEY } from './gitlab-axis.js'

/** Join the fence, then refuse if the persisted document now names another Gitea instance. */
export async function joinGiteaAxisFence(tx: Prisma.TransactionClient, operationBaseUrl: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${DEPLOYMENT_CONFIG_LOCK_KEY}, 0)) IS NULL AS "locked"`
  )
  const row = await tx.deploymentConfig.findUnique({
    where: { id: DEPLOYMENT_CONFIG_ID },
    select: { schemaVersion: true, values: true }
  })
  if (!row) return
  const persisted = effectiveGiteaBaseUrl(parseDeploymentConfigValues(row.schemaVersion, row.values))
  if (persisted !== operationBaseUrl) throw new GiteaAxisRetargeted(operationBaseUrl, persisted)
}

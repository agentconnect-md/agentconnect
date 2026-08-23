/**
 * The deployment-wide GitLab host-axis fence (gitlab-com-integration.md §24.1).
 *
 * No GitLab row carries instance provenance, so the axis may only change while
 * no GitLab state exists. That is a two-sided invariant, and one advisory key
 * carries both sides: the deployment-config writer takes it EXCLUSIVELY around
 * its state count, and every transaction that creates first-of-its-kind GitLab
 * state takes it SHARED and then proves the persisted axis still matches the
 * base its in-flight operation was composed against. Without the shared side a
 * count of zero and a concurrent connect could both commit, leaving one host's
 * credentials to be presented to another after the next restart.
 */
import { Prisma } from '../../generated/prisma/client.js'
import { GitlabAxisRetargeted } from '../errors.js'
import { effectiveGitlabBaseUrl, parseDeploymentConfigValues } from '../deployment-config.js'

export const DEPLOYMENT_CONFIG_ID = 1
const DEPLOYMENT_CONFIG_LOCK_KEY = 'agentconnect:deployment-config'

/** The config writer's side: nothing else may commit GitLab state alongside it. */
export async function lockAxisExclusive(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${DEPLOYMENT_CONFIG_LOCK_KEY}, 0)) IS NULL AS "locked"`
  )
}

/**
 * A GitLab state write's side: join the fence, then refuse if the persisted
 * document now selects an instance other than the one this operation addressed.
 * With no document the running process IS the axis, so there is nothing to
 * disagree with; `operationBaseUrl` is the normalized base the caller's client
 * composed its provider calls from.
 */
export async function joinAxisFence(tx: Prisma.TransactionClient, operationBaseUrl: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${DEPLOYMENT_CONFIG_LOCK_KEY}, 0)) IS NULL AS "locked"`
  )
  const row = await tx.deploymentConfig.findUnique({
    where: { id: DEPLOYMENT_CONFIG_ID },
    select: { schemaVersion: true, values: true }
  })
  if (!row) return
  const persisted = effectiveGitlabBaseUrl(parseDeploymentConfigValues(row.schemaVersion, row.values))
  if (persisted !== operationBaseUrl) throw new GitlabAxisRetargeted(operationBaseUrl, persisted)
}

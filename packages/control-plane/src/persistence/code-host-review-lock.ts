import { Prisma } from '../generated/prisma/client.js'
import type { CodeHostReviewSubject } from './ports.js'

/**
 * Serialize every lease decision for ONE merge-request subject
 * (gitlab-com-integration.md §15.1).
 *
 * A row-level lock cannot cover the no-row case, and acquisition has to read the
 * whole operation ledger before it decides between transfer and an indefinite
 * lock — so two brokers racing an expired lease must not evaluate that ledger
 * concurrently. The key is the provider subject, not the organization: the
 * publisher is one shared service account, so the boundary is the merge request.
 */
export async function lockCodeHostReviewSubject(
  tx: Prisma.TransactionClient,
  subject: CodeHostReviewSubject
): Promise<void> {
  const key = JSON.stringify([
    'code-host-review-lease',
    subject.provider,
    subject.projectExternalId.toString(),
    subject.mergeRequestIid,
    subject.serviceAccountExternalId.toString()
  ])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

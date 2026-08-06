/**
 * PgAgentConfigWriter — the transactional unit-of-work for an agent's durable
 * configuration: the agent row mutation and its `agent_secret` row mutations
 * commit atomically (docs/designs/secret-store-seams.md decision 5). Without it, a
 * failure between the two writes leaves a partially-updated definition that
 * reconcile would then replicate.
 *
 * The organization-environment fence (organization-secrets-and-variables.md §5)
 * lives in `PgAgentRepo.create` / `PgAgentRepo.update`, so EVERY agent-row write
 * gets it — including callers that use the repo directly (the icon route, preset
 * provisioning). The repo also owns all of the fence's LOCK ACQUISITION, in the
 * one order the whole codebase agrees on: skill-source name scopes → org row (on
 * create, whose row does not exist yet) → agent rows. This writer deliberately
 * takes no locks itself; one acquired here would sit outside those name scopes and
 * invert the order against a concurrent skill-source delete or sharing flip.
 *
 * Its one remaining fence responsibility is what the repo cannot see:
 * CREATE-TIME RE-VALIDATION. On create the secret rows can only land AFTER the
 * agent row exists, i.e. after the repo already validated, so the complete
 * definition is re-validated here — a create whose own secrets collide with an
 * assigned organization variable (or overflow the wire admission budget) is
 * refused rather than committed.
 *
 * On update the secrets are applied BEFORE the row update, so the repo's fence
 * already sees them and no second check is needed.
 *
 * The configured SecretCipher transform happens BEFORE the transaction opens
 * (an encrypting provider may make network calls; a transaction must never wait
 * on one). The prepared stored values are plaintext under `none` and ciphertext
 * under an encrypting provider.
 */
import type { PrismaClient } from '../../generated/prisma/client.js'
import { withTx } from '../prisma.js'
import type {
  AgentConfigWriter,
  AgentCreateOpts,
  AgentRecord,
  AgentUpdateOpts,
  CreateAgentInput,
  UpdateAgentInput
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { PgAgentRepo } from './agent.repo.js'
import { applySealedSecretPatch, sealSecretPatch } from './agent-secret.repo.js'
import { assertEnvironmentAdmissible, snapshotAgentEnvironments } from './organization-environment-fence.js'

export class PgAgentConfigWriter implements AgentConfigWriter {
  constructor(
    // The full client (not PrismaLike): this is a transaction OWNER, not a repo
    // that composes under someone else's transaction.
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipher
  ) {}

  async create(
    input: CreateAgentInput,
    secrets?: Record<string, string>,
    opts?: AgentCreateOpts
  ): Promise<AgentRecord> {
    const sealed = secrets && Object.keys(secrets).length > 0 ? await sealSecretPatch(this.cipher, secrets) : undefined
    return withTx(this.prisma, async (tx) => {
      // The repo owns the fence's lock acquisition (skill-source name scopes → org
      // row), so this path adds none of its own — a lock taken here would sit
      // OUTSIDE those name scopes and invert the order against a skill-source
      // sharing write.
      const agent = await new PgAgentRepo(tx).create(input, opts)
      if (sealed) {
        await applySealedSecretPatch(tx, agent.id, sealed)
        // The repo validated before these rows existed; re-validate the complete
        // definition. A throw aborts the whole create.
        assertEnvironmentAdmissible(await snapshotAgentEnvironments(tx, agent.orgId, [agent.id]))
      }
      return agent
    })
  }

  async update(
    orgId: OrgId,
    agentId: AgentId,
    patch: UpdateAgentInput,
    secrets?: Record<string, string | null>,
    opts?: AgentUpdateOpts
  ): Promise<AgentRecord> {
    const sealed = secrets && Object.keys(secrets).length > 0 ? await sealSecretPatch(this.cipher, secrets) : undefined
    return withTx(this.prisma, async (tx) => {
      // This path takes NO locks of its own. All of them belong to the repo, which
      // owns the established order (skill-source name scopes → agent row); anything
      // acquired here would sit outside those name scopes and invert it against a
      // concurrent skill-source delete or sharing flip.
      //
      // Writing the secret rows before that agent-row lock is still safe for the
      // cross-kind rule, because validation happens AFTER it: an
      // organization-environment writer either takes the agent row first — so its
      // read misses these uncommitted rows, it commits, and this transaction's
      // later re-read sees its entry and refuses — or it queues behind, and then sees
      // these rows committed and refuses itself. Either way exactly one survives.
      if (sealed) await applySealedSecretPatch(tx, agentId, sealed)
      // The row update last: it stamps lastModifiedAt, advances configRevision, and
      // runs the fence over the definition INCLUDING the secrets above — so the
      // audit advance, the secret rows, and the validation commit (or roll back) as
      // one edit. Its org fence also unwinds the secret rows above for a
      // cross-org id (AgentMissing aborts the transaction).
      return new PgAgentRepo(tx).update(orgId, agentId, patch, opts)
    })
  }
}

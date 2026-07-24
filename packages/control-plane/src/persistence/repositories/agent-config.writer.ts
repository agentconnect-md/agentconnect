/**
 * PgAgentConfigWriter — the transactional unit-of-work for an agent's durable
 * configuration: the agent row mutation and its `agent_secret` row mutations
 * commit atomically (docs/designs/secret-store-seams.md decision 5). Without it, a
 * failure between the two writes leaves a partially-updated definition that
 * reconcile would then replicate.
 *
 * The configured SecretCipher transform happens BEFORE the transaction opens
 * (an encrypting provider may make network calls; a transaction must never wait
 * on one). The prepared stored values are plaintext under `none` and ciphertext
 * under an encrypting provider.
 */
import type { PrismaClient } from '../../generated/prisma/client.js'
import { withTx } from '../prisma.js'
import type { AgentConfigWriter, AgentRecord, CreateAgentInput, UpdateAgentInput } from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import type { AgentId } from '../../domain/ids.js'
import { PgAgentRepo } from './agent.repo.js'
import { applySealedSecretPatch, sealSecretPatch } from './agent-secret.repo.js'

export class PgAgentConfigWriter implements AgentConfigWriter {
  constructor(
    // The full client (not PrismaLike): this is a transaction OWNER, not a repo
    // that composes under someone else's transaction.
    private readonly prisma: PrismaClient,
    private readonly cipher: SecretCipher
  ) {}

  async create(input: CreateAgentInput, secrets?: Record<string, string>): Promise<AgentRecord> {
    const sealed = secrets && Object.keys(secrets).length > 0 ? await sealSecretPatch(this.cipher, secrets) : undefined
    return withTx(this.prisma, async (tx) => {
      const agent = await new PgAgentRepo(tx).create(input)
      if (sealed) await applySealedSecretPatch(tx, agent.id, sealed)
      return agent
    })
  }

  async update(
    agentId: AgentId,
    patch: UpdateAgentInput,
    secrets?: Record<string, string | null>
  ): Promise<AgentRecord> {
    const sealed = secrets && Object.keys(secrets).length > 0 ? await sealSecretPatch(this.cipher, secrets) : undefined
    return withTx(this.prisma, async (tx) => {
      if (sealed) await applySealedSecretPatch(tx, agentId, sealed)
      // The row update last: it stamps lastModifiedAt, so the audit advance and
      // the secret rows commit (or roll back) as one edit.
      return new PgAgentRepo(tx).update(agentId, patch)
    })
  }
}

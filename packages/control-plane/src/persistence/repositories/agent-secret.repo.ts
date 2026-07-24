/**
 * PgAgentSecretStore — the ONLY read/write path for an agent's write-only secret
 * env vars (`agent_secret`, row-per-key). BotSecret discipline: never joined into
 * agent list/DTO reads; key names come from `keys` (values untouched), values only
 * from `get` on the wire-projection paths. Every value passes through the injected
 * {@link SecretCipher}, so at-rest encryption is a wiring change, not a code change.
 */
import type { PrismaLike } from '../prisma.js'
import type { AgentSecretStore } from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import type { AgentId } from '../../domain/ids.js'

/**
 * Seal every set-value of a merge patch (null delete-markers pass through). Run
 * this OUTSIDE any DB transaction — a real cipher may make network calls, and a
 * transaction must never wait on one.
 */
export async function sealSecretPatch(
  cipher: SecretCipher,
  patch: Record<string, string | null>
): Promise<Record<string, string | null>> {
  const sealed: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(patch)) {
    sealed[key] = value === null ? null : await cipher.seal(value)
  }
  return sealed
}

/**
 * Apply an already-sealed merge patch to the `agent_secret` rows: null deletes
 * its key, a string upserts it. Pure row I/O — safe inside a transaction. Shared
 * by {@link PgAgentSecretStore.merge} and the transactional `PgAgentConfigWriter`.
 */
export async function applySealedSecretPatch(
  db: PrismaLike,
  agentId: AgentId,
  sealed: Record<string, string | null>
): Promise<void> {
  const deletes = Object.keys(sealed).filter((key) => sealed[key] === null)
  if (deletes.length > 0) {
    await db.agentSecret.deleteMany({ where: { agentId, key: { in: deletes } } })
  }
  for (const [key, value] of Object.entries(sealed)) {
    if (value === null) continue
    await db.agentSecret.upsert({
      where: { agentId_key: { agentId, key } },
      create: { agentId, key, value },
      update: { value }
    })
  }
}

export class PgAgentSecretStore implements AgentSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async merge(agentId: AgentId, patch: Record<string, string | null>): Promise<void> {
    // Seal first (never inside a transaction), then write; keys are independent
    // rows, so plain sequential upserts/deletes suffice — a mid-way failure leaves
    // whole key/value pairs and the merge is retryable.
    await applySealedSecretPatch(this.db, agentId, await sealSecretPatch(this.cipher, patch))
  }

  async get(agentId: AgentId): Promise<Record<string, string>> {
    const rows = await this.db.agentSecret.findMany({ where: { agentId } })
    const out: Record<string, string> = {}
    for (const r of rows) out[r.key] = await this.cipher.open(r.value)
    return out
  }

  async keys(agentIds: readonly AgentId[]): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map()
    const rows = await this.db.agentSecret.findMany({
      where: { agentId: { in: [...agentIds] } },
      select: { agentId: true, key: true },
      orderBy: { key: 'asc' }
    })
    const out = new Map<string, string[]>()
    for (const r of rows) {
      const list = out.get(r.agentId) ?? []
      list.push(r.key)
      out.set(r.agentId, list)
    }
    return out
  }
}

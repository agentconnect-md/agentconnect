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
import { orgScope } from '../../secrets/scope.js'
import type { AgentId, OrgId } from '../../domain/ids.js'

/**
 * Seal every set-value of a merge patch (null delete-markers pass through) under
 * the owning org's key. Run this OUTSIDE any DB transaction — a real cipher may
 * make network calls, and a transaction must never wait on one.
 */
export async function sealSecretPatch(
  cipher: SecretCipher,
  orgId: OrgId,
  patch: Record<string, string | null>
): Promise<Record<string, string | null>> {
  const scope = orgScope(orgId)
  const sealed: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(patch)) {
    sealed[key] = value === null ? null : await cipher.seal(value, scope)
  }
  return sealed
}

/**
 * Apply an already-sealed merge patch to the `agent_secret` rows: null deletes
 * its key, a string upserts it. Pure row I/O — safe inside a transaction. Shared
 * by {@link PgAgentSecretStore.merge} and the transactional `PgAgentConfigWriter`.
 *
 * The row writes address `agent_secret` by `agentId` alone (that is its unique
 * key), so the org fence is one explicit check against the parent row up front.
 * A mismatch is a caller bug, not a missing row: throw rather than write values
 * sealed under one org's key onto another org's agent.
 */
export async function applySealedSecretPatch(
  db: PrismaLike,
  orgId: OrgId,
  agentId: AgentId,
  sealed: Record<string, string | null>
): Promise<void> {
  if ((await db.agent.count({ where: { id: agentId, orgId } })) === 0) {
    throw new Error('agent secret write outside its organization')
  }
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

  async merge(orgId: OrgId, agentId: AgentId, patch: Record<string, string | null>): Promise<void> {
    // Seal first (never inside a transaction), then write; keys are independent
    // rows, so plain sequential upserts/deletes suffice — a mid-way failure leaves
    // whole key/value pairs and the merge is retryable.
    await applySealedSecretPatch(this.db, orgId, agentId, await sealSecretPatch(this.cipher, orgId, patch))
  }

  async get(orgId: OrgId, agentId: AgentId): Promise<Record<string, string>> {
    // Fences through the parent relation: a mismatched pair yields no rows, so
    // the caller gets {} instead of another org's values.
    const rows = await this.db.agentSecret.findMany({ where: { agentId, agent: { orgId } } })
    const scope = orgScope(orgId)
    const out: Record<string, string> = {}
    for (const r of rows) out[r.key] = await this.cipher.open(r.value, scope)
    return out
  }

  async keys(orgId: OrgId, agentIds: readonly AgentId[]): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map()
    const rows = await this.db.agentSecret.findMany({
      where: { agentId: { in: [...agentIds] }, agent: { orgId } },
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

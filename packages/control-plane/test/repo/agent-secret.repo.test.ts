/**
 * AgentSecretStore — the ONLY read/write path for an agent's write-only secret
 * env vars (docs/designs/secret-store-seams.md). Row-per-key `agent_secret`;
 * every value passes through the injected SecretCipher, so a sealing cipher must
 * be observable at rest while `get` still round-trips plaintext.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgAgentSecretStore } from '../../src/persistence/repositories/agent-secret.repo.js'
import { PgAgentConfigWriter } from '../../src/persistence/repositories/agent-config.writer.js'
import { PlaintextSecretCipher, type SecretCipher } from '../../src/secrets/cipher.js'
import { seedAgent } from '../fixtures/seed.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const AGENT = 'a5a5a5a5-5555-4555-8555-555555555555'
const OTHER = 'a6a6a6a6-6666-4666-8666-666666666666'

/** A toy sealing cipher — enough to prove every value passes the seam. */
class PrefixCipher implements SecretCipher {
  seal(plaintext: string): Promise<string> {
    return Promise.resolve(`sealed:${plaintext}`)
  }
  open(stored: string): Promise<string> {
    return Promise.resolve(stored.startsWith('sealed:') ? stored.slice('sealed:'.length) : stored)
  }
}

describe('AgentSecretStore — row-per-key, merge semantics, cipher seam (real Postgres)', () => {
  it('merge sets/replaces on string, deletes on null, leaves omitted keys; get round-trips', async () => {
    await seedAgent(prisma, AGENT)
    const store = new PgAgentSecretStore(prisma, new PlaintextSecretCipher())

    await store.merge(AgentId(AGENT), { API_KEY: 'sk-1', DB_PASSWORD: 'p@ss' })
    expect(await store.get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-1', DB_PASSWORD: 'p@ss' })

    // Replace one, add one, delete one — the untouched key survives.
    await store.merge(AgentId(AGENT), { API_KEY: 'sk-2', SLACK_TOKEN: 'xoxb', DB_PASSWORD: null })
    expect(await store.get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-2', SLACK_TOKEN: 'xoxb' })

    // keys() lists sorted names only — and batches across agents ({} agents absent).
    const keys = await store.keys([AgentId(AGENT), AgentId(OTHER)])
    expect(keys.get(AGENT)).toEqual(['API_KEY', 'SLACK_TOKEN'])
    expect(keys.has(OTHER)).toBe(false)

    // Deleting the rest leaves no rows.
    await store.merge(AgentId(AGENT), { API_KEY: null, SLACK_TOKEN: null })
    expect(await store.get(AgentId(AGENT))).toEqual({})
    expect(await prisma.agentSecret.count({ where: { agentId: AGENT } })).toBe(0)
  })

  it('every VALUE passes the SecretCipher: transformed before storage, opened on get, keys() untouched', async () => {
    await seedAgent(prisma, AGENT)
    const store = new PgAgentSecretStore(prisma, new PrefixCipher())

    await store.merge(AgentId(AGENT), { API_KEY: 'sk-1' })
    const row = await prisma.agentSecret.findUniqueOrThrow({
      where: { agentId_key: { agentId: AGENT, key: 'API_KEY' } }
    })
    expect(row.value).toBe('sealed:sk-1') // stored representation uses the injected transform
    expect(await store.get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-1' }) // read = opened
    expect((await store.keys([AgentId(AGENT)])).get(AGENT)).toEqual(['API_KEY']) // names never sealed
  })

  it('cascades away with its agent (FK), like bot_secret', async () => {
    await seedAgent(prisma, AGENT)
    const store = new PgAgentSecretStore(prisma, new PlaintextSecretCipher())
    await store.merge(AgentId(AGENT), { API_KEY: 'sk-1' })

    await prisma.agent.delete({ where: { id: AGENT } })
    expect(await prisma.agentSecret.count({ where: { agentId: AGENT } })).toBe(0)
  })
})

describe('AgentConfigWriter — agent row + secret rows commit atomically (real Postgres)', () => {
  it('create persists the row and its initial secrets together', async () => {
    const writer = new PgAgentConfigWriter(prisma, new PlaintextSecretCipher())
    const agent = await writer.create(
      { id: AgentId(AGENT), orgId: OrgId(DEFAULT_ORG_ID), name: 'atomic-bot', runtime: 'claude' },
      { API_KEY: 'sk-1' }
    )
    expect(agent.name).toBe('atomic-bot')
    const store = new PgAgentSecretStore(prisma, new PlaintextSecretCipher())
    expect(await store.get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-1' })
  })

  it('rolls the secret merge back when the row update fails — no half-applied edit', async () => {
    await seedAgent(prisma, AGENT)
    const writer = new PgAgentConfigWriter(prisma, new PlaintextSecretCipher())
    const store = new PgAgentSecretStore(prisma, new PlaintextSecretCipher())
    await writer.update(OrgId(DEFAULT_ORG_ID), AgentId(AGENT), {}, { API_KEY: 'sk-1' })

    // The secret merge applies FIRST inside the transaction; the row update then
    // fails on the app_user FK (unknown editor id), which must take the already-
    // applied merge down with it.
    await expect(
      writer.update(
        OrgId(DEFAULT_ORG_ID),
        AgentId(AGENT),
        { lastModifiedByUserId: 'no-such-user' },
        { API_KEY: 'sk-2' }
      )
    ).rejects.toThrow()
    expect(await store.get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-1' })
  })
})

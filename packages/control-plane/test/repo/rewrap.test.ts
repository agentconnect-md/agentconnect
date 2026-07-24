/**
 * `rewrapAllSecrets` — the at-rest convergence sweep (secret-store-seams.md §6):
 * every secret value in every secret-bearing table is re-sealed through the
 * cipher (plaintext residue → sealed; JSONB header names untouched), the typed
 * stores still read the original plaintexts back, and a second run is a
 * harmless re-seal (idempotent by value).
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { rewrapAllSecrets } from '../../src/secrets/rewrap.js'
import { PgBotSecretStore, PgAgentSecretStore } from '../../src/persistence/index.js'
import {
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo
} from '../../src/persistence/repositories/memory-connection.repo.js'
import type { SecretCipher } from '../../src/secrets/cipher.js'
import { seedAgent } from '../fixtures/seed.js'
import { AgentId, BotId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

/** The port-contract sealing fake: seal prefixes, open strips or passes through. */
class PrefixCipher implements SecretCipher {
  seal(plaintext: string): Promise<string> {
    return Promise.resolve(`sealed:${plaintext}`)
  }
  open(stored: string): Promise<string> {
    return Promise.resolve(stored.startsWith('sealed:') ? stored.slice('sealed:'.length) : stored)
  }
}

const AGENT = 'ab11ab11-1111-4111-8111-ab11ab11ab11'
const BOT = 'b071b071-2222-4222-8222-b071b071b071'
const MEM_CONNECTION = 'ec111e11-3333-4333-8333-ec111e11ec11'

async function seedAllSecretTables(): Promise<void> {
  await seedAgent(prisma, AGENT)
  await prisma.agentSecret.create({ data: { agentId: AGENT, key: 'API_KEY', value: 'sk-agent' } })

  await prisma.bot.create({ data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'sweep-bot' } })
  await prisma.botSecret.create({
    data: { botId: BOT, botToken: 'xoxb-plain', appToken: 'xapp-plain', signingSecret: null }
  })

  const hook = await prisma.hookDef.create({
    data: { orgId: DEFAULT_ORG_ID, agentId: AGENT, kind: 'webhook', name: 'sweep-hook', sessionMode: 'perDelivery' }
  })
  await prisma.hookSecret.create({ data: { hookId: hook.id, hmacSecret: 'hmac-plain' } })

  const provider = await prisma.mcpProvider.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'sweep-mcp', url: 'https://mcp.example.com' }
  })
  await prisma.mcpProviderSecret.create({
    data: { mcpProviderId: provider.id, headers: [{ name: 'authorization', value: 'Bearer up-plain' }] }
  })
  await prisma.mcpGrant.create({ data: { mcpProviderId: provider.id, key: 'grant-plain' } })

  await prisma.slackInstall.create({
    data: {
      id: randomUUID(),
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      appId: 'A123',
      clientId: 'c1',
      clientSecret: 'cs-plain',
      botToken: 'xoxb-pending-plain',
      signingSecret: null
    }
  })

  await prisma.slackUserConfig.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      userId: DEFAULT_OWNER_ID,
      accessToken: 'xoxe.xoxp-plain',
      refreshToken: 'xoxe-plain',
      accessExpiresAt: new Date('2026-01-01T12:00:00Z')
    }
  })

  const installation = await prisma.memoryPluginInstallation.create({
    data: { orgId: DEFAULT_ORG_ID, pluginId: 'ai.example.memory', endpoint: 'https://plugin.example/mcp' }
  })
  await prisma.externalMemoryConnection.create({
    data: { id: MEM_CONNECTION, orgId: DEFAULT_ORG_ID, installationId: installation.id }
  })
  await prisma.externalMemoryConnectionSecret.create({
    data: { connectionId: MEM_CONNECTION, values: { apiKey: 'mem-plain', projectToken: 'mem-token-plain' } }
  })
  await prisma.externalMemoryGrant.create({ data: { connectionId: MEM_CONNECTION, key: 'memgrant-plain' } })
}

describe('rewrapAllSecrets — converge lazy migration / post-rotation rewrap (real Postgres)', () => {
  it('re-seals every value in every secret table; stores still read the plaintexts; idempotent', async () => {
    await seedAllSecretTables()
    const cipher = new PrefixCipher()

    const stats = await rewrapAllSecrets(prisma, cipher)
    expect(stats.map((s) => s.table).sort()).toEqual([
      'agent_secret',
      'bot_secret',
      'external_memory_connection_secret',
      'external_memory_grant',
      'hook_secret',
      'mcp_grant',
      'mcp_provider_secret',
      'slack_install',
      'slack_user_config'
    ])
    // Every table saw its seeded row with no concurrent-write skips; bot_secret
    // resealed 2 values (null signingSecret stays null), the external-memory
    // connection secret both entries of its JSONB values map.
    expect(stats.every((s) => s.rows === 1 && s.skipped === 0)).toBe(true)
    expect(stats.find((s) => s.table === 'bot_secret')!.values).toBe(2)
    expect(stats.find((s) => s.table === 'external_memory_connection_secret')!.values).toBe(2)

    // At rest: sealed everywhere; nullable columns stay null; header NAMES readable.
    const bot = await prisma.botSecret.findUniqueOrThrow({ where: { botId: BOT } })
    expect(bot.botToken).toBe('sealed:xoxb-plain')
    expect(bot.appToken).toBe('sealed:xapp-plain')
    expect(bot.signingSecret).toBeNull()
    const agentRow = await prisma.agentSecret.findFirstOrThrow({ where: { agentId: AGENT } })
    expect(agentRow.value).toBe('sealed:sk-agent')
    const hook = await prisma.hookSecret.findFirstOrThrow()
    expect(hook.hmacSecret).toBe('sealed:hmac-plain')
    const headers = (await prisma.mcpProviderSecret.findFirstOrThrow()).headers as Array<{
      name: string
      value: string
    }>
    expect(headers).toEqual([{ name: 'authorization', value: 'sealed:Bearer up-plain' }])
    expect((await prisma.mcpGrant.findFirstOrThrow()).key).toBe('sealed:grant-plain')
    const install = await prisma.slackInstall.findFirstOrThrow()
    expect(install.clientSecret).toBe('sealed:cs-plain')
    expect(install.botToken).toBe('sealed:xoxb-pending-plain')
    expect(install.signingSecret).toBeNull()
    const cfg = await prisma.slackUserConfig.findFirstOrThrow()
    expect(cfg.accessToken).toBe('sealed:xoxe.xoxp-plain')
    expect(cfg.refreshToken).toBe('sealed:xoxe-plain')
    // External memory: JSONB value-map NAMES stay readable, values sealed; grant key sealed.
    expect((await prisma.externalMemoryConnectionSecret.findFirstOrThrow()).values).toEqual({
      apiKey: 'sealed:mem-plain',
      projectToken: 'sealed:mem-token-plain'
    })
    expect((await prisma.externalMemoryGrant.findFirstOrThrow()).key).toBe('sealed:memgrant-plain')

    // The typed seams (same cipher) still hand back the original plaintexts.
    expect(await new PgBotSecretStore(prisma, cipher).get(BotId(BOT))).toEqual({
      botToken: 'xoxb-plain',
      appToken: 'xapp-plain',
      signingSecret: null
    })
    expect(await new PgAgentSecretStore(prisma, cipher).get(AgentId(AGENT))).toEqual({ API_KEY: 'sk-agent' })
    expect(await new PgExternalMemoryConnectionSecretStore(prisma, cipher).get(MEM_CONNECTION)).toEqual({
      apiKey: 'mem-plain',
      projectToken: 'mem-token-plain'
    })
    expect(
      (await new PgExternalMemoryGrantRepo(prisma, cipher).activeForConnection(MEM_CONNECTION)).map((g) => g.key)
    ).toEqual(['memgrant-plain'])

    // Idempotent: a second sweep re-seals to the SAME values (no double prefix).
    const again = await rewrapAllSecrets(prisma, cipher)
    expect(again.find((s) => s.table === 'bot_secret')!.rows).toBe(1)
    const bot2 = await prisma.botSecret.findUniqueOrThrow({ where: { botId: BOT } })
    expect(bot2.botToken).toBe('sealed:xoxb-plain')
  })

  it('SKIPS a row a live CP updated between snapshot and write — never reverts the newer credential', async () => {
    await seedAgent(prisma, AGENT)
    await prisma.bot.create({ data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'raced-bot' } })
    await prisma.botSecret.create({ data: { botId: BOT, botToken: 'xoxb-old', appToken: null, signingSecret: null } })

    // Fires a concurrent (already-sealed, as every store write is) credential
    // change exactly when the sweep seals this row's snapshot — i.e. between the
    // findMany snapshot and the CAS write.
    class RaceInjectingCipher extends PrefixCipher {
      private fired = false
      override async seal(plaintext: string): Promise<string> {
        if (!this.fired && plaintext === 'xoxb-old') {
          this.fired = true
          await prisma.botSecret.update({ where: { botId: BOT }, data: { botToken: 'sealed:xoxb-NEW' } })
        }
        return super.seal(plaintext)
      }
    }

    const stats = await rewrapAllSecrets(prisma, new RaceInjectingCipher())
    // The CAS lost to the concurrent write → the row is skipped, NOT reverted.
    expect(stats.find((s) => s.table === 'bot_secret')).toMatchObject({ rows: 0, values: 0, skipped: 1 })
    const row = await prisma.botSecret.findUniqueOrThrow({ where: { botId: BOT } })
    expect(row.botToken).toBe('sealed:xoxb-NEW')
  })
})

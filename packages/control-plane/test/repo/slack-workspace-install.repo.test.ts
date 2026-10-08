import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { PgSlackWorkspaceInstallStore } from '../../src/persistence/repositories/slack-workspace-install.repo.js'
import { PgBotSecretStore } from '../../src/persistence/repositories/integration.repo.js'
import { AgentId, BotId, OrgId } from '../../src/domain/ids.js'
import { DEPLOYMENT_SCOPE, orgScope, type SecretCipher } from '../../src/secrets/cipher.js'

it('moves credentials to the organization key only when the complete binding commits', async () => {
  const cipher: SecretCipher = {
    async seal(value, scope) {
      return JSON.stringify({ scope, value })
    },
    async open(value, scope) {
      const stored = JSON.parse(value)
      if (JSON.stringify(stored.scope) !== JSON.stringify(scope)) throw new Error('wrong key scope')
      return stored.value
    }
  }
  const installs = new PgSlackWorkspaceInstallStore(prisma, cipher)
  const pending = await installs.put({
    appId: 'AEXAMPLE',
    teamId: 'TEXAMPLE',
    teamName: 'Example workspace',
    botUserId: 'UBOT',
    installerUserId: 'UINSTALLER',
    botToken: 'example-token',
    grantedScopes: ['chat:write']
  })
  const stored = await prisma.slackWorkspaceInstall.findUniqueOrThrow({ where: { id: pending.id } })
  expect(await cipher.open(stored.botToken, DEPLOYMENT_SCOPE)).toBe('example-token')
  await expect(cipher.open(stored.botToken, orgScope(OrgId(DEFAULT_ORG_ID)))).rejects.toThrow('wrong key scope')
  const agentId = AgentId(randomUUID())
  const claim = {
    id: pending.id,
    revision: pending.credentialRevision,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId,
    userId: DEFAULT_OWNER_ID,
    signingSecret: 'example-signing-secret'
  }
  await expect(installs.claim(claim)).rejects.toThrow()
  expect(await prisma.bot.count()).toBe(0)
  expect(await prisma.botSecret.count()).toBe(0)
  expect(await installs.get(pending.id)).not.toBeNull()

  await seedAgent(prisma, agentId)
  expect(await installs.claim(claim)).toBe(pending.id)
  expect(await installs.get(pending.id)).toBeNull()
  const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId: pending.id } })
  await expect(cipher.open(secret.botToken!, DEPLOYMENT_SCOPE)).rejects.toThrow('wrong key scope')
  expect(await new PgBotSecretStore(prisma, cipher).get(OrgId(DEFAULT_ORG_ID), BotId(pending.id))).toMatchObject({
    botToken: 'example-token',
    signingSecret: 'example-signing-secret'
  })
})

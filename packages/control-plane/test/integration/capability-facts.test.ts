// The Phase 2 capability facts read from real rows: repository grants, installation grants and MCP header names (capability-requests.md §4.2).
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { repoCapabilityFacts } from '../../src/capability/capability-facts.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { PgAgentInstallationAuthorizationRepo } from '../../src/persistence/repositories/agent-installation-auth.repo.js'
import { PgGithubInstallationRepo } from '../../src/persistence/repositories/github.repo.js'
import { PgGitlabConnectionRepo } from '../../src/persistence/repositories/gitlab.repo.js'
import { PgIntegrationRepo } from '../../src/persistence/repositories/integration.repo.js'
import { PgMcpProviderRepo, PgMcpProviderSecretStore } from '../../src/persistence/repositories/mcp.repo.js'
import { PgMcpProviderOauthRepo } from '../../src/persistence/repositories/mcp-oauth.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'

const ORG = OrgId(DEFAULT_ORG_ID)

function facts() {
  return repoCapabilityFacts({
    repoAuth: new PgAgentRepoAuthorizationRepo(prisma),
    installationAuth: new PgAgentInstallationAuthorizationRepo(prisma),
    mcpProviders: new PgMcpProviderRepo(prisma),
    mcpOauth: new PgMcpProviderOauthRepo(prisma),
    mcpSecrets: new PgMcpProviderSecretStore(prisma, new PlaintextSecretCipher()),
    githubInstallations: new PgGithubInstallationRepo(prisma),
    gitlabConnections: new PgGitlabConnectionRepo(prisma),
    integrations: new PgIntegrationRepo(prisma),
    knownPlatform: (platform) => platform === 'slack',
    gitlabHost: 'gitlab.com'
  })
}

describe('repoCapabilityFacts', () => {
  it('reads the best honored grant for a repository, and an installation grant over its account', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {})
    const agent = (await new PgAgentRepo(prisma).get(ORG, AgentId(agentId)))!
    const want = { provider: 'github', repository: 'Acme/Widgets', access: 'write' } as const
    expect((await facts().load(agent, { kind: 'repository', want })).repository).toEqual({
      authorized: 'none',
      repoId: null,
      installationId: null,
      installationWide: false
    })
    await prisma.agentRepoAuthorization.create({
      data: { agentId, provider: 'github', repoId: 77n, repoFullName: 'acme/widgets', access: 'read' }
    })
    expect((await facts().load(agent, { kind: 'repository', want })).repository).toMatchObject({
      authorized: 'read',
      repoId: '77',
      installationWide: false
    })
    await prisma.agentInstallationAuthorization.create({
      data: { agentId, installationId: 4242n, accountLogin: 'acme', access: 'write' }
    })
    expect((await facts().load(agent, { kind: 'repository', want })).repository).toMatchObject({
      authorized: 'write',
      installationId: '4242',
      installationWide: true
    })
  })

  it('says whether an MCP header is set by name only, and refuses targets the organization does not have', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, {})
    const agent = (await new PgAgentRepo(prisma).get(ORG, AgentId(agentId)))!
    const provider = await new PgMcpProviderRepo(prisma).create({
      orgId: ORG,
      name: 'Grafana',
      url: 'https://mcp.example.test/grafana'
    })
    const header = {
      kind: 'secret',
      want: { name: 'X-Api-Key', description: 'the key', use: { route: 'mcp-header', server: 'Grafana' } }
    } as const
    expect((await facts().load(agent, header)).mcpProvider).toMatchObject({ headerPresent: false })
    await new PgMcpProviderSecretStore(prisma, new PlaintextSecretCipher()).put(ORG, provider.id, [
      { name: 'x-api-key', value: 'not-read-here' }
    ])
    const loaded = await facts().load(agent, header)
    expect(loaded.mcpProvider).toEqual({ providerId: provider.id, connected: false, headerPresent: true })
    expect(JSON.stringify(loaded)).not.toContain('not-read-here')

    expect(await facts().unknownTarget(agent, header)).toBeUndefined()
    expect(
      await facts().unknownTarget(agent, { kind: 'connection', want: { type: 'mcp-oauth', server: 'Grafana' } })
    ).toContain('does not connect with OAuth')
    expect(
      await facts().unknownTarget(agent, { kind: 'connection', want: { type: 'chat-integration', platform: 'fax' } })
    ).toContain('no chat platform')
    expect(
      await facts().unknownTarget(agent, {
        kind: 'repository',
        want: { provider: 'gitlab', host: 'git.example.test', repository: 'a/b', access: 'read' }
      })
    ).toContain('does not connect to GitLab')
  })
})

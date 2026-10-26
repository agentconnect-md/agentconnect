// The rows outside the agent that the Phase 2 kinds are judged by (capability-requests.md §4.2, §4.6): never a secret's value.
import type { CapabilityAsk, CapabilityConnectionWant, CapabilityRepositoryWant } from '@agentconnect.md/protocol'
import type { AgentId, OrgId } from '../domain/ids.js'
import type {
  AgentInstallationAuthorizationRepo,
  AgentRecord,
  AgentRepoAuthorizationRepo,
  GithubInstallationRepo,
  GitlabConnectionRepo,
  IntegrationRepo,
  McpProviderOauthRepo,
  McpProviderRepo,
  McpProviderSecretStore,
  RepoAccess
} from '../persistence/ports.js'
import { isHonoredRepoGrant } from '../persistence/ports.js'
import type { CapabilityFacts } from './capability-wording.js'

/** Reads the facts one ask needs; `unknownTarget` says why a target names nothing the organization has. */
export interface CapabilityFactsSource {
  load(agent: AgentRecord, ask: CapabilityAsk): Promise<CapabilityFacts>
  unknownTarget(agent: AgentRecord, ask: CapabilityAsk): Promise<string | undefined>
}

export interface RepoCapabilityFactsDeps {
  repoAuth: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  installationAuth: Pick<AgentInstallationAuthorizationRepo, 'listForAgent'>
  mcpProviders: Pick<McpProviderRepo, 'listForOrg'>
  mcpOauth: Pick<McpProviderOauthRepo, 'get'>
  mcpSecrets: Pick<McpProviderSecretStore, 'get'>
  githubInstallations: Pick<GithubInstallationRepo, 'listForOrg'>
  gitlabConnections: Pick<GitlabConnectionRepo, 'listForOrg'>
  integrations: Pick<IntegrationRepo, 'activeForAgents'>
  /** Whether a chat platform with this id is installed on this deployment. */
  knownPlatform: (platform: string) => boolean
  /** The deployment's GitLab host (`gitlab.com` unless self-managed). */
  gitlabHost: string
}

const TIER: Record<RepoAccess, number> = { read: 1, comment: 2, write: 3 }

function tierOf(access: RepoAccess | undefined): 'none' | 'read' | 'write' {
  if (!access) return 'none'
  return access === 'write' ? 'write' : 'read'
}

function sameGitlabHost(want: string | undefined, deployment: string): boolean {
  return (want ?? 'gitlab.com').toLowerCase() === deployment.toLowerCase()
}

/** A host string as a bare lowercase host, whether configured as a URL or not. */
export function gitlabHostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return 'gitlab.com'
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

export function repoCapabilityFacts(deps: RepoCapabilityFactsDeps): CapabilityFactsSource {
  const provider = async (orgId: OrgId, name: string) =>
    (await deps.mcpProviders.listForOrg(orgId)).find((p) => p.name === name) ?? null

  const repository = async (
    agentId: AgentId,
    want: CapabilityRepositoryWant
  ): Promise<CapabilityFacts['repository']> => {
    const path = want.repository.toLowerCase()
    const grants = (await deps.repoAuth.listForAgent(agentId)).filter(
      (g) => g.provider === want.provider && isHonoredRepoGrant(g) && g.repoFullName.toLowerCase() === path
    )
    const best = grants.sort((a, b) => TIER[b.access] - TIER[a.access])[0]
    // An installation grant covers every repository of its account (GitHub only in this version).
    const owner = path.split('/')[0]
    const installation =
      want.provider === 'github'
        ? (await deps.installationAuth.listForAgent(agentId))
            .filter((g) => g.accountLogin.toLowerCase() === owner)
            .sort((a, b) => TIER[b.access] - TIER[a.access])[0]
        : undefined
    const repoTier = best ? TIER[best.access] : 0
    const installationTier = installation ? TIER[installation.access] : 0
    const viaInstallation = installationTier > repoTier
    return {
      authorized: tierOf(viaInstallation ? installation?.access : best?.access),
      repoId: best ? best.repoId.toString() : null,
      installationId: installation ? installation.installationId.toString() : null,
      installationWide: viaInstallation
    }
  }

  const codeHost = async (orgId: OrgId, want: Extract<CapabilityConnectionWant, { type: 'code-host' }>) => {
    if (want.provider === 'github')
      return (await deps.githubInstallations.listForOrg(orgId)).some((i) => i.revokedAt === null && !i.suspendedAt)
    return (await deps.gitlabConnections.listForOrg(orgId)).some((c) => c.state === 'connected')
  }

  return {
    async load(agent, ask) {
      switch (ask.kind) {
        case 'repository':
          return { repository: await repository(agent.id, ask.want) }
        case 'connection': {
          const want = ask.want
          if (want.type === 'mcp-oauth') {
            const p = await provider(agent.orgId, want.server)
            const oauth = p ? await deps.mcpOauth.get(agent.orgId, p.id) : null
            return {
              mcpProvider: { providerId: p?.id ?? null, connected: oauth?.status === 'connected', headerPresent: false }
            }
          }
          if (want.type === 'code-host') return { codeHostConnected: await codeHost(agent.orgId, want) }
          const integrations = await deps.integrations.activeForAgents([agent.id])
          return { integrationConnected: integrations.some((i) => i.platform === want.platform) }
        }
        case 'secret': {
          const use = ask.want.use
          if (use.route !== 'mcp-header') return {}
          const p = await provider(agent.orgId, use.server)
          // Names only: the values are dropped here and never leave this function.
          const names = p ? ((await deps.mcpSecrets.get(agent.orgId, p.id)) ?? []).map((h) => h.name.toLowerCase()) : []
          return {
            mcpProvider: {
              providerId: p?.id ?? null,
              connected: false,
              headerPresent: names.includes(ask.want.name.toLowerCase())
            }
          }
        }
        default:
          return {}
      }
    },

    async unknownTarget(agent, ask) {
      if (ask.kind === 'connection') {
        const want = ask.want
        if (want.type === 'mcp-oauth') {
          const p = await provider(agent.orgId, want.server)
          if (!p) return `This organization has no MCP server named ${JSON.stringify(want.server)}.`
          if (p.auth !== 'oauth2') return `MCP server ${JSON.stringify(want.server)} does not connect with OAuth.`
        }
        if (want.type === 'code-host' && want.provider === 'gitlab' && !sameGitlabHost(want.host, deps.gitlabHost))
          return `This deployment does not connect to GitLab at ${JSON.stringify(want.host)}.`
        if (want.type === 'chat-integration' && !deps.knownPlatform(want.platform))
          return `There is no chat platform named ${JSON.stringify(want.platform)}.`
      }
      if (
        ask.kind === 'repository' &&
        ask.want.provider === 'gitlab' &&
        !sameGitlabHost(ask.want.host, deps.gitlabHost)
      )
        return `This deployment does not connect to GitLab at ${JSON.stringify(ask.want.host)}.`
      if (ask.kind === 'secret' && ask.want.use.route === 'mcp-header') {
        const p = await provider(agent.orgId, ask.want.use.server)
        if (!p) return `This organization has no MCP server named ${JSON.stringify(ask.want.use.server)}.`
        if (p.auth !== 'headers')
          return `MCP server ${JSON.stringify(ask.want.use.server)} does not take upstream headers.`
      }
      return undefined
    }
  }
}

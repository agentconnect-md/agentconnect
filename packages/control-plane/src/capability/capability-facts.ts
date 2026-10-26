// The rows outside the agent that the Phase 2 kinds are judged by (capability-requests.md §4.2, §4.6): never a secret's value.
import {
  gitRepoLabel,
  type CapabilityAsk,
  type CapabilityConnectionWant,
  type CapabilityRepositoryWant
} from '@agentconnect.md/protocol'
import type { OrgId } from '../domain/ids.js'
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
  /** The agent's live secret names, never their values. */
  liveSecretNames: (orgId: OrgId, agentId: AgentRecord['id']) => Promise<readonly string[]>
  /** The agent's spawn-time secret names, which a live secret may not reuse. */
  spawnSecretNames?: (orgId: OrgId, agentId: AgentRecord['id']) => Promise<readonly string[]>
  /** The deployment's GitLab host (`gitlab.com` unless self-managed). */
  gitlabHost: string
}

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

  // The tier credential issuance would mint at, in its own order: the workspace's repository, an exact grant, then an installation grant (GithubService.resolveAgentRepoAuthorizationByName).
  const repository = async (
    agent: AgentRecord,
    want: CapabilityRepositoryWant
  ): Promise<CapabilityFacts['repository']> => {
    const path = want.repository.toLowerCase()
    const workspace = agent.workspace
    if (
      workspace.mode === 'git' &&
      workspace.credential?.provider === want.provider &&
      gitRepoLabel(workspace.gitRepo).toLowerCase() === path
    ) {
      const repoId = agent.workspaceRepoId
      return {
        authorized: tierOf(workspace.credential.access as RepoAccess),
        repoId: repoId !== undefined ? repoId.toString() : null,
        installationId: null,
        installationWide: false
      }
    }
    const exact = (await deps.repoAuth.listForAgent(agent.id)).find(
      (g) => g.provider === want.provider && isHonoredRepoGrant(g) && g.repoFullName.toLowerCase() === path
    )
    if (exact)
      return {
        authorized: tierOf(exact.access),
        repoId: exact.repoId.toString(),
        installationId: null,
        installationWide: false
      }
    // An installation grant covers every repository of its account, and counts only where no exact grant exists (GitHub only in this version).
    const owner = path.split('/')[0]
    const installation =
      want.provider === 'github'
        ? (await deps.installationAuth.listForAgent(agent.id)).find((g) => g.accountLogin.toLowerCase() === owner)
        : undefined
    return {
      authorized: tierOf(installation?.access),
      repoId: null,
      installationId: installation ? installation.installationId.toString() : null,
      installationWide: installation !== undefined
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
          return { repository: await repository(agent, ask.want) }
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
          if (use.route === 'live')
            return { liveSecretPresent: (await deps.liveSecretNames(agent.orgId, agent.id)).includes(ask.want.name) }
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
      // A live secret named like an environment variable or spawn-time secret of the agent could never be saved, so it is never asked for.
      if (ask.kind === 'secret' && ask.want.use.route === 'live') {
        const name = ask.want.name
        const taken = name in agent.env || ((await deps.spawnSecretNames?.(agent.orgId, agent.id)) ?? []).includes(name)
        return taken
          ? `${name} is already an environment variable or secret of this agent; ask for a live secret under another name.`
          : undefined
      }
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

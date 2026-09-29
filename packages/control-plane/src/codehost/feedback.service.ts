import {
  CODEHOST_FEEDBACK_FEATURE,
  codeHostReviewPublicEffect,
  type CodeHostHookMetadata,
  type CodeHostReviewResultReport,
  type RcCodeHostFeedback,
  type RcCodeHostFeedbackResult,
  type RcCodeHostFeedbackWatch
} from '@agentconnect.md/protocol'
import { OrgId } from '../domain/ids.js'
import type { AgentRecord, AgentRepo, PullRequestWakeRecord, SessionMetaRecord } from '../persistence/ports.js'
import type { RelayChannel } from '../ws/relay-registry.js'
import type { FeedbackCapture, SessionPullRequestFeedbackService } from './session-pull-request-feedback.service.js'

export interface FeedbackPull {
  number: number
  branch: string
  headSha: string
  sourceRepoId: bigint
}

export interface FeedbackRepository {
  bindingId: string
  orgId: string
  repoId: bigint
  repoFullName: string
  host: string
  signingKey: string | null
  nextSigningKey?: string
  pulls(query: { branch?: string; number?: number }): Promise<FeedbackPull[]>
  admits(signal: RcCodeHostFeedback): Promise<boolean>
}

export interface FeedbackProvider {
  provider: RcCodeHostFeedback['provider']
  pullNumber(metadata: CodeHostHookMetadata): number | undefined
  repositories(): Promise<Array<{ orgId: string; repoId: bigint }>>
  repository(orgId: string, repoId: bigint): Promise<FeedbackRepository | null>
}

export function ownsFeedbackWorkspace(agent: AgentRecord, provider: string, repoId: bigint): boolean {
  return (
    agent.workspace.mode === 'git' &&
    agent.workspace.credential?.provider === provider &&
    agent.workspaceRepoId === repoId &&
    agent.workspace.credential?.access === 'write'
  )
}

export class CodeHostFeedbackService {
  private readonly providers: Map<string, FeedbackProvider>

  constructor(
    private readonly deps: {
      providers: FeedbackProvider[]
      agents: Pick<AgentRepo, 'list'>
      readBranch(agent: AgentRecord, session: SessionMetaRecord): Promise<string | null>
      queue: SessionPullRequestFeedbackService
      broadcast(watch: RcCodeHostFeedbackWatch): void
    }
  ) {
    this.providers = new Map(deps.providers.map((provider) => [provider.provider, provider]))
  }

  async wants(provider: string, orgId: string, repoId: bigint): Promise<boolean> {
    return (await this.deps.agents.list(OrgId(orgId))).some((agent) => ownsFeedbackWorkspace(agent, provider, repoId))
  }

  private async watch(provider: FeedbackProvider, orgId: string, repoId: bigint): Promise<RcCodeHostFeedbackWatch> {
    const repo = await provider.repository(orgId, repoId)
    return {
      provider: provider.provider,
      repoId: String(repoId),
      ...(repo?.signingKey && (await this.wants(provider.provider, orgId, repoId))
        ? {
            watch: {
              orgId,
              bindingId: repo.bindingId,
              host: repo.host,
              signingKey: repo.signingKey,
              ...(repo.nextSigningKey ? { nextSigningKey: repo.nextSigningKey } : {})
            }
          }
        : {})
    }
  }

  async sync(providerId: string, orgId: string, repoId: bigint): Promise<void> {
    const provider = this.providers.get(providerId)
    if (provider) this.deps.broadcast(await this.watch(provider, orgId, repoId))
  }

  async replayTo(channel: RelayChannel): Promise<void> {
    if (!channel.features?.includes(CODEHOST_FEEDBACK_FEATURE)) return
    for (const provider of this.providers.values()) {
      for (const repo of await provider.repositories()) {
        channel.send('rc/codehost-feedback-watch', await this.watch(provider, repo.orgId, repo.repoId))
      }
    }
  }

  async capture(agent: AgentRecord, session: SessionMetaRecord): Promise<FeedbackCapture> {
    if (agent.workspace.mode !== 'git' || !agent.workspace.credential || agent.workspaceRepoId === undefined)
      return { status: 'absent' }
    const provider = this.providers.get(agent.workspace.credential.provider)
    if (!provider || !ownsFeedbackWorkspace(agent, provider.provider, agent.workspaceRepoId))
      return { status: 'absent' }
    const repo = await provider.repository(agent.orgId, agent.workspaceRepoId)
    if (!repo) return { status: 'absent' }
    const branch = await this.deps.readBranch(agent, session)
    if (!branch) return { status: 'absent' }
    const pulls = (await repo.pulls({ branch })).filter(
      (pull) => pull.branch === branch && pull.sourceRepoId === repo.repoId
    )
    if (pulls.length !== 1) return { status: 'absent' }
    return {
      status: 'resolved',
      link: {
        provider: provider.provider,
        bindingId: repo.bindingId,
        host: repo.host,
        installationId: null,
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        pullNumber: pulls[0]!.number,
        branch,
        scope: 'session',
        ambiguous: false
      }
    }
  }

  async validate(item: PullRequestWakeRecord, agent: AgentRecord): Promise<boolean> {
    const provider = this.providers.get(item.provider ?? '')
    if (!provider || !ownsFeedbackWorkspace(agent, provider.provider, item.repoId)) return false
    const repo = await provider.repository(item.orgId, item.repoId)
    if (!repo || repo.bindingId !== item.bindingId || repo.host !== item.host) return false
    const pulls = await repo.pulls({ number: item.pullNumber })
    return pulls.some(
      (pull) =>
        pull.number === item.pullNumber &&
        pull.sourceRepoId === item.repoId &&
        (!item.headSha || pull.headSha === item.headSha)
    )
  }

  async receive(signal: RcCodeHostFeedback): Promise<RcCodeHostFeedbackResult> {
    const provider = this.providers.get(signal.provider)
    const repo = await provider?.repository(signal.orgId, BigInt(signal.repoId))
    if (!repo || repo.bindingId !== signal.bindingId || repo.host !== signal.host)
      return { accepted: true, authorAgentIds: [] }
    if (signal.kind === 'comment' && !(await repo.admits(signal))) return { accepted: true, authorAgentIds: [] }
    const authors = await this.enqueue(repo, signal.provider, signal, undefined)
    return { accepted: true, authorAgentIds: authors }
  }

  // The publication ledger already authenticated this result; platform bot webhooks never impersonate its reviewer.
  async reviewPublished(
    orgId: string,
    agentId: string,
    result: CodeHostReviewResultReport,
    sourceSessionId?: string
  ): Promise<void> {
    if (codeHostReviewPublicEffect(result.state) !== 'present') return
    const provider = this.providers.get(result.provider)
    const repo = await provider?.repository(orgId, BigInt(result.projectId))
    if (!repo || !provider) return
    await this.enqueue(
      repo,
      provider.provider,
      {
        deliveryKey: `review:${result.attemptId}`,
        pullNumber: result.mergeRequestIid,
        headSha: result.headSha
      },
      agentId,
      sourceSessionId
    )
  }

  async outputPublished(
    orgId: string,
    agentId: string,
    metadata: CodeHostHookMetadata,
    outputId: string,
    sourceSessionId?: string
  ): Promise<void> {
    const provider = this.providers.get(metadata.provider)
    const pullNumber = provider?.pullNumber(metadata)
    if (!provider || pullNumber === undefined) return
    const repo = await provider.repository(orgId, BigInt(metadata.repo.externalId))
    if (!repo) return
    await this.enqueue(
      repo,
      provider.provider,
      { deliveryKey: `output:${outputId}`, pullNumber },
      agentId,
      sourceSessionId
    )
  }

  private async enqueue(
    repo: FeedbackRepository,
    provider: RcCodeHostFeedback['provider'],
    signal: Pick<RcCodeHostFeedback, 'deliveryKey' | 'pullNumber' | 'headSha'>,
    sourceAgentId: string | undefined,
    sourceSessionId?: string
  ): Promise<string[]> {
    const pulls = await repo.pulls({ number: signal.pullNumber })
    const authors = new Set<string>()
    for (const pull of pulls) {
      if (pull.sourceRepoId !== repo.repoId || (signal.headSha && pull.headSha !== signal.headSha)) continue
      const owner = await this.deps.queue.enqueueForOrg(OrgId(repo.orgId), {
        provider,
        bindingId: repo.bindingId,
        host: repo.host,
        repoId: String(repo.repoId),
        repoFullName: repo.repoFullName,
        pullNumber: pull.number,
        deliveryKey: signal.deliveryKey,
        ...(signal.headSha ? { headSha: signal.headSha } : {}),
        ...(sourceAgentId ? { sourceAgentId } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {})
      })
      if (owner) authors.add(owner)
    }
    return [...authors]
  }
}

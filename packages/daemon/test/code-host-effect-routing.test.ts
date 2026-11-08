import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { codeHostEffectGuidance, codeHostEffectToolsFor } from '../src/codehost/effect-tools.js'
import { sessionKey } from '../src/store/local-store.js'
import type { CodeHostEffectReq } from '../src/mcp/ops/code-host.js'
import { descriptionInitiator, initiatorFooter, withDescriptionFooter } from '../src/codehost/description-footer.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL = 'hook-1'
const THREAD = 'thread-1'

function daemonWith(workspace: { provider: string; repoId: string }, hook?: { provider: string; repoId: string }) {
  const daemon = new Daemon({ sandboxMechanism: null } as never)
  const inner = daemon as never as {
    codeHostBrokers: Map<string, { execute: ReturnType<typeof vi.fn> }>
    activeTurnCodeHost: Map<string, unknown>
    managedWorkspaceRepo: (agentId: string) => unknown
    runCodeHostEffect: (req: CodeHostEffectReq) => Promise<unknown>
  }
  const gitlab = { execute: vi.fn(async () => ({ ok: 'gitlab' })) }
  const gitea = { execute: vi.fn(async () => ({ ok: 'gitea' })) }
  inner.codeHostBrokers.set('gitlab', gitlab)
  inner.codeHostBrokers.set('gitea', gitea)
  vi.spyOn(inner, 'managedWorkspaceRepo').mockReturnValue(workspace)
  const key = sessionKey('hook', CHANNEL, THREAD, AGENT_ID)
  if (hook) inner.activeTurnCodeHost.set(key, { agentId: AGENT_ID, ...hook })
  const run = (provider: 'gitlab' | 'gitea') =>
    inner.runCodeHostEffect({
      provider,
      agentId: AGENT_ID,
      platform: 'hook',
      channel: CHANNEL,
      thread: THREAD,
      operation: { kind: 'createComment', subject: 'issue', iid: 7, body: 'hi' }
    })
  return { run, gitlab, gitea, key }
}

describe('code-host effect routing', () => {
  it('refuses a tool whose host has no repository in the session instead of acting on another host', async () => {
    const { run, gitlab, gitea } = daemonWith({ provider: 'gitlab', repoId: '10' })
    await expect(run('gitea')).rejects.toThrow('this session has no gitea repository of its own')
    expect(gitlab.execute).not.toHaveBeenCalled()
    expect(gitea.execute).not.toHaveBeenCalled()
  })

  it("acts on the tool's own host when the hook turn belongs to another", async () => {
    const { run, gitlab, gitea, key } = daemonWith(
      { provider: 'gitlab', repoId: '10' },
      { provider: 'gitea', repoId: '20' }
    )
    await run('gitlab')
    expect(gitlab.execute).toHaveBeenCalledWith(
      { provider: 'gitlab', repoId: '10', agentId: AGENT_ID, sessionKey: key },
      expect.anything()
    )
    await run('gitea')
    expect(gitea.execute).toHaveBeenCalledWith(
      { provider: 'gitea', repoId: '20', agentId: AGENT_ID, sessionKey: key },
      expect.anything()
    )
  })
})

describe('a repository the model names', () => {
  function namedDaemon() {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const inner = daemon as never as {
      agents: Map<string, unknown>
      codeHostBrokers: Map<string, { execute: ReturnType<typeof vi.fn> }>
      activeTurnCodeHost: Map<string, unknown>
      managedWorkspaceRepo: (agentId: string) => unknown
      holdsEffectRepository: (agent: unknown, provider: string) => boolean
      runCodeHostEffect: (req: CodeHostEffectReq) => Promise<unknown>
    }
    const agent = {
      id: AGENT_ID,
      output: { showFooter: false },
      workspace: {
        mode: 'git-repo',
        additionalRepos: [{ provider: 'gitlab', repoId: '30', repoFullName: 'example-group/other-project' }],
        additionalInstallations: [{ provider: 'github', accountLogin: 'Example-Org', access: 'write' }]
      }
    }
    inner.agents.set(AGENT_ID, agent)
    const brokers = {
      github: { execute: vi.fn(async () => ({})) },
      gitlab: { execute: vi.fn(async () => ({})) },
      gitea: { execute: vi.fn(async () => ({})) }
    }
    for (const [provider, broker] of Object.entries(brokers)) inner.codeHostBrokers.set(provider, broker)
    vi.spyOn(inner, 'managedWorkspaceRepo').mockReturnValue({
      provider: 'gitlab',
      repoId: '10',
      repoPath: 'example-group/workspace'
    })
    const key = sessionKey('hook', CHANNEL, THREAD, AGENT_ID)
    inner.activeTurnCodeHost.set(key, {
      agentId: AGENT_ID,
      provider: 'gitlab',
      repoId: '20',
      repoPath: 'example-group/hooked',
      hookId: 'hook-9'
    })
    const run = (provider: 'github' | 'gitlab' | 'gitea', repository?: string) =>
      inner.runCodeHostEffect({
        provider,
        agentId: AGENT_ID,
        platform: 'hook',
        channel: CHANNEL,
        thread: THREAD,
        ...(repository !== undefined ? { repository } : {}),
        operation: { kind: 'createComment', subject: 'issue', iid: 7, body: 'hi' }
      })
    const targetOf = (broker: { execute: ReturnType<typeof vi.fn> }) =>
      (broker.execute.mock.calls.at(-1) as unknown[])[0]
    return { inner, agent, brokers, run, key, targetOf }
  }

  it('keeps the hook turn first when nothing is named', async () => {
    const { brokers, run, key, targetOf } = namedDaemon()
    await run('gitlab')
    expect(targetOf(brokers.gitlab)).toEqual({
      provider: 'gitlab',
      repoId: '20',
      repoPath: 'example-group/hooked',
      hookId: 'hook-9',
      agentId: AGENT_ID,
      sessionKey: key
    })
  })

  it('acts on the workspace, the hook repository, or an additional repository by name, ignoring case', async () => {
    const { brokers, run, targetOf } = namedDaemon()
    await run('gitlab', 'example-group/workspace')
    expect(targetOf(brokers.gitlab)).toMatchObject({ repoId: '10', repoPath: 'example-group/workspace' })
    expect(targetOf(brokers.gitlab)).not.toHaveProperty('hookId')
    await run('gitlab', 'example-group/hooked')
    expect(targetOf(brokers.gitlab)).toMatchObject({ repoId: '20', hookId: 'hook-9' })
    await run('gitlab', 'Example-Group/Other-Project')
    expect(targetOf(brokers.gitlab)).toMatchObject({ repoId: '30', repoPath: 'example-group/other-project' })
    expect(targetOf(brokers.gitlab)).not.toHaveProperty('hookId')
  })

  it('addresses a repository an installation grant covers by its path, on a host that resolves by name', async () => {
    const { brokers, run, targetOf } = namedDaemon()
    await run('github', 'example-org/another-repo')
    expect(targetOf(brokers.github)).toMatchObject({
      provider: 'github',
      repoId: 'example-org/another-repo',
      repoPath: 'example-org/another-repo'
    })
  })

  it('refuses a repository the agent holds no authorization for, or one on another host, before any broker call', async () => {
    const { brokers, run } = namedDaemon()
    await expect(run('gitlab', 'example-group/unknown')).rejects.toThrow(
      'example-group/unknown is not a gitlab repository this agent is authorized for'
    )
    await expect(run('gitea', 'example-group/other-project')).rejects.toThrow(
      'example-group/other-project is not a gitea repository this agent is authorized for'
    )
    await expect(run('github', 'other-org/repo')).rejects.toThrow('is not a github repository')
    await expect(run('github', 'example-org/repo/extra')).rejects.toThrow('is not a github repository')
    for (const broker of Object.values(brokers)) expect(broker.execute).not.toHaveBeenCalled()
  })

  it("offers a host's tools for any repository the agent holds there, not only its workspace", () => {
    const { inner, agent } = namedDaemon()
    expect(inner.holdsEffectRepository(agent, 'gitlab')).toBe(true)
    expect(inner.holdsEffectRepository(agent, 'github')).toBe(true)
    expect(inner.holdsEffectRepository(agent, 'gitea')).toBe(false)
  })
})

describe('a GitHub workspace and the description footer', () => {
  function githubDaemon(showFooter: boolean) {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const inner = daemon as never as {
      agents: Map<string, unknown>
      codeHostBrokers: Map<string, { execute: ReturnType<typeof vi.fn> }>
      managedWorkspaceRepo: (agentId: string) => unknown
      workspaces: { managedCredentialProvider: (agent: unknown) => string | undefined; specHostsOf: () => object }
      store: { getSession: (key: string) => Promise<unknown>; assistantSubsessions: { get: () => Promise<unknown> } }
      githubReviews: { githubCommentAttribution: (...args: unknown[]) => Promise<unknown> }
      workspaceEffectTarget: (agentId: string) => unknown
      runCodeHostEffect: (req: CodeHostEffectReq) => Promise<unknown>
    }
    inner.agents.set(AGENT_ID, {
      id: AGENT_ID,
      output: { showFooter },
      workspace: { mode: 'git-repo', gitRepo: 'https://github.com/example-org/example-repo' }
    })
    vi.spyOn(inner, 'managedWorkspaceRepo').mockReturnValue(undefined)
    vi.spyOn(inner.workspaces, 'managedCredentialProvider').mockReturnValue('github')
    vi.spyOn(inner.workspaces, 'specHostsOf').mockReturnValue({})
    inner.store = {
      getSession: vi.fn(async () => ({
        sessionId: 'acp-session-1',
        initiator: JSON.stringify({ name: 'Alex', commitAuthors: [] })
      })),
      assistantSubsessions: { get: async () => undefined }
    }
    inner.githubReviews = {
      githubCommentAttribution: vi.fn(async () => ({
        agentName: 'Example Agent',
        agentUrl: 'https://console.example.test/agents/1',
        runtime: 'Example Runtime',
        model: 'example-model',
        sessionUrl: 'https://console.example.test/sessions/1'
      }))
    }
    const github = { execute: vi.fn(async (_target: unknown, _operation: unknown): Promise<unknown> => ({})) }
    inner.codeHostBrokers.set('github', github)
    const create = () =>
      inner.runCodeHostEffect({
        provider: 'github',
        agentId: AGENT_ID,
        platform: 'hook',
        channel: CHANNEL,
        thread: THREAD,
        operation: {
          kind: 'createMergeRequest',
          sourceBranch: 'feature',
          targetBranch: 'main',
          title: 't',
          description: 'Body'
        }
      })
    return { inner, github, create }
  }

  it('delegates for the current requester in a long conversation and keeps the original requester in a task', async () => {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const inner = daemon as any
    const task = vi.fn(async (): Promise<unknown> => undefined)
    const session = { key: 'parent', agentId: AGENT_ID, initiator: JSON.stringify({ name: 'Alex', commitAuthors: [] }) }
    inner.store = {
      getSession: async () => session,
      getDisplayNames: async () => new Map([['U-DANA', 'Dana']]),
      assistantSubsessions: { get: task }
    }
    inner.activeGateEntries.set('parent', {
      agentId: AGENT_ID,
      msg: { source: 'user', platform: 'slack', sender: { id: 'U-DANA', isBot: false } }
    })
    expect(await inner.initiatorForSession('parent')).toEqual({ name: 'Dana', commitAuthors: [] })
    task.mockResolvedValue({ childSessionKey: 'parent' })
    expect(await inner.initiatorForSession('parent')).toEqual({ name: 'Alex', commitAuthors: [] })
  })

  it('snapshots linked commit identities using the trusted sender and keeps missing links optional', async () => {
    const inner = new Daemon({ sandboxMechanism: null } as never) as any
    const authors = [
      { provider: 'github', host: 'github.com', name: 'alex', email: '123+alex@users.noreply.github.com' }
    ]
    const readAccess = vi.fn(async () => ({ asker: 'linked', visibleSessionIds: [], commitAuthors: authors }))
    inner.cpClient = { supportsServerFeature: () => true, readAccess }
    inner.cpCollab = { orgForAgent: () => 'org-1' }
    inner.store = { getDisplayNames: async () => new Map() }
    const message = { source: 'user', platform: 'slack', sender: { id: 'U1', name: 'Alex', isBot: false } }
    expect(await inner.initiatorForMessage(AGENT_ID, message, 'integration-1')).toEqual({
      name: 'Alex',
      commitAuthors: authors
    })
    expect(readAccess).toHaveBeenCalledWith(
      {
        agentId: AGENT_ID,
        asker: { integrationId: 'integration-1', memberId: 'U1' },
        sessionIds: [],
        includeCommitAuthors: true
      },
      'org-1'
    )
    await inner.initiatorForMessage(AGENT_ID, message, 'integration-1')
    expect(readAccess).toHaveBeenCalledTimes(1)
    readAccess.mockRejectedValue(new Error('identity service unavailable'))
    expect(await inner.initiatorForMessage(AGENT_ID, { ...message, initiator: undefined }, 'integration-1')).toEqual({
      name: 'Alex',
      commitAuthors: []
    })
  })

  it('addresses a GitHub workspace by its path, since the spec carries no numeric id for it', () => {
    const { inner } = githubDaemon(false)
    expect(inner.workspaceEffectTarget(AGENT_ID)).toEqual({
      provider: 'github',
      repoId: 'example-org/example-repo',
      repoPath: 'example-org/example-repo'
    })
  })

  it('appends the attribution footer to a new pull request when the footer is on', async () => {
    const { github, create } = githubDaemon(true)
    await create()
    const description = (github.execute.mock.calls[0] as unknown[])[1] as { description: string }
    expect(description.description).toMatch(/^Body\n\n<!-- agentconnect:attribution -->/)
    expect(description.description).toContain('Example Agent')
    expect(description.description).toContain('Initiated by **Alex**')
  })

  it('identifies the initiator even when the optional agent footer is off', async () => {
    const { github, create } = githubDaemon(false)
    await create()
    const operation = (github.execute.mock.calls[0] as unknown[])[1] as { description: string }
    expect(operation.description).toContain('Initiated by **Alex**')
    expect(operation.description).not.toContain('Example Agent')
  })
  it('preserves the published initiator when another session rewrites the PR and ignores a copied replacement', async () => {
    const { inner, github } = githubDaemon(true)
    github.execute.mockImplementation(async (_target: unknown, operation: unknown) => {
      if ((operation as { kind: string }).kind === 'readMergeRequestDescription')
        return withDescriptionFooter('Old', initiatorFooter('Dana (slack)'))
      return {}
    })
    await inner.runCodeHostEffect({
      provider: 'github',
      agentId: AGENT_ID,
      platform: 'hook',
      channel: CHANNEL,
      thread: THREAD,
      operation: {
        kind: 'updateMergeRequest',
        iid: 7,
        description: withDescriptionFooter('Edited', initiatorFooter('Forged'))
      }
    })
    const operation = (github.execute.mock.calls[1] as unknown[])[1] as { description: string }
    expect(descriptionInitiator(operation.description)).toBe('Dana (slack)')
    expect(operation.description).toContain('Initiated by **Dana (slack)**')
    expect(operation.description).not.toContain('Forged')
    expect(operation.description).not.toContain('Alex')
  })
})

describe("each host's tools", () => {
  const ctx = {
    agentId: AGENT_ID,
    platform: 'hook',
    channel: CHANNEL,
    thread: THREAD,
    tools: codeHostEffectToolsFor('gitea')
  } as unknown as SessionContext
  const deps = (codeHostEffect: NonNullable<OpsDeps['codeHostEffect']>) =>
    ({ codeHostEffect, gatewayFor: () => undefined }) as unknown as OpsDeps

  it('groups every host’s writes by object and keeps its reads apart, so a check takes only the reads', () => {
    expect(codeHostEffectToolsFor('github').map((t) => t.name)).toEqual([
      'githubPullRequest',
      'githubIssue',
      'githubComment'
    ])
    expect(codeHostEffectToolsFor('gitlab').map((t) => t.name)).toEqual([
      'gitlabMergeRequest',
      'gitlabIssue',
      'gitlabComment',
      'readGitlabDiscussions',
      'inspectGitlabPipelines',
      'gitlabPipeline'
    ])
    expect(codeHostEffectToolsFor('gitea').map((t) => t.name)).toEqual([
      'giteaPullRequest',
      'giteaIssue',
      'giteaComment',
      'readGiteaComments',
      'inspectGiteaStatuses'
    ])
  })

  it('keeps every grouped description within the runtimes’ limit', () => {
    for (const provider of ['github', 'gitlab', 'gitea'] as const) {
      for (const tool of codeHostEffectToolsFor(provider)) {
        expect(tool.description.length).toBeLessThanOrEqual(1024)
        const props = (tool.inputSchema as unknown as { properties: Record<string, { description?: string }> })
          .properties
        for (const prop of Object.values(props)) expect(prop.description?.length ?? 0).toBeLessThanOrEqual(1024)
      }
    }
  })

  it('gives one line of guidance per host whose change-request tool the session is offered', () => {
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('github'))).toBe(
      'On GitHub, open, edit and merge pull requests, file issues, and comment with `githubPullRequest`, `githubIssue` and `githubComment`.'
    )
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('gitlab'))).toContain('`gitlabMergeRequest`')
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('gitea'))).toContain('`giteaPullRequest`')
    // A check keeps only the reads, so it gets no guidance about opening anything.
    const reads = codeHostEffectToolsFor('gitlab').filter((t) => t.name.startsWith('read'))
    expect(codeHostEffectGuidance(reads)).toBeUndefined()
  })

  it('maps each action onto its broker operation', async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    const github = { ...ctx, tools: codeHostEffectToolsFor('github') } as unknown as SessionContext
    const calls: [string, Record<string, unknown>][] = [
      [
        'githubPullRequest',
        {
          action: 'create',
          sourceBranch: 'feat',
          targetBranch: 'main',
          title: 'T',
          labels: ['bug'],
          reviewers: ['ann']
        }
      ],
      ['githubPullRequest', { action: 'update', iid: 4, draft: false }],
      ['githubPullRequest', { action: 'merge', iid: 4, mergeMethod: 'squash', sha: 'abc1234' }],
      ['githubPullRequest', { action: 'close', iid: 4 }],
      ['githubIssue', { action: 'create', title: 'Bug', assignees: ['ann'] }],
      ['githubIssue', { action: 'update', iid: 9, addLabels: ['bug'], removeAssignees: ['ann'] }],
      ['githubIssue', { action: 'reopen', iid: 9 }],
      ['githubComment', { action: 'create', subject: 'pull_request', iid: 4, body: 'hi' }],
      ['githubComment', { action: 'update', subject: 'issue', iid: 9, body: 'edit', commentId: '77' }]
    ]
    for (const [name, args] of calls) await executeTool(github, name, args, deps(codeHostEffect))
    expect(codeHostEffect.mock.calls.map(([req]) => req.operation)).toEqual([
      {
        kind: 'createMergeRequest',
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'T',
        labels: ['bug'],
        reviewers: ['ann']
      },
      { kind: 'updateMergeRequest', iid: 4, draft: false },
      { kind: 'mergeMergeRequest', iid: 4, method: 'squash', sha: 'abc1234' },
      { kind: 'setState', subject: 'merge_request', iid: 4, state: 'closed' },
      { kind: 'createIssue', title: 'Bug', assignees: ['ann'] },
      { kind: 'updateIssue', iid: 9, addLabels: ['bug'], removeAssignees: ['ann'] },
      { kind: 'setState', subject: 'issue', iid: 9, state: 'open' },
      { kind: 'createComment', subject: 'merge_request', iid: 4, body: 'hi' },
      { kind: 'updateComment', subject: 'issue', iid: 9, body: 'edit', noteId: '77' }
    ])
  })

  it('refuses a field the action does not take, a missing required one, and an empty update', async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    const github = { ...ctx, tools: codeHostEffectToolsFor('github') } as unknown as SessionContext
    const run = (name: string, args: Record<string, unknown>) => executeTool(github, name, args, deps(codeHostEffect))
    await expect(run('githubPullRequest', { action: 'merge', iid: 4, title: 'x' })).rejects.toThrow(
      'action merge does not take title'
    )
    await expect(run('githubPullRequest', { action: 'create', title: 'x' })).rejects.toThrow(
      'action create requires sourceBranch, targetBranch'
    )
    await expect(run('githubPullRequest', { action: 'update', iid: 4 })).rejects.toThrow(
      'action update needs at least one of'
    )
    await expect(run('githubIssue', { action: 'close' })).rejects.toThrow('action close requires iid')
    // An update adds or removes, as the CLIs do; the whole-set fields belong to create alone.
    await expect(run('githubIssue', { action: 'update', iid: 9, labels: ['bug'] })).rejects.toThrow(
      'action update does not take labels'
    )
    await expect(run('githubIssue', { action: 'create', title: 't', addLabels: ['bug'] })).rejects.toThrow(
      'action create does not take addLabels'
    )
    await expect(run('githubComment', { action: 'update', subject: 'issue', iid: 1, body: 'x' })).rejects.toThrow(
      'action update requires commentId'
    )
    expect(codeHostEffect).not.toHaveBeenCalled()
  })

  it('keeps a title-carried draft tied to the title, and tells how a GitLab merge lands', async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    const gitlab = { ...ctx, tools: codeHostEffectToolsFor('gitlab') } as unknown as SessionContext
    await expect(
      executeTool(gitlab, 'gitlabMergeRequest', { action: 'update', iid: 4, draft: true }, deps(codeHostEffect))
    ).rejects.toThrow('argument draft also requires title')
    await expect(
      executeTool(gitlab, 'gitlabMergeRequest', { action: 'merge', iid: 4, mergeMethod: 'fast' }, deps(codeHostEffect))
    ).rejects.toThrow('argument mergeMethod must be one of: merge, squash, rebase')
    const merge = (
      codeHostEffectToolsFor('gitlab')[0]!.inputSchema as unknown as {
        properties: Record<string, { description: string }>
      }
    ).properties.mergeMethod!.description
    expect(merge).toContain('merges once the pipeline passes')
    await executeTool(
      gitlab,
      'gitlabComment',
      { action: 'reply', subject: 'merge_request', iid: 4, body: 'ok', discussionId: 'abc123' },
      deps(codeHostEffect)
    )
    expect(codeHostEffect.mock.calls[0]?.[0].operation).toEqual({
      kind: 'replyDiscussion',
      subject: 'merge_request',
      iid: 4,
      body: 'ok',
      discussionId: 'abc123'
    })
  })

  it('carries a named repository beside the operation and describes it in the host’s own form', async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    await executeTool(
      ctx,
      'giteaComment',
      { action: 'create', subject: 'issue', iid: 3, body: 'hi', repository: 'example-org/other' },
      deps(codeHostEffect)
    )
    expect(codeHostEffect.mock.calls[0]?.[0]).toMatchObject({
      provider: 'gitea',
      repository: 'example-org/other',
      operation: { kind: 'createComment', subject: 'issue', iid: 3, body: 'hi' }
    })
    expect(codeHostEffect.mock.calls[0]?.[0].operation).not.toHaveProperty('repository')
    for (const provider of ['github', 'gitlab', 'gitea'] as const) {
      for (const tool of codeHostEffectToolsFor(provider)) {
        const schema = tool.inputSchema as unknown as {
          properties: Record<string, { description: string }>
          required: string[]
        }
        expect(schema.properties.repository?.description).toContain('Omit it to act on this session’s repository')
        expect(schema.required).not.toContain('repository')
      }
    }
    const gitlab = codeHostEffectToolsFor('gitlab')[0]!.inputSchema as unknown as {
      properties: Record<string, { description: string }>
    }
    expect(gitlab.properties.repository!.description).toContain('`group/subgroup/project`')
  })

  it("maps Gitea's words onto the broker's operations and names the host", async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    await executeTool(
      ctx,
      'giteaComment',
      { action: 'create', subject: 'pull_request', iid: 3, body: 'hi' },
      deps(codeHostEffect)
    )
    await executeTool(ctx, 'readGiteaComments', { subject: 'issue', iid: 3, commentId: '9' }, deps(codeHostEffect))
    await executeTool(ctx, 'inspectGiteaStatuses', { ref: 'main' }, deps(codeHostEffect))
    expect(codeHostEffect.mock.calls.map(([req]) => [req.provider, req.operation])).toEqual([
      ['gitea', { kind: 'createComment', subject: 'merge_request', iid: 3, body: 'hi' }],
      ['gitea', { kind: 'readDiscussions', subject: 'issue', iid: 3, discussionId: '9' }],
      ['gitea', { kind: 'inspectPipelines', scope: 'pipelines', ref: 'main' }]
    ])
    await expect(
      executeTool(
        ctx,
        'giteaComment',
        { action: 'create', subject: 'merge_request', iid: 3, body: 'hi' },
        deps(codeHostEffect)
      )
    ).rejects.toThrow('argument subject must be one of: issue, pull_request')
  })
})

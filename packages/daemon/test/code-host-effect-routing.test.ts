import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { codeHostEffectGuidance, codeHostEffectToolsFor } from '../src/codehost/effect-tools.js'
import { sessionKey } from '../src/store/local-store.js'
import type { CodeHostEffectReq } from '../src/mcp/ops/code-host.js'

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
    await expect(run('gitea')).rejects.toThrow('this session has no gitea repository to act on')
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

describe('a GitHub workspace and the description footer', () => {
  function githubDaemon(showFooter: boolean) {
    const daemon = new Daemon({ sandboxMechanism: null } as never)
    const inner = daemon as never as {
      agents: Map<string, unknown>
      codeHostBrokers: Map<string, { execute: ReturnType<typeof vi.fn> }>
      managedWorkspaceRepo: (agentId: string) => unknown
      workspaces: { managedCredentialProvider: (agent: unknown) => string | undefined; specHostsOf: () => object }
      store: { getSession: (key: string) => Promise<unknown> }
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
    inner.store = { getSession: vi.fn(async () => ({ sessionId: 'acp-session-1' })) }
    inner.githubReviews = {
      githubCommentAttribution: vi.fn(async () => ({
        agentName: 'Example Agent',
        agentUrl: 'https://console.example.test/agents/1',
        runtime: 'Example Runtime',
        model: 'example-model',
        sessionUrl: 'https://console.example.test/sessions/1'
      }))
    }
    const github = { execute: vi.fn(async () => ({})) }
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
  })

  it('leaves the description as written when the footer is off', async () => {
    const { github, create } = githubDaemon(false)
    await create()
    expect((github.execute.mock.calls[0] as unknown[])[1]).toMatchObject({ description: 'Body' })
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

  it('offers Gitea only the operations its broker implements', () => {
    expect(codeHostEffectToolsFor('gitea').map((t) => t.name)).toEqual([
      'createGiteaComment',
      'updateGiteaComment',
      'readGiteaComments',
      'createGiteaPullRequest',
      'updateGiteaPullRequest',
      'inspectGiteaStatuses'
    ])
    expect(codeHostEffectToolsFor('github').map((t) => t.name)).toEqual([
      'createGithubPullRequest',
      'updateGithubPullRequest'
    ])
  })

  it('gives one line of guidance per host whose change-request tools the session is offered', () => {
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('github'))).toBe(
      'On GitHub, open and edit pull requests with `createGithubPullRequest` and `updateGithubPullRequest`.'
    )
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('gitlab'))).toContain('`createGitlabMergeRequest`')
    expect(codeHostEffectGuidance(codeHostEffectToolsFor('gitea'))).toContain('`createGiteaPullRequest`')
    // A check keeps only the reads, so it gets no guidance about opening anything.
    const reads = codeHostEffectToolsFor('gitlab').filter((t) => t.name.startsWith('read'))
    expect(codeHostEffectGuidance(reads)).toBeUndefined()
  })

  it('lets a GitHub draft change stand alone, since GitHub keeps it apart from the title', async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    const github = { ...ctx, tools: codeHostEffectToolsFor('github') } as unknown as SessionContext
    await executeTool(github, 'updateGithubPullRequest', { iid: 4, draft: false }, deps(codeHostEffect))
    expect(codeHostEffect.mock.calls[0]?.[0]).toMatchObject({
      provider: 'github',
      operation: { kind: 'updateMergeRequest', iid: 4, draft: false }
    })
    await expect(executeTool(github, 'updateGithubPullRequest', { iid: 4 }, deps(codeHostEffect))).rejects.toThrow(
      'supply at least one of title, description, targetBranch, or draft'
    )
  })

  it("maps Gitea's words onto the broker's operations and names the host", async () => {
    const codeHostEffect = vi.fn(async (_req: CodeHostEffectReq): Promise<unknown> => ({}))
    await executeTool(ctx, 'createGiteaComment', { subject: 'pull_request', iid: 3, body: 'hi' }, deps(codeHostEffect))
    await executeTool(ctx, 'readGiteaComments', { subject: 'issue', iid: 3, commentId: '9' }, deps(codeHostEffect))
    await executeTool(ctx, 'inspectGiteaStatuses', { ref: 'main' }, deps(codeHostEffect))
    expect(codeHostEffect.mock.calls.map(([req]) => [req.provider, req.operation])).toEqual([
      ['gitea', { kind: 'createComment', subject: 'merge_request', iid: 3, body: 'hi' }],
      ['gitea', { kind: 'readDiscussions', subject: 'issue', iid: 3, discussionId: '9' }],
      ['gitea', { kind: 'inspectPipelines', scope: 'pipelines', ref: 'main' }]
    ])
    await expect(
      executeTool(ctx, 'createGiteaComment', { subject: 'merge_request', iid: 3, body: 'hi' }, deps(codeHostEffect))
    ).rejects.toThrow('argument subject must be one of: issue, pull_request')
  })
})

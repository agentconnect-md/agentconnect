import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { codeHostEffectToolsFor } from '../src/codehost/effect-tools.js'
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
    expect(codeHostEffectToolsFor('github')).toEqual([])
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

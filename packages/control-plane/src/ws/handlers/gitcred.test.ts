import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { GitCredDeniedError } from '../../github/service.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleGitCredRequest } from './gitcred.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG_ID = 'org-a'

/** An agent placed on DAEMON_ID — passes the handler's placement scope check. */
const PLACED_AGENT = { id: AGENT_ID, orgId: 'org-a', daemonId: DAEMON_ID }

function gitcredFrame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-11T00:00:00.000Z',
    type: 'gitcred/request',
    payload: { agentId: AGENT_ID, ...payload }
  } as AnyFrame
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    orgId: ORG_ID,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

describe('handleGitCredRequest — repoFullName passthrough (issue #457)', () => {
  it('forwards capabilities + repoFullName to mintForAgent and replies with the grant', async () => {
    const mintForAgent = vi.fn(async () => ({
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'Acme/Tools', // as the grant row stores it — may differ from the ask
      access: 'read' as const
    }))
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForAgent }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ capabilities: ['contents'], repoFullName: 'acme/tools' })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForAgent).toHaveBeenCalledWith(
      PLACED_AGENT,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      ['contents'],
      'acme/tools',
      undefined
    )
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', {
      username: 'x-access-token',
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'Acme/Tools',
      access: 'read'
    })
    expect(conn.sendError).not.toHaveBeenCalled()

    // An absent repoFullName stays absent — the pre-multi-repo workspace ask.
    await handleGitCredRequest(gitcredFrame(), conn, deps)
    expect(mintForAgent).toHaveBeenLastCalledWith(PLACED_AGENT, expect.anything(), undefined, undefined, undefined)
  })

  it('uses the enabled-hook mint for a GithubPoster reply instead of the workspace gitAccess path', async () => {
    const mintForAgent = vi.fn()
    const mintForHookReply = vi.fn(async () => ({
      token: 'ghs_comment',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'read' as const
    }))
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: {
        get: async () => ({
          agentId: AGENT_ID,
          kind: 'github',
          enabled: true,
          repoId: 501n,
          // The request uses the post-rename name. Authorization must stay on
          // hookId/repoId instead of this stale display field.
          repoFullName: 'acme/infra-old'
        })
      },
      github: { mintForAgent, mintForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      forceRefresh: true,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra-renamed'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForHookReply).toHaveBeenCalledWith(
      PLACED_AGENT,
      'acme/infra-renamed',
      501n,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      true,
      undefined
    )
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ token: 'ghs_comment', access: 'read' })
    )
  })

  it('denies a GithubPoster mint when no enabled hook watches the requested repo', async () => {
    const mintForHookReply = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => null },
      github: { mintForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/tools'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'hook is not an enabled github hook of this agent',
      false
    )
    expect(mintForHookReply).not.toHaveBeenCalled()
  })

  it('denies a malformed GithubPoster capability request before minting', async () => {
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForHookReply: vi.fn() }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'contents'],
      repoFullName: 'acme/tools'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'github hook reply credentials require a hook, one repo, and issues/pull_requests only',
      false
    )
  })

  it('routes a provider=gitlab request to the gitlab grant path (§17.1)', async () => {
    const grantForAgent = vi.fn(async () => ({
      username: 'agentconnect-p4455667',
      token: 'glpat-secret',
      ttlSec: 3600,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'example-group/example-project',
      access: 'write' as const,
      provider: 'gitlab',
      externalRepoId: '4455667',
      credentialEpoch: '3',
      providerExpiresAt: '2026-10-01T00:00:00.000Z'
    }))
    const mintForAgent = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForAgent },
      gitlabGitcred: { grantForAgent }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ provider: 'gitlab', externalRepoId: '4455667', consumer: 'proxy' })

    await handleGitCredRequest(frame, conn, deps)

    expect(grantForAgent).toHaveBeenCalledWith(PLACED_AGENT, 4455667n, undefined)
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ provider: 'gitlab', username: 'agentconnect-p4455667' })
    )
  })

  it('serves gitlab to the proxy and the daemon only, and has no lease for a purpose it does not know', async () => {
    const grantForAgent = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      gitlabGitcred: { grantForAgent }
    } as unknown as DaemonWsDeps
    for (const consumer of [undefined, 'helper']) {
      const conn = fakeConn()
      await handleGitCredRequest(
        gitcredFrame({ provider: 'gitlab', externalRepoId: '4455667', ...(consumer ? { consumer } : {}) }),
        conn,
        deps
      )
      expect(conn.sendError).toHaveBeenCalledWith(
        expect.anything(),
        'SCOPE_DENIED',
        expect.stringContaining("gitlab credentials are served only to the daemon's credential proxy and its own Git"),
        false
      )
    }
    const conn = fakeConn()
    await handleGitCredRequest(
      gitcredFrame({ provider: 'gitlab', externalRepoId: '4455667', consumer: 'proxy', purpose: 'gitea_effect' }),
      conn,
      deps
    )
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      'gitlab has no gitea_effect credential',
      false
    )
    expect(grantForAgent).not.toHaveBeenCalled()
  })

  it('routes a gitlab_hook_reply to the effect grant, gated by the enabled gitlab hook (§14.1)', async () => {
    const grantForHookReply = vi.fn(async () => ({
      username: 'agentconnect-p4455667',
      token: 'glpat-effect',
      ttlSec: 900,
      expiresAt: '2026-07-11T00:15:00.000Z',
      repoFullName: 'example-group/example-project',
      access: 'read' as const,
      provider: 'gitlab',
      externalRepoId: '4455667',
      credentialEpoch: '3',
      providerExpiresAt: '2026-10-01T00:00:00.000Z'
    }))
    const grantForAgent = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'gitlab', enabled: true, repoId: 4455667n }) },
      github: {},
      gitlabGitcred: { grantForAgent, grantForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'gitlab',
      purpose: 'gitlab_hook_reply',
      hookId: HOOK_ID,
      externalRepoId: '4455667'
    })

    await handleGitCredRequest(frame, conn, deps)

    // The workspace clamp is bypassed: the hook, not gitAccess, is the authority.
    // The reply is authored by the HOOK AGENT's own account (§7.2).
    expect(grantForHookReply).toHaveBeenCalledWith(ORG_ID, AGENT_ID, 4455667n)
    expect(grantForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ provider: 'gitlab', access: 'read', ttlSec: 900 })
    )
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('denies a gitlab_hook_reply whose hook is disabled, foreign, wrong-kind, or on another project', async () => {
    const grantForHookReply = vi.fn()
    const frame = gitcredFrame({
      provider: 'gitlab',
      purpose: 'gitlab_hook_reply',
      hookId: HOOK_ID,
      externalRepoId: '4455667'
    })
    const enabledGitlab = { agentId: AGENT_ID, kind: 'gitlab', enabled: true, repoId: 4455667n }
    const cases = [
      { ...enabledGitlab, enabled: false },
      { ...enabledGitlab, kind: 'github' },
      { ...enabledGitlab, repoId: 999n },
      { ...enabledGitlab, agentId: 'e0e0e0e0-eeee-4eee-8eee-eeeeeeeeeeee' },
      null
    ]

    for (const hook of cases) {
      const conn = fakeConn()
      const deps = {
        agent: { get: async () => PLACED_AGENT },
        hook: { get: async () => hook },
        github: {},
        gitlabGitcred: { grantForHookReply }
      } as unknown as DaemonWsDeps

      await handleGitCredRequest(frame, conn, deps)

      expect(conn.sendError).toHaveBeenCalledWith(
        frame.id,
        'SCOPE_DENIED',
        'hook is not an enabled gitlab hook of this agent on that project',
        false
      )
      expect(conn.replyTo).not.toHaveBeenCalled()
    }
    expect(grantForHookReply).not.toHaveBeenCalled()
  })

  it('denies a gitlab_hook_reply that names no hook or no project before reaching the store', async () => {
    const grantForHookReply = vi.fn()
    const get = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get },
      github: {},
      gitlabGitcred: { grantForHookReply }
    } as unknown as DaemonWsDeps

    for (const payload of [{ hookId: HOOK_ID }, { externalRepoId: '4455667' }, {}]) {
      const conn = fakeConn()
      const frame = gitcredFrame({ provider: 'gitlab', purpose: 'gitlab_hook_reply', ...payload })

      await handleGitCredRequest(frame, conn, deps)

      expect(conn.sendError).toHaveBeenCalledWith(
        frame.id,
        'SCOPE_DENIED',
        'gitlab hook reply credentials require a hook and a project',
        false
      )
    }
    expect(get).not.toHaveBeenCalled()
    expect(grantForHookReply).not.toHaveBeenCalled()
  })

  it('routes a gitlab_effect request to the broker grant, authorized by the workspace alone (§14.2)', async () => {
    const grantForBrokerEffect = vi.fn(async () => ({
      username: 'agentconnect-p4455667',
      token: 'glpat-effect',
      ttlSec: 900,
      expiresAt: '2026-07-11T00:15:00.000Z',
      repoFullName: 'example-group/example-project',
      access: 'write' as const,
      provider: 'gitlab',
      externalRepoId: '4455667',
      credentialEpoch: '3',
      providerExpiresAt: '2026-10-01T00:00:00.000Z'
    }))
    const hookGet = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: hookGet },
      github: {},
      gitlabGitcred: { grantForBrokerEffect }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ provider: 'gitlab', purpose: 'gitlab_effect', externalRepoId: '4455667' })

    await handleGitCredRequest(frame, conn, deps)

    // No hook named ⇒ no hook read at all; the workspace binding is the only authorization asked for.
    expect(hookGet).not.toHaveBeenCalled()
    expect(grantForBrokerEffect).toHaveBeenCalledWith(PLACED_AGENT, 4455667n, false, false)
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ provider: 'gitlab', access: 'write', ttlSec: 900 })
    )
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('passes a follow-up watch on the project to the broker grant, for its checks’ reads (assistant-mode.md §5.14)', async () => {
    const grantForBrokerEffect = vi.fn(async () => ({ access: 'read' as const }))
    const agentWatches = vi.fn(async () => true)
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: vi.fn() },
      github: {},
      gitlabGitcred: { grantForBrokerEffect },
      followUpWatch: { agentWatches }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(
      gitcredFrame({ provider: 'gitlab', purpose: 'gitlab_effect', externalRepoId: '4455667' }),
      conn,
      deps
    )
    expect(agentWatches).toHaveBeenCalledWith(PLACED_AGENT.id, 'gitlab', 4455667n)
    expect(grantForBrokerEffect).toHaveBeenCalledWith(PLACED_AGENT, 4455667n, false, true)
  })

  it('passes hook authorization to the broker grant when the request names an enabled gitlab hook', async () => {
    const grantForBrokerEffect = vi.fn(async () => ({
      username: 'agentconnect-p4455667',
      token: 'glpat-effect',
      ttlSec: 900,
      expiresAt: '2026-07-11T00:15:00.000Z',
      repoFullName: 'example-group/example-project',
      access: 'comment' as const,
      provider: 'gitlab',
      externalRepoId: '4455667'
    }))
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'gitlab', enabled: true, repoId: 4455667n }) },
      github: {},
      gitlabGitcred: { grantForBrokerEffect }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'gitlab',
      purpose: 'gitlab_effect',
      hookId: HOOK_ID,
      externalRepoId: '4455667'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(grantForBrokerEffect).toHaveBeenCalledWith(PLACED_AGENT, 4455667n, true, false)
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', expect.objectContaining({ access: 'comment' }))
  })

  it('refuses a gitlab_effect request naming a stale hook instead of falling back to the workspace', async () => {
    const grantForBrokerEffect = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'gitlab', enabled: false, repoId: 4455667n }) },
      github: {},
      gitlabGitcred: { grantForBrokerEffect }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'gitlab',
      purpose: 'gitlab_effect',
      hookId: HOOK_ID,
      externalRepoId: '4455667'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'hook is not an enabled gitlab hook of this agent on that project',
      false
    )
    expect(grantForBrokerEffect).not.toHaveBeenCalled()
  })

  it('refuses a gitlab_effect request that names no project, and relays the service denial otherwise', async () => {
    const grantForBrokerEffect = vi.fn(async () => {
      throw new GitCredDeniedError('the agent is not authorized for that gitlab project', 'SCOPE_DENIED', false)
    })
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: vi.fn() },
      github: {},
      gitlabGitcred: { grantForBrokerEffect }
    } as unknown as DaemonWsDeps

    const noProject = fakeConn()
    const noProjectFrame = gitcredFrame({ provider: 'gitlab', purpose: 'gitlab_effect' })
    await handleGitCredRequest(noProjectFrame, noProject, deps)
    expect(noProject.sendError).toHaveBeenCalledWith(
      noProjectFrame.id,
      'SCOPE_DENIED',
      'gitlab effect credentials require a project',
      false
    )
    expect(grantForBrokerEffect).not.toHaveBeenCalled()

    // Neither the workspace binding nor a hook authorizes the project: the service refuses and the
    // handler relays it as a correlated error REP, never a grant.
    const unauthorized = fakeConn()
    const frame = gitcredFrame({ provider: 'gitlab', purpose: 'gitlab_effect', externalRepoId: '999' })
    await handleGitCredRequest(frame, unauthorized, deps)
    expect(unauthorized.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'the agent is not authorized for that gitlab project',
      false
    )
    expect(unauthorized.replyTo).not.toHaveBeenCalled()
  })

  it('fails a gitlab request closed when the seam is absent, and refuses unknown providers per-value', async () => {
    const deps = { agent: { get: async () => PLACED_AGENT }, github: {} } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(gitcredFrame({ provider: 'gitlab', consumer: 'daemon' }), conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      'gitlab workspaces are not enabled on this control plane',
      false
    )
    conn.sendError.mockClear()
    await handleGitCredRequest(gitcredFrame({ provider: 'bitbucket' }), conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      'unknown git credential provider bitbucket',
      false
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })

  it('serves a proxy-only host to the proxy and the daemon only, never through the GitHub arm (azure-devops §6.1)', async () => {
    const mintForAgent = vi.fn()
    const lease = { username: 'Example Application', token: 'example-token', ttlSec: 3000 }
    const grantForAgent = vi.fn(async () => lease)
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForAgent },
      azureDevOpsGitcred: { grantForAgent }
    } as unknown as DaemonWsDeps
    // An older daemon names no consumer, and the helper is the agent-facing channel: both are refused.
    for (const consumer of [undefined, 'helper']) {
      const conn = fakeConn()
      const payload = { provider: 'azure-devops', externalRepoId: '7', ...(consumer ? { consumer } : {}) }
      await handleGitCredRequest(gitcredFrame(payload), conn, deps)
      expect(conn.sendError).toHaveBeenCalledWith(
        expect.anything(),
        'SCOPE_DENIED',
        consumer === undefined
          ? "azure-devops credentials are served only to the daemon's credential proxy and its own Git; upgrade this daemon, which names neither"
          : "azure-devops credentials are served only to the daemon's credential proxy and its own Git",
        false
      )
      expect(conn.replyTo).not.toHaveBeenCalled()
    }
    for (const consumer of ['proxy', 'daemon']) {
      const conn = fakeConn()
      const frame = gitcredFrame({ provider: 'azure-devops', externalRepoId: '7', requestedAccess: 'read', consumer })
      await handleGitCredRequest(frame, conn, deps)
      expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', lease)
    }
    expect(grantForAgent).toHaveBeenCalledWith(PLACED_AGENT, 7n, 'read', false)
    // A proxy that met a 401 asks again with forceRefresh, which reaches the lease service.
    await handleGitCredRequest(
      gitcredFrame({ provider: 'azure-devops', externalRepoId: '7', consumer: 'proxy', forceRefresh: true }),
      fakeConn(),
      deps
    )
    expect(grantForAgent).toHaveBeenLastCalledWith(PLACED_AGENT, 7n, undefined, true)
    // No purpose-gated lease exists for it, and the other hosts keep serving the helper.
    const conn = fakeConn()
    await handleGitCredRequest(
      gitcredFrame({ provider: 'azure-devops', consumer: 'proxy', purpose: 'gitea_effect', externalRepoId: '7' }),
      conn,
      deps
    )
    expect(conn.sendError).toHaveBeenCalledWith(expect.anything(), 'SCOPE_DENIED', expect.any(String), false)
    expect(mintForAgent).not.toHaveBeenCalled()
  })

  it('serves the hook reply lease to the daemon alone, for an enabled azure-devops hook of the agent on that repository (§11.5)', async () => {
    const lease = { username: 'identity', token: 'example-token', ttlSec: 3000, access: 'comment' }
    const grantForHookReply = vi.fn(async () => lease)
    let hook: Record<string, unknown> | null = { agentId: AGENT_ID, kind: 'azure-devops', enabled: true, repoId: 7n }
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => hook },
      azureDevOpsGitcred: { grantForHookReply }
    } as unknown as DaemonWsDeps
    const ask = (over: Record<string, unknown> = {}) =>
      gitcredFrame({
        provider: 'azure-devops',
        consumer: 'daemon',
        purpose: 'azure_devops_hook_reply',
        hookId: HOOK_ID,
        externalRepoId: '7',
        ...over
      })
    const served = fakeConn()
    const frame = ask()
    await handleGitCredRequest(frame, served, deps)
    expect(served.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', lease)
    expect(grantForHookReply).toHaveBeenCalledWith(ORG_ID, 7n, false)
    // The proxy never holds it, a request without its hook is refused, and another repository or a disabled hook names nothing.
    for (const over of [{ consumer: 'proxy' }, { hookId: undefined }, { externalRepoId: '8' }]) {
      const conn = fakeConn()
      await handleGitCredRequest(ask(over), conn, deps)
      expect(conn.sendError).toHaveBeenCalledWith(expect.anything(), 'SCOPE_DENIED', expect.any(String), false)
    }
    hook = { agentId: AGENT_ID, kind: 'azure-devops', enabled: false, repoId: 7n }
    const disabled = fakeConn()
    await handleGitCredRequest(ask(), disabled, deps)
    expect(disabled.sendError).toHaveBeenCalledWith(expect.anything(), 'SCOPE_DENIED', expect.any(String), false)
    expect(grantForHookReply).toHaveBeenCalledTimes(1)
  })

  it('refuses Azure DevOps when the control plane wires no lease service', async () => {
    const deps = { agent: { get: async () => PLACED_AGENT } } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(gitcredFrame({ provider: 'azure-devops', consumer: 'proxy' }), conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      'azure-devops workspaces are not enabled on this control plane',
      false
    )
  })

  it('maps a GitCredDeniedError onto a correlated error REP (code + retryable preserved)', async () => {
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: {
        mintForAgent: vi.fn(async () => {
          throw new GitCredDeniedError('acme/tools is not authorized for this agent', 'SCOPE_DENIED', false)
        })
      }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ repoFullName: 'acme/tools' })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'acme/tools is not authorized for this agent',
      false
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })
})

/**
 * §17.3 — an explicitly github-qualified request takes exactly the arms the absent-provider form
 * takes, and adds the echo a daemon verifies. The absent form is the long-lived acceptance path
 * for user-installed daemons, so every case below carries its unqualified twin as the control.
 */
describe('handleGitCredRequest — explicit provider=github (§17.3)', () => {
  const BUCKETS = [`daemon:${DAEMON_ID}`, `org:org-a`]

  function githubDeps(overrides: Record<string, unknown> = {}) {
    const mintForAgent = vi.fn(async () => ({
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'write' as const,
      repoId: 501n
    }))
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForAgent },
      ...overrides
    } as unknown as DaemonWsDeps
    return { deps, mintForAgent }
  }

  it('resolves a workspace request identically to its absent-provider twin, adding only the echo', async () => {
    const { deps, mintForAgent } = githubDeps()

    const v1 = fakeConn()
    await handleGitCredRequest(gitcredFrame(), v1, deps)
    const qualified = fakeConn()
    await handleGitCredRequest(gitcredFrame({ provider: 'github' }), qualified, deps)

    // Same resolution: identical mint arguments on both calls.
    expect(mintForAgent).toHaveBeenNthCalledWith(1, PLACED_AGENT, BUCKETS, undefined, undefined, undefined)
    expect(mintForAgent).toHaveBeenNthCalledWith(2, PLACED_AGENT, BUCKETS, undefined, undefined, undefined)

    const v1Grant = v1.replyTo.mock.calls[0]?.[2] as Record<string, unknown>
    const qualifiedGrant = qualified.replyTo.mock.calls[0]?.[2] as Record<string, unknown>
    // Negative control: the old-daemon answer carries no v2 field at all.
    expect(v1Grant).toEqual({
      username: 'x-access-token',
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'write'
    })
    expect(qualifiedGrant).toEqual({ ...v1Grant, provider: 'github', externalRepoId: '501' })
    expect(qualified.sendError).not.toHaveBeenCalled()
  })

  it('routes a repo-targeted CLI-plane request to the same mint and forwards the access floor', async () => {
    const { deps, mintForAgent } = githubDeps()
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'github',
      capabilities: ['contents', 'issues', 'pull_requests'],
      repoFullName: 'acme/tools',
      requestedAccess: 'read'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForAgent).toHaveBeenCalledWith(
      PLACED_AGENT,
      BUCKETS,
      ['contents', 'issues', 'pull_requests'],
      'acme/tools',
      'read'
    )
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ provider: 'github', externalRepoId: '501' })
    )
  })

  it('routes a github_hook_reply identically to its unqualified twin and echoes the hook repository', async () => {
    const mintForHookReply = vi.fn(async () => ({
      token: 'ghs_comment',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'read' as const,
      repoId: 501n
    }))
    const { deps } = githubDeps({
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'github', enabled: true, repoId: 501n }) },
      github: { mintForAgent: vi.fn(), mintForHookReply }
    })
    const payload = {
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra'
    }

    const v1 = fakeConn()
    await handleGitCredRequest(gitcredFrame(payload), v1, deps)
    const qualified = fakeConn()
    await handleGitCredRequest(gitcredFrame({ ...payload, provider: 'github', externalRepoId: '501' }), qualified, deps)

    expect(mintForHookReply).toHaveBeenNthCalledWith(1, PLACED_AGENT, 'acme/infra', 501n, BUCKETS, false, undefined)
    expect(mintForHookReply).toHaveBeenNthCalledWith(2, PLACED_AGENT, 'acme/infra', 501n, BUCKETS, false, undefined)
    const v1Grant = v1.replyTo.mock.calls[0]?.[2] as Record<string, unknown>
    const qualifiedGrant = qualified.replyTo.mock.calls[0]?.[2] as Record<string, unknown>
    expect(v1Grant.provider).toBeUndefined()
    expect(qualifiedGrant).toEqual({ ...v1Grant, provider: 'github', externalRepoId: '501' })
  })

  it("pins an installation row's reply to the named repository within its own installation", async () => {
    const mintForHookReply = vi.fn(async () => ({
      token: 'ghs_comment',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/tools',
      access: 'read' as const,
      repoId: 777n
    }))
    const { deps } = githubDeps({
      hook: {
        get: async () => ({ agentId: AGENT_ID, kind: 'github', enabled: true, repoId: null, installationId: 1234567n })
      },
      github: { mintForAgent: vi.fn(), mintForHookReply }
    })
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/tools',
      provider: 'github',
      externalRepoId: '777'
    })

    await handleGitCredRequest(frame, conn, deps)

    // No repository of its own to disagree with: the mint pins the named id inside the row's installation.
    expect(mintForHookReply).toHaveBeenCalledWith(PLACED_AGENT, 'acme/tools', 777n, BUCKETS, false, 1234567n)
    expect(conn.sendError).not.toHaveBeenCalled()
  })

  it('refuses a numeric identity the request named but the resolution disagrees with', async () => {
    const { deps, mintForAgent } = githubDeps()
    const conn = fakeConn()
    const frame = gitcredFrame({ provider: 'github', repoFullName: 'acme/infra', externalRepoId: '999' })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForAgent).toHaveBeenCalledOnce()
    // Minted, then discarded — the wrong repository's token never reaches the wire.
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'github repository 999 is not the repository this request resolves to',
      false
    )
  })

  it('refuses a hook reply naming another repository before it mints anything', async () => {
    const mintForHookReply = vi.fn()
    const { deps } = githubDeps({
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'github', enabled: true, repoId: 501n }) },
      github: { mintForHookReply }
    })
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'github',
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra',
      externalRepoId: '999'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForHookReply).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'the named repository is not the one this hook watches',
      false
    )
  })

  it('omits the externalRepoId echo when the resolution had no numeric id (legacy workspace)', async () => {
    const { deps } = githubDeps({
      github: {
        mintForAgent: vi.fn(async () => ({
          token: 'ghs_secret',
          ttlSec: 3540,
          expiresAt: '2026-07-11T01:00:00.000Z',
          repoFullName: 'acme/infra',
          access: 'write' as const
        }))
      }
    })
    const conn = fakeConn()

    await handleGitCredRequest(gitcredFrame({ provider: 'github' }), conn, deps)

    const grant = conn.replyTo.mock.calls[0]?.[2] as Record<string, unknown>
    expect(grant.provider).toBe('github')
    expect('externalRepoId' in grant).toBe(false)
  })
})

describe('handleGitCredRequest — the gitea arm (gitea-integration.md §9, §10)', () => {
  const GRANT = {
    username: 'example-bot',
    token: 'gitea-token-1',
    ttlSec: 3600,
    expiresAt: '2026-07-11T01:00:00.000Z',
    repoFullName: 'example-org/example-repo',
    access: 'write' as const,
    provider: 'gitea',
    externalRepoId: '556677',
    credentialEpoch: '1',
    host: 'https://gitea.com'
  }

  it('serves the workspace grant, narrowed by the requested access, without touching the GitHub arm', async () => {
    const grantForAgent = vi.fn(async () => GRANT)
    const mintForAgent = vi.fn()
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      github: { mintForAgent },
      giteaGitcred: { grantForAgent }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'gitea',
      externalRepoId: '556677',
      requestedAccess: 'read',
      consumer: 'proxy'
    })
    await handleGitCredRequest(frame, conn, deps)
    expect(grantForAgent).toHaveBeenCalledWith(PLACED_AGENT, 556677n, 'read')
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', GRANT)
  })

  it('serves the bot token to the credential proxy and the daemon’s own Git only', async () => {
    const grantForAgent = vi.fn(async () => GRANT)
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      giteaGitcred: { grantForAgent }
    } as unknown as DaemonWsDeps
    // An older daemon names no consumer, and the helper is the agent-facing channel: both are refused.
    for (const consumer of [undefined, 'helper']) {
      const conn = fakeConn()
      const payload = { provider: 'gitea', externalRepoId: '556677', ...(consumer ? { consumer } : {}) }
      await handleGitCredRequest(gitcredFrame(payload), conn, deps)
      expect(conn.sendError).toHaveBeenCalledWith(
        expect.anything(),
        'SCOPE_DENIED',
        expect.stringContaining("gitea credentials are served only to the daemon's credential proxy and its own Git"),
        false
      )
      expect(conn.replyTo).not.toHaveBeenCalled()
    }
    expect(grantForAgent).not.toHaveBeenCalled()
    // A purpose the Gitea arm does not know is refused, never answered with the Git grant.
    const unknown = fakeConn()
    await handleGitCredRequest(
      gitcredFrame({ provider: 'gitea', externalRepoId: '556677', purpose: 'azure_devops_hook_reply' }),
      unknown,
      deps
    )
    expect(unknown.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      'gitea has no azure_devops_hook_reply credential',
      false
    )
    expect(grantForAgent).not.toHaveBeenCalled()
    for (const consumer of ['proxy', 'daemon']) {
      const conn = fakeConn()
      const frame = gitcredFrame({ provider: 'gitea', externalRepoId: '556677', consumer })
      await handleGitCredRequest(frame, conn, deps)
      expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', GRANT)
    }
  })

  it('serves a daemon too old to name its consumer the hook reply lease, whose authority is the hook', async () => {
    const grantForHookReply = vi.fn(async () => ({ ...GRANT, access: 'read' as const, ttlSec: 900 }))
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => ({ agentId: AGENT_ID, kind: 'gitea', enabled: true, repoId: 556677n }) },
      giteaGitcred: { grantForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      provider: 'gitea',
      purpose: 'gitea_hook_reply',
      hookId: HOOK_ID,
      externalRepoId: '556677'
    })
    await handleGitCredRequest(frame, conn, deps)
    expect(conn.sendError).not.toHaveBeenCalled()
    expect(grantForHookReply).toHaveBeenCalledWith(ORG_ID, 556677n)
  })

  it('routes gitea_hook_reply and gitea_effect through the enabled gitea hook', async () => {
    const grantForHookReply = vi.fn(async () => ({ ...GRANT, access: 'read' as const, ttlSec: 900 }))
    const grantForBrokerEffect = vi.fn(async () => ({ ...GRANT, access: 'comment' as const, ttlSec: 900 }))
    const hook = { agentId: AGENT_ID, kind: 'gitea', enabled: true, repoId: 556677n }
    const deps = {
      agent: { get: async () => PLACED_AGENT },
      hook: { get: async () => hook },
      giteaGitcred: { grantForHookReply, grantForBrokerEffect }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(
      gitcredFrame({
        provider: 'gitea',
        purpose: 'gitea_hook_reply',
        hookId: HOOK_ID,
        externalRepoId: '556677',
        consumer: 'daemon'
      }),
      conn,
      deps
    )
    expect(grantForHookReply).toHaveBeenCalledWith(ORG_ID, 556677n)
    await handleGitCredRequest(
      gitcredFrame({
        provider: 'gitea',
        purpose: 'gitea_effect',
        hookId: HOOK_ID,
        externalRepoId: '556677',
        consumer: 'daemon'
      }),
      conn,
      deps
    )
    expect(grantForBrokerEffect).toHaveBeenCalledWith(PLACED_AGENT, 556677n, true)
    expect(conn.sendError).not.toHaveBeenCalled()
    // A hook on another repository, or of another kind, is a fence — refused rather than ignored.
    await handleGitCredRequest(
      gitcredFrame({
        provider: 'gitea',
        purpose: 'gitea_hook_reply',
        hookId: HOOK_ID,
        externalRepoId: '999',
        consumer: 'daemon'
      }),
      conn,
      deps
    )
    expect(conn.sendError).toHaveBeenLastCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      expect.stringContaining('gitea hook'),
      false
    )
  })

  it('denies every gitea request on a control plane without the gitea arm', async () => {
    const deps = { agent: { get: async () => PLACED_AGENT }, github: {} } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(gitcredFrame({ provider: 'gitea', consumer: 'proxy' }), conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SCOPE_DENIED',
      expect.stringContaining('gitea'),
      false
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })
})

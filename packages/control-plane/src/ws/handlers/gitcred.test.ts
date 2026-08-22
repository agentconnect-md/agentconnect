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
      'acme/tools'
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
    expect(mintForAgent).toHaveBeenLastCalledWith(PLACED_AGENT, expect.anything(), undefined, undefined)
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
      true
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
    const frame = gitcredFrame({ provider: 'gitlab', externalRepoId: '4455667' })

    await handleGitCredRequest(frame, conn, deps)

    expect(grantForAgent).toHaveBeenCalledWith(PLACED_AGENT, 4455667n, undefined)
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ provider: 'gitlab', username: 'agentconnect-p4455667' })
    )
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
    expect(grantForHookReply).toHaveBeenCalledWith(ORG_ID, 4455667n)
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

  it('fails a gitlab request closed when the seam is absent, and refuses unknown providers per-value', async () => {
    const deps = { agent: { get: async () => PLACED_AGENT }, github: {} } as unknown as DaemonWsDeps
    const conn = fakeConn()
    await handleGitCredRequest(gitcredFrame({ provider: 'gitlab' }), conn, deps)
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

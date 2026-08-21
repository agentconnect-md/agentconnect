/**
 * `gitcred/request` handler — D→C REQ → `gitcred/grant` REP
 * (docs/designs/github-app-git-credentials.md §Minting Path).
 *
 * DATA-PLANE path (resource-visibility §9 exemption): the agent read is the
 * viewer-free `AgentRepo.get` + a placement comparison — NEVER canView /
 * visibilityWhere. A restricted-but-active agent is still placed, still
 * receives messages, and still pushes; filtering here would be a graceful-
 * degradation correctness bug, not a security feature. (A ws handler has no
 * `req.orgCtx` to filter by anyway — keep it that way.)
 *
 * Retransmit idempotency: the daemon's ReqRep re-sends the same frame id every
 * 5s and the CP does NOT dedupe daemon-issued REQs — duplicate dispatches land
 * here and are absorbed by the token service's in-flight single-flight, which
 * collapses them onto one GitHub call and byte-identical grants.
 *
 * The grant payload carries the token MATERIAL — never log it.
 */
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, HookId } from '../../domain/ids.js'
import { GitCredDeniedError } from '../../github/service.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleGitCredRequest: Handler = async (frame, conn, deps) => {
  if (!isFrame('gitcred/request')(frame)) return
  const {
    agentId,
    capabilities,
    repoFullName,
    purpose,
    hookId,
    forceRefresh,
    provider,
    externalRepoId,
    requestedAccess
  } = frame.payload

  // v2 provider fail-per-value (§17.1): only gitlab has a non-GitHub arm here.
  if (provider !== undefined && provider !== 'github' && provider !== 'gitlab') {
    conn.sendError(frame.id, 'SCOPE_DENIED', `unknown git credential provider ${provider}`, false)
    return
  }
  const gitlabRequest = provider === 'gitlab'
  if (!gitlabRequest && !deps.github) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github-app workspaces are not enabled on this control plane', false)
    return
  }
  if (gitlabRequest && !deps.gitlabGitcred) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'gitlab workspaces are not enabled on this control plane', false)
    return
  }

  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }

  // Service scope: the requesting daemon must currently serve the agent — its placement, or a
  // duty it holds. A daemon that lost it (re-placement or a lapsed lease while offline) gets a
  // terminal SCOPE_DENIED — its cache layer clears the entry and stops asking. The read is
  // fenced on the frame's org, so a foreign-org agent is indistinguishable from a missing one.
  const agent = await deps.agent.get(orgId, AgentId(agentId))
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
    return
  }

  try {
    if (gitlabRequest) {
      // The binding's PAT under the workspace access clamp (§13.1). No hook
      // purpose here — the M5 poster gets its own gated path.
      const grant = await deps.gitlabGitcred!.grantForAgent(
        agent,
        externalRepoId !== undefined ? BigInt(externalRepoId) : undefined,
        requestedAccess
      )
      conn.replyTo(frame, 'gitcred/grant', grant)
      return
    }
    if (purpose === 'github_hook_reply') {
      const requested = new Set(capabilities)
      const commentOnly =
        repoFullName !== undefined &&
        hookId !== undefined &&
        requested.size === 2 &&
        requested.has('issues') &&
        requested.has('pull_requests')
      if (!commentOnly) {
        conn.sendError(
          frame.id,
          'SCOPE_DENIED',
          'github hook reply credentials require a hook, one repo, and issues/pull_requests only',
          false
        )
        return
      }
      // The poster is daemon-owned and the token never enters the agent's
      // environment. Its authority is the enabled hook itself, not the
      // workspace contents gitAccess (read workspaces must still be able to
      // deliver the reply promised by an always-on GitHub hook).
      // The hook named by the requesting daemon's own run, fenced on the frame's org (§4).
      const hook = await deps.hook.get(orgId, HookId(hookId))
      if (!hook || hook.agentId !== AgentId(agentId) || hook.kind !== 'github' || !hook.enabled) {
        conn.sendError(frame.id, 'SCOPE_DENIED', 'hook is not an enabled github hook of this agent', false)
        return
      }
      const cred = await deps.github!.mintForHookReply(
        agent,
        repoFullName,
        hook.repoId ?? undefined,
        [`daemon:${conn.daemonId}`, `org:${agent.orgId}`],
        forceRefresh === true
      )
      conn.replyTo(frame, 'gitcred/grant', {
        username: 'x-access-token',
        token: cred.token,
        ttlSec: cred.ttlSec,
        expiresAt: cred.expiresAt,
        repoFullName: cred.repoFullName,
        // The wire access field describes contents capability. This token has
        // no contents permission at all, so read is the conservative label.
        access: 'read'
      })
      return
    }
    // `capabilities` (P2.5) widen the scope set, clamped to the agent's gitAccess.
    // `repoFullName` (issue #457) targets a non-workspace repo — admitted only
    // through the agent's explicit AgentRepoAuthorization rows (multi-repo
    // design §2). GithubPoster requests take the purpose-gated path above;
    // general agent git/gh credentials stay constrained by this allowlist.
    const cred = await deps.github!.mintForAgent(
      agent,
      [`daemon:${conn.daemonId}`, `org:${agent.orgId}`],
      capabilities,
      repoFullName
    )
    conn.replyTo(frame, 'gitcred/grant', {
      username: 'x-access-token',
      token: cred.token,
      ttlSec: cred.ttlSec,
      expiresAt: cred.expiresAt,
      repoFullName: cred.repoFullName,
      access: cred.access
    })
  } catch (e) {
    if (e instanceof GitCredDeniedError) {
      conn.sendError(frame.id, e.code, e.message, e.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'gitcred mint failed', true)
  }
}

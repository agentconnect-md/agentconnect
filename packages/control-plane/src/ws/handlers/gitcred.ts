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
import type { HookRecord } from '../../persistence/ports.js'

/** §17.1 verify-if-present: the GitHub arms resolve by NAME, so a named numeric id must match what they resolved. */
function githubRepoIdMismatch(requested: string | undefined, resolved: bigint | null | undefined): boolean {
  return requested !== undefined && (resolved === null || resolved === undefined || resolved.toString() !== requested)
}

/** §17.3 grant echo for an explicitly github-qualified request; the absent-provider form answers unqualified. */
function githubEcho(qualified: boolean, repoId?: bigint): { provider?: 'github'; externalRepoId?: string } {
  if (!qualified) return {}
  return { provider: 'github', ...(repoId !== undefined ? { externalRepoId: repoId.toString() } : {}) }
}

/** §13.1 hook authorization: the named hook must be an ENABLED gitlab hook of this agent on that very project. */
function gitlabHookAuthorizes(
  hook: HookRecord | null,
  agentId: AgentId,
  projectId: bigint
): hook is HookRecord & { repoId: bigint } {
  return (
    hook !== null && hook.agentId === agentId && hook.kind === 'gitlab' && hook.enabled && hook.repoId === projectId
  )
}

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
  // §17.3: an explicit 'github' takes exactly the arms the absent form takes and adds the echo the
  // daemon verifies. The absent form stays unqualified — old daemons upgrade slowly and still send it.
  const githubQualified = provider === 'github'
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
      if (purpose === 'gitlab_hook_reply') {
        // §14.1: the daemon-owned note poster — its authority is the ENABLED gitlab hook itself, not the workspace clamp.
        if (hookId === undefined || externalRepoId === undefined) {
          conn.sendError(frame.id, 'SCOPE_DENIED', 'gitlab hook reply credentials require a hook and a project', false)
          return
        }
        const hook = await deps.hook.get(orgId, HookId(hookId))
        if (!gitlabHookAuthorizes(hook, AgentId(agentId), BigInt(externalRepoId))) {
          conn.sendError(
            frame.id,
            'SCOPE_DENIED',
            'hook is not an enabled gitlab hook of this agent on that project',
            false
          )
          return
        }
        const grant = await deps.gitlabGitcred!.grantForHookReply(orgId, agentId, hook.repoId)
        conn.replyTo(frame, 'gitcred/grant', grant)
        return
      }
      if (purpose === 'gitlab_effect') {
        // §14.2: the structured broker's action-time lease. Either the agent's own GitLab workspace
        // binding or an enabled gitlab hook on the project authorizes it (§13.1); the service echoes
        // the clamp the broker then enforces per operation.
        if (externalRepoId === undefined) {
          conn.sendError(frame.id, 'SCOPE_DENIED', 'gitlab effect credentials require a project', false)
          return
        }
        const projectId = BigInt(externalRepoId)
        // A NAMED hook is a fence, not a hint: a stale or foreign one is refused rather than ignored.
        let hookAuthorized = false
        if (hookId !== undefined) {
          const hook = await deps.hook.get(orgId, HookId(hookId))
          if (!gitlabHookAuthorizes(hook, AgentId(agentId), projectId)) {
            conn.sendError(
              frame.id,
              'SCOPE_DENIED',
              'hook is not an enabled gitlab hook of this agent on that project',
              false
            )
            return
          }
          hookAuthorized = true
        }
        const grant = await deps.gitlabGitcred!.grantForBrokerEffect(agent, projectId, hookAuthorized)
        conn.replyTo(frame, 'gitcred/grant', grant)
        return
      }
      // The binding's PAT under the workspace access clamp (§13.1).
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
      // The hook already carries the numeric identity, so a disagreeing ask is refused before any mint.
      if (githubRepoIdMismatch(externalRepoId, hook.repoId)) {
        conn.sendError(frame.id, 'SCOPE_DENIED', 'the named repository is not the one this hook watches', false)
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
        access: 'read',
        ...githubEcho(githubQualified, cred.repoId)
      })
      return
    }
    // `capabilities` (P2.5) widen the scope set, clamped to the agent's gitAccess.
    // `repoFullName` (issue #457) targets a non-workspace repo — admitted only
    // through the agent's explicit AgentRepoAuthorization rows (multi-repo
    // design §2). GithubPoster requests take the purpose-gated path above;
    // general agent git/gh credentials stay constrained by this allowlist.
    // `requestedAccess` is the §17.1 access floor; every pre-v2 caller leaves it absent and keeps the tier.
    const cred = await deps.github!.mintForAgent(
      agent,
      [`daemon:${conn.daemonId}`, `org:${agent.orgId}`],
      capabilities,
      repoFullName,
      requestedAccess
    )
    // This arm resolves the repo INSIDE the mint, so a named numeric id is verified on the way out —
    // the grant is discarded rather than served, exactly as a daemon discards a mismatched echo.
    if (githubRepoIdMismatch(externalRepoId, cred.repoId)) {
      conn.sendError(
        frame.id,
        'SCOPE_DENIED',
        `github repository ${externalRepoId} is not the repository this request resolves to`,
        false
      )
      return
    }
    conn.replyTo(frame, 'gitcred/grant', {
      username: 'x-access-token',
      token: cred.token,
      ttlSec: cred.ttlSec,
      expiresAt: cred.expiresAt,
      repoFullName: cred.repoFullName,
      access: cred.access,
      ...githubEcho(githubQualified, cred.repoId)
    })
  } catch (e) {
    if (e instanceof GitCredDeniedError) {
      conn.sendError(frame.id, e.code, e.message, e.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'gitcred mint failed', true)
  }
}

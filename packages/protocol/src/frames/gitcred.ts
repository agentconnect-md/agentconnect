import { z } from 'zod'
import { CodeHostExternalId, CodeHostProviderString } from '../code-host.js'

/**
 * Deployment GitHub App identity used for ordinary commits made by an agent.
 * This is public attribution metadata, not a credential.
 */
export const GitCommitIdentity = z.object({
  name: z.string().min(1),
  email: z.string().min(1)
})
export type GitCommitIdentity = z.infer<typeof GitCommitIdentity>

/**
 * Git credentials (github-app workspaces) — daemon-pulled, CP-minted.
 *
 * The CP holds the GitHub App private key and mints short-lived (1h,
 * non-renewable) installation access tokens scoped to a single repository;
 * the daemon pulls one on demand right before a remote git operation and
 * holds it in memory only. Unlike `secrets/*` (lease + reference semantics,
 * still unwired), the grant here carries the TOKEN MATERIAL itself — same
 * plaintext-over-TLS-WS posture as `integration/upsert`, and the same
 * discipline: **never log the payload**.
 *
 * The daemon may only name an agentId — the CP resolves agent → workspace →
 * repo → installation itself, so a daemon can never pick a repo it wasn't
 * assigned. Failures come back as correlated `error` REPs: `SCOPE_DENIED`
 * (not a github-app workspace, or agent not placed on this daemon — stop
 * asking), `LEASE_DENIED` (installation uninstalled/suspended or the repo
 * left its grant set — recoverable only by an operator), `RATE_LIMITED`,
 * `INTERNAL`.
 */

/**
 * Token capability classes (webhook-triggers-and-github-events.md P2.5 write-back).
 * `contents` is the git data plane (the pre-capabilities behavior); `issues` /
 * `pull_requests` buy the agent `gh` write-back (issue/PR comments), and
 * `actions` buys GitHub Actions inspection/execution. Every
 * General agent credentials mint every capability admitted by the repo's
 * `gitAccess` / authorization tier — a read-only agent gets read-only
 * issues/PR scopes and no Actions capability.
 * The one exception is purpose=github_hook_reply: a daemon-owned writer whose
 * token never enters the agent environment and is gated by an enabled hook.
 */
export const GitCredCapability = z.enum(['contents', 'issues', 'pull_requests', 'actions'])
export type GitCredCapability = z.infer<typeof GitCredCapability>

export const GitCredRequest = z.object({
  // D→C, REQ
  agentId: z.string().uuid(),
  reason: z.enum(['clone', 'fetch', 'pull', 'push', 'helper']).optional(), // observability only
  // Absent ⇒ ['contents'] — pre-P2.5 daemons keep byte-identical behavior.
  capabilities: z.array(GitCredCapability).nonempty().optional(),
  // The daemon-owned GithubPoster is a narrower consumer than an agent's git/
  // gh tools: its token never enters the agent environment and may only back
  // the one final comment for an enabled GitHub hook turn. Marking that purpose
  // explicitly lets the CP apply the hook authorization instead of incorrectly
  // clamping the comment token to the workspace contents gitAccess.
  // gitlab_hook_reply is the §14.1 twin: the note poster's effect lease, gated by an enabled gitlab hook.
  // gitlab_effect is the §14.2 broker lease: the same never-agent-visible effect PAT, authorized by the
  // agent's GitLab workspace binding OR an enabled gitlab hook, and clamped by the grant's echoed access.
  // A new value here is frame-fatal to an older CP (§17.3): name it only after GITLAB_EFFECT_V1_FEATURE.
  purpose: z.enum(['github_hook_reply', 'gitlab_hook_reply', 'gitlab_effect']).optional(),
  // Trusted hook identity copied from the relay-delivered rd/msg. Required by
  // the CP for purpose=github_hook_reply so authorization stays rename-safe on
  // HookDef.repoId instead of comparing mutable owner/repo display names.
  hookId: z.string().uuid().optional(),
  // A poster sets this only after GitHub rejects a cached token with 401/403.
  // The CP then bypasses its installation-token cache exactly once; ordinary
  // git/gh requests ignore it.
  forceRefresh: z.boolean().optional(),
  // Absent ⇒ the agent's workspace repo (pre-multi-repo behavior). "owner/repo".
  // The CP admits only workspace ∪ the agent's AgentRepoAuthorization rows and
  // mints the requested capability subset at the row's access tier — the daemon
  // still cannot pick an arbitrary repo (agent-multi-repo-authorization.md
  // decision 2). A purpose=github_hook_reply request is separately gated by an
  // enabled GitHub hook and receives only issues/PR write, never contents. Old
  // CPs strip this field and answer with a WORKSPACE grant: consumers MUST
  // verify grant.repoFullName against what they asked for before trusting it.
  repoFullName: z.string().optional(),
  // ── gitcred v2 (gitlab-com-integration.md §17.1) — negotiated fields ──
  // Absent ⇒ GitHub, the pre-v2 wire user-installed daemons keep sending for a long time yet.
  // 'gitlab' may be named only after GITCRED_PROVIDER_V2_FEATURE and an explicit 'github' only
  // after GITCRED_GITHUB_V2_FEATURE; an older CP strips the field and answers a GitHub workspace
  // grant, so a consumer that named one MUST verify the echo before trusting it (see GitCredGrant).
  provider: CodeHostProviderString.optional(),
  // Rename-stable numeric repository/project identity for the named provider; display paths are
  // never a v2 match key. The GitHub arm still RESOLVES by name, so there it is verify-if-present.
  externalRepoId: CodeHostExternalId.optional(),
  // v2 access floor (§17.1): request LESS than the workspace clamp — the read-only CLI wrapper asks
  // for 'read' even on a write workspace, so a mutating command cannot ride its token. Honored on
  // both provider arms; absent ⇒ the clamp itself, which is what every GitHub caller asks for today.
  requestedAccess: z.enum(['read', 'write']).optional()
})
export type GitCredRequest = z.infer<typeof GitCredRequest>

export const GitCredGrant = z
  .object({
    // C→D, REP (plaintext token — never log)
    // GitHub grants (provider absent or 'github') keep the exact installation-token
    // literal 'x-access-token' — enforced below, so the v1 validation fence stands;
    // only a provider-qualified non-GitHub v2 grant may name another basic-auth
    // username (the binding's service-account login).
    username: z.string().min(1),
    token: z.string(), // ghs_… — new stateless format runs ~520 chars; never assume a length
    ttlSec: z.number().int(), // CP-computed remaining life, 60s clock-skew allowance already shaved.
    // Daemons MUST track expiry as monotonic receivedAt+ttlSec (a skewed local
    // clock must never resurrect a dead token); `expiresAt` is observability only.
    expiresAt: z.string().datetime(),
    repoFullName: z.string(), // owner/repo (github) or namespaced project path (gitlab) — helper path-match + diagnostics
    // §13.1 authorization level. 'comment' is the effect-lease clamp a daemon broker enforces per
    // operation and rides only a gitlab grant (fenced below), so the GitHub v1 wire stays read|write.
    access: z.enum(['read', 'comment', 'write']),
    // ── gitcred v2 echo (gitlab-com-integration.md §17.1) — negotiated fields ──
    // Absent ⇒ an unqualified GitHub grant: an older CP, or the answer to an absent-provider
    // request. A consumer that named a provider MUST verify provider and externalRepoId against
    // its request before returning the password — a mismatched echo is a wrong-repo credential.
    provider: CodeHostProviderString.optional(),
    externalRepoId: CodeHostExternalId.optional(),
    // Purge fence: a grant is dead the moment the CP broadcasts a newer epoch.
    credentialEpoch: CodeHostExternalId.optional(),
    // Provider-side expiry of the UNDERLYING credential (observability only; the
    // local lease above is always the shorter authority).
    providerExpiresAt: z.string().datetime().optional(),
    // The instance the credential authenticates against (§24.4), echoed for the consumer to
    // verify exactly as it verifies provider and externalRepoId. Absent means GitLab.com.
    host: z.string().optional()
  })
  .superRefine((grant, ctx) => {
    const isGithub = grant.provider === undefined || grant.provider === 'github'
    if (isGithub && grant.username !== 'x-access-token') {
      ctx.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'a GitHub grant carries the fixed installation-token username'
      })
    }
    if (isGithub && grant.access === 'comment') {
      ctx.addIssue({
        code: 'custom',
        path: ['access'],
        message: 'comment-level authority rides a provider-qualified gitlab grant only'
      })
    }
  })
export type GitCredGrant = z.infer<typeof GitCredGrant>

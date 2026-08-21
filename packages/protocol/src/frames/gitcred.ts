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
  purpose: z.literal('github_hook_reply').optional(),
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
  // Absent ⇒ GitHub v1, byte-identical to the pre-v2 wire. A daemon may name a
  // provider only after the CP advertises GITCRED_PROVIDER_V2_FEATURE: an older
  // CP strips both fields and answers a GitHub workspace grant, so the consumer
  // MUST verify the grant's provider echo before trusting it (see GitCredGrant).
  provider: CodeHostProviderString.optional(),
  // Rename-stable numeric repository/project identity for the named provider;
  // display paths are never a v2 match key.
  externalRepoId: CodeHostExternalId.optional()
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
    access: z.enum(['read', 'write']),
    // ── gitcred v2 echo (gitlab-com-integration.md §17.1) — negotiated fields ──
    // Absent ⇒ GitHub v1 grant. A v2 consumer MUST verify provider and
    // externalRepoId against its request before returning the password: an older
    // CP answers without them, and a mismatched echo is a wrong-repo credential.
    provider: CodeHostProviderString.optional(),
    externalRepoId: CodeHostExternalId.optional(),
    // Purge fence: a grant is dead the moment the CP broadcasts a newer epoch.
    credentialEpoch: CodeHostExternalId.optional(),
    // Provider-side expiry of the UNDERLYING credential (observability only; the
    // local lease above is always the shorter authority).
    providerExpiresAt: z.string().datetime().optional()
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
  })
export type GitCredGrant = z.infer<typeof GitCredGrant>

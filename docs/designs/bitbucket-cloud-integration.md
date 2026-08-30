# Bitbucket Cloud Integration

> Status: **Design, not implemented.** No Bitbucket code exists in the tree.
> Section 22 is the merge-order ladder that would build it.
>
> Platform assumptions last verified: **2026-08-27**. Section 23.1 lists the
> assumptions that a hands-on API spike must confirm before Sections 10 and 15
> can leave draft.
>
> Codebase alignment last revised: **2026-08-27**.
>
> Scope: **Bitbucket Cloud only**. Bitbucket Data Center and Bitbucket Server
> are outside the v1 support contract.

This design adds Bitbucket Cloud as a third first-class code-host provider with
semantic parity to the current GitHub and GitLab integrations. The user
experience is a single OAuth authorization followed by repository selection.
Internally, OAuth is only the administration identity: normal agent and webhook
execution uses per-binding repository access tokens, managed repository
webhooks, and purpose-separated credentials.

The central architectural invariant does not change: the Control Plane is not on
the webhook message hot path. Bitbucket sends a signed webhook to the relay, the
relay verifies and routes it directly to the owning daemon, and the daemon runs
the agent. The Control Plane stores and transports only configuration,
authorization facts, secrets, and body-free run metadata.

Bitbucket is the seam's **third implementer**, and that changes what this
document is for. GitLab's Section 6.5 built the code-host contract from two data
points and recorded three surfaces it deliberately left out, because "forcing any
of these behind one interface would be guessing at an abstraction from two data
points that disagree." A third implementer resolves some of those arguments and
hardens others. It also breaks one assumption GitHub and GitLab happen to share
but never justified: that a repository has a numeric identity. Section 8.4 is the
consequence, and it is the largest single piece of work in this plan.

## 1. Decision Summary

1. Support **Bitbucket Cloud only** in v1. No configurable instance host, no
   Data Center or Server compatibility branch, no custom certificate handling,
   no version negotiation. Bitbucket DC would follow the way GitLab
   Self-Managed did, as its own later ladder against its own design section.
2. Use the OAuth 2.0 authorization-code flow for repository discovery and
   installation administration. OAuth access and refresh tokens stay encrypted
   in the Control Plane and never reach a relay, daemon, agent process,
   repository, or diagnostic bundle.
3. **Widen the code-host external identity from a numeric id to an opaque
   string** (Section 8.4). Bitbucket repositories are identified by UUID and
   have no numeric id. This is a provider-neutral migration that lands before
   any Bitbucket-shaped value exists, and GitHub and GitLab keep storing decimal
   digits in the same column.
4. Provision **one repository access token set per agent per binding** as the
   runtime identity. Bitbucket Cloud has no service-account primitive, so
   GitLab's per-agent account model does not transfer; the token itself is the
   actor. Section 7.2 records what that costs in visible attribution.
5. Create credentials with **separate purposes**: a read token, a Git-write
   token, and an API-effect token. The effect token is available only to trusted
   broker code and never enters the agent environment. This carries over from
   GitLab Section 7.3 unchanged.
6. Install and reconcile one **repository webhook** for the union of enabled
   AgentConnect hooks on that repository, with a per-webhook secret, verified at
   the relay as an `X-Hub-Signature` HMAC over the raw body.
7. Reuse the existing repository authorization, hook fencing, per-thread
   session, ordinary-reply, formal-review, and durable run-projection semantics
   through the Section 6.5 contract. Do not build a second automation stack.
8. Publish run state on a pull request using **Bitbucket commit build statuses**,
   not a status comment, subject to Section 16.2's argument. This is the first
   place the three providers genuinely diverge in the right direction rather
   than the convenient one.
9. Treat parity as **product-semantic parity**, not identical provider UI or API
   names. Provider constraints must be visible rather than silently
   approximated.
10. **Extract each contract member in the same change that adds its third
    implementer.** Where a surface is currently duplicated between two hardcoded
    provider arms, the Bitbucket change collapses it rather than adding a third
    copy. Section 6.5 names every such surface.

## 2. Goals

1. Connect a Bitbucket Cloud workspace with one browser redirect, browse
   accessible repositories, and select one without copying a token by hand.
2. Materialize private Bitbucket workspaces and additional repositories with the
   same `read`, `comment`, and `write` authorization model used for GitHub and
   GitLab.
3. Support issues, pull requests, conversation comments, diff comments, and
   pushes as hook sources, including created, updated, and mention-only modes.
4. Preserve rename-stable repository identity and per-thread session continuity
   across repository and workspace renames and transfers.
5. Publish exactly one ordinary final reply or one formal review for a numbered
   hook turn, with the same mutual-exclusion rule as the other two providers.
6. Support formal review outcomes equivalent to comment, request changes, and
   approve, including single-line and multi-line diff comments.
7. Publish durable queued, running, completed, failed, skipped, superseded, and
   interrupted run state, and support an authorized re-request on the current
   pull-request revision.
8. Automatically install, repair, rotate, and remove AgentConnect-owned webhooks
   and access tokens.
9. Keep user OAuth credentials, webhook secrets, and access tokens out of normal
   DTOs, logs, agent prompts, and persistent daemon state.
10. Preserve existing GitHub and GitLab behavior throughout a rolling deployment,
    including the Section 8.4 identity migration.

## 3. Non-Goals

- Bitbucket Data Center, Bitbucket Server, custom Bitbucket hosts, custom TLS
  roots, or version-specific compatibility branches.
- Bitbucket Connect or Forge apps. The OAuth consumer plus access tokens is the
  supported path; a Connect app would be a second installation lifecycle with a
  descriptor, a JWT scheme, and a marketplace listing, and it buys nothing this
  design needs.
- Workspace-level webhooks. Repository webhooks give each binding an independent
  lifecycle and secret, matching the GitLab project-webhook decision for the
  same reasons.
- Creating or modifying customer merge checks, branch restrictions, default
  reviewers, required approvals, or Bitbucket Pipelines configuration.
- Authoring or triggering Bitbucket Pipelines. Reading pipeline state through
  the Section 14.2 broker is in scope; starting one is not.
- Bot-to-bot triggering. One agent's contribution never wakes another agent, per
  Section 12.1. Opening that deliberately gets its own change, as it would on
  the other two providers.
- Exposing a broad API token through an environment variable, a CLI
  configuration file, an environment snapshot, or a general token-vending tool.
- App passwords. They are on Atlassian's deprecation path and are a whole-account
  credential, which is the opposite of the purpose separation in Section 7.3.

## 4. Product Parity Contract

The target is the currently supported GitHub and GitLab behavior, not reserved
or future modes.

| AgentConnect capability        | Bitbucket Cloud implementation                         | Parity                                        |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| Browser connection             | OAuth 2.0 authorization code                           | Equivalent                                    |
| Repository selection           | Workspace and repository picker over the connection    | Equivalent                                    |
| Rename-stable identity         | Repository UUID (Section 8.4)                          | Equivalent, different shape                   |
| Managed webhook                | One repository webhook per binding, per-binding secret | Equivalent to GitLab                          |
| Signature verification         | `X-Hub-Signature: sha256=<hex>` over the raw body      | Equivalent to GitHub                          |
| Runtime bot identity           | Per-binding repository access token                    | **Degraded**, see Section 7.2                 |
| Issue and PR triggers          | Repository webhook events                              | Equivalent                                    |
| Comment triggers               | PR and issue comment events, including inline          | Equivalent                                    |
| Ordinary final reply           | One PR or issue comment per turn                       | Equivalent                                    |
| Formal review: comment         | PR comment with inline comments                        | Equivalent                                    |
| Formal review: approve         | `POST .../pullrequests/{id}/approve`                   | Equivalent                                    |
| Formal review: request changes | `POST .../pullrequests/{id}/request-changes`           | **Unconfirmed**, see Section 23.1             |
| Inline diff comments           | Comment with an `inline` object                        | Equivalent                                    |
| Atomic multi-comment review    | Not available                                          | **Degraded**, see Section 15                  |
| Run state projection           | Commit build status (Section 16.2)                     | **Better than GitLab**, different from GitHub |
| Re-request a run               | Console action, no native button                       | Equivalent to GitLab                          |
| Git read/write                 | Access token over HTTPS                                | Equivalent                                    |
| Read-only provider CLI         | No first-party CLI equivalent to `gh`/`glab`           | **Absent**, see Section 13.3                  |

Three rows are honest degradations and must surface in the Console rather than
being papered over:

- **Runtime bot identity.** GitLab gives each agent its own visible actor.
  Bitbucket cannot, and Section 7.2 explains what the Console shows instead.
- **Atomic multi-comment review.** GitHub publishes a review object atomically.
  GitLab approximates it with drafts plus a bulk publish. Bitbucket has neither,
  so a multi-comment review is a sequence of individually visible comments, and
  Section 15 makes the partial-publication semantics explicit rather than
  pretending atomicity.
- **Provider CLI.** There is no first-party read-only CLI to shim, so the
  Section 13.3 surface is served by the broker in Section 14.2 instead.

## 5. Plan Contract

Bitbucket Cloud Free, Standard, and Premium are in scope. The capabilities this
design depends on (OAuth consumers, repository access tokens, repository
webhooks, PR comments and approvals, commit build statuses) are available on
all three.

Premium-only capabilities (merge checks, required approvals, branch permission
granularity) are **read-only inputs** to this design: an agent may observe that
a merge is blocked, and must never create, modify, or bypass such a rule. Where
a Premium constraint changes what an agent can do, the refusal is explicit and
carries the provider's reason. Do not silently approximate a Premium behavior on
a Free workspace.

## 6. Architecture and Trust Boundaries

Unchanged from the other two providers. The Control Plane orchestrates and holds
configuration, authorization facts, secrets, and body-free run metadata. The
relay terminates the public webhook, verifies it, and forwards to the owning
daemon without persisting content. The daemon owns provider egress, agent
execution, and every published output.

### 6.1 Control Plane

Owns the OAuth connection, the repository catalog and its deployment-global
claim, binding provisioning and reconciliation, access-token minting and
rotation, membership authorization answers, the formal-review publication lease
and operation ledger, and the run-projection desired state. Never sees a webhook
body, an ACP update stream, or a published comment body.

### 6.2 Relay

Terminates `POST /webhooks/bitbucket`, verifies the `X-Hub-Signature` HMAC over
the raw body against the owning binding's secret, maps the Bitbucket event to a
semantic event, applies the veto and gate table, and forwards a pre-addressed
delivery to the owning daemon. Persists no message content.

### 6.3 Daemon

Owns the Bitbucket API egress, the credential helper host rules, hook
normalization and the untrusted-content fence, the turn-final poster, the formal
review adapter, the turn-start acknowledgement, and the run-state projection
writer. Keeps running established sessions if the Control Plane is down.

### 6.4 Agent Runtime

Receives a fenced, normalized prompt and a workspace whose Git credentials are
vended on demand and held only in daemon memory. Receives the Section 14.2
broker tools, never a raw API token.

### 6.5 Code-Host Modules: The Third Implementer

GitLab's Section 6.5 established the contract and its directory conventions.
Those stand. What changes here is the list of surfaces that belong inside it.

The contract as it stands today, unchanged by this design:

| Host          | Contract surface                                                                                           | A code-host module owns                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon        | turn-final surface, review adapter, turn-start acknowledgement, credential/CLI profile, hook normalization | final poster, formal-review publication steps, the turn-start reaction, Git credential host rules, session-key recompute and transport-scope pin, maintenance-event handling                       |
| relay         | code-host ingress module behind a shared pipeline skeleton                                                 | signature scheme, event mapping, veto and gate table, membership-authorization request construction, delivery-key extraction                                                                       |
| control plane | code-host provider                                                                                         | repository identity refresh, membership authorization, credential minting, provisioning and reconciliation loops, projection write strategy, provider routes at the org and public-callback scopes |
| web           | thin code-host module                                                                                      | connect entry, repository-picker source, binding status fragments, mark                                                                                                                            |

GitLab left three things outside the contract. A third implementer settles two
of the three arguments:

1. **Webhook-secret distribution now earns a contract member.** GitLab left it
   out because GitHub uses one deployment-wide App secret and GitLab uses a
   per-binding signing token, and two disagreeing shapes are not an abstraction.
   Bitbucket is also per-binding. Two of three now agree, and the odd one out is
   the one whose shape is an artifact of the GitHub App model rather than a
   considered choice. The member is: **given a compiled rule, produce the
   verification inputs for this delivery**, with GitHub's implementation
   returning the deployment secret and the other two returning the rule's own.
   This is what removes the "parse the body first to find the binding, then
   verify" asymmetry between the GitHub and GitLab ingresses.
2. **Bot identity and claim lifecycle stays outside, and more firmly.** Three
   implementers, three genuinely different primitives: a GitHub App installation,
   a GitLab per-agent service account, a Bitbucket per-binding access token.
   They differ in what the actor is, whether it consumes a seat, whether it can
   be named, whether it survives the binding, and who may create it. This is now
   evidence, not a two-point guess: leave it out permanently and stop
   revisiting it.
3. **GitHub-only product surfaces stay outside.** The workflow-approval start
   path and the session pull-request dock panel remain GitHub-only and are not
   Bitbucket goals.

Three surfaces are currently duplicated across two hardcoded provider arms.
Adding a third arm to each would be the fourth copy of the same code, so the
Bitbucket change collapses them instead. Each is named in its milestone:

- **The relay hook table's provider indexes.** `HookTable` keys GitHub rules by
  repository id and GitLab rules by project id in two separate maps
  (`packages/relay/src/hooks/hook-table.ts:37`). Section 8.4's single string
  identity space is exactly what makes one provider-qualified map possible.
  Collapse in B4.
- **The Console's per-provider wizard panes.** `AddIntegrationModal.tsx` carries
  two roughly 400-line hardcoded panes with parallel state, parallel submit
  functions, and `familyAttr`/`triggerAttr` literal unions. Extract a shared
  code-host pane in B8.
- **The daemon's reply-target provider discriminator.**
  `GithubReplyTarget.provider` is optional and absent means GitHub
  (`packages/daemon/src/github/hook-coords.ts:69`). A third value cannot be
  encoded as absence. Make the tag explicit in B1, before any Bitbucket value
  can flow through it.

Two rules from `CLAUDE.md` still bind and are worth restating because this
change touches so much core code: **a provider name is never core knowledge**,
and there is still **no code-host manifest**, because code hosts have no
pre-dispatch capability reads. Every behavioral difference is a contract member
or a strategy function inside one host module.

## 7. Identity and Credential Model

### 7.1 OAuth Is the Administration Identity

A workspace is connected by one browser redirect through the OAuth
authorization-code flow. The resulting access and refresh tokens are the
**administration** identity only: they discover repositories, install and repair
webhooks, and mint runtime credentials. They are never used to publish a comment,
approve a pull request, or push a commit, and they never leave the Control Plane.

The OAuth consumer is registered once per deployment by an administrator through
the Setup Server (Section 18.3), not per organization. Bitbucket registers OAuth
consumers under a workspace's settings, which means the deployment's consumer
physically lives in some workspace the operator controls. Section 23.1 flags the
open question of whether such a consumer can authorize users of other
workspaces; if it cannot, the deployment-owned provider App model does not
apply to Bitbucket and each organization must register its own consumer. That
answer changes Section 18.3 materially and must be settled before B2.

### 7.2 Access Tokens Are the Runtime Identity

Bitbucket Cloud has no service-account primitive. There is no non-human,
non-billable user an organization can create per agent, so GitLab's Section 7.2
model does not transfer and must not be simulated.

Instead, each `(agent, binding)` pair gets its own **repository access token
set**, named after the agent. The token is the actor: comments, approvals, and
pushes are attributed to it. What this buys and what it costs:

- Two agents on one repository hold different tokens, so their effects are
  independently revocable and independently fenced by credential epoch. The
  authorization model in Section 13.1 is unaffected.
- Whether the two agents are **visually** distinguishable in the Bitbucket UI
  depends on how Bitbucket renders an access token as a comment author, which
  Section 23.1 lists as an open question. If it renders one indistinguishable
  actor per repository, the Console must say so plainly on the binding, because
  a user reading a pull request would otherwise attribute one agent's comment to
  another.
- No seat is consumed and no human account is impersonated. This is the property
  that makes the token model preferable to the alternative of a dedicated bot
  Bitbucket user, which would consume a billable seat per workspace and require
  a manual invitation per workspace.

The Console never presents an access token as an identity the user manages
directly. It presents the binding, its agents, and its health; the token is an
implementation detail of the binding, in the same way an installation token is
for GitHub.

Where a Bitbucket workspace's own policy forbids creating repository access
tokens, provisioning fails with an explicit reason on the binding
(`token_creation_forbidden`), mirroring GitLab's `service_account_quota`
refusal. It does not fall back to the OAuth user's credential.

### 7.3 Three Credential Purposes

Carried over from GitLab Section 7.3 without change, because the reasoning was
never GitLab-specific:

| Purpose     | Reaches                                 | Scope                           |
| ----------- | --------------------------------------- | ------------------------------- |
| `read`      | the agent's read-only provider access   | repository read                 |
| `git_write` | the agent's Git credential helper       | repository write, contents only |
| `effect`    | trusted broker code only (Section 14.2) | the allowlisted mutation set    |

The `effect` credential is never returned to a caller, never placed in an
environment variable, and never named in an agent prompt. The broker spends it
and returns a normalized outcome.

### 7.4 Rotation

A background rotator replaces tokens approaching expiry on the same horizon the
GitLab rotator uses (`packages/control-plane/src/gitlab/rotator.ts`), and a
rotation increments the binding's credential epoch. Every grant issued under an
older epoch dies immediately; the daemon's credential cache verifies the epoch
on the grant echo. Section 19.3 covers drift where the provider revoked a token
out from under the Control Plane.

## 8. Resource Model

### 8.1 `CodeHostRepository`

The provider-neutral catalog is unchanged in shape and changed in one field's
type. It remains organization-scoped metadata:

- internal UUID;
- provider: `github | gitlab | bitbucket`;
- **provider external repository identity, now an opaque string** (Section 8.4);
- current display path;
- canonical HTTPS clone URL;
- default branch; and
- optional provider-binding reference.

Unique identity stays `(orgId, provider, externalId)`. Display paths and clone
URLs remain mutable hints; authorization, hook matching, and run effects use the
provider-qualified identity and never a display path. This matters more for
Bitbucket than for either predecessor, because a Bitbucket repository's path
changes on both a repository rename and a workspace rename, and the UUID
survives both plus a transfer.

`CodeHostRepositoryClaim` keeps its deployment-scoped `(provider, externalId)`
uniqueness and its `provisioning | active | transferring | cleanup_pending`
lifecycle. Bitbucket bindings acquire it transactionally before provisioning,
the way GitLab bindings do.

### 8.2 Bitbucket-Specific Resources

| Resource                    | Non-secret contents                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BitbucketConnection`       | org, AgentConnect user, Bitbucket account id and username, workspace memberships, granted scopes, access expiry, state, token version, refresh lease, last sync                           |
| `BitbucketRepoBinding`      | org, repository UUID, workspace UUID, current full path, installer connection, webhook UUID, desired event hash, credential epoch, lifecycle state, state reason, converge-owed timestamp |
| `BitbucketAgentCredential`  | binding, agent, purpose, external token id, scopes, provider expiry, active generation                                                                                                    |
| `BitbucketWebhookSecret`    | binding relation only in normal reads                                                                                                                                                     |
| `BitbucketConnectionSecret` | connection relation only in normal reads                                                                                                                                                  |
| `BitbucketOauthState`       | one-shot state with a sealed verifier and browser binding                                                                                                                                 |

Note what is absent relative to GitLab's Section 8.2: there is no
`BitbucketAgentAccount` and no `BitbucketAccountMembership`, because there is no
account to manage. The per-agent axis moves onto the credential row, which is
why `BitbucketAgentCredential` is keyed by `(binding, agent, purpose)` rather
than GitLab's `(account, purpose)`.

There is also no `BitbucketReviewPublication`. The provider-neutral
`CodeHostReviewLease` and `CodeHostReviewOperation` tables already carry that
job and are reused as-is, with the caveat in Section 8.4 about
`serviceAccountExternalId`.

Binding lifecycle states reuse the GitLab vocabulary exactly, including the
instruction not to collapse them into a connected boolean: `provisioning`,
`ready`, `admin_degraded` (runtime works, OAuth repair needed), `runtime_degraded`
(token or permission no longer satisfies runtime requirements), and
`cleanup_pending` (local authority disabled, external cleanup still owed).

### 8.3 Existing Agent and Hook Resources

An agent workspace and each `AgentRepoAuthorization` reference a
`CodeHostRepository`. `AgentRepoAuthorization` already carries a provider column
beside its identity with uniqueness `(agent, provider, repoId)`, so Bitbucket
needs no new shape there, only the Section 8.4 type change.

`HookDef` gains `bitbucket` in the `HookKind` enum and reuses `repoId`,
`family`, `events`, `commentFamilies`, `labelFilter`, and `mentionOnly`
unchanged. `HookDef.githubSessionKey` is already reused verbatim by GitLab and
is reused again here; its name is Section 21's naming debt, not a functional
problem.

### 8.4 Opaque External Identity

This section has no GitLab counterpart. It is the one place where adding a third
provider forces a change to the other two.

#### 8.4.1 The problem

GitHub numbers repositories. GitLab numbers projects. Both fit a `BigInt`, and
the seam was built on that coincidence: `CodeHostRepository.externalId BigInt`
(`packages/control-plane/prisma/schema.prisma:942`), `HookDef.repoId BigInt`,
`AgentRepoAuthorization.repoId BigInt`, `CodeHostReviewLease.projectExternalId
BigInt`, `CodeHostRunProjection.projectId BigInt`, and on the wire
`CodeHostExternalId = z.string().regex(/^(?:0|[1-9]\d*)$/)`
(`packages/protocol/src/code-host.ts:48`).

Bitbucket Cloud repositories have no numeric id. Their stable identity is a
UUID, delivered in the REST API wrapped in curly braces. It is the id that
survives a repository rename, a workspace rename, and a transfer, which is
exactly the property Section 8.1 requires of an external identity. There is no
second, numeric candidate to fall back on.

#### 8.4.2 Decision: widen to a bounded opaque string

The external identity becomes an opaque string across the provider-neutral seam.
GitHub and GitLab continue to store decimal digits in the widened column; only
the type and the validator change for them, never a value.

The rejected alternative was a deployment-local numeric surrogate: allocate a
`BIGINT` per Bitbucket UUID and keep the seam numeric. It fails on one fact.
**The relay has no database.** It matches an inbound webhook by comparing the
payload's repository UUID against the compiled rule, so the real UUID has to
travel to the relay regardless. A surrogate would leave the system holding two
identities for one repository with a translation boundary between them, where a
mismatch is a silent no-match. It would also break the Section 8.1 premise that
the external id is the provider's own authority, which is what makes
`CodeHostRepositoryClaim` meaningful and what lets an operator correlate a log
line with the Bitbucket UI. Keep it documented as the fallback if the B0
conversion overruns, but do not adopt it.

#### 8.4.3 Split the alias before touching anything

`CodeHostExternalId` currently does three unrelated jobs: repository identity,
provider object identity (note and comment ids), and a **monotonic counter**.
The counter uses are `CodeHostReviewFence` and `GitCredGrant.credentialEpoch`,
and they are consumed by `BigInt(...)` comparison on the daemon
(`packages/daemon/src/gitlab/note-projection.ts:424`). Widening the alias in
place would let a non-decimal value reach a `BigInt()` call that throws.

So the first change, in its own PR, before any Bitbucket-shaped value exists:

- Keep the decimal regex under a new name, `CodeHostDecimalString`, and repoint
  the counter uses at it. They stay decimal forever.
- Redefine `CodeHostExternalId` as a **bounded opaque token**:

  ```
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  ```

  Braces, slashes, whitespace, and control characters are excluded
  deliberately, so the canonicalization rule below is enforced by the schema
  itself and a braced value cannot reach the wire by accident. The length cap
  matters because these values land in log lines, advisory-lock keys, hidden
  markers inside provider comment bodies, session keys, and URL query
  parameters.

#### 8.4.4 Canonicalize once, at ingest; compare raw thereafter

Store the Bitbucket UUID **bare and lowercase, without braces**. Re-add braces
only inside the Bitbucket REST client, in one function, at the moment a path
segment is built.

The reasoning, in order of weight:

1. Every match in this system is exact string equality: the relay's rule map
   (`packages/relay/src/hooks/hook-table.ts:37`), the Postgres unique index, the
   credential grant echo check
   (`packages/daemon/src/cp/git-credential.ts:424`), and the workspace
   materialization attestation
   (`packages/daemon/src/workspace/workspace-manager.ts:726`). Two spellings of
   one id is a **silent** no-match: the hook never fires and nothing logs an
   error.
2. `{` and `}` are outside RFC 3986's unreserved and reserved sets, so a stored
   braced value must be percent-encoded at every use. "Forgot to encode" and
   "double-encoded" is a bug class repeated at every call site; encoding in one
   function is one bug site.
3. `{a,b}` is brace expansion in `bash` and `zsh`, and the daemon shells out to
   `git` and writes credential-helper configuration.
4. Every other UUID in this system is bare and lowercase.
5. Braces are pure delimiters, so the transform is lossless and exactly
   invertible. Nothing is discarded.

The canonicalizer accepts **both** spellings on input, so an operator pasting an
id from the Bitbucket UI works, and emits one form.

**This decision is not revisable after rollout.**
`workspace-manager.ts:726` refuses, and deliberately never deletes, a checkout
whose attestation records a different `repoId` string, and the grant echo check
refuses a credential that differs by one character. Changing the canonical form
after any Bitbucket workspace has been materialized strands checkouts and breaks
credentials with no automatic repair. Lock it with a protocol test asserting
both input spellings map to one output, before B5.

#### 8.4.5 Per-provider validation lives in `code-host.ts`

The validator registry goes **inside** `packages/protocol/src/code-host.ts`, not
in a new sibling module. That file has no relative imports by design, and
`packages/web/src/protocol-imports.leaf.test.ts` fails the build if it gains
one, because the bundler does not do TypeScript's `.js`-to-`.ts` substitution. A
separate module importing `./code-host.js` would either be unusable from web or
have to duplicate the provider list.

Shape it like `packages/protocol/src/platform-manifest.ts`: a total lookup with
a fail-closed default.

```ts
interface CodeHostIdSpec {
  /** Provider payload value to canonical stored form, or undefined if it is not one. */
  canonicalRepoId(raw: string): string | undefined
  /** The same for actor identities (membership authz, review lease subject). */
  canonicalActorId(raw: string): string | undefined
  /** Canonical form to the literal the provider's REST path expects. */
  toProviderPathSegment(canonical: string): string
}
```

`github` and `gitlab` validate decimal and canonicalize to identity. `bitbucket`
strips one optional matched brace pair, lowercases, and requires the 8-4-4-4-12
hex shape. An unknown provider gets a default spec that refuses everything, so
an unknown provider plus an unvalidatable id fails closed, matching the posture
`isCodeHostProvider` already takes per value.

The call sites are the ingest boundaries and nowhere else: relay webhook
ingress where the payload id is first read, Control Plane REST route bodies,
Control Plane provider API responses at the catalog upsert, and daemon
credential-request construction.

#### 8.4.6 Migration: expand, promote, contract

An in-place `ALTER COLUMN ... TYPE TEXT` is not available. Migrations run as an
initContainer of the Control Plane Deployment, whose rollout strategy is
`maxSurge: 1 / maxUnavailable: 0`
(`charts/agentconnect/templates/control-plane.yaml:18-22`) at `replicas: 1` with
`minReadySeconds: 15` (`charts/agentconnect/values.yaml:379,384`). The old pod
therefore serves live traffic against the already-migrated schema for the whole
surge window, and a `helm rollback` puts it back there permanently. An in-place
type change makes every code-host query on that pod fail with
`operator does not exist: bigint = text`.

Three migrations, in the repository's `<synthetic timestamp>_<snake_name>`
convention:

**Expand.** Add a stored generated mirror plus its unique index:

```sql
ALTER TABLE "code_host_repository"
  ADD COLUMN "externalKey" TEXT GENERATED ALWAYS AS ("externalId"::text) STORED;
CREATE UNIQUE INDEX "code_host_repository_orgId_provider_externalKey_key"
  ON "code_host_repository" ("orgId", "provider", "externalKey");
```

The generated column is the whole trick: the old Control Plane keeps writing the
bigint and the text mirror follows automatically, with no dual-write code and no
trigger, so there is no window in which a new reader can miss an old writer's
row. Adding a stored generated column does rewrite the table, which is why this
happens while the tables are still small and before any Bitbucket rows exist.

**Bake.** Ship one release whose readers select `externalKey` and whose ports
expose `string`. Writers still write the bigint. Old and new pods coexist safely
because both write the same authoritative column. This is the phase that mirrors
GitLab M0's "read both shapes, write both, then cut writers over".

**Promote.** `DROP EXPRESSION` (Postgres 12+, keeps the data, no rewrite), make
the text column `NOT NULL`, make the bigint column nullable, and install a
bridge trigger that fills whichever side the writer omitted, converting only
when the text value matches the decimal regex. The resulting property is the one
this whole design depends on: a Bitbucket row's UUID fails the regex, its bigint
stays `NULL`, and an old pod's `WHERE "externalId" = $1` is **blind** to it
rather than wrong about it. Fail-closed, expressed in SQL.

**Contract.** One release later, drop the trigger and the legacy column, then
`RENAME externalKey TO externalId` and rename the index to match. Because of that
rename, every field name in `schema.prisma`, the persistence ports, and the DTOs
is stable across the whole exercise, and the contract migration is a zero-diff
for application code. Only the intermediate readers phase names `externalKey`,
and only inside `persistence/repositories/`.

#### 8.4.7 What widens, what does not

Widens, because it is provider-neutral:

| Model                          | Column                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `CodeHostRepository`           | `externalId`                                           |
| `CodeHostRepositoryClaim`      | `externalId`                                           |
| `AgentRepoAuthorization`       | `repoId`                                               |
| `HookDef`                      | `repoId`                                               |
| `CodeHostReviewLease`          | `projectExternalId` **and `serviceAccountExternalId`** |
| `CodeHostReviewAttemptOutcome` | `projectExternalId`                                    |
| `CodeHostRunProjection`        | `projectId`                                            |
| `Agent`                        | `workspaceRepoId`                                      |
| `HookReviewProjection`         | `repoId`                                               |

`serviceAccountExternalId` (`schema.prisma:1973`) is easy to miss and is part of
the lease's subject uniqueness (`schema.prisma:2001`). Bitbucket has no numeric
actor id. **If only the repository axis widens, formal reviews cannot ship**,
because the lease subject key is unusable. The actor axis widens in the same
series, along with `RcCodeHostMembershipAuthz`'s
`repoExternalId` / `actorExternalId` / `subjectAuthorExternalId`, all of which
carry a `/^[1-9]\d*$/` regex today (`packages/protocol/src/frames/relay-cp.ts:228`).

Does **not** widen, and saying so halves the blast radius: every `Gitlab*` table
(provider-specific by construction), `SessionPullRequest.repoId` (GitHub-only,
keyed alongside `installationId`), and `SkillSource.githubRepoId` (public GitHub
skill sources only).

`hook_run` is treated separately. It is the only unbounded-growth table in the
set, it has no time-based retention, and its `repoId` is a write-once snapshot
that participates in no uniqueness. Give it a nullable `repoExternalId TEXT`
with a partial index, no backfill, and readers that coalesce. Old rows keep
their bigint forever, because nothing joins history across the boundary.

`mergeRequestIid` stays an `Int` and stays correct: Bitbucket pull request ids
are integers scoped to the repository, the same contract as a GitLab IID. Its
name is Section 21's naming debt.

#### 8.4.8 The wire widens less than the database does

The provider-neutral frames must widen: `codehost/review-*`, `codehost/note-*`,
gitcred v2, `CodeHostRepoRef`, `RcCodeHostMembershipAuthz`, and
`PublishedHookOutput`.

The per-provider ingress arms must **not**. `RcHookAssign` already carries a
separate typed sub-object per kind, so Bitbucket gets its own arm with its own
members and its own `sessionKeyPrefix`, and never touches `CodeHostExternalId`.
Stating this split matters because it means the wire change and the database
change can be sized, reviewed, and scheduled independently.

#### 8.4.9 The sites that will not fail to compile

TypeScript catches the port and DTO changes. It does not catch these, and each
accepts a `string` today and converts:

- `BigInt(...)` on an id that is about to stop being decimal:
  `packages/control-plane/src/ws/handlers/gitcred.ts` (three sites in one
  handler), `codehost/review-lease.service.ts:166`,
  `codehost/note-projection.service.ts:81`,
  `gitlab/membership-authz.service.ts:60`, `ws/handlers/hook-report.ts:62`,
  `github/rerequest.service.ts`, and `http/github-session-access.ts`.
- Raw SQL with a bigint parameter binding, which fails at query time rather
  than at type check:
  `persistence/repositories/code-host-projection.repo.ts:201` inside a
  `FOR UPDATE` natural-key lock.
- Validation regexes that would reject a Bitbucket value:
  `packages/protocol/src/frames/relay-cp.ts:228`, and the `projectId` /
  `GithubRepoId` DTOs in `packages/control-plane/src/http/dto/index.ts`.
- The Console's session facet filter, which parses `github-repo:<decimal>` out
  of one opaque string (`packages/web/src/lib/session-trigger.ts:131`) and is
  GitHub-only today.

One reassurance worth recording: the advisory-lock keys built from
`id.toString()` are byte-identical before and after, because
`4455667n.toString() === '4455667'`. The widening renumbers no lock.

## 9. OAuth Flow and Correctness

The three-hop shape is GitLab's, and the implementation should be a sibling of
`packages/control-plane/src/gitlab/oauth.service.ts` rather than a reinvention.

### 9.1 Start

An authenticated Console request mints a one-shot state row holding a sealed
verifier and a browser-binding cookie value, then returns the provider
authorization URL. The state row is org-scoped and consumed exactly once.

Whether the flow uses PKCE depends on Section 23.1's open question. If Bitbucket
supports it, use it; if not, the browser-binding cookie plus the one-shot state
row carries the whole binding, and that weakening must be recorded here
explicitly rather than left implicit in the code.

### 9.2 Callback

The public, unauthenticated callback route consumes the state, verifies the
browser binding, exchanges the code, resolves the Bitbucket account identity,
and seals the access and refresh pair. A replayed or mismatched state is
refused without a token exchange.

### 9.3 Refresh Rotation

A single-writer refresh under a lease with a token-version compare-and-swap,
identical to GitLab Section 9.3. Concurrent refreshers must not both spend the
refresh token, because Bitbucket rotates it.

### 9.4 Disconnect

Disconnecting a connection revokes what can be revoked, moves every binding it
installed to `admin_degraded` if no other connection can administer them, and
leaves runtime credentials working. It does not silently delete bindings. A
binding whose last administering connection is gone reports the repair path in
the Console.

## 10. Repository Provisioning and Reconciliation

### 10.1 Repository Selection

The picker lists workspaces the connection can see, then repositories within a
workspace, with server-side search. Bitbucket's repository listing is paginated
and workspace-scoped, so the Console asks the Control Plane rather than
assembling a client-side roster the way the GitHub picker does. The GitLab
project picker (`packages/web/src/lib/use-gitlab-projects.ts`) is the shape to
copy, including its treatment of a 404 as "the provider is not configured for
this deployment".

Selecting a repository records the **UUID**, canonicalized per Section 8.4.4,
plus the current full path as a display hint.

### 10.2 Desired-State Provisioning

Provisioning is a saga with a deterministic ownership marker, recoverable after
a failure at any external side effect:

1. Acquire the deployment-global `CodeHostRepositoryClaim` transactionally.
2. Refresh repository metadata by UUID and upsert the catalog row.
3. Mint the per-agent access tokens for the three purposes, validating the
   provider-reported expiry rather than assuming one.
4. Install the repository webhook for the union of enabled events, with a fresh
   secret, and test it.
5. Mark the binding `ready`.

Every step is convergent: re-running the saga against a partially provisioned
binding must reach the same end state without duplicating an external object.
Ownership is recognized by a deterministic marker on the webhook description, in
the same way the GitLab provisioner recognizes its own hooks.

### 10.3 Webhook Ownership

AgentConnect owns only the webhooks it created, identified by its marker. It
never edits or deletes a webhook it does not own. Removing a binding removes its
own webhook and its own tokens, and nothing else. A binding whose external
cleanup cannot complete (the administering connection is gone) parks in
`cleanup_pending` with local authority already disabled, so no further delivery
is honored while the operator repairs access.

## 11. Webhook Ingress

### 11.1 Installation

One repository webhook per binding, subscribed to the union of the events every
enabled hook on that repository needs. The desired-event union is recomputed
whenever a hook on that repository is created, updated, or deleted, and the
binding carries a hash of the desired set so a converge sweep can detect drift.
This mirrors `packages/control-plane/src/gitlab/webhook-events.ts`.

### 11.2 Verification

Bitbucket signs with `X-Hub-Signature: sha256=<hex>`, an HMAC-SHA256 over the
raw body using the per-webhook secret, in WebSub format. That is byte-for-byte
the scheme `verifySha256Header` already implements
(`packages/relay/src/hooks/signature.ts:11`), so Bitbucket **reuses GitHub's
verifier**, not GitLab's Standard Webhooks one.

The lookup order, however, is GitLab's, not GitHub's. GitHub verifies first
against one deployment-wide App secret and then finds the rules; Bitbucket, like
GitLab, must find the candidate rules by repository before it has a secret to
verify against. The relay therefore parses only enough of the body to extract
the repository UUID, canonicalizes it, looks up the rules, and verifies against
each candidate rule's secret, accepting any match so a mid-rotation mixed table
cannot drop deliveries. Nothing from the body is trusted before verification
succeeds.

This asymmetry between "verify then look up" and "look up then verify" is
exactly the seam the Section 6.5 webhook-secret member exists to absorb.

### 11.3 Compiled Rule

The `bitbucket` arm of `RcHookAssign` carries: repository UUID, workspace UUID,
current full path, session-key prefix, subscribed events, label filter, comment
families, mention-only flag, agent name, the acting token's actor identity for
loop prevention, the set of bound actor identities to veto, and the inline
webhook secret. It does not carry any credential beyond that secret.

## 12. Event Mapping and Routing

Bitbucket event keys (`repo:push`, `pullrequest:created`, `pullrequest:updated`,
`pullrequest:comment_created`, `issue:created`, `issue:comment_created`, and so
on) map to the same semantic vocabulary the other two hosts use. The families
are `pull_request`, `issues`, and `push`, matching GitHub's set rather than
GitLab's, so `hook-family.ts` gains a `BITBUCKET_FAMILIES` constant and arms in
`familyOfEventPattern` and `eventPatternFitsFamily`.

### 12.1 Loop Prevention

An agent's own contribution must never wake an agent. The relay vetoes any
delivery whose author is one of the bound actor identities on that rule. Because
Section 7.2's actor is an access token rather than a named account, the veto set
is the set of actor identities Bitbucket reports for this binding's tokens, and
it must be populated before the first delivery is honored, not after. A binding
whose actor identity is unknown does not dispatch.

### 12.2 Contributor Gate

A delivery from an actor without at least write permission on the repository is
authorized live through the provider-neutral `rc/codehost-membership-authz`
round trip, the same frame GitLab uses. The Control Plane answers from the
provider, not from a cached membership list, and fails closed.

### 12.3 Session Affinity and Prompt Boundary

The session thread key is recomputed from the trusted discriminator, never
parsed out of a transported string:

```
bitbucket:<repo-uuid>:pull_request:<id>
bitbucket:<repo-uuid>:issue:<id>
bitbucket:<repo-uuid>:push:<ref>
```

and the turn pins `transportScope: bitbucket:<repo-uuid>`. Because the key is
built from the UUID and not the path, a repository or workspace rename does not
split a conversation, which is the concrete payoff of Section 8.4 for a user.

The prompt boundary gains its own fence opener,
`UNTRUSTED_CONTENT_BEGIN_BITBUCKET`, naming Bitbucket in the same shape the
other two use, and shares the existing closing delimiter and the existing
`neutralizeDelimiters` escaping. Titles are sanitized at the relay.

## 13. Repository Authorization and Git Access

### 13.1 Authorization

Unchanged. An agent may act on a repository only through an
`AgentRepoAuthorization` grant or its own workspace binding, the grant is
provider-qualified, and its `read | comment | write` tier clamps what any vended
credential can do. The Console's additional-repository picker already chooses
the host first and then the repository, because a grant is provider-qualified;
Bitbucket is a third tile there.

### 13.2 HTTPS Credential Helper

The daemon's credential plane learns a third managed host. Concretely:

- `ManagedCredentialProvider` (`packages/daemon/src/gitcred/managed-hosts.ts:12`)
  widens, and `managedHostTableFor` stops returning a fixed two-element array.
- Path parsing uses **GitHub's** shape, not GitLab's: a Bitbucket repository
  path is `workspace/repo`, two segments, with no subgroup nesting. Reuse
  `repoFromPath`, not `projectFromPath`.
- `https://bitbucket.org` joins `DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS`
  (`packages/protocol/src/git-url.ts:24`), where Bitbucket is already named in
  the surrounding comment as an origin an operator might add by hand.
- The grant echo carries the provider and the canonical repository UUID, and the
  daemon refuses a grant whose echo does not match, exactly as it does for
  GitLab.

The credential is minted on demand, held only in daemon memory, and dies on a
credential-epoch bump.

### 13.3 Read-Only Provider CLI

There is no first-party Bitbucket CLI equivalent to `gh` or `glab`, so there is
no shim to write and no read-only token plane to define for one. The read
surface an agent needs is served by the Section 14.2 broker instead. If a
deployment ships a third-party CLI, it is unmanaged: it receives no AgentConnect
credential and the origin policy still applies.

## 14. Output Ownership

### 14.1 Ordinary Final Reply

One comment per turn, published by the daemon behind the publish barrier, on
whatever subject fired the turn. The poster is a sibling of
`packages/daemon/src/gitlab/poster.ts`, reusing the shared markdown chrome and
attribution helpers that already live in `packages/daemon/src/github/poster.ts`
and that the GitLab poster already imports.

Bitbucket renders Markdown in comments, so the existing chrome applies. The
comment length cap is a provider constant that the poster truncates against,
the way `MAX_NOTE_CHARS` works for GitLab.

### 14.2 Controlled Non-Review Effects

The provider-neutral `CODE_HOST_EFFECT_TOOLS` surface already exists and is
GitLab-backed today. Bitbucket registers a second broker behind the same tool
names: create and update a comment, read and reply to a comment thread, create
and update a pull request, and inspect pipeline state. Each is one allowlisted
endpoint spent by trusted code with the `effect` credential, which is never
returned to the caller.

Because Section 13.3 leaves Bitbucket without a CLI, this broker is not a
convenience for Bitbucket the way it is for GitLab: it is the agent's only read
and mutate path outside Git itself. Size the allowlist accordingly, and treat a
missing endpoint as a product gap rather than a workaround opportunity.

`inspectCodeHostPipelines` reads Bitbucket Pipelines state.
`controlCodeHostPipeline` does **not** start one, per Section 3.

## 15. Formal Pull-Request Reviews

The daemon-side seam is already correct and costs one registration: Bitbucket
implements `CodeHostReviewAdapter` and registers on `CodeHostReviewRouter`
(`packages/daemon/src/codehost/review-adapter.ts`). Core compares no provider
name.

The Control Plane side is not free. Two literals must become dispatch:

- the review publisher resolver hard-returns `null` for any non-GitLab provider
  (`packages/control-plane/src/container.ts:1249`); and
- the "provider-neutral" broker still gates on a `'gitlab'` literal
  (`packages/control-plane/src/codehost/review-lease.service.ts:169`).

The publication lease, the single-use operation ledger, the fence, and the one
body-free terminal outcome are reused unchanged.

**Bitbucket has no review object.** GitHub publishes one atomically. GitLab
approximates atomicity with draft notes plus a bulk publish. Bitbucket has
neither drafts nor a bulk endpoint, so a multi-comment review is a sequence of
individually visible comment creations followed by an approval or a
request-changes call. The consequences must be designed, not discovered:

- **Partial publication is visible.** A failure midway leaves real comments on
  the pull request. The ledger records each comment as its own issued operation
  so a retry does not duplicate, and the terminal outcome is `ambiguous` rather
  than `not_submitted` when the failure point cannot be classified.
- **Ordering is the publication order.** Inline comments publish before the
  summary and the verdict, so a reader never sees a verdict without its
  supporting comments.
- **The verdict is the last effect.** Approval or request-changes is issued only
  after every comment settles, and it is fenced on the exact head commit. A head
  that moved mid-review aborts before the verdict rather than approving stale
  code.
- **Signed markers** identify AgentConnect-authored comments for reconciliation
  after an ambiguous failure, reusing `packages/daemon/src/gitlab/review-marker.ts`.

Section 15's mutual-exclusion rule is unchanged and enforced in the same three
places: the daemon's fallback gate, the turn-final enforcement, and the
`HookReport` wire refinement that currently reads "github and gitlab metadata are
mutually exclusive" (`packages/protocol/src/frames/hook.ts:311`) and becomes a
three-member one-of.

`CodeHostReviewExternalRef.kind` is GitLab vocabulary today
(`note | draft_note | discussion | approval`). Bitbucket contributes `comment`,
`inline_comment`, and `approval`, and `draft_note` becomes explicitly
GitLab-only rather than implicitly universal.

## 16. Informational Run Projection

Durable, fenced, daemon-written run state for a numbered hook turn, publishing
`queued`, `running`, `completed`, `failed`, `skipped`, `superseded`, and
`interrupted`. The Control Plane records the desired generation; the owning
daemon writes the provider object. `CodeHostRunProjection` and the
`codehost/note-*` frames carry it, and the daemon's single provider gate
(`packages/daemon/src/gitlab/note-projection.ts:403`) plus the Control Plane's
`const PROVIDER = 'gitlab'`
(`packages/control-plane/src/codehost/note-projection.service.ts:41`) both
become registries.

### 16.1 Re-request

Bitbucket has no native re-run affordance on a pull request, so the Console
carries the "Run again" action, exactly as it does for GitLab, revalidating every
fence live and reading the head from the provider before emitting the rerun.

### 16.2 Build Statuses, Not a Status Comment

GitLab rejected commit statuses because a GitLab commit status is modeled as an
external CI job: posting one can append to an existing pipeline or create a new
external pipeline, which is materially different from an informational
agent-run projection.

**Bitbucket commit build statuses do not have that property.** A build status is
a first-class annotation on a commit with a key, a state, a name, and a URL. It
does not create or mutate a pipeline. It is exactly the informational surface
this projection wants, it renders natively on the pull request, and it does not
consume a comment slot in the conversation.

Therefore Bitbucket projects run state as a **commit build status**, keyed
deterministically per hook and projection epoch so a re-run replaces rather than
accumulates. This is the first place the three providers diverge on transport
rather than on vocabulary, and it is the right divergence: GitHub uses Checks,
Bitbucket uses build statuses, GitLab uses a note because its native options are
worse.

Two consequences to hold:

- **The persistence is note-shaped.** `CodeHostRunProjection` names `noteId` and
  `mergeRequestIid` (`packages/control-plane/prisma/schema.prisma:2092`). The
  field is an external object identity regardless of what kind of object it is,
  so the type is fine and the name is Section 21's naming debt. Do not fork the
  table.
- **A build status can gate a merge.** Bitbucket merge checks can require a
  successful build. An informational projection that reports `failed` could
  therefore block a merge on a workspace that configured such a check. This
  design **never** creates or modifies a merge check, but it must state the
  interaction in the Console on the reporting-mode control, because the failure
  mode is a user's own configuration meeting our status key. If that interaction
  proves unacceptable in the spike, the fallback is a status comment and the
  GitLab implementation transfers unchanged.

## 17. Protocol and Compatibility

### 17.1 Provider-Qualified Git Credentials

`GitCredRequest.purpose` gains `bitbucket_hook_reply` and `bitbucket_effect`.
That enum is closed and lives in a daemon-to-Control-Plane frame, so a new value
is frame-fatal to an older Control Plane; the comment already at
`packages/protocol/src/frames/gitcred.ts:62` states the rule. The daemon names a
Bitbucket purpose only after it has seen the feature in `register/ok`.

`GitCredGrant`'s refinement currently treats an absent provider as GitHub and
asserts `username === 'x-access-token'` for it. Bitbucket grants are explicitly
provider-qualified and carry their own username convention, so they take the
same path GitLab grants already do.

### 17.2 Hook and Review Frames

- `CODE_HOST_PROVIDERS` (`packages/protocol/src/code-host.ts:13`) gains
  `'bitbucket'`. This is the compile-time trigger: every `Record<HookKind, ...>`
  in the tree stops type-checking until it is given an entry, which is the
  intended discovery mechanism and the reason the union is derived rather than
  restated.
- `HookKind` and `WorkspaceMode` Postgres enums each gain a value, in the shape
  of the existing one-line `ALTER TYPE ... ADD VALUE IF NOT EXISTS` migration.
- `AgentWorkspace` gains a fourth discriminated arm.
- `RcHookAssign` gains a `bitbucket` sub-object (Section 11.3).
- `HookStart` and `HookReport` gain a third provider member, and their
  mutual-exclusion refinements become three-member one-ofs.
- `HookContext.source` widens with `HOOK_KINDS`.
- `GithubReplyTarget.provider` stops meaning "absent is GitHub" and becomes an
  explicit tag (`packages/daemon/src/github/hook-coords.ts:69`). This must land
  before any Bitbucket value can flow through it, because an unrecognized
  provider silently reading as GitHub is a wrong-repository write, not an error.

### 17.3 Feature Negotiation

One new feature string, `bitbucket-cloud-v1`, declared beside the existing six
in `packages/protocol/src/consts.ts` (lines 321 to 369).

It is deliberately **one** string, not two. A separate identity-widening feature
would be advertisable by a peer that can decode an opaque id but cannot do
anything with it, and no reachable state needs that distinction: every
non-decimal external id in the system belongs to Bitbucket.

The gate in `packages/control-plane/src/domain/daemon-features.ts`
(`requiredDaemonFeatures`, line 52) reads three sources today: the workspace
mode, the assembled additional-repository list, and the host axis. It gains a
fourth predicate that is **value-shaped as well as provider-shaped**: require the
feature when the provider is `bitbucket` **or** the external id is not decimal.

Gating on the id's shape and not only on the provider name is cheap and prevents
the quiet failure the file's own comment already warns about for GitLab. A
pre-Bitbucket daemon reading an `additionalRepos` row tolerantly strips the
unknown `provider` key, reads the remaining path as `owner/repo`, and clones
from github.com. A UUID id beside a `workspace/repo` path is exactly that
failure again, and it is silent.

The mixed-version matrix:

| Combination                            | Behavior                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| New daemon, old Control Plane          | The daemon does not name a Bitbucket credential purpose until it sees the feature. GitHub and GitLab work unchanged.        |
| New Control Plane, old daemon          | The Control Plane withholds every Bitbucket-shaped spec, placement, and hook dispatch through `daemonSupportsAgent`.        |
| New Control Plane, old relay           | No `kind: 'bitbucket'` rule is broadcast to it, and no non-decimal id rides `rc/codehost-membership-authz` to it.           |
| New relay, old Control Plane           | The membership-authz frame is rejected and the relay fails closed. No turn starts.                                          |
| Old Control Plane pod, migrated schema | Blind to Bitbucket rows, correct on GitHub and GitLab rows. This is the property Section 8.4.6's promote step is built for. |

The Section 8.4 decode tests land before any Bitbucket-shaped value exists, for
the same reason GitLab's did.

## 18. Console and REST Surface

### 18.1 Console

The web module is thin by contract: connect entry, repository-picker source,
binding status fragments, mark.

- **Integrations** gains a Bitbucket card beside the GitHub and GitLab ones,
  showing the connection's account and workspaces, one row per agent, per-binding
  repair and take-over, an orphan group for managed bindings no agent holds, and
  a credential expiry warning. The GitHub card is currently inline inside
  `IntegrationsView.tsx` rather than a module; extract it when adding the third
  so all three are siblings.
- **Repository choice happens where the repository is used**: the hook wizard,
  the workspace editor, and the additional-repository picker. There are no
  repository rows under a connection.
- **Run again** exists for the same reason it does on GitLab (Section 16.1).
- **The reporting-mode control** carries the Section 16.2 merge-check notice.
- **Attribution** carries the Section 7.2 caveat on the binding, if the spike
  confirms that access tokens do not render distinguishably.
- The mark is a `BitbucketMark` export in `packages/web/src/components/marks.tsx`
  plus one arm in `PlatformMark` and one entry in `IntegrationMarks`. It does
  **not** go in `components/console/platforms/marks.ts`, which is chat-platform
  only, and it gets no `platform-labels.ts` entry.

The session pull-request dock panel stays GitHub-only, per Section 6.5.

### 18.2 REST

Two route plugins mirroring the GitLab pair: an org-scoped one under
`/orgs/:orgId` (connections, workspaces, repositories, bindings, create, repair,
transfer, delete) and an unauthenticated public one for the OAuth begin and
callback. Both 404 entirely when the deployment has no Bitbucket application
configured, which is how the Console learns availability from the authenticated
API rather than from a build-time flag.

Every route carries `tags`, `summary`, `description`, and a unique
`operationId`, per the OpenAPI rule in `CLAUDE.md`.

Hook creation and update reuse `POST /hooks` and `PUT /hooks/:id` with a
`bitbucket` arm on the discriminated body. The existing `POST /hooks/:id/rerun`
generalizes from GitLab-only to any host without a native re-run affordance.

### 18.3 Deployment Configuration

The typed deployment document gains a nullable `bitbucket` key beside `github`
and `gitlab`. The client secret is a write-only sealed deployment secret at
`bitbucket.clientSecret`; the client key is a configuration value. Plain
environment variables remain the no-document fallback only.

The Setup Server card is **publish-only**, modelled on the 45-line
`packages/setup/src/gitlab-app.ts` rather than on the GitHub manifest flow:
Bitbucket has no application-creation API, so setup publishes the exact callback
URL and scope list to register by hand, then accepts the key and secret typed
back in. URLs are composed by concatenation onto the normalized base so a path
prefix survives.

Section 7.1's open question decides whether this is a deployment-owned
application at all. If a consumer registered in one workspace cannot authorize
users of another, this section becomes per-organization configuration and the
Setup Server card does not apply.

## 19. Failure, Recovery, and Removal

- **Control Plane unavailable.** Established sessions keep running. New hook
  dispatch degrades because the relay cannot resolve authorization, and it fails
  closed.
- **OAuth unavailable.** Runtime credentials keep working until they expire.
  Bindings move to `admin_degraded` and the Console shows the reconnect path.
- **Runtime drift.** A token revoked or a permission removed at the provider
  moves the binding to `runtime_degraded` with the provider's reason. A converge
  sweeper re-attempts on the GitLab sweeper's cadence.
- **Ambiguous review effect.** The lease locks rather than retrying, and
  reconciliation uses signed markers. Ownership of an ambiguous attempt is not
  transferable.
- **Disconnect and delete.** Section 10.3. Local authority is disabled first,
  external cleanup is owed, and retention lives in `cleanup_pending`.

## 20. Security Analysis

- Webhook bodies are untrusted input, fenced in the prompt (Section 12.3) and
  never trusted before signature verification (Section 11.2).
- OAuth tokens never leave the Control Plane. Runtime tokens never persist on a
  daemon and die on a credential-epoch bump.
- The `effect` credential is never returned to any caller, including the agent.
- The review target is never model input: it comes from trusted turn metadata.
- Section 8.4's canonicalization is a security property, not only a correctness
  one: two spellings of one id would let a rule match a repository the operator
  did not authorize, or fail to match one they did, with no log line either way.
- Section 17.3's value-shaped gate exists to prevent a pre-Bitbucket daemon from
  resolving a Bitbucket path against github.com.
- Message bodies, ACP update streams, and attachment bytes stay off the Control
  Plane, unchanged.

## 21. Naming Debt

Recorded so the next reader is not misled. None of this is in scope for the
Bitbucket work unless a milestone says so.

Provider-neutral in behavior, GitHub-named in code: `GithubReplyTarget`,
`GithubReviewBatch`, `GithubReviewHost`,
`GithubReviewOrchestrator.dispatchRelayHook`, and the whole of
`packages/daemon/src/github/hook-coords.ts`, which is both providers' durable
turn state today and would be three providers' after this work.

GitLab vocabulary on provider-neutral surfaces: `mergeRequestIid` and `noteId`
on `CodeHostRunProjection` and the `codehost/*` frames,
`HookDef.githubSessionKey`, and `CodeHostReviewExternalRef.kind`'s `draft_note`.

The only one this design changes is `CodeHostReviewExternalRef.kind`, and only
because it must gain members anyway (Section 15). The rest stay, because a rename
pass touching this much core code alongside a new provider is how a rolling
deployment breaks.

## 22. Implementation Plan

Milestones are merge order, not calendar. Each milestone is several small,
independently mergeable PRs. **GitHub and GitLab behavior stays green at every
merge.** Each Section 6.5 contract member is extracted in the same change that
adds its Bitbucket implementer, and each duplicated surface named in Section 6.5
is collapsed in the change that would otherwise have added a third copy. A
feature string is advertised only when its complete slice is live. No big-bang
refactor PR exists anywhere in this plan.

The dependency spine is B0 to B1 to B2 to B3 to (B4 parallel B5) to B6 to B7 to
B8.

### B0: Opaque external identity

The Section 8.4 widening, with no Bitbucket concept anywhere in the diff.

- Split `CodeHostExternalId` from the counter alias (Section 8.4.3) in its own
  PR, first.
- Add the `CodeHostIdSpec` registry to `packages/protocol/src/code-host.ts`
  (Section 8.4.5), with `github` and `gitlab` entries only.
- Ship the expand migration (Section 8.4.6) with no application change.
- Move Control Plane readers to the text column and flip
  `packages/control-plane/src/persistence/ports.ts` from `bigint` to `string`.
  This is one PR on purpose: a half-converted port that widens to
  `bigint | string` is a runtime error rather than a compile error.
- Audit every site in Section 8.4.9 that the compiler will not catch.
- Widen the actor axis at the same time (`serviceAccountExternalId`,
  `RcCodeHostMembershipAuthz`'s three id fields), or B7 cannot ship.
- Give `hook_run` the additive column instead (Section 8.4.7).

**Exit:** GitHub and GitLab behavior unchanged;
`pnpm --filter @agentconnect.md/control-plane test:unit` and `test:int` green;
tolerant-reader and mixed-version decode tests green, before any
Bitbucket-shaped value exists to leak.

### B1: Protocol union and feature negotiation

- `'bitbucket'` joins `CODE_HOST_PROVIDERS`; resolve the resulting compile
  breakage across every `Record<HookKind, ...>` in the tree.
- `HookKind` and `WorkspaceMode` Postgres enum values; `AgentWorkspace` arm;
  `RcHookAssign` arm; `HookStart` and `HookReport` three-member one-of;
  `GitCredRequest.purpose` values; `BITBUCKET_FAMILIES` and the
  `hook-family.ts` arms.
- **Collapse the reply-target discriminator** (Section 6.5): make
  `GithubReplyTarget.provider` explicit, so absence stops meaning GitHub.
- Declare `BITBUCKET_CLOUD_V1_FEATURE`; do not advertise it. Extend
  `requiredDaemonFeatures` with the value-shaped predicate (Section 17.3).
- Promote migration for Section 8.4.6, cutting Control Plane writers over.

**Exit:** mixed-version fail-closed tests green; `pnpm typecheck` clean across
the workspace; no Bitbucket behavior reachable.

### B2: Control Plane OAuth connection

- Deployment-document `bitbucket` key and `bitbucketDeploymentPut`; the
  publish-only Setup Server card (Section 18.3).
- `BitbucketConnection` and its sealed secret; `BitbucketOauthState`.
- OAuth start, begin, and callback; single-writer refresh with the token-version
  compare-and-swap; disconnect semantics (Section 9).
- **Settle Section 7.1's cross-workspace consumer question first.** If the
  answer is no, redesign Section 18.3 before writing this milestone.
- Routes stay hidden. No Console entry.

**Exit:** state and browser-binding unit tests; sealing and metadata-only DTO
integration tests.

### B3: Control Plane bindings and reconciliation

- `BitbucketRepoBinding`, `BitbucketAgentCredential`, `BitbucketWebhookSecret`.
- The global-claim transaction; the provisioning saga (Section 10.2) with
  provider-reported expiry validation and the deterministic ownership marker;
  repair, transfer, and delete routes; the binding lifecycle states.
- The converge sweeper, the rotator, and the desired-event union.
- **Contract member extracted here:** webhook-secret distribution (Section 6.5),
  now that two of three providers agree.
- Test infrastructure: a local fake Bitbucket API server, following the existing
  fake-server precedent.

**Exit:** claim-race, saga-recovery-after-every-side-effect, and
token-expiry-policy integration tests.

### B4: Relay ingress

- `packages/relay/src/hooks/bitbucket-ingress.ts`, reusing `verifySha256Header`
  with the look-up-then-verify order (Section 11.2).
- **Collapse the hook table's provider indexes** (Section 6.5) into one
  provider-qualified map. Section 8.4's single string identity space is what
  makes this possible; adding a third parallel index instead would leave the
  seam wider and the code no more general.
- Extract the shared verification-and-dispatch skeleton from the GitHub and
  GitLab ingresses in the same change.
- Event mapping, the veto and gate table (Sections 12.1 and 12.2), and the
  membership-authorization round trip.

**Exit:** signature, replay, and multi-candidate-secret units; two-relay
redelivery; mixed-version fail-closed integration tests.

### B5: Daemon credentials, workspace, sessions

- The credential plane (Section 13.2): `ManagedCredentialProvider`,
  `managedHostTableFor`, helper path parsing on GitHub's two-segment shape,
  `gitcred-server.ts` provider resolution, cache keys, `git-injection.ts` scope
  and canonical URL, and `bitbucket.org` in the origin allowlist.
- Hook normalization: the Bitbucket fence opener, the session-thread grammar,
  and the transport-scope pin (Section 12.3).
- The Section 8.4.4 canonicalization test lands here, before any workspace can
  be materialized.
- Decide whether secondary repository roots, materialized for GitHub only today,
  extend to Bitbucket.

**Exit:** helper and session-disjointness units; a credential-plane integration
test over a real socket; worktree cleanup.

### B6: Daemon outputs: poster and run projection

- The Bitbucket final poster behind the publish barrier (Section 14.1) and the
  Section 14.2 broker.
- The Section 16.2 build-status projection, with the daemon and Control Plane
  provider gates becoming registries.
- Handover reporting.

**Exit:** single-writer, ambiguous-reconciliation, and offline-pending
integration tests. Daemons carrying B5 and B6 may now advertise
`bitbucket-cloud-v1`.

### B7: Formal pull-request reviews

- The `CodeHostReviewAdapter` registration, plus the two Control Plane literals
  that must become dispatch (Section 15).
- The sequential publication pipeline, the per-comment ledger entries, the
  exact-head verdict fence, ambiguous classification, and marker
  reconciliation.
- `CodeHostReviewExternalRef.kind` gains its Bitbucket members.

**Exit:** the Section 15 review matrix. This is the largest test surface in the
plan; budget it accordingly.

### B8: Console, docs, general availability

- The thin web module (Section 18.1): connect entry, picker source, binding
  status fragments, mark.
- **Collapse the wizard panes** (Section 6.5): extract a shared code-host pane
  from `AddIntegrationModal.tsx` rather than adding a third roughly 400-line
  copy, and apply the same judgement to `EditWorkspaceModal`, `AddAgentModal`,
  and the three hand-written workspace-mode tiles.
- Make the Console's session facet filter provider-qualified
  (`packages/web/src/lib/session-trigger.ts:131`).
- User docs; the `docs/product-conventions.md` entries; pilot then general
  enablement.

**Exit:** `pnpm -r test` green; a documented end-to-end pass per Section 23.2.

### B9: Contract the identity migration

One release after B8 is generally available: drop the bridge trigger and the
legacy bigint columns and rename the text columns back (Section 8.4.6). This is
a zero-diff migration for application code and exists as its own milestone so it
cannot be rushed into the same release as the promote step.

## 23. Validation

### 23.1 Open questions the spike must answer

These are assumptions, not facts. Each is load-bearing for the section named,
and each must be answered against a live Bitbucket Cloud workspace with a
throwaway OAuth consumer before that section leaves draft.

| Question                                                                                                                                                          | Blocks                    | If the answer is no                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Is there a REST endpoint to create a repository or workspace access token?                                                                                        | Section 10.2, B3          | The provisioning saga collapses into operator-pasted tokens and Section 7.2 changes shape entirely.        |
| Does `POST .../pullrequests/{id}/request-changes` exist?                                                                                                          | Section 15, B7            | `REQUEST_CHANGES` maps to "comment and withhold approval", and Section 4 records the degradation.          |
| Does REST v2 accept a bare UUID in a path segment, or are braces mandatory?                                                                                       | Section 8.4.4             | `toProviderPathSegment` re-adds braces unconditionally. The stored form does not change either way.        |
| Can an OAuth consumer registered in one workspace authorize users of another?                                                                                     | Sections 7.1 and 18.3, B2 | Bitbucket becomes per-organization configuration and the Setup Server card does not apply.                 |
| Does the authorization-code flow support PKCE?                                                                                                                    | Section 9.1               | The browser-binding cookie plus the one-shot state row carries the binding, and the weakening is recorded. |
| Does an access token render as a distinguishable comment author, and can it be named per agent?                                                                   | Section 7.2, Section 18.1 | The Console states plainly that agents share one visible actor on a binding.                               |
| Does an informational build status interact with a workspace's merge checks?                                                                                      | Section 16.2              | Fall back to a status comment; the GitLab implementation transfers unchanged.                              |
| What is the current state of the app-password to API-token migration, and of the 2026-05-04 change routing OAuth traffic to `api.bitbucket.org` with bearer auth? | Sections 7 and 9          | Adjust the API client's base URL and auth header accordingly.                                              |

Record the spike transcript in this section so B3 and B7 are specified against
observed behavior rather than documentation.

### 23.2 Test surface

Unit tests for pure boundaries:

- OAuth state binding and refresh single-writer transitions;
- `X-Hub-Signature` verification, including a wrong secret, a truncated
  signature, and a multi-candidate rotating table;
- event normalization, mention targeting, actor veto, and the contributor gate;
- disjoint pull-request, issue, and push session-key derivation, including
  stability across a repository and a workspace rename;
- **the Section 8.4.4 canonicalizer**: both input spellings map to one output,
  and every non-UUID input is refused;
- **the `CodeHostIdSpec` registry**: an unknown provider refuses everything;
- provider-qualified authorization and grant-echo mismatch rejection;
- review verdict and event pairing, and the exact-head fence.

Integration tests:

- secret sealing and metadata-only DTOs;
- transactional global claim races and serialized ownership transfer;
- provisioning saga recovery after each external side effect;
- token expiry policy on create and replace, including a missing or mismatched
  provider expiry;
- daemon and relay feature negotiation, and mixed-version rejection;
- two-relay redelivery absorbed by the daemon inbox and the unique `HookRun`;
- credential epoch invalidation on permission, token, binding, placement, and
  disconnect changes;
- **the Section 8.4.6 rolling matrix**: an old Control Plane pod against the
  promoted schema is blind to Bitbucket rows and correct on the other two;
- daemon-only build-status creation and update, offline pending intent, and
  fail-closed writer transfer after an ambiguous provider mutation;
- **partial review publication** (Section 15): a failure midway leaves real
  comments, a retry does not duplicate them, and the outcome classifies as
  ambiguous rather than not-submitted;
- snapshot projection withholding Bitbucket-shaped specs from daemons that have
  not advertised `bitbucket-cloud-v1`; and
- message and content absence from Control Plane frames and persistence.

### 23.3 Documentation checks

- Every `file:line` reference in this document resolves, and the cited symbol is
  at or near the cited line. Re-run before each milestone and update the
  "Codebase alignment last revised" date in the header.
- Every milestone Exit line names a command someone can run.
- Any user-visible Bitbucket behavior has a `docs/product-conventions.md` entry,
  and no proposed Console copy contains an internal component name.

## 24. References

- `docs/designs/gitlab-com-integration.md`: the two-implementer contract this
  document extends, and the source of every structure reused here.
- `docs/designs/github-pr-review-checks.md`: the origin of the
  `reviewPolicy` / `reportingMode` / `gateMode` vocabulary.
- `docs/designs/webhook-triggers-and-github-events.md`: the hook-kind
  vocabulary and the `HOOK_KINDS` derivation rule.
- `docs/designs/github-app-git-credentials.md`: the credential security
  boundary and the workspace cold-change semantics.
- `docs/designs/architecture.md`: the Control-Plane-off-the-hot-path invariant.
- `docs/designs/agent-multi-repo-authorization.md`: provider-qualified grants.
- `docs/product-conventions.md`: user-facing invariants.

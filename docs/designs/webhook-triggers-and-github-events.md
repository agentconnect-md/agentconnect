# General Webhook Triggers and GitHub Event Integration

This document describes the current webhook trigger implementation. A hook maps
one inbound delivery to one agent turn. The relay is the public ingress and data
plane, the daemon runs the turn, and the Control Plane (CP) stores definitions
and body-free run metadata.

The hook kinds sharing this execution path are the generic endpoint plus one per
code host. The vocabulary is `HOOK_KINDS` in `packages/protocol/src/code-host.ts`,
derived from `CODE_HOST_PROVIDERS`, so a new host widens it in one place and every
mapping over it — the session integration facet, the console's trigger taxonomy,
the per-kind marks and labels — stops type-checking until it is extended:

- `webhook`: an unguessable capability URL accepts a caller-supplied
  instruction.
- `github`: a GitHub App webhook accepts signed repository events, applies
  subscription and authorization rules, and preserves issue or pull-request
  session continuity.
- `gitlab`: the GitLab counterpart, described in
  [gitlab-com-integration.md](gitlab-com-integration.md).

Only `webhook` is generic. Every code-host kind is promoted out of the generic
bucket wherever a session is classified, so a code-host session is never
filtered, marked, or labelled as a plain webhook. `webhook` is the mapping for
the generic kind and for a hook whose source cannot be determined at all — it is
never the fallback for a kind nobody mapped.

A session's kind is **snapshotted onto the session row at creation**
(`session_meta."hookKind"`), beside the trigger id and display names it already
records. A hook definition can be deleted and recreated, which leaves past
sessions pointing at an id that resolves to nothing; reading the kind live would
then rewrite their history as generic webhooks. Every read — display label,
integration facet, and the filter predicate — prefers the snapshot and consults
the live definition only when a row has none. Rows written before the column
have no snapshot and keep resolving through the live hook exactly as before;
they are deliberately **not** backfilled, so a code-host session that predates
the column still degrades to the generic rendering once its hook is gone.

For a numbered GitHub thread, `GithubPoster` owns the ordinary reply comment and
publishes only the completed ACP final answer. A formal pull-request review is a
separate controlled effect and must use the daemon-owned structured action
described in
[github-pr-review-checks.md](github-pr-review-checks.md).

## Architecture

```text
general caller ──POST /webhooks/in/:token──┐
                                           │
GitHub App ─────POST /webhooks/github──────┤
                                           ▼
                                      relay ingress
                              verify → match → rate limit
                                           │
                                rd/msg { source: hook }
                                           │
                                           ▼
                                         daemon
                                 deduplicate → ACP turn
                                           │
                          hook/start + hook/report metadata
                                           │
                                           ▼
                                     Control Plane
```

The relay sends event content directly to the target daemon. Event bodies,
comments, diffs, and attachment content never pass through the CP. The CP
receives only configuration, trusted routing metadata, delivery accounting, and
terminal outcomes.

The CP compiles each enabled, placed hook into an `rc/hook-assign` rule and
broadcasts it to every connected relay. Hook disablement, deletion, or an
unplaced agent produces `rc/hook-remove`. A relay starts with an empty in-memory
table and receives a full replay after registration.

The authoritative implementation surfaces are:

- [hook routes](../../packages/control-plane/src/http/routes/hooks.ts)
- [hook compiler](../../packages/control-plane/src/hooks/hook.service.ts)
- [generic ingress](../../packages/relay/src/hooks/ingress.ts)
- [GitHub ingress](../../packages/relay/src/hooks/github-ingress.ts)
- [hook protocol](../../packages/protocol/src/frames/hook.ts)
- [relay protocol](../../packages/protocol/src/frames/relay-cp.ts)
- [daemon hook message](../../packages/daemon/src/messages/hook-message.ts)
- [Prisma schema](../../packages/control-plane/prisma/schema.prisma)

## Core Invariants

1. The relay owns public webhook ingress and signature verification.
2. Event content travels only on the relay-to-daemon data plane.
3. The CP stores hook definitions and body-free run metadata, never event
   bodies.
4. Matching uses numeric GitHub repository IDs and CP-compiled installation
   membership. Payload ownership fields are filters, not authorization.
5. Every matched hook names one explicit `agentId`; daemon route arbitration is
   not involved.
6. The daemon deduplicates on `(sessionKey, msgId)`, where
   `msgId = "<hookId>:<deliveryKey>"`.
7. The relay returns HTTP `202` after verification, matching, and queueing. It
   does not wait for the agent turn to finish.
8. A numbered GitHub turn has one ordinary-comment writer:
   `GithubPoster`.
9. Secrets are never logged, returned by list APIs, or placed in an agent
   environment.

## General Webhook

### Creation and Capability URL

Creating a `webhook` hook mints:

- a random `urlToken` with at least 128 bits of entropy;
- a full ingress URL derived from `PUBLIC_RELAY_URL`; and
- optionally, a per-hook HMAC signing secret.

The URL is a capability credential. Anyone who holds it can direct the agent,
so callers must protect it like an API key. The HMAC secret is an optional
second factor and is returned only in the create response.

The console presents a client-signed test-delivery command. There is no
server-side `POST /hooks/:id/test` route.

### Ingress Contract

The endpoint is:

```text
POST /webhooks/in/:token
Content-Type: application/json
X-AC-Delivery-Key: <caller-stable-id>        # optional
X-AC-Signature: sha256=<hex>                 # required when HMAC is enabled
```

The relay:

1. resolves the token from its in-memory hook table;
2. verifies `X-AC-Signature` over the raw body when configured;
3. applies a per-hook token-bucket rate limit;
4. uses a valid caller delivery key or creates a UUID;
5. truncates the model-visible body to the protocol limit;
6. dispatches an `rd/msg` hook frame; and
7. returns `202` with the delivery key.

An unknown token and an invalid HMAC both return `404`, avoiding a token
existence oracle. The route accepts JSON with a 128 KiB request limit. Payload
bodies are never logged.

### Message Semantics

The capability URL authenticates the caller, so the payload is an instruction,
not untrusted quoted context. The daemon extracts a string field named
`prompt`, `text`, or `message` as the instruction and attaches remaining JSON
fields as context. If none exists, the complete payload becomes the message.

A generic hook has no separate trigger prompt. The agent description remains
standing context.

`sessionMode` controls continuity:

- `perDelivery`: every delivery uses a distinct session;
- `shared`: all deliveries for the hook reuse one session.

An optional target integration and channel can anchor output using the same
target model as scheduled triggers. Without a target, the turn is headless.

## GitHub Hooks

### Repository Authorization

A GitHub hook watches one repository covered by a live GitHub App installation
owned by the organization. The server resolves the repository name to its
numeric `repoId`; clients cannot supply the numeric ID directly.

The watched repository must also be either:

- the agent workspace repository; or
- an explicit `AgentRepoAuthorization`.

Agent-visible credentials remain clamped to the workspace repository plus the
explicit authorization set. A hook does not implicitly broaden `GH_TOKEN`.

`GithubPoster` requests a separate repository-scoped token with
`purpose: github_hook_reply` and the relay-delivered `hookId`. The CP
revalidates the enabled hook by immutable hook and repository identity before
minting issue or pull-request comment permission. That token never enters the
agent environment.

### Signature and Attribution

`POST /webhooks/github` returns 404 unless the Relay's startup snapshot contains
the webhook secret opened from the deployment-wide GitHub App configuration.
The Control Plane supplies that snapshot when the Relay connects. Every enabled
request requires a valid timing-safe `X-Hub-Signature-256` comparison over the raw
body.

After signature verification:

- `ping` returns `204`;
- verified unmatched deliveries return `202`;
- `installation` and `installation_repositories` events become
  `rc/github-installation` doorbells;
- Check actions and pull-request `workflow_run:in_progress` events are resolved
  as explicit metadata-only review controls before subscription matching;
- subscription events are matched by numeric `repository.id`; and
- every candidate rule must contain the payload `installation.id` in its
  CP-compiled installation set.

The CP treats an installation doorbell as cache invalidation. It pulls the
installation from GitHub and updates stored facts from that authenticated API
response. The webhook payload is not the source of truth.

The route accepts JSON with a 1 MiB request limit and never logs the payload.
If the webhook secret is absent, the handler returns 404.

### Supported Events and Matching

The relay recognizes these subscription event families:

- `issues`
- `pull_request`
- `issue_comment`
- `pull_request_review_comment`
- `push`

Stored patterns use `family:action`, with `family:*` as a wildcard. Label
filters require at least one current subject label to match.
`commentFamilies` distinguishes issue comments from pull-request conversation
comments because GitHub sends both through `issue_comment`.

The matcher rejects bot-authored comments and review comments, plus unrelated bot
events, to prevent self-reply loops and agent-to-agent mention loops. Revision-bearing
PR events authored by the configured App are admitted as the lifecycle
exception: same-repository PRs are treated as an internal CI lane and may start review
without a human-author permission lookup, while fork PRs remain on the maintainer
workflow-approval path.

Closed, deleted, and reopened issue or pull-request lifecycle events do not start
turns. Ordinary issue/PR title and body edits are also silent. A PR edit carrying
signed `changes.base` metadata is a target-branch revision and starts a new review.
Signed issue-close, issue-delete, and merged-pull-request
deliveries instead fan out as maintenance-only requests that apply the daemon's
safe session-worktree cleanup without deleting session metadata or transcripts.
Deleted issue comments and review comments are silent no-ops. A diff-line review
comment may match a shared `issue_comment` subscription or an explicit
`pull_request_review_comment` subscription.

### Summon and Maintainer Gates

With `mentionOnly` enabled, authored event text must contain either:

- `@<agent-name>` to select one agent; or
- `@<app-slug>` to broadcast to all matching hooks in the repository.

The App handle wins when both forms are present. Unrelated mentions do not
change the candidate set.

Every numbered-thread event passes a live, body-free permission decision owned
by the CP. Webhook `author_association` values are descriptive only: `MEMBER`
and `COLLABORATOR` can still represent read or triage access and never bypass
the current repository-permission lookup.

Issue and pull-request lifecycle events require a current trigger-authorized role
(`admin`, `write`, or `triage`) from the subject author. Every comment requires it from `comment.user`, not the
top-level action `sender`; this distinction prevents a maintainer edit/delete
action from authorizing someone else's content. An unmentioned comment also
requires that same role from the Issue/PR author; an explicit
mention by an authorized maintainer omits that second requirement and can summon
the Agent onto an externally authored thread. Missing identity metadata, denial,
timeout, or an unavailable lookup fails closed. Matching comment rules with the
same actor requirement share one fenced authorization decision.

A native `pull_request:review_requested` event can explicitly request the App
bot as reviewer. It bypasses cadence, labels, and mention filters only after a
live maintainer authorization.

### External Issues and Pull Requests

Issue/PR bodies and pull-request diffs are attacker-controlled input. A
lifecycle event from an author outside the repository write boundary does not
run an agent automatically, even when the body mentions the Agent or App. One
live decision and a batch of durable hook fences authorize the complete
repository fan-out before any agent dispatch.

An authorized maintainer can request execution on an external thread by
explicitly mentioning the Agent or App in a comment. An ordinary unmentioned
comment cannot silently activate an external thread; both its commenter and
the original subject author must pass the same live role check.

For external PR revision-bearing events such as open, synchronize, and target-branch change, the system records a body-free
`review_request_required` outcome and may project an informational Check with a
maintainer action. A maintainer can then request execution through:

- the Check action;
- a comment mention;
- GitHub Actions' `Approve and run workflows` control, when the approved
  pull-request workflow enters `in_progress`; or
- an explicit native App-reviewer request event. GitHub's normal reviewer picker
  cannot select a third-party App bot, so its Request/Re-request control is not a
  general AgentConnect entry point.

Each path revalidates current repository authority before opening a review
generation.

The signed `workflow_run:in_progress` payload identifies the triggering actor,
repository, installation, and head revision but not the target hook. Relay also
preserves the PR number when GitHub supplies one; fork workflow runs may omit
that association. CP otherwise resolves the latest body-free
`review_request_required` candidate per hook and PR and rejects a shared head
with multiple candidates instead of guessing. Relay then rechecks current rule
fences and the triggering actor's live repository role. A stable
repository/pull/head delivery key coalesces multiple workflows for one revision.

### Session Affinity

GitHub hooks always use `perThread`. The relay forms the session key from the
hook's immutable `githubSessionKey` prefix and the issue or pull-request number.
New rows use a numeric-repository-based prefix, so repository renames do not
split the conversation.

The daemon maps this to its normal session identity and resumes the same ACP
session on later matching events. No GitHub-specific session store exists.

The repository checkout follows the same logical session affinity. When the
Agent uses worktrees, the daemon maps the session key to a stable opaque path
under that Agent's `worktrees` directory; concurrent pull requests therefore
use different working directories while later events for one pull request
reuse its directory.

### Pull Request Feedback Continuation

A pull request opened from an ordinary or issue-originated session must keep
that session as its owner after the creating turn ends. The CP therefore stores
one `SessionPullRequest` row keyed by organization, numeric repository id, and
pull-request number; its optional `sessionId` is the durable owner. Only a
terminal lifecycle snapshot emitted for that exact session may establish the
owner: the CP resolves the session's isolated worktree and persists the
branch-to-PR result. Before acknowledging a durable session snapshot, the CP
persists one `SessionPullRequestCapture` obligation keyed only by that
`sessionId`. The worker leases that exact row: transient daemon or GitHub
failures defer it, while a definitive missing branch, repository, or PR
completes it. Shared workspaces and console PR-panel reads cannot establish
wake eligibility.
If feedback arrives before capture, it creates an unowned row that stays
dormant until the same session establishes the forward binding. The worker
never searches session history to infer an owner.

The signature-verified relay ingress has a separate metadata lane before hook
subscription matching. It reports submitted reviews with actionable text or a
changes-requested state, created or edited review comments, created or edited
PR issue comments, and failed completed check suites. This lane intentionally
does not reject comments authored by the deployment's own GitHub App: GitHub
can reject the App's formal review submission and the review worker then leaves
its actionable verdict as an App-authored PR comment. The ordinary hook matcher
keeps its bot-loop filter unchanged.

The relay sends no review body or check log to the CP. The CP stores one
level-triggered `deliveryKey` on the ownership row, not one row per GitHub
event. Every new delivery resets a short quiet window; the daemon later reads
the current review and check state from GitHub, so payload detail is
unnecessary. Successful admission clears the wake only if its delivery key is
still current, so a concurrent delivery remains pending. Deferred delivery
moves only that PR's next-attempt time forward, allowing the worker to continue
with other due PRs in the same pass. Unowned rows expire from the latest
distinct signal time without ever entering the delivery queue.

The relay acknowledges GitHub only after the marker is durable. A transient
persistence failure returns 503 instead of falsely acknowledging the delivery;
GitHub records it as a failed webhook delivery for explicit redelivery rather
than retrying it automatically.

The CP dispatches that continuation only to a ready daemon that can serve the
original session content and advertises `pull-request-feedback-v1`. The daemon
reopens the exact agent-scoped session, constructs a local system turn that
asks the agent to inspect current GitHub review and check state, and durably
admits it under the webhook delivery key. Chat and webchat sessions retain
their normal reply surface; hook and dream sessions continue headlessly while
recording the result in their transcript. This is a continuation, not a new
`HookRun`, and all reviewer text and CI output remain provider- or daemon-local.

### Revision Admission

Deliveries for one pull request contend for the next generation rather than each
queueing its own turn. Within one (hook, repository, pull-request) lane the
newest relay-fired head supersedes queued turns and preempts an active turn on an
older head with the normalized `superseded` outcome. A re-request names the head
already current, so a burst of them collapses onto the newest delivery and
re-runs that head once. Inline comments belonging to one submitted review
coalesce into a single batched turn, sealed by the first of three gates — a
maximum comment count, a quiet window since the last comment, and a maximum wait
since the batch opened — and answered through the daemon-owned batched reply
tool, which takes over publication from the ordinary reply.

That admission plan is a provider-neutral seam with two implementers. Each code
host supplies its own lane identity, revision and re-run event sets, comment
batch stream and prompt, and whether a sealed batch publishes each item itself;
the daemon core consults the seam and never a provider module. GitLab's
implementation, and the two places the hosts deliberately differ, are in
[gitlab-com-integration.md](gitlab-com-integration.md) Section 12.3.

### Prompt Boundary

GitHub content is untrusted external input. The daemon wraps model-visible
event text in an explicit untrusted-content delimiter and supplies only bounded
excerpts in the delivery frame. The agent reads the authoritative issue,
pull-request, comments, or diff through an authorized GitHub read path when it
needs more context.

The trust boundary depends on runtime permissions and repository credentials:

- public issue text can contain prompt injection;
- pull requests from authors without current write authority require a
  maintainer request;
- repository tokens are narrowed to the required repository and capability;
- ordinary comment mutation is unavailable to the agent during a numbered
  hook turn; and
- formal reviews require the structured, action-time-authorized review path.

Before a formal pull-request review generation starts, the daemon must also
establish the trusted filesystem revision. It resolves any missing head/base
metadata through the authenticated GitHub API. When the Agent workspace is the
same repository, the daemon fetches the exact base and head objects into
daemon-owned refs and checks out an isolated worktree. A GitHub merge ref may be
used only after its object ID and ordered parents are proven to be the trusted
base and head; otherwise the exact head is used.
Reused formal-review worktrees are hard-reset and cleaned including ignored
untracked content before they are presented as exact snapshots. Ordinary session
worktrees continue to preserve their working state between turns.

Repository hooks are not a reason to reject a workspace. Every daemon-managed
Git command disables hooks and fsmonitor at command scope, and every configured
Git workspace gives its Agent runtime the same default policy without rewriting
the repository config. Unconditional local includes are expanded so their
effective settings can be audited; an include that only selects a hooks path
remains usable. Conditional includes are refused because their activation can
change between the primary checkout and a linked worktree, and the separate
worktree config scope is refused because a local-scope audit cannot inspect it.
Network routing or other executable overrides that the daemon cannot neutralize
are also refused for the affected daemon-managed operation. The daemon repeats
that audit immediately before linked-worktree materialization or reset, and an
unsafe result is never degraded into a best-effort pull failure. Daemon Git also
disables replacement-object processing and ignores repository graft files, so
verified object IDs, parents, and checked-out trees retain the same meaning. It
also disables sparse checkout at daemon command scope so an exact checkout is a
complete tree even when the primary repository uses sparse-checkout settings.
This policy applies to every task in a configured Git repository, not only GitHub
reviews.

Failure to obtain the authoritative base/head remains fail-closed. Once those
identities are known, however, a revision fetch, verification, or local checkout
failure degrades to revision-only review instead of failing the Agent turn. The
daemon replaces any earlier review checkout with an empty isolated cwd when it
can, and the prompt forbids trusting local traces, permits skipping local
execution, and requires inspection of the exact revision through GitHub read-only
tools. The same revision-only path applies when the Agent workspace belongs to
another repository. Ordinary PR conversations preserve their stable session
worktree, do not carry formal-review authority, and require read-only or
revision-addressed inspection instead of trusting working-tree paths.

The model-visible formal-review instruction repeats the trusted base/head and
requires verifying local `HEAD` before relying on file traces. This workspace
fence is in addition to the action-time revision fence on formal review
submission.

## GitHub Output Ownership

### Ordinary Reply

`GithubPoster` is always enabled for a numbered GitHub turn. It collects ACP
updates in daemon memory but publishes only the completed final answer. It
does not publish commentary, progress, tool output, temporary placeholders, or
an incomplete answer.

The poster:

1. waits for all turn tools to finish;
2. selects the authoritative final-answer message;
3. obtains its purpose-bound comment token;
4. performs one bounded comment `POST`; and
5. records failure locally without changing the agent result.

An empty or incomplete final produces no comment.

During this turn, the agent must not create, update, or delete ordinary GitHub
comments through `gh`, MCP, connectors, raw REST, or GraphQL. The single-writer
rule prevents duplicate and overwrite races.

### Formal Review

Formal pull-request review submission is not an ordinary poster comment. It
uses the daemon-owned `submitGithubReview` action, a complete configuration and
dispatch fence, CP authorization, and a broker-only token.

A formal review attempt and the fallback ordinary reply are mutually
exclusive. If a review is submitted, the poster does not add an ordinary
comment. If the review attempt deterministically ends `not_submitted`, the
final ordinary reply remains available as fallback. Ambiguous review effects
fail closed pending reconciliation.

Informational Check projection and formal review details are defined in
[github-pr-review-checks.md](github-pr-review-checks.md).

## Protocol

### CP to Relay

- `rc/hook-assign`: upsert one compiled hook rule.
- `rc/hook-remove`: remove one rule.

A compiled rule includes:

- hook, agent, and placed daemon identity;
- configuration and dispatch revisions;
- session mode and optional output target;
- a generic capability token and optional HMAC secret; or
- GitHub repository identity, event filters, mention handles, installation
  membership, and review/reporting policy.

The HMAC secret is sensitive and must never appear in logs.

### Relay to Daemon

The relay sends `rd/msg` with `source: "hook"`. It contains:

- explicit `agentId`;
- stable `hookId` and `deliveryKey`;
- daemon deduplication key;
- computed session key;
- bounded context;
- trusted, signature-verified GitHub revision metadata when applicable; and
- the exact configuration/dispatch snapshot when available.

The daemon acknowledges message admission through `rd/ack`.

### Delivery and Completion Accounting

The relay emits body-free `rc/run-report` metadata:

- `accepted` opens a running `HookRun`;
- `failed` records a delivery-stage failure.

Immediately before an accepted GitHub turn enters the model prompt, the daemon
sends correlated `hook/start`. The CP durably attaches the authoritative
revision and advances any informational projection before acknowledging the
barrier.

At turn completion, the daemon sends correlated `hook/report`. A metadata-only
daemon outbox retains the report until the CP acknowledges it. The report
closes the run with status, duration, session ID, and normalized review outcome
when present.

`HookRun` is unique on `(hookId, deliveryKey)`, so duplicate delivery reports
and redeliveries converge on one record. A reaper marks stale running rows as
`failed(orphaned)`; an exact late completion may still replace that outcome.

## Persistence

The Prisma schema is authoritative. The main records are:

- `HookDef`: definition, repository identity, event filters, session policy,
  immutable revision fences, review/reporting policy, optional anchor, and
  owning agent.
- `HookSecret`: the generic hook's HMAC secret, separated from normal hook
  reads and DTOs.
- `HookRun`: body-free delivery, dispatch, revision, review, projection,
  session, and redelivery metadata.
- `HookReviewProjection`: durable external Check or reporting state that can be
  cleaned up even if its owning hook is deleted.

A hook belongs to one agent and has no independent visibility setting. Access
inherits the owning agent's visibility. Agent deletion cascades to hook
definitions and secrets. Projection records intentionally do not depend on that
foreign key so cleanup can still converge.

The CP never stores webhook bodies, GitHub comment text, pull-request diffs, or
attachment bytes.

## REST and Console

Organization-scoped routes provide:

```text
POST   /hooks
GET    /agents/:agentId/hooks
GET    /hooks/:id
PUT    /hooks/:id
DELETE /hooks/:id
GET    /hooks/:id/runs
```

There is no organization-wide hook list and no hook sharing endpoint. By-ID
reads apply the owning agent's visibility and return `404` for unknown,
cross-organization, or inaccessible rows.

Creation requires:

- a configured public relay URL;
- at least one live relay;
- a visible owning agent;
- a valid target integration when anchoring is requested; and
- for GitHub, a configured App, a covered repository, and appropriate explicit
  repository authorization.

GitHub review and reporting settings are validated both at configuration time
and again at effect time. Unsupported required gates and commit-status
reporting are rejected.

The agent detail Integrations card lists hooks alongside integrations. Generic
hook creation reveals the capability URL and optional HMAC secret once. GitHub
creation uses the App installation and repository picker. Recent runs show
status, delivery key, duration, and a session deep link.

## Redelivery and Failure Semantics

The HTTP response only confirms that ingress accepted the delivery for
asynchronous dispatch. It does not promise that the daemon admitted or
completed the turn.

| Failure                                 | General webhook                                                                              | GitHub hook                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CP unavailable                          | Existing relay rules can still dispatch; accounting and configuration changes may be delayed | Same; installation doorbells and projections may be delayed              |
| One relay unavailable                   | Another relay with the replayed rule can accept the request                                  | Same                                                                     |
| All relays unavailable                  | Caller receives an HTTP failure and must retry                                               | GitHub delivery reconciliation requests redelivery after recovery        |
| Assigned daemon offline                 | Delivery records `daemon_offline`                                                            | One durable automatic retry is scheduled after a short backoff           |
| Daemon drains or no duty holder accepts | Durable receipt replays first; only a receipt-free refusal is recorded                       | One safe retry; prior admission always wins over the lifecycle gate      |
| Dispatch acknowledgement ambiguous      | Records terminal `dispatch_timeout`; no automatic replay                                     | Same, because the daemon may already have admitted the turn              |
| Agent stops being served mid-turn       | Turn reports terminal `agent_handover`; no automatic replay                                  | Same; a GitHub hook additionally offers the maintainer Check retry       |
| GitHub unavailable                      | No effect                                                                                    | Source reads, permission checks, posting, and projection may fail closed |

`HookRedeliveryReconciler` compares recent GitHub App deliveries with stored
run metadata. It requests redelivery for missing eligible deliveries and for
the closed set of explicitly retryable delivery-stage failures. The current
set contains `daemon_offline`, `rejected:draining`, and
`rejected:not_holder`; each is emitted before durable daemon admission.
The daemon probes its durable hook receipt before duty and drain refusals, so
an earlier admission whose relay report was lost replays `accepted` instead of
entering this set. Retryable refusals are not cached as terminal daemon ACKs,
letting the same GUID re-enter admission after recovery. Once a configured
platform anchor send is attempted, a later drain gate reports nonretryable
`anchor_side_effect` even if the provider response was lost, because the
external effect is then ambiguous rather than proven absent.

Reconciliation does not retry an ambiguous dispatch, an agent/business
rejection, or any row that may already have produced an effect. Partial
`review_request_required` fanout is retried only when every observed sibling
proves that no agent or external review effect occurred.

An admitted turn ended by a handover (`agent_handover`) is deliberately outside
that set, and the reason is a stage question rather than a wording one. Retry
eligibility is proof that the delivery never executed — the retryable predicate
requires no start barrier at all — while a handover proves only that no external
effect was reached. Redelivery could not act on it either way: it preserves the
delivery GUID, and the daemon's own durable receipt for that GUID replays the
recorded outcome instead of rerunning the model. Admitting this class would
therefore mean separating "never executed" from "executed with no external
effect" and giving the daemon a receipt it is allowed to discard — both of which
weaken the exactly-once guarantee that predicate exists to provide. Until then
the recovery for a handover is an explicit request: the Check's `Request review`
action or a fresh mention, each of which is a new delivery under live
maintainer authorization.

Cron has a different availability boundary: a daemon-local schedule can fire
without the relay, while a webhook always requires a public ingress process.

## Security Checklist

- Capability tokens have at least 128 bits of entropy.
- Unknown tokens and invalid optional HMAC signatures are indistinguishable.
- GitHub signature verification is mandatory before matching or doorbells.
- Repository matching uses numeric IDs.
- Installation membership comes from CP-owned records.
- Bot senders never trigger GitHub hooks.
- Issue/PR actors pass live repository-role checks; payload associations never authorize.
- External Issues and pull requests require an explicit maintainer request.
- Event bodies remain relay-to-daemon only.
- Logs contain identifiers and outcomes, never payload text or secrets.
- `HookSecret` is absent from normal hook queries and DTOs.
- App private-key material remains in the CP trust domain.
- The GitHub webhook secret remains in the relay trust domain.
- Purpose-bound poster and review tokens never enter the agent environment.
- Ordinary replies have one writer.
- Formal reviews require action-time authorization and exact revision fences.

## Unsupported Capabilities

The implementation does not provide:

- synchronous webhook responses containing agent output;
- arbitrary payload transformation or filter programs;
- structured Bitbucket event semantics;
- per-repository webhook registration managed by AgentConnect;
- daemon polling as an alternative public ingress;
- queueing arbitrary generic deliveries while a daemon is offline;
- automatic replay of ambiguous dispatches;
- required GitHub review gates;
- commit-status reporting; or
- per-organization custom GitHub Apps or GitHub Enterprise Server support.

These omissions are explicit compatibility and trust-boundary constraints, not
hidden fallbacks.

# Pull-request feedback continuation

GitHub, GitLab and Gitea feedback can resume the session that created a pull
request. This is a code-host continuation of existing work. It does not expose
an arbitrary `agentId + sessionId` messaging target or change A2A routing.

## Association

After an isolated session finishes a turn, the Control Plane asks its serving
daemon for that session's branch. For GitLab and Gitea, it associates the session
only when exactly one open PR/MR has that source branch in the agent's writable,
managed primary repository. Creating the PR with a CLI works: association reads
the provider's current state and does not depend on intercepting a create tool.
Shared checkouts, fork heads and additional workspace roots are excluded.

The durable identity is `(org, provider, binding, repository id, PR number)`.
A PR has one author session, and a session has one linked PR. Repository names
are display metadata. A replacement binding cannot inherit the previous
binding's association. GitHub retains its existing App installation validation
and wire format.

## Subscriptions and events

A writable GitLab or Gitea primary workspace subscribes feedback independently
of review Triggers. Saving or removing a workspace reconverges the repository's
webhook. Removing its last Trigger keeps feedback subscribed while a writable
workspace remains. Existing bindings are queued for convergence by the schema
migration. Relay registration replays the current subscriptions.

| Provider                    | Feedback admitted                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| GitLab 19.1+                | Human MR notes and diff comments; failed pipelines for the current source SHA            |
| Gitea 1.23+ and Forgejo 15+ | Human PR comments and reviews with content, or a changes-requested verdict               |
| Gitea 1.25+                 | Also failed commit statuses and failed completed Actions runs for the current source SHA |

Gitea CI subscriptions are conservative: Forgejo's compatibility version string
does not establish support for Gitea's newer events. Native event references:
[GitLab webhooks](https://docs.gitlab.com/user/project/integrations/webhook_events/)
and [Gitea webhooks](https://docs.gitea.com/usage/repository/webhooks/).

The relay verifies the repository's signing key before sending event
coordinates to the Control Plane. Human commenters pass the provider's current
membership or Trusted users gate. Managed bot identities remain excluded from
that gate. Managed agent reviews instead notify through the authenticated
publication ledger; ordinary managed replies notify through the accepted hook
report. Neither a marker in comment text nor a shared bot name proves which
agent published a review.

The relay subscription contains no agent, prompt or review authority. Its new
frames and non-GitHub continuations require `codehost-feedback-v1`; unsupported
peers receive no new frame shapes.

## Delivery

The existing durable feedback queue coalesces notifications for ten seconds.
An event arriving before association remains pending for up to seven days.
Delivery receipts are scoped per provider, binding, repository and PR, so one
failed commit shared by multiple PRs can notify each author without a redelivery
duplicating their turns. Claim leases and durable daemon admission handle
reconnects and retries.

Coalescing preserves independent reasons to wake: an unpinned comment remains
eligible if a CI signal's SHA becomes stale, and mixed authors cannot turn the
whole batch into a self-wake. Completed batches do not weaken later events'
head or author checks.

Before dispatch, the Control Plane rechecks current workspace write authority,
the live binding and host, the open PR, and the source SHA when the signal has
one. It sends to the linked session's content-serving daemon. The daemon
rechecks its workspace identity and continues the original conversation.
An unavailable daemon or chat connection defers delivery.

An author's own session output does not wake itself. A different review session
can notify the author even when both sessions belong to the same agent. Once a
human feedback event is queued for a linked author, ordinary Trigger dispatch
for that author agent is suppressed; other reviewers remain eligible.

Comment bodies, review text and CI logs stay off the Control Plane. The daemon
constructs a notification asking the agent to inspect current feedback with
provider tooling, treat external text as untrusted data, and push any fixes to
the same PR branch. This watcher adds notification and continuation; it does
not add Gitea Actions log-download tools or expand the console's GitHub PR panel.

# Code-host and Linear Decisions

> Status: Implemented for GitHub, GitLab and Gitea hooks, and Linear team conversations.
> Scope: Decision routing across the agents that watch a code-host repository (GitHub, GitLab,
> Gitea), and By decision on Linear. Builds on [decisions.md](decisions.md) (the reusable judgment, conditions, Jev adapter),
> [message-intake.md](message-intake.md) (record first, judge second, admit last; §6's evaluation
> host), and [webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md) (hook
> matching, authorization, delivery — unchanged here).
> Primary implementation areas: `packages/protocol`, `packages/control-plane`, `packages/relay`,
> `packages/daemon`, `packages/web`.

## 1. Summary

Several agents can watch one repository. Without a Decision every agent whose hook matches an
issue or pull request is triggered. **Decision routing** lets the organization pick which agents
take each new issue or PR from a typed judgment, the way a shared bot routes a new conversation
(decisions.md §3.2):

- One routing exists per organization, provider, repository, and subject family — `issues` and
  `pull_request` on GitHub, `issues` and `merge_request` on GitLab and Gitea, the names their hook
  rows store (`CODE_HOST_ROUTING_PROVIDER_FAMILIES`). It names a Decision, answer-to-agent rules, and **Otherwise** (every agent that
  would fire, or nobody).
- Each reached Decision is evaluated **once**, on one **evaluation host**, never once per agent. The host records
  it in its channel record, evaluates, and returns the selected hooks to the relay, which fires them
  through the ordinary hook path.
- **The Decision rules the scope.** Every event is judged, including later updates of the same
  issue or PR and events that @-mention an agent; when the Decision's target differs from the
  mentioned agent, the Decision's target takes the event.
- **The scope is the repository's own rows.** An installation-wide row, which covers every
  repository of a GitHub App installation, is not a candidate and is not held back: it fires on a
  routed scope as it would elsewhere
  ([webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md),
  Installation-Wide Rows).
- **A routed scope runs on every update.** While routing is enabled, the scope's rows ignore their
  own trigger mode (Opened, Any update, @-mention) and fire on any update; label filters still
  apply.

Linear gains By decision on its team conversations through the existing chat gate (§6).

## 2. Principles carried over

- **Evaluation stays on the data plane.** A daemon calls the model; the CP distributes
  configuration and proxies bounded evaluation reads; the relay forwards and fans out. Event
  content never enters CP storage.
- **A Decision never grants permission.** Candidates are exactly the hooks that pass the bot veto,
  installation gate, label filter, and maintainer authorization under the scope's Any update
  cadence (§4). The Decision only chooses among them.
- **One storage model.** The host records events in the channel record (`transcript`) and its
  verdicts in `decision_verdict`, as the shared-bot router does. No new daemon table exists.
- **Same failure policy as IM routing.** A provider failure keeps the eligible delivery on its
  default — here, every candidate, as without a Decision (decisions.md §3.3). Stale or
  unsynchronized configuration holds instead of firing unrouted.

## 3. Configuration

### 3.1 The routing

The CP stores a `code_host_decision_routing` row per `(orgId, provider, repoId, family)`; `repoId`
is the provider's numeric repository or project id, as its hook rows store it.
Its config has the shared-bot routing shape (`SharedBotDecisionRouting`): `enabled`, `decisionId`,
`rules[{ id, when, action: agent | skip | decision }]`, `otherwise: default_agent | skip`, and
optional `steps` for chained Decisions (decisions.md §10.7). A `decision` action names a
`nextStepId`; the referenced step has its own `decisionId` and rules. For code-host routing
`default_agent` means **every candidate**, including when a reached child has no matching rule.

```text
GET    /api/v1/decision-routing/:provider/:repoId/:family
PUT    /api/v1/decision-routing/:provider/:repoId/:family      { config }
DELETE /api/v1/decision-routing/:provider/:repoId/:family
```

The response carries the config (or `null`), its `status` (`enabled`, `needs_review`,
`access_revoked`), and the **members**: the agents with an enabled hook of that provider on that
repository and family, which are the only valid rule targets. Validation mirrors shared-bot routing: a visible,
supported Decision at every step; `decisionRoutingIssues` for the rules; all terminal targets must be members. A Decision edit
that makes the rules incompatible marks the routing `needs_review`, as it flags a shared bot's
routing; while it needs review, the routing holds its scope's events rather than firing them
unrouted. A Decision used by a routing appears in **Used by**, named by the repository path and its
provider's family label (`example-group/example-project · merge requests`), and cannot be deleted.
A pair a provider does not route (`github` with `merge_request`) is a 400.

### 3.2 The evaluation host

The CP picks one member as the **evaluation agent** — the placed member whose daemon was created
earliest, then the earliest-created agent — and recomputes it when membership or placement changes.
Every rule in the scope carries `RcHookAssign.routing = { routingId, decisionId, evaluationAgentId,
evaluationDaemonId }`, so every relay names the same host. The host agent's `AgentSpec.hookRoutings`
carries the scope's `HookRoutingProjection`: repository, family, config, every referenced Decision definition, and
the members' `(agentId, hookId)`. The relay receives only ids; question text does not travel to it.

### 3.3 Compatibility

Routing needs `hook-decision-routing-v1` on the relay and on the host daemon; a GitLab or Gitea
scope also needs `hook-decision-routing-v2`, because an older peer would fire its routed rules
unrouted or reject a non-GitHub projection.

- The CP sends a routed rule only to relays advertising the scope's feature; an older relay drops
  the scope's rules instead of firing them unrouted.
- The CP strips from an older daemon's spec the projections it cannot read, and does not choose it
  as host for those scopes.
- Chains additionally require `decision-chain-v1` on the host daemon. Host selection prefers a
  capable member; a connected older host receives no chained projection and holds the scope.
- A relay whose host is offline, too old, or does not answer within its timeout fires every
  candidate, with `unavailable` evidence — the provider-failure fallback.

## 4. Relay: candidates and the host copy

The CP compiles every rule of an enabled routing scope with its provider's **Any update** cadence —
on GitHub events `<family>:*` and `issue_comment:created`, on GitLab and Gitea `<family>:*`; comment
family `<family>`; `mentionOnly: false` — whatever trigger mode the hook row stores. Each provider's
cadence is a member of its CP code-host module (`codeHostProviders`), not a branch in core; the stored mode is kept and applies again when routing
is paused or removed. Label filters, the lifecycle-noise and bot vetoes, the installation gate, and
the maintainer check apply unchanged. A native App reviewer request is a candidate like any other.

The routing step is shared relay code (`hooks/code-host-routing.ts`): grouping candidates by scope,
the host copy, fan-out of the host's choice, the unavailable fallback, and record-only copies. Each
provider's ingress supplies only what differs: the event's thread family, the families a rule
covers, the host rule's repository fence, and whether an unmatched event may be recorded. For an
event, the ingress runs every rule's verdict and live maintainer check, and settles every
authorization before the scopes are routed. Rules without `routing` fire as today, including mention
narrowing. For each routing scope the event belongs to (its family: issues, or change requests
including their comments and reviews):

1. The **candidates** are the scope's rules that would fire. A targeted `@agent` mention does not
   narrow them: the mentioned agent's rule and every other routed rule stay candidates.
2. The relay sends **one** host copy: an `rd/msg` hook addressed to the evaluation agent's own rule
   in the scope, with `routing: { routingId, decisionId, candidates }`. It waits for the `rd/ack`
   with a routing timeout longer than the Decision deadline.
3. The ack's `hookRoute.targets` name the hooks to fire, each with a `HookRouteSelection`. The relay
   fires exactly those through the ordinary path (`dispatchHookFire`, run reports, retries), with
   `routeSelection` on each delivery. A non-selected candidate gets no run.

Thread events with no candidate — the filters rejected it, the maintainer check refused the actor,
a third-party PR is held — still reach the host as a
**record-only** copy (`candidates: []`), so the thread's history is complete, as an IM host sees
every message in its conversation. Bot-authored events are recorded too; they cannot fire. The
relay does not wait for a record-only ack and reports nothing for it. Thread cleanup, relay
notices, and check/workflow re-requests bypass routing.

`HookContext` gains `subject`, filled by every provider: the issue or change request's author login
and type (and GitHub's association), its state, draft flag, and body excerpt (≤ 4 KiB). GitLab and
Gitea drop noise events in their normalizers, so only normalized events can be recorded.

## 5. The host: record, choose, reply

For a host copy the daemon:

1. **Records** the event with `recordChannelInbound` at the host agent's own coordinates for the
   thread (`transcriptChannelKey(channel, transportScope)`, `ts = transcriptTs`). If the relay later
   fires the host agent's own hook for the same delivery, its session write lands on the same row.
   A record-only copy stops here.
2. **Resolves** the routing from `hookRoutings`. A missing projection or a different `decisionId`
   answers `accepted: false` (pending sync) and the relay fires nothing.
3. **Chooses** by evaluating each reached Decision once against the same thread state (§5.1),
   within one five-second deadline — for every
   event, whether or not it mentions an agent or an earlier event of the thread selected someone —
   matched against every rule with the shared-bot matcher: all matching rules' agents among the candidates, reason
   `decision`. A matching **Do not activate** rule contributes no agent and is not a veto; when
   every match is a skip, nobody is selected. At each reached step, when **no** rule matches Otherwise applies:
   every candidate (reason `otherwise`) or nobody. `unavailable` → every candidate, reason
   `unavailable`.
   Matched child branches contribute their terminal agents to the same deduplicated set.
   A chain edited during evaluation cancels that verdict; a redelivery uses the saved disposition.
4. **Persists** the verdict in `decision_verdict` with subject `hook-router:<routingId>`,
   `integrationId = routingId`, the frozen input and answer, and the selected targets in
   `targetsJson` and reached-step answers in `answerJson`; the host's choice is final once written, and a redelivery of the same host copy
   returns it without evaluating again.
5. **Replies** `rd/ack` with `hookRoute.targets`.

Each event of a thread is judged on its own, so a later update may go to different agents than an
earlier one; the thread's history (§5.1) is how the Decision sees what came before. A selected agent receives the event as
an ordinary hook fire whose prompt carries the selection as evidence; because skipped and
record-only events sit in the host's channel record, the host agent's first turn in the thread also
gets them through gap replay, and every agent can read the thread from GitHub.

### 5.1 The state Jev sees

The code-host state keeps the chat field names, so a question written against `currentMessage` and
`history` reads the same. Routing, session runtime selection and repository selection use the same
loader and pure builder (`daemon/src/codehost/decision-state.ts`). Each provider's hook normalizer
supplies the subject identity; its existing repository grant supplies optional PR/MR context:

```jsonc
{
  "source": "github", // github | gitlab | gitea
  "event": { "name": "issue_comment", "action": "created" },
  "repository": { "fullName": "example-org/example-repo" },
  "subject": {
    "kind": "issue", // issue | pull_request | merge_request
    "number": 42,
    "title": "…",
    "url": "https://github.com/example-org/example-repo/issues/42",
    "author": { "login": "…", "type": "User", "association": "FIRST_TIME_CONTRIBUTOR" },
    "labels": ["bug"],
    "state": "open",
    "draft": false,
    "body": "…"
  },
  "currentMessage": { "id": "…", "sender": { "id": "…", "association": "NONE" }, "text": "…" },
  "history": [{ "id": "…", "sender": { "id": "…" }, "text": "…", "time": "…" }],
  "context": {
    "partial": true,
    "reasons": ["observed_history"],
    "omittedMessages": 0,
    "snapshotSequence": 123,
    "tokenCount": "estimate"
  }
}
```

`currentMessage` is the triggering comment, review text, or normalized lifecycle event summary.
`subject.body` is the issue/PR/MR description, capped at an 8 KiB UTF-8 prefix. The assembled agent
prompt is never used. `history` contains the same thread's observed rows strictly before the
trigger's sequence, including skipped and record-only events: newest 100, presented oldest first,
with each history text capped at 16 KiB. Issues omit `pullRequest`.

PR/MR states add `pullRequest: { baseSha?, headSha?, commitMessages, diff }`. The optional API read
has one 1.5-second budget including credentials. It reads metadata, then one page of at most 10
commits and a 12 KiB diff prefix concurrently, then metadata again. Both revision reads must agree;
a known webhook head/base must agree too. GitLab's current MR head must also match its generated
diff head. A changed or unverifiable revision omits the commits and
diff with `revision_changed`, `revision_mismatch`, or `revision_unverified`. A failed read retains
the webhook and observed history with `pull_request_unavailable`. The webhook description takes
precedence over the API description. No checkout, retries or pagination are involved.

Commit messages contribute at most 4 KiB. The code-host builder supplies its ordered optional text
fields to the shared request fitter, which measures the actual serialized question, model and
state, including JSON escaping, against both 8,000 estimated tokens at four
bytes each (32,000 bytes) and the 32 KiB hard limit. It drops oldest history, then shortens diff,
commit messages and subject body in that order. It preserves the trigger and required identity;
an input that still cannot fit is `unsupported_input`, handled by each consumer's fallback policy.
`context.reasons` records missing and trimmed data; `omittedMessages` counts budget-dropped rows
within the observed window. Chains budget against their largest request envelope and keep one
state for all steps. Repository selection adds `workspace` before refitting with the same code-host
trim rules. A routing deadline reached during context collection is recorded as `timeout`.

History begins when routing was enabled and has gaps while the host was offline; a new host on a
separate SQLite store starts with partial history. GitLab and Gitea record a thread under the host
agent's hook, so a host change also starts that scope's history afresh. `observed_history` marks
these windows partial; comments outside the observed window are not fetched from the provider.
The runtime and repository selectors reuse one collected snapshot per session birth, while a
routing host can have a different observation window. Both call the code-host context reader
directly, using the same provider host dependencies as review orchestration. The bounded ingress
envelope is retained in the daemon's durable inbox for restart replay; it is not sent to the Control Plane.

## 6. Linear

Linear is a chat platform module whose team conversation compiles to the owner-as-default rung
(`ownerAsDefault`). The CP compile skipped every channel-scoped route there and muted By decision
rows, so the console refused By decision. The fixed-target gate now works on Linear team
conversations; shared-bot routing stays refused.

- **Compile.** A Linear team channel set to **By decision** compiles the owner's scoped `decision`
  route and is no longer muted. Mention rows keep their `conversationDefaults` entry.
- **Arbitration.** On an `ownerAsDefault` assignment the relay places that decision route in the
  team's default slot — below keyword selection and session continuity — rather than first, and
  does not add the owner as an extra recipient. A session another agent holds keeps its single
  writer, and the relay still reports which agent owns the session, so a stop reaches it. The
  relay attaches `decisionId` to every delivery in the team.
- **Judge.** The daemon's existing gate evaluates the delivery against the team's channel record;
  nothing in the daemon is Linear-specific. A follow-up prompt in a session already admitted is
  continuity, not a new address, and is admitted without evaluation.
- **Skip.** A skip starts nothing and emits no Linear activity: the ≤ 10 s acknowledgement is
  posted only after admission. Linear then shows the session as unresponsive, which is the accepted
  consequence of "skipped means no response". The 5 s evaluation deadline keeps an admitted
  session's acknowledgement inside Linear's window in the ordinary case.
- **Failure.** A provider failure activates as usual.
- **Compatibility.** The new arbitration needs a relay advertising the owner-default decision
  feature; for an older relay the CP strips the team's decision route and mutes it, and the
  console reports the gate as unsupported.

## 7. Operational visibility

- **Recent evaluations** for a routing read the host's verdict rows through
  `GET /api/v1/decision-routing/:provider/:repoId/:family/evaluations[/:seq]`. The CP forwards
  `decision/evaluations` and `decision/evaluation` to the host daemon with `source: 'hook_routing'`
  and `integrationId = channel = routingId`.
- The console's issue and pull-request rows carry the routing entry: a Decision chip (empty, or
  naming the Decision) opening the rules modal — Decision picker, answer-to-agent table,
  branch continuation, Otherwise — with the scope's members as targets. While a scope is routed,
  the row's trigger modes are locked and it
  reads **Any update**, because the Decision judges every update.
- A selected fire's run appears in the hook's run history as usual; a non-selected candidate has no
  run.

## 8. Not in this version

- Fetching thread history from the provider API.
- Cross-daemon forwarding from the host: the relay fans out the host's choice, so hook delivery keeps
  its existing in-memory durability.
- Selected targets in Recent evaluations: the evaluation record shape carries the reason but not
  the target list, which stays in the host's verdict row.

## 9. Testing

- Protocol: the new optional fields round-trip, and older shapes still decode.
- CP: routing validation and members, `needs_review` after a Decision edit, delete protection, host
  choice and recomputation, relay and daemon feature fences, the evaluation routes' access checks.
- CP: the Any update cadence on routed rules and the stored mode after pausing.
- Relay: candidates unnarrowed by a mention, one host copy per scope, fan-out of exactly the selected
  hooks, record-only copies and their eligibility, the host-unavailable fallback, the feature fence.
- Daemon: record-only recording; a mentioned event judged like any other; each event of a thread
  judged again; Otherwise and
  `unavailable`; a redelivered host copy returning the stored choice; the state builder; the
  evaluation reader's scoping.
- Web: the routing entry and modal against the API, the trigger lock, and Recent evaluations.

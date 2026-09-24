# Code-host and Linear Decisions

> Status: Implemented for GitHub hooks and Linear team conversations.
> Scope: Decision routing across the agents that watch a GitHub repository, and By decision on
> Linear. Builds on [decisions.md](decisions.md) (the reusable judgment, conditions, Jev adapter),
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

- One routing exists per organization, repository, and subject family (`issues`,
  `pull_request`). It names a Decision, answer-to-agent rules, and **Otherwise** (every agent that
  would fire, or nobody).
- An event is judged **once**, on one **evaluation host**, never once per agent. The host records
  it in its channel record, evaluates, and returns the selected hooks to the relay, which fires them
  through the ordinary hook path.
- The chosen agents keep the thread: later events of the same issue or PR go to them without
  another evaluation. A targeted @-mention names its agent directly and skips the Decision.

Linear gains By decision on its team conversations through the existing chat gate (§6).

## 2. Principles carried over

- **Evaluation stays on the data plane.** A daemon calls the model; the CP distributes
  configuration and proxies bounded evaluation reads; the relay forwards and fans out. Event
  content never enters CP storage.
- **A Decision never grants permission.** Candidates are exactly the hooks the relay's existing
  filters, bot veto, installation gate, and maintainer authorization would fire. Routing only
  narrows that set.
- **One storage model.** The host records events in the channel record (`transcript`) and its
  verdicts in `decision_verdict`, as the shared-bot router does. No new daemon table exists.
- **Same failure policy as IM routing.** A provider failure keeps the eligible delivery on its
  default — here, every candidate, as without a Decision (decisions.md §3.3). Stale or
  unsynchronized configuration holds instead of firing unrouted.

## 3. Configuration

### 3.1 The routing

The CP stores a `code_host_decision_routing` row per `(orgId, provider = github, repoId, family)`.
Its config has the shared-bot routing shape (`SharedBotDecisionRouting`): `enabled`, `decisionId`,
`rules[{ id, when, action: agent | skip }]`, and `otherwise: default_agent | skip`. For code-host
routing `default_agent` means **every candidate**.

```text
GET    /api/v1/decision-routing/github/:repoId/:family
PUT    /api/v1/decision-routing/github/:repoId/:family      { config }
DELETE /api/v1/decision-routing/github/:repoId/:family
```

The response carries the config (or `null`), its `status` (`enabled`, `needs_review`,
`access_revoked`), and the **members**: the agents with an enabled GitHub hook on that repository
and family, which are the only valid rule targets. Validation mirrors shared-bot routing: a visible,
supported Decision; `decisionRoutingIssues` for the rules; targets must be members. A Decision edit
that makes the rules incompatible marks the routing `needs_review`, as it flags a shared bot's
routing; while it needs review, the routing holds its scope's events rather than firing them
unrouted. A Decision used by a routing appears in **Used by** and cannot be deleted.

### 3.2 The evaluation host

The CP picks one member as the **evaluation agent** — the placed member whose daemon was created
earliest, then the earliest-created agent — and recomputes it when membership or placement changes.
Every rule in the scope carries `RcHookAssign.routing = { routingId, decisionId, evaluationAgentId,
evaluationDaemonId }`, so every relay names the same host. The host agent's `AgentSpec.hookRoutings`
carries the scope's `HookRoutingProjection`: repository, family, config, Decision definition, and
the members' `(agentId, hookId)`. The relay receives only ids; question text does not travel to it.

### 3.3 Compatibility

Routing needs `hook-decision-routing-v1` on the relay and on the host daemon.

- The CP sends a routed rule only to relays advertising the feature; an older relay drops the
  scope's rules instead of firing them unrouted.
- The CP strips `hookRoutings` from an older daemon's spec and does not choose it as host.
- A relay whose host is offline, too old, or does not answer within its timeout fires every
  candidate, with `unavailable` evidence — the provider-failure fallback.

## 4. Relay: candidates and the host copy

For a GitHub event on a repository, the relay runs every rule's existing verdict, mention narrowing,
and live maintainer check unchanged. Rules without `routing` fire as today. For each routing scope
the event belongs to (its family: issues, or pull requests including their comments and reviews):

1. The **candidates** are the scope's rules that would fire. A candidate kept by a targeted
   `@agent` mention is marked `via: mention`.
2. The relay sends **one** host copy: an `rd/msg` hook addressed to the evaluation agent's own rule
   in the scope, with `routing: { routingId, decisionId, candidates }`. It waits for the `rd/ack`
   with a routing timeout longer than the Decision deadline.
3. The ack's `hookRoute.targets` name the hooks to fire, each with a `HookRouteSelection`. The relay
   fires exactly those through the ordinary path (`dispatchHookFire`, run reports, retries), with
   `routeSelection` on each delivery. A non-selected candidate gets no run.

Thread events with no candidate — the filters rejected it, a mention excluded the rule, the
maintainer check refused the actor, a third-party PR is held — still reach the host as a
**record-only** copy (`candidates: []`), so the thread's history is complete, as an IM host sees
every message in its conversation. Bot-authored events are recorded too; they cannot fire. The
relay does not wait for a record-only ack and reports nothing for it. Thread cleanup, relay
notices, and check/workflow re-requests bypass routing.

`HookContext` gains `subject`: the issue/PR author login, type and association, its state, draft
flag, and body excerpt (≤ 4 KiB).

## 5. The host: record, choose, reply

For a host copy the daemon:

1. **Records** the event with `recordChannelInbound` at the host agent's own coordinates for the
   thread (`transcriptChannelKey(channel, transportScope)`, `ts = transcriptTs`). If the relay later
   fires the host agent's own hook for the same delivery, its session write lands on the same row.
   A record-only copy stops here.
2. **Resolves** the routing from `hookRoutings`. A missing projection or a different `decisionId`
   answers `accepted: false` (pending sync) and the relay fires nothing.
3. **Chooses**, in order:
   - candidates `via: mention` → exactly those, reason `mention`, no evaluation;
   - earlier verdicts of this routing for this thread selected agents → every agent they selected,
     among the candidates, reason `thread`, no evaluation (possibly none this time);
   - otherwise **one** evaluation of the Decision against the thread state (§5.1), matched against
     every rule with the shared-bot matcher: all matching rules' agents among the candidates, reason
     `decision`. A matching **Do not activate** rule contributes no agent and is not a veto; when
     every match is a skip, nobody is selected. Only when **no** rule matches does Otherwise apply:
     every candidate (reason `otherwise`) or nobody. `unavailable` → every candidate, reason
     `unavailable`.
4. **Persists** the verdict in `decision_verdict` with subject `hook-router:<routingId>`,
   `integrationId = routingId`, the frozen input and answer, and the selected targets in
   `targetsJson`; the host's choice is final once written, and a redelivery of the same host copy
   returns it without evaluating again.
5. **Replies** `rd/ack` with `hookRoute.targets`.

A thread whose evaluation selected nobody has no owner yet, so its next event is evaluated again.
Once a verdict selects agents, the thread stays with them. A selected agent receives the event as
an ordinary hook fire whose prompt carries the selection as evidence; because skipped and
record-only events sit in the host's channel record, the host agent's first turn in the thread also
gets them through gap replay, and every agent can read the thread from GitHub.

### 5.1 The state Jev sees

The code-host state keeps the chat field names, so a question written against `currentMessage` and
`history` reads the same:

```jsonc
{
  "source": "github",
  "event": { "name": "issue_comment", "action": "created" },
  "repository": { "fullName": "example-org/example-repo" },
  "subject": {
    "kind": "issue", // issue | pull_request
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
  "context": { "partial": false, "reasons": [], "omittedMessages": 0 }
}
```

`history` is the same thread's earlier channel-record rows (`thread` equal to the issue/PR
number), newest 100, oldest first. The budget is the chat gate's (8,000 estimated tokens, 32 KiB
serialized); trimming drops the oldest history first, then shortens the subject body, and never
cuts the current message. `context.reasons` names each trim (`history_limit`, `budget_trimmed`,
`subject_body_trimmed`).

History begins when routing was enabled and has gaps while the host was offline; a new host on a
separate SQLite store starts with partial history and no thread choices, so a thread's next event is
evaluated again. Comments older than the routing are not fetched from the GitHub API.

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
  `GET /api/v1/decision-routing/github/:repoId/:family/evaluations[/:seq]`. The CP forwards
  `decision/evaluations` and `decision/evaluation` to the host daemon with `source: 'hook_routing'`
  and `integrationId = channel = routingId`.
- The console's issue and pull-request rows carry the routing entry: a Decision pill (or
  `+ Decision`) opening the rules modal — Decision picker, answer-to-agent table, Otherwise — with
  the scope's members as targets. While a scope is routed, the row's **@-mention** trigger mode is
  unavailable, because a mention picks its agent directly.
- A selected fire's run appears in the hook's run history as usual; a non-selected candidate has no
  run.

## 8. Not in this version

- GitLab and Gitea hooks. The relay candidate step and the daemon state builder are per-provider;
  they will be extracted into the code-host seam when a second provider implements them.
- Fetching thread history from the provider API.
- Cross-daemon forwarding from the host: the relay fans out the host's choice, so hook delivery keeps
  its existing in-memory durability.
- Selected targets in Recent evaluations: the evaluation record shape carries the reason but not
  the target list, which stays in the host's verdict row.

## 9. Testing

- Protocol: the new optional fields round-trip, and older shapes still decode.
- CP: routing validation and members, `needs_review` after a Decision edit, delete protection, host
  choice and recomputation, relay and daemon feature fences, the evaluation routes' access checks.
- Relay: candidates and mention marking, one host copy per scope, fan-out of exactly the selected
  hooks, record-only copies and their eligibility, the host-unavailable fallback, the feature fence.
- Daemon: record-only recording; mention, thread and decision choices; Otherwise and
  `unavailable`; a redelivered host copy returning the stored choice; the state builder; the
  evaluation reader's scoping.
- Web: the routing entry and modal against the API, the mention lock, and Recent evaluations.

# `sendMessage` Actions and On-Demand Tool Guide — Proposal

**Status:** Proposed

Keep one agent-facing `sendMessage` tool, add a required `action` discriminator,
and move detailed argument documentation into an on-demand `getToolGuide` tool. Existing
delivery argument names and semantics remain, except that background self-calls use
`messageSubsession` without `sessionId` for creation. A supplied id targets an
existing direct child and requires ownership validation. Calls without `action` are rejected
before any delivery, with instructions to read the guide and retry. This is an
intentional input-contract change, not transparent backward compatibility.

The proposal also includes an explicit capability extension (§8): parents can
message their own persistent sub-sessions, and sub-sessions can message their
parent throughout their lifetime. That extension is new runtime work, separate
from the behavior-preserving action adapter audited in §7. Section 9 adds explicit
peer-session targeting and multiple authorized origin sessions; it replaces the
baseline single-effective-origin reply restriction without changing sub-session
parent ownership.

Baseline routing rules are defined by [`send-message-routing-rework.md`](send-message-routing-rework.md).

## 1. Problem

The original tool-payload measurement for an agent with Slack and Telegram
integrations is:

| Item                              | Characters |
| --------------------------------- | ---------- |
| `sendMessage` description         | 4363       |
| `sendMessage` input schema (JSON) | 9484       |

The binding constraint is Codex: OpenAI-hosted function tools are reported to
limit a description to 1024 characters. Codex sessions still run with the current
4363-character description, so the limit is not a hard request failure there. Whether
the description is truncated or the whole tool is silently dropped is unconfirmed;
the baseline probe in §10 settles it.

The current tool carries agent calls, origin-session replies, and platform posts behind
one top-level `oneOf`. Shortening its description alone does not remove the large
schema or the top-level union. An explicit action makes the intended operation
visible while retaining one tool name and the existing delivery arguments.

## 2. Goals and non-goals

Goals:

1. Keep the `sendMessage` name and existing delivery argument names and types;
   derive a new child's identity from trusted context and validate any supplied child id.
2. Require an explicit action, validated before any delivery or other effect.
3. Use a flat object schema without a top-level `oneOf` or `anyOf`.
4. Keep the tool description within 1024 characters and expose detailed usage
   through `getToolGuide`, including runnable argument examples with `action`.
5. Make old calls fail with actionable migration instructions rather than execute
   with inferred intent.
6. Use `messageSubsession` to create or continue a direct child, and
   `replyToSession` to return messages to its parent, including across work rounds (§8).
7. Allow an authorized caller to address an existing peer session and let that
   session reply separately to any of its admitted origins (§9).

Non-goals:

- Changing the place write rule or Slack join handling. Preserve existing routing
  except the explicit sub-session and multi-origin extensions in §8–§9.
- Changing peer `needsReply` defaults. Section 9 scopes reply obligations to each
  admitted call; sub-session completion/failure reporting is extended per round in §8.
- Adding arbitrary session messaging, steering another agent's unrelated sessions,
  or a new cancellation tool.
- Renaming `toAgent` or introducing duplicate aliases for existing fields.

## 3. Design

### 3.1 Actions

| `action`            | Purpose                                                                    | Required target       | Optional arguments                                                                    |
| ------------------- | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `callAgent`         | Call a peer, optionally in an existing session, or yourself with `channel` | `toAgent`             | `channel` or `sessionId` (mutually exclusive)                                         |
| `messageSubsession` | Create a background child or send to your existing direct child            | None when creating    | `sessionId` to continue an existing child                                             |
| `replyToSession`    | Reply to a chosen authorized origin; a sub-session replies to its parent   | `sessionId`           | None                                                                                  |
| `postMessage`       | Post to a person, channel, or another existing thread                      | `toUser` or `channel` | `thread`, `attachment`, `platform`, `integrationId`, subject to existing branch rules |

Every action also requires `message`. `callAgent` does not promise a fresh session:
existing routing may reuse the target's conversational context. Without `channel`,
`callAgent` accepts only a peer and is postless. With `channel`, a peer or self target
uses the existing platform-dependent post-and-wake behavior. A peer call with an
explicit `sessionId` instead targets that existing peer session without a new root
post; `channel` and `sessionId` are mutually exclusive. It must resolve to the
agent named by `toAgent`, pass existing agent-call policy and the session-admission
rule in §9, and must not create a replacement if lookup/admission fails.

A visible self-call is not a background sub-session: for example, an agent may
post a task into another project channel and start working as itself in that
conversation, where people can follow and respond. `messageSubsession` instead
keeps work headless and returns results to its parent. A plain `postMessage` can
seed idle context but does not explicitly activate a model turn. Preserve all
three existing distinctions; the `callAgent` guide must include a visible-self
example rather than imply that every self-call creates background work.

`messageSubsession` requires `action` and `message`, with optional `sessionId`.
Omit `sessionId` to create a new background child using trusted caller identity.
Supply a nonempty `sessionId` to send into an existing child: the daemon must
verify that it is a direct sub-session of the current caller session. A missing,
invalid, unrelated, or unavailable target never falls back to creation. A supplied
null or empty id is invalid, not an instruction to create.

It accepts no `toAgent`, `channel`, `platform`, `integrationId`, or `needsReply`.
Sub-session work reports completion or failure automatically; one-level nesting
restrictions and active per-agent concurrency limits still apply. Every admitted
child input carries the parent as its trusted origin, so the child uses
`replyToSession` for progress, questions, and results. Message delivery alone must
not mark the child's work complete; §8 specifies that lifecycle extension.

A postless `callAgent` targeting the caller is rejected before effects, with a
pointer to `getToolGuide {"tool":"sendMessage","action":"messageSubsession"}`.
Do not silently reinterpret it or keep a second spelling for a background self-call.

`replyToSession` takes a required `sessionId` selecting one authorized origin.
In §9's multi-origin model, a session can retain more than one admitted source:
C calling an existing B session must not remove B's authority to reply to A.
Replies are point-to-point, not an automatic broadcast to all origins. The old
single effective origin remains part of the audited baseline (§7), not the final
authorization limit of this proposal. Existing reciprocal reply paths are retained
through recorded source relations, without granting arbitrary session access.

For an indexed background sub-session, its parent is its origin. Creation,
continuation, and recovery must keep that parent origin consistent in trusted
metadata and standing guidance. The child calls `replyToSession` with the parent's
outward id; no separate parent-message action is needed. A continuation must not
reparent the child to another session or rely on the parent's current origin.
The new parent-to-child authority belongs to `messageSubsession` and is checked
against the persistent direct-child relationship (§8).

`callAgent` accepts no `platform` or `integrationId`: its platform and caller
identity come from trusted context. `postMessage` supports those selectors. Its
handler does not call the explicit agent-wake path, but existing platform ingress
routing remains intact; an existing-thread update can reach agents already in that
thread. Posts can seed or reuse the author's idle context, including for updates,
and do not invariably create a fresh conversation.

Except for the explicitly added `callAgent.sessionId` form (§9), existing combinations remain strict: for example, `thread` belongs only to a
bare-channel post, a `toUser` array requires `channel`, and `attachment` is not
accepted for an agent call. `action` selects the operation; it does not relax its
argument rules or grant authority.

### 3.2 Description and flat schema

Draft description:

```text
Send outside your current conversation. Required action: callAgent to ask a peer to
work (sessionId continues an existing peer session; channel starts visible work); messageSubsession to send work to your own
background child (omit sessionId to create one; provide it to continue your direct
child, including after completion); replyToSession to select one authorized origin
by sessionId. Peer sessions can have multiple origins; replies are not broadcast.
A sub-session's origin is its parent. Background work reports completion or failure
automatically. postMessage reaches a person, channel, or another existing thread.
For your current conversation, write your ordinary reply. When requesting a peer's
result or completion notice, use toAgent: {agentId: "...", needsReply: true}.
Call getToolGuide {"tool":"sendMessage"} for arguments and examples. Calls without
action fail without sending anything.
```

The input schema is a single object, with `action` and `message` required.
`sessionId` is required for `replyToSession` and optional for `callAgent` / `messageSubsession`:

| Field           | Type                                                                    | Meaning                                                                                                                      |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `action`        | enum: `callAgent`, `messageSubsession`, `replyToSession`, `postMessage` | Operation to perform; required                                                                                               |
| `message`       | string                                                                  | Message body in Markdown; required                                                                                           |
| `toAgent`       | string or `{agentId, needsReply}`                                       | AgentConnect agent to call; `callAgent` only                                                                                 |
| `toUser`        | string or string array                                                  | Human platform member id(s)                                                                                                  |
| `channel`       | string                                                                  | Destination channel or chat                                                                                                  |
| `thread`        | string                                                                  | Existing thread root, for a bare-channel `postMessage` only                                                                  |
| `sessionId`     | string                                                                  | Existing peer session for `callAgent`; origin outward id for `replyToSession`; optional child handle for `messageSubsession` |
| `attachment`    | string                                                                  | Received image name from an `[attached: …]` marker                                                                           |
| `platform`      | enum of the agent's platforms                                           | Target platform                                                                                                              |
| `integrationId` | string                                                                  | Bot selection when multiple integrations apply                                                                               |

Preserve existing accepted field types for existing forms; the new optional child
`sessionId` has the explicit omitted-versus-nonempty rule above. Apply the same
no-fallback rule to an explicitly supplied peer-session id. Retain compatibility string values
for nested `toAgent.needsReply`. Do not add a top-level `needsReply` alias. The
remaining field-level unions are not top-level operation unions.

The complete proposal has four actions. Keep them and the `sessionId` field
discoverable rather than hiding origin replies based on a stale parent snapshot.
Today's `toolsForIntegrations` descriptor is built from integrations, not fresh
per-turn authority. `getToolGuide` may tailor availability notes from trusted
current context; runtime authorization remains authoritative. Publish each new capability only when its runtime contract is implemented: both
forms of `messageSubsession` (§8), and explicit peer targeting with multi-origin
replies (§9). Do not advertise a target field that the daemon will silently ignore.

Keep messaging and its guide available without IM integrations: postless agent
calls, background sub-sessions, and authorized origin replies need no platform
posting connection. Retain existing runtime-specific and read-only patrol tool
gates. Any later conditional injection needs proof that resumed sessions and
changing turn origins cannot lose a valid operation.

### 3.3 Validation and dispatch

Validate the action and its argument combination before platform sends, agent
wakes, session replies, approvals, joins, or session initialization:

1. Reject a missing, unknown, or incorrectly typed `action`.
2. Select the action's validator and reject conflicting or unexpected fields.
3. Validate existing target constraints and authorization.
4. Delegate to the existing messaging implementation with the validated payload.

Place action/shape validation before `resolveChannelArg` in the tool execution
pipeline; that helper can consult a gateway before the current handler runs. The
missing-action recovery path must perform no target lookup or delivery. Keep
existing stopped-turn and read-only patrol restrictions ahead of execution.

Never infer a missing action, silently choose another action based on the target,
or discard conflicting target fields. The action is a checked contract, not an
annotation. An adapter may remove the already-validated `action` before passing
arguments to the existing strict branch parser; it must preserve all other
validation and the existing write/join wrappers. For `messageSubsession` without
`sessionId`, construct the internal self-call from trusted caller identity and
`message`. With `sessionId`, validate direct-child ownership and admit into that
existing session instead of invoking the old origin-reply branch. Normalize and
select the correct handler before downstream routing and write/join classification.

Preserve the actual `isPlatformPost` predicate: it excludes both `toAgent` and
`sessionId`, even when an agent call contains `channel`. Thus `postMessage` keeps
the place-write/draft rule and join wrapper; `callAgent` with `channel` keeps its
existing reach check and agent policy, without being newly routed through the
ordinary-post draft/join path. Both forms of `messageSubsession` are session-only
paths, even though their public arguments omit `toAgent` and may contain `sessionId`.
Do not delegate them blindly to the old target inference or platform-post classifier.
Likewise, `callAgent` with `sessionId` is an explicit peer call, not the old
`sessionId` origin-reply branch. Action dispatch must precede legacy target inference.

The daemon validates `action` even when a caller bypasses the advertised schema.
A harness may reject a missing required property before reaching the daemon; its
error wording is outside the daemon's control. The advertised description and
`getToolGuide` discovery must therefore also explain the new contract.

### 3.4 `getToolGuide`

```text
getToolGuide { tool: "sendMessage", action?: "callAgent" | "messageSubsession" | "replyToSession" | "postMessage" }
```

Without `action`, return the available operations, their required arguments, and
one minimal example each, sufficient to make a common call without a second guide
lookup. With `action`, return that operation's complete argument rules, examples,
and relevant platform/session restrictions. Every example includes `action`.

The agent-call guide covers postless peers and visible channel calls. The
sub-session guide covers background self-work, automatic reporting, nesting
restrictions, concurrency limits, and both directions of persistent messaging
when §8 is available. The posting guide covers DMs, human mentions,
channel roots, thread updates, and image forwarding. Keep platform capabilities and session availability
consistent with the descriptor and authoritative runtime rules.

Example delegation:

```json
{
  "action": "callAgent",
  "toAgent": { "agentId": "<agent-id>", "needsReply": true },
  "message": "Review this change and report your findings."
}
```

Example visible work by the same agent in a channel (not a background child):

```json
{
  "action": "callAgent",
  "toAgent": "<own-agent-id>",
  "channel": "<project-channel-id>",
  "message": "Investigate this project's failing build here and discuss the findings in this conversation."
}
```

Example creating a background child (no `sessionId`):

```json
{
  "action": "messageSubsession",
  "message": "Investigate the flaky test in the background and report your findings."
}
```

Example additional instructions to a child, running or previously completed:

```json
{
  "action": "messageSubsession",
  "sessionId": "<childSessionId returned by messageSubsession>",
  "message": "Continue with the Windows failure and keep your earlier findings."
}
```

Example child progress update or question:

```json
{
  "action": "replyToSession",
  "sessionId": "<parent origin outward id>",
  "message": "The failure is isolated. Should the repair preserve the old configuration format?"
}
```

Example result sent to the authorized origin:

```json
{
  "action": "replyToSession",
  "sessionId": "<authorized-origin-outward-id>",
  "message": "Review complete: two issues found."
}
```

Example platform post:

```json
{
  "action": "postMessage",
  "channel": "<channel-id>",
  "message": "The review is complete."
}
```

Delegation examples request feedback explicitly. The guide also explains that a
bare agent id requests no feedback obligation on that call; it does not prohibit an
authorized explicit reply or clear a previously persisted reporting obligation.
Background sub-sessions retain automatic outcome reporting, with the round-aware
changes in §8. The baseline `needsReply` inference already exists: a clean delegated turn with an outstanding obligation can
have its ordinary final output forwarded, or an explicit no-result notice sent;
an already reported/failed obligation and live background work suppress inference.
This mechanism exists today and is not a future benefit of either proposal.

Standing and turn-scoped instructions must name the authorized origin and exact
`replyToSession` call. For background children this is their parent, consistently
across creation, continuation, and recovery. Peer-session guidance names the admitted source of each input and the available
origin reply addresses, rather than claiming that the latest caller is the only one. Optional guide reading cannot replace these instructions.

The guide distinguishes handles: `childSessionId` in the creation receipt contains
a session key; `messageSubsession` accepts that returned handle through the child
index. `replyToSession` accepts the authorized origin's outward id. Do not teach
agents to reconstruct ids or copy a child handle into an origin reply. Sending a
child reply is messaging, not a signal to close its work round (§8).

Use a tool rather than an MCP resource so the guide is accessible through the
same tool channel as messaging. `tool` is an enum of documented tools; initially
only `sendMessage`. The name `getToolGuide` identifies a read operation returning
usage instructions, examples, and rules, rather than only a machine-readable schema.
Other tools can use the same guide entry point later.

### 3.5 Errors direct the agent to the tool guide

A missing action produces a tool argument failure, surfaced through the existing
MCP `isError` path, rather than a successful result with a migration notice:

```text
sendMessage: missing required argument `action`. Nothing was sent and no agent was woken.
Use an action listed by getToolGuide for this daemon. The complete tool supports callAgent,
messageSubsession, replyToSession, and postMessage.
Call getToolGuide {"tool":"sendMessage"} to get the arguments and examples, then retry
sendMessage with the appropriate action.
```

Invalid actions also direct the caller to the overview. For a recognized action
with invalid arguments, identify the conflicting or missing fields and point to
its guide, for example:

```text
sendMessage: action `replyToSession` requires `sessionId` and does not accept `toAgent`.
Nothing was sent. Call getToolGuide {"tool":"sendMessage","action":"replyToSession"}
for the required arguments, then retry with a valid action and target.
```

Extend the existing self-correcting argument-error path from #2084. Errors include
argument names, not message bodies or other supplied values. Do not guess which
action the model meant when arguments conflict. Reading the guide is the instructed
recovery path, not a server-enforced prerequisite for later valid calls.

The no-effect statement applies only to argument rejection before execution.
Preserve existing partial-delivery and uncertain-delivery results after execution
begins; never encourage an unconditional retry of a message that may have landed.
Existing delivery receipts keep their shapes and semantics. In particular, an
agent-call result can be `{ok: true, wake: {delivered: false, ...}}`; `ok` alone is
not proof of delivery. Origin replies return `{delivered, targetSession?, reason?}`
directly, without an `ok` wrapper. Preserve draft receipts and partial/uncertain
post outcomes. See the baseline comparison in §7 and continuation receipts in §8.

## 4. Migration

| Existing usage                                              | New behavior                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Peer calls or self-calls with `channel`                     | Rejected without effects; read guide and add `action: "callAgent"`                  |
| Self-call without `channel`                                 | Rejected without effects; use `action: "messageSubsession"` with `message` only     |
| `sendMessage {sessionId, ...}`                              | Rejected without effects; read guide and add `action: "replyToSession"`             |
| `sendMessage {toUser, ...}` or `{channel, ...}`             | Rejected without effects; read guide and add `action: "postMessage"`                |
| Agent descriptions, knowledge, and skills with old examples | Need updates; old model-generated calls receive migration guidance                  |
| Standing context and built-in examples                      | Updated in the same release, including origin-reply and parent-reporting directives |
| Scripted callers and evaluation harnesses                   | Updated before rollout; they cannot be assumed to read an error and self-correct    |
| Warm sessions with cached tool schemas                      | Require runtime-specific verification of guide discovery and schema refresh/reload  |

There is no silent legacy execution path or optional-action transition period.
Release notes must describe the required-field change for self-hosted deployments.
Retaining argument names makes migration smaller but does not make old calls valid.
Background self-call examples must also remove the explicit `toAgent` and any
feedback flag, since `messageSubsession` derives identity and reports automatically.

## 5. Size budget and validation

| Item                                | Target                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `sendMessage` description           | ≤ 1024 characters                                            |
| `sendMessage` schema                | Measure a flat-schema prototype, including required `action` |
| `getToolGuide` description + schema | ≤ 600 characters                                             |
| Top-level `oneOf` / `anyOf`         | None                                                         |

The earlier approximately 2.2k combined estimate omitted the guide tool's payload.
Measure the full descriptor set rather than claim that number for this revision.
Guide responses enter conversation context too; total token cost and latency must
include guide calls, recovery attempts, and later turns, not just initial schemas.

Acceptance checks:

- Missing, unknown, or mistyped actions fail with guide instructions and zero
  platform writes, wakes, session injections, approval requests, or joins.
- Conflicting action/target fields fail before effects; existing forbidden field
  combinations remain forbidden.
- `messageSubsession` without `sessionId` derives the caller identity and rejects extra target fields;
  with `sessionId` it verifies the current caller is the recorded direct parent. It
  preserves automatic completion/failure reports, and enforces nesting and concurrency
  limits. Postless `callAgent` self-targets fail with the sub-session guide pointer.
- Origin replies preserve existing valid reply paths, local/remote routing, hop
  limits, and receipts; §9 expands authorization to all admitted origins without
  broadcasting. For indexed sub-sessions,
  verify stable parent origin and separate message delivery from work completion (§8).
- Every supported delivery form works with its explicit action and preserves the
  current authorization, routing, return receipt, and partial-delivery behavior,
  except the explicitly listed lifecycle and multi-origin extensions in §8–§9.
- Guide examples satisfy their action validators; overview examples cover common
  operations without requiring a second lookup.
- Descriptors, guides, standing context, and resumed sessions expose consistent
  operations and include the guide wherever messaging is offered.
- Supported harnesses can discover `getToolGuide` and recover from legacy calls; record
  limitations when their local schema validation intercepts a call first.
- Model evaluations measure first-attempt success, final delivery and parent
  reporting, wrong destinations, guide/retry calls, total tokens, and latency.

## 6. Trade-offs

| Aspect           | Consequence                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Intent           | Required `action` identifies the operation within one tool                                              |
| Migration        | Tool name remains; every call adds `action`, and background self-calls omit the explicit agent target   |
| Schema           | One flat schema; action-specific combinations require runtime validation                                |
| Documentation    | Short common description plus on-demand guides, with lookup or error-recovery cost for unfamiliar calls |
| Runtime behavior | Baseline audited; §8 adds sub-session continuity and §9 adds multi-origin peer sessions                 |

Explicit operation selection does not remove every conditional: `channel` still
changes agent-call delivery, and the shared schema exposes several operations'
fields. Interface changes alone do not guarantee correct feedback delivery;
validate behavior and model outcomes against §5 and the implementation contracts.

## 7. Implementation parity audit

Audited against source at commit `69dd916ee09ba7a569d83afe9ccef3b57e51ccd7`.
The “after” column describes the behavior-preserving adapter stage, not a claim
that it has shipped. Sections 8 and 9 separately identify intentional additions to sub-session
lifecycle, peer-session targeting, and reply authorization; those explicit changes
supersede the relevant baseline rows when implemented. Executable code and tests take precedence over
older design prose and tool descriptions when they disagree.

### 7.1 Source map

| Ref | Source and relevant symbols                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M   | [Messaging handler](../../packages/daemon/src/mcp/ops/messaging.ts): `SEND_MESSAGE_BRANCHES`, `parseAgentTarget`, `sendMessage`, `settlePost`                                                                                                              |
| C   | [Collaboration coordinator](../../packages/daemon/src/collab/coordinator.ts): `localWakeDecision`, `messageAgent`, `deliverReply`, `reportFromSubsession`, `maybeInferParentReply`, `failAgentDispatch`, `settleSubsessionTurn`                            |
| O   | [Tool execution](../../packages/daemon/src/mcp/ops.ts), [place gate](../../packages/daemon/src/mcp/ops/place-gate.ts), [channel names](../../packages/daemon/src/mcp/ops/channel-names.ts), [join handling](../../packages/daemon/src/mcp/ops/join-ask.ts) |
| G   | [Gateway selection](../../packages/daemon/src/mcp/ops/gateway.ts), [read ports](../../packages/daemon/src/platforms/read-ports.ts), [thread keys](../../packages/daemon/src/platforms/thread-keys.ts)                                                      |
| S   | [Session manager](../../packages/daemon/src/session/session-manager.ts), [standing context](../../packages/daemon/src/session/turn/standing-context.ts), [sub-session tools](../../packages/daemon/src/mcp/ops/assistant-subsessions.ts)                   |
| T   | [Tool descriptors](../../packages/daemon/src/mcp/tools.ts), [argument primitives](../../packages/daemon/src/mcp/ops/args.ts), [argument errors](../../packages/daemon/src/mcp/ops/argument-error.ts)                                                       |

### 7.2 Delivery forms: before and after

All examples below also carry `message`. Apart from the explicit input migrations
in §7.7, the same target, authority, delivery, bookkeeping, and receipt must result.

| Existing form / capability                   | Current implementation                                                                                               | Required after refactor                                                                                              | Ref     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `toAgent: peer`, no channel                  | Postless, headless peer wake; current routing can reuse target context                                               | `callAgent` with the same target; no new-session guarantee                                                           | M, C    |
| Object `toAgent` with `needsReply`           | Requests reporting; trusted metadata carries the obligation                                                          | Same nested field and normalization under `callAgent`                                                                | M, C, S |
| `toAgent: self`, no channel                  | Fresh `subsession:<deliveryId>` coordinate, inherited parent context, no visible post                                | `messageSubsession` without `sessionId` constructs the same trusted self-delegation                                  | C       |
| `toAgent: peer` plus `channel`               | Attempts one channel-root post before wake, rendering a native mention when available                                | `callAgent` plus `channel`; retain target preflight and actual gateway behavior                                      | M, C    |
| `toAgent: self` plus `channel`               | Visible self-activation; requires a real provider post id and paired delivery evidence                               | Same `callAgent` form; not a background sub-session                                                                  | M, C    |
| Agent call plus `platform` / `integrationId` | Rejected by the strict agent branch                                                                                  | Still rejected; these are not supported agent-call selectors                                                         | M, T    |
| `toUser: string`, no channel                 | Opens one DM; body is not prefixed with a mention                                                                    | `postMessage` with same `toUser`                                                                                     | M, G    |
| `toUser: string` or array plus `channel`     | One root post with all human mentions; not multiple sends or a group DM                                              | Same under `postMessage`                                                                                             | M       |
| Bare `channel`                               | Posts at the root, records outbound content, seeds/reuses author context when a real anchor is available             | Same under `postMessage`; no explicit `messageAgent` call                                                            | M, G    |
| Bare `channel` plus `thread`                 | Posts into an existing supported thread, stamps final response/hop metadata, seeds/reuses the author's context there | Same under `postMessage`; preserve ingress delivery to existing participants                                         | M, G    |
| `attachment` with user/channel branch        | Forwards retained received image bytes with message as caption, including supported thread updates                   | Same under `postMessage`; not a produced-file upload                                                                 | M       |
| `sessionId`                                  | Replies only into the authorized active or durable origin                                                            | `replyToSession` with the same outward id and authorization                                                          | M, C    |
| Reciprocal session reply                     | Reply metadata names the replier as origin, allowing the receiving turn to reply back                                | Preserve; do not restrict to a fixed parent or add arbitrary child messaging                                         | C       |
| No IM integration                            | Postless collaboration and authorized origin replies still work without a posting gateway                            | Keep `sendMessage` and `getToolGuide` discoverable; background self-work remains available subject to existing gates | T, C    |

Do not inherit the old proposal's claim that non-Slack channel-agent calls simply
fall back to postless delivery. The handler attempts the gateway post when a
channel is supplied and preflight allows it; `mcp-ops.test.ts` includes a Telegram
post-and-wake anchor case. Platform-specific pairing and routing restrictions stay
where the runtime enforces them, without adding a new fallback in the adapter.

### 7.3 Arguments and target resolution

| Behavior                          | Before                                                                                                                   | Required after                                                                                              | Ref  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---- |
| Strict branch keys                | Reject mixed targets, unknown keys, caller identity overrides, and removed fields such as `correlationId`                | Same strict target payload after validating/removing `action`; no silently ignored fields                   | M    |
| Agent target encoding             | Bare id, structured object, and a JSON-stringified structured object are accepted                                        | Preserve all three, while guides recommend a real object                                                    | M    |
| `needsReply` values               | Boolean or case-insensitive `"true"`/`"false"`; absent/null means no new request                                         | Preserve accepted values; no top-level alias, default change, or clearing of sticky session obligations     | M, S |
| String parsing                    | Required strings are nonempty; optional strings are nullish, and optional empty strings are not globally normalized away | Reuse existing parsers for retained fields; do not silently tighten or reinterpret them during flattening   | M, T |
| User target validation            | Nonempty strings/arrays; aliases such as `U1` and `<@U1>` count as duplicates; arrays require channel                    | Preserve validation and mention rendering                                                                   | M    |
| `thread` / `attachment` placement | `thread` only on bare channel; attachments only on user/channel branches                                                 | Preserve, including rejection on agent/session actions                                                      | M    |
| Channel names                     | `resolveChannelArg` resolves a name on the selected bot when unambiguous                                                 | Preserve after action validation; ids and unresolved names retain existing behavior                         | O    |
| Posting platform default          | Explicit `platform` wins; otherwise current platform, except DM uses `directMessagePlatformFor`                          | Preserve capability-driven default; do not hardcode Slack or apply it to channel-user posts                 | M, G |
| Posting bot default               | Explicit integration, else current session's integration on that platform, else first candidate                          | Preserve existing selection; `sendMessage` does not opt into the resolver's optional bot-selection question | G, M |
| Missing connection                | Unknown platform/integration or no live gateway refuses; no implicit alternative bot                                     | Preserve errors and target selection                                                                        | G    |
| DM support                        | Both DM and channel-user forms require the DM capability; opening a DM also probes the selected live gateway             | Preserve both checks                                                                                        | M, G |
| Existing-thread support           | Current update registry permits Slack; own-thread comparison and readable-root verification run before posting           | Preserve current checks and refusal; never silently post at root instead                                    | M, G |

### 7.4 Authority, sessions, and feedback

| Behavior                         | Before                                                                                                                                                | Required after                                                                                                     | Ref  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| Ordinary posting authority       | `isPlatformPost` excludes `toAgent` and `sessionId`; ordinary posts get place-write/draft and join handling                                           | `postMessage` retains these wrappers; public omission of `toAgent` on `messageSubsession` must not opt it in       | O    |
| Visible agent-call authority     | Even with channel, A2A bypasses ordinary-post draft/join wrappers and retains reach checking                                                          | Keep that distinction; a visible side effect alone does not select ordinary-post policy                            | O, M |
| Peer policy and coordinates      | Directional call policy, org snapshot, coordinate integrity, caller/target policy, and hop limits are checked                                         | Same checks for local and remote delivery; no model-supplied caller identity                                       | C    |
| Preflight and post/wake ordering | Locally decidable refusal suppresses the post; remote refusal can still follow an already-visible post                                                | Preserve ordering and partial outcome; do not present send+wake as atomic                                          | M, C |
| Paired activation                | Provider id and trusted metadata pair the root post with the wake; existing rendezvous avoids duplicate activation                                    | Preserve pairing, transcript deduplication, hop and transport scope                                                | M, C |
| Sub-session admission            | Requires a parent session, forbids nesting, and atomically enforces per-agent concurrency limits                                                      | Same refusal reasons and bookkeeping; caps do not newly apply to peers or visible self-wakes                       | C    |
| Origin authorization             | Active-turn origin overrides persisted origin; durable fallback supports later local follow-up turns                                                  | Same precedence, including turn-scoped guidance; never authorize all children by ownership                         | C, S |
| Reply addressing                 | Reply input uses outward session id; wake `childSessionId` currently contains `wake.targetSession`, a session key                                     | Preserve both formats; document the distinction rather than silently changing results                              | M, C |
| Reciprocal replies               | `deliverReply` stamps the stored replier session's outward id into the recipient turn's origin metadata                                               | Preserve this existing conditional reply-back path                                                                 | C    |
| Reply lifecycle                  | No blanket refusal based on target session being done; `reportFromSubsession` rejects a caller whose index is `failed` or `reporting`                 | Preserve the actual caller-side guard; do not invent terminal-target rejection or reopening semantics              | C    |
| Local reply                      | Resolve outward id, inject without a platform post, and resume with the target's ordinary reply route                                                 | Preserve transport scope, code-host reply snapshots, and serial-gate admission; acceptance is not model completion | C    |
| Remote reply                     | Needs active inbound coordinates; uses `lineageReplyTo` and `deliveryKind: session-reply`, with existing remote admission/version fences              | Preserve; a durable id alone does not supply missing remote routing coordinates                                    | C    |
| Feedback opt-in                  | `needsReply` sets standing/turn-scoped guidance; existing persisted obligation can remain sticky                                                      | Preserve; a new bare-id call does not prohibit explicit reports or necessarily clear previous obligations          | C, S |
| Inferred successful report       | Outstanding `needsReply` wake can forward final prose; empty/no-response output becomes an explicit no-result report                                  | Preserve existing inference and duplicate suppression; do not label it an unimplemented future feature             | C    |
| Inference exclusions             | No inference for plain no-reply calls, unrelated follow-up turns, suppressed output, resolved obligations, or outstanding background work             | Preserve exact guards; do not promise every final output is forwarded                                              | C    |
| Failure reporting                | Requested peer dispatch failure can wake the parent; sub-session settlement/sweep reports unreported endings with existing admission/retry safeguards | Preserve existing handling and limits; do not promise infallible delivery                                          | C    |
| Companion tools                  | `viewSessionStatus` reads authorized delegated work; `stopSubsession` has separate main-conversation, human-authority, and lifecycle gates            | Leave both tools and their handle formats unchanged; starting work grants no extra stop/steer permission           | C, S |

The reciprocal reply row follows the actual metadata and authorization path. The
baseline tests verify origin delivery, durable fallback, and precedence, but the
full original-parent → child → original-parent → child exchange should receive an
explicit regression case when implementing the refactor. The existence of that
path is not a guarantee that every target state or admission gate accepts it.

### 7.5 Posting effects and results

| Behavior                | Before                                                                                                                        | Required after                                                                                                | Ref  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- |
| Draft approval          | Eligible ordinary posts can return an intercepted draft receipt before sending; attachment drafts are refused                 | Preserve receipt and no-resend guidance; do not wrap as a completed post                                      | M, O |
| Image provenance        | Resolve only retained bytes received by this conversation; no model-supplied path/bytes or arbitrary file forwarding          | Preserve resolution, supported retained formats, and no-caption-only fallback on failure                      | M    |
| Image delivery failure  | Indeterminate upload says it may have landed and forbids retry; partial caption failure can be a success receipt with warning | Preserve uncertainty and notices; never convert all errors into “nothing sent”                                | M    |
| Thread identity         | Platform-specific roots/DMs use canonical thread keys; Discord guild roots require native thread creation                     | Preserve root/update differences and continuous DM behavior                                                   | M, G |
| Native-thread failure   | Root may already be visible when thread creation fails; outbound is recorded and no seed follows                              | Preserve partial-failure error; do not retry automatically                                                    | M    |
| Missing provider id     | Synthetic local id can record/display a post, but does not seed a session or prove a paired self-wake                         | Preserve; do not claim a session was started merely because `post.ts` exists                                  | M, C |
| Session seeding         | Real anchors can seed/reuse author context without running a model turn; seed acceptance is not completion                    | Preserve no duplicate activation, including existing-thread updates                                           | M    |
| Identity and transcript | Trusted agent identity, recorded body, platform id, integration, and canonical thread drive audit/display                     | Preserve; action stays tool metadata, not a new message-body prefix                                           | M    |
| Wrong-root notice       | A root post into the parent/own conversation can warn that it did not answer the intended context                             | Keep notice, but rewrite suggested calls with required `action: "replyToSession"`                             | M    |
| Agent/post receipt      | `{ok: true, wake?, post?, childSessionId?, reply?, nextAction?, message?, notice?}`                                           | Preserve fields, omission conditions, and `wake.delivered`/reason; `ok` alone does not mean a wake succeeded  | M    |
| Session reply receipt   | `{delivered, targetSession?, reason?}` returned directly                                                                      | Preserve exact shape and reason values, including `not_authorized`, admission refusal, and `subsession_ended` | M, C |
| Waiting guidance        | Admitted feedback-requesting calls/sub-sessions include `reply` and `nextAction: finish-turn-and-wait`                        | Preserve; no synchronous result or guaranteed immediate steering                                              | M    |

### 7.6 Baseline verification and refactor acceptance

The following existing suites passed during this source audit: **10 files,
586 tests**. They establish the current baseline; they do not test the proposed
action adapter, which has not been implemented.

```bash
pnpm --filter @agentconnect.md/daemon exec vitest run \
  test/mcp-ops.test.ts \
  test/mcp-tool-args.test.ts \
  test/mcp-tool-argument-errors.test.ts \
  test/mcp-tools-self-delegation.test.ts \
  test/mcp-write-rule.test.ts \
  test/mcp-join-ask.test.ts \
  test/daemon-message-agent.test.ts \
  test/inferred-parent-reply.test.ts \
  test/assistant-subsession-safeguards.test.ts \
  test/assistant-stop-subsession.test.ts
```

When implementing, port the existing behavior cases through the new action
adapter, changing only tool inputs and intentionally updated guidance assertions.
Assert the same calls, effects, metadata, authorization decisions, and result
shapes. Update descriptor/validator parity tests for the flat schema plus strict
action validators. Add focused cases for missing/conflicting actions, the trusted
self-target adapter, guide examples, and reciprocal replies. Validate at the MCP
execution boundary as well as the inner handler, so pre-handler gateway lookups
and policy wrappers cannot evade the no-effect migration error.

### 7.7 Intentional differences, exhaustively scoped

1. Every call requires `action`; legacy calls fail before target lookup/effects and
   point to `getToolGuide`. The name and existing backend delivery paths remain.
2. Postless self-delegation is spelled `messageSubsession {message}` without `sessionId`, instead of
   `toAgent: self`; self-target `callAgent` without channel is rejected with that
   repair. This changes input shape, not sub-session execution or feedback.
3. A flat shared descriptor and `getToolGuide` replace the top-level union and
   repeated prose. Runtime branch validation remains strict.
4. Existing generated instructions and corrective notices use the new action
   forms. `replyToSession` replaces the draft name `replyToParent` because the
   original backend already authorizes reciprocal origin replies.

This adapter does not introduce arbitrary session targeting, peer feedback-default
changes, cross-platform agent selectors, or a new cancellation tool. The requested
persistent sub-session messaging and multi-origin peer calls are specified in
§8–§9 rather than hidden inside the adapter or described as existing behavior.

## 8. Persistent sub-session messaging — explicit capability extension

**Status:** Proposed runtime extension; not present in the audited baseline.

The original [assistant-mode design §5.6](assistant-mode.md#56-sub-sessions)
identifies steering as re-delegating into the same child and explicitly defers it.
Complete that capability with one action, `messageSubsession`: no `sessionId`
creates a child; a supplied `sessionId` continues that existing direct child.
The child's origin is its parent, so all child-to-parent messages use the existing
`replyToSession` action. No separate start or parent-message action is needed.

### 8.1 One create-or-continue contract

| Input                                                                           | Behavior                                                               | Authorization                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `{action: "messageSubsession", message}`                                        | Create a new background child and deliver its initial task             | Trusted caller identity; existing self-delegation, nesting, and concurrency gates      |
| `{action: "messageSubsession", sessionId, message}`                             | Deliver into that existing child, running or retained after completion | Persistent relation must identify the current caller session as the direct parent      |
| `{action: "replyToSession", sessionId: parentOriginId, message}` from the child | Return progress, a question, or results to its parent                  | The child's trusted origin is its recorded parent; preserve origin-reply authorization |

For `messageSubsession`, only `action` and `message` are required; `sessionId` is
optional but must be a nonempty string when supplied. Reject null, empty, or
mistyped ids instead of treating them as creation. Reject `toAgent`, `channel`,
`thread`, `platform`, `integrationId`, `attachment`, and `needsReply`.

A supplied target that does not exist, is unavailable, or does not belong to the
current parent must fail; never fall back to creating another child. Do not infer
creation from a lookup failure or use agent identity alone as proof of ownership.
The distinction is deliberate: sending without an id requests new work in a new
child; sending with an id requests continuity in that exact retained context.

### 8.2 Persistent relationship, origin, and handles

Creation retains the existing `childSessionId` receipt, which currently contains
the child's session key. The caller passes it unchanged as `sessionId` when
continuing. Like the stop tool, resolve a child key or outward id through the
persistent sub-session index and verify the recorded direct parent against the
trusted current caller session, including agent and transport scope. Do not accept
an ACP runtime id or a sibling/grandchild merely because it shares the same agent.

Each creation/continuation establishes the child's active origin as its recorded
parent and keeps durable origin and standing guidance consistent with that parent.
Recovery and background-wake turns preserve this origin; no caller may reparent
a child through a message. Inputs claiming a conflicting parent are refused.
`replyToSession` uses the parent's outward id provided by trusted origin context,
not the child's returned status handle.

Parent-to-child authorization does not depend on the parent's current turn origin,
a recent incoming reply, or the in-memory `childSessionLinks` map. Retain the
persistent relationship while the child session exists, including when a round is
done, failed, or stopped. A later human-triggered turn in the same parent can
continue the child. Another session of the same agent gains no authority merely
by sharing a channel. Existing daemon-authored report recovery after `!new` is not
by itself a grant for a replacement caller session to steer the old child: any
relationship migration must be explicit trusted state and validated consistently.

Ordinary non-sub-session origin replies preserve their existing authorized paths
and gain the multi-origin authorization in §9. A parent processing a child
reply retains the existing conditional reply-back path too; direct continuation
should use `messageSubsession`, whose durable relationship check does not depend
on that temporary origin. All admitted parent inputs into an indexed child must
participate in the same round/admission accounting, including that existing
reciprocal route, so no legacy entry point bypasses caps or reporting.

“Any time” means authorization is independent of the current turn's origin.
Availability, pause/drain, bounded queues, retained session state, and execution
authority can still refuse admission. A purged child is not recreated implicitly.

### 8.3 Messages do not complete a job

Send parent inputs through the child's existing serial input path. Initially,
messages to a running child are queued for the next input opportunity; admission
does not cancel a running tool or promise immediate application. Preserve the
child's context and workspace identity under existing recovery behavior.

The child sends progress, questions, and results with `replyToSession` to its
parent origin. The reply body is injected into the parent's session, not posted
to a platform; the parent's ordinary turn keeps its existing visible reply route.
The parent can answer through `messageSubsession` in this or a later turn.

For indexed sub-sessions, a successful `replyToSession` is a delivered message,
not a command to mark the work done, release a concurrency slot, or clear the
completion obligation. This intentionally changes the baseline wrapper that marks
an indexed child done as soon as it reports. Keep authorization and receipt shape;
move completion decisions to actual work settlement. Do not add a second reply
action or a model-supplied completion flag just to distinguish progress from results.

Questions do not create an implicit indefinite wait. If the child's current round
ends before an answer arrives, the parent's later answer can begin another round
in the same session. Existing permission/background-work waiting rules still apply.

### 8.4 Work rounds and continuation

The session relationship outlives one round of work. A round begins when input is
admitted into an idle child and includes inputs accepted while it is active. It
ends when execution, accepted pending input, and background work have settled, or
when failure/stop has explicitly accounted for that work.

| Child state                                                            | Existing-child `messageSubsession` behavior                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Running or with pending accepted work                                  | Queue into the same child and round; no extra concurrency slot                                            |
| Completed and retained                                                 | Reuse its context; start a new round with a new completion/failure obligation                             |
| Failed or stopped but retained and eligible                            | An explicit new parent message may start a new round; never automatically retry old failed/stopped inputs |
| Paused, draining, unavailable, queue-full, or over the active-work cap | Refuse admission with a truthful reason                                                                   |
| Missing, purged, or not the caller's direct child                      | Refuse without creating or retargeting a session                                                          |

Starting or resuming idle work rechecks current execution authority and atomically
acquires a slot under the existing per-agent active sub-session cap. Retained idle
contexts consume no active slot. Simultaneous messages to one idle child open one
round, with later inputs appended in order; they do not independently acquire slots.
Nested sub-session creation remains forbidden.

Scope pending inputs, status, completion obligations, and report deduplication to a
daemon-owned round identity. Admission racing with completion either joins the
old round before it settles or opens a new one afterward. Late outcomes from an
older round cannot complete a newer round or release its slot.

Keep `stopSubsession` and its existing authority checks. It stops the active work
and accounts for queued inputs so they cannot restart it accidentally. An explicit
later parent message can request new work. Previously performed effects and
external processes retain their existing stop semantics; continuing is not rollback.

### 8.5 Automatic outcomes and reply delivery

Every created or continued round owes a completion/failure outcome to its parent,
without `needsReply`. Preserve final-output inference, no-result notices, and
failure fallback as appropriate, but scope them to the round and actual execution
settlement rather than treating any successful reply as job completion.

A progress reply must not suppress the eventual terminal outcome. A terminal
outcome already recorded as delivered for the settled round must not be duplicated
by inference or retry. That determination belongs to trusted round/report state,
not a heuristic that any earlier `replyToSession` means the task is complete.
Pending accepted input or live background work prevents premature settlement.

Replace session-wide report rejection for completed old rounds with round-aware
checks: the next admitted round must be able to send replies and report its own
outcome. Stale completion from a failed or stopped round cannot overwrite the new
round. Persist delivery identity and receipt state for recovery; retain bounded
failure handling when the parent is unavailable or gone rather than guaranteeing
unconditional arrival.

These lifecycle changes apply to indexed background sub-sessions. Peer
`needsReply` defaults remain unchanged; their multi-origin authorization and
per-call reporting changes are specified separately in §9. Explicit child replies continue to use the existing
`{delivered, targetSession?, reason?}` result shape; delivery does not mean a human
has read the parent's response or the parent has finished processing it.

### 8.6 Unified receipts and retry behavior

For creation, preserve the existing self-delegation receipt fields and meanings:
`ok`, `wake`, `childSessionId`, `reply`, `nextAction`, and explanatory `message`.
For continuation, use that same result family: successful admission identifies the
same child in `childSessionId` and `wake.targetSession`, with waiting/reporting
guidance as appropriate. Do not describe continuation as creating another child.

`ok` alone does not prove delivery; inspect `wake.delivered`. Admission is not
model completion or immediate steering. Known runtime refusals use typed reasons;
malformed input uses the argument-error path. Unknown and unauthorized targets
must not disclose other sessions' existence or trigger fallback creation.

Persist a stable per-submission identity and receipt across transport retries.
Replaying one submission must not create another child, append the same input
twice, acquire two slots, or duplicate its terminal report. A new intentional
model call remains a new submission even if its text is identical. Uncertain
acknowledgement is not a known refusal and must not encourage an unqualified resend.

Do not change the meanings or shapes of `callAgent`, `replyToSession`, or
`postMessage` receipts. In particular, the child's session-key handle used for
continuation does not become an outward-origin id accepted by `replyToSession`.

### 8.7 Acceptance boundary

Creation is adapted existing behavior; continuation and round-aware sub-session
reporting are new runtime work. They may be reviewed separately, but publish the
complete `messageSubsession` contract only when both forms work. The 586 tests in
§7 verify the original baseline, not this extension.

Required additional behavior tests:

- Omitted `sessionId` creates a child; a valid supplied id continues that same child.
  Null, empty, unknown, unavailable, or unauthorized ids never create a replacement.
- The current caller must be the child's persistent direct parent, independent of
  active origin; siblings, grandchildren, unrelated sessions of the same agent,
  and other agents are refused.
- Child origin remains its parent across creation, continuation, background turns,
  and restart. The child can send progress, questions, and results using
  `replyToSession`; conflicting origin metadata cannot reparent it.
- Progress replies do not end work, release slots, or suppress terminal outcomes.
- Completed/failed/stopped retained children can receive explicitly requested new
  work when eligible; new rounds reacquire slots and report automatically.
- Simultaneous admission/settlement, duplicate delivery, late outcomes, and restart
  neither lose input nor report/finish the wrong round. The reciprocal reply entry
  path cannot bypass this accounting.
- Stop, pause/drain, queue limits, parent recovery, purged sessions, and uncertain
  receipts behave as specified, without creating extra work or unauthorized access.
- Both messaging directions remain session-only; the parent's ordinary response
  keeps its existing visible reply route.

Implement the durable round/admission state alongside indexing, dispatch, reports,
and cancellation. Merely widening origin authorization or adding an enum value
does not provide this contract.

## 9. Shared peer sessions with multiple origins — explicit capability extension

**Status:** Proposed runtime extension; not the single-origin baseline audited in §7.

A peer session can receive calls from several source sessions. Its origin is
therefore a set of authorized reply destinations, not a single slot overwritten
by the latest caller. This does not give a background sub-session multiple parents:
its direct parent relationship and §8's continuation ownership rule remain intact.

### 9.1 The A → B ← C scenario

1. Session A calls agent B. Existing routing starts or selects B's session B1.
   Admission records A as a source B1 can reply to.
2. Session C calls B with `sessionId` identifying B1. Once the existing-session call
   is authorized and admitted, C is also recorded as a source B1 can reply to.
3. B1 can use `replyToSession` with A's outward session id or C's outward session id,
   regardless of which caller most recently woke B1. Each call sends to one chosen
   source only. Neither reply changes the owner of B1 or a sub-session parent.

C's call:

```json
{
  "action": "callAgent",
  "toAgent": { "agentId": "B", "needsReply": true },
  "sessionId": "<B1 handle returned by the earlier call>",
  "message": "Continue the discussion here and check the Windows behavior as well."
}
```

B1 chooses A:

```json
{
  "action": "replyToSession",
  "sessionId": "<A outward session id>",
  "message": "Here are the findings for your original request."
}
```

Or B1 chooses C:

```json
{
  "action": "replyToSession",
  "sessionId": "<C outward session id>",
  "message": "Here are the Windows findings you asked for."
}
```

A, B, and C name agents in the example, but reply addresses identify their precise
source sessions. Two source sessions belonging to agent A are distinct origins;
agent identity alone is never the reply address. The example does not authorize a
self-reply to B1 just because B1 is the current session.

### 9.2 Existing-session `callAgent`

Keep `toAgent` required. `sessionId` is optional; when present it is a nonempty
existing target-session handle, must resolve to the agent named by `toAgent`, and
is mutually exclusive with `channel`. Preserve `toAgent.needsReply` and its existing
accepted representations. Still reject `platform`, `integrationId`, `thread`, and
`attachment` on this action.

Without `sessionId`, preserve existing peer routing; this need not create a new
session. With `sessionId`, resolve the session key returned in `childSessionId` or
its outward id on the owning daemon. Do not accept an ACP runtime id. Deliver into
that exact retained context through normal admission, without posting a new root,
changing its conversation identity, or creating a replacement on failure. Do not
infer a headless/visible output change from the addressing form: preserve the
target's established output behavior and trusted delivery rules.

**Proposed admission rule:** retain existing organization, directional agent-call,
hop, and execution checks, and require authority to participate in that specific
session under its conversation/audience rules. Knowing the id or merely being
allowed to call agent B does not by itself grant access to all of B's contexts.
Read-only console visibility is not an invocation grant. Session-specific admission
must be enforced on the owning daemon for local and remote calls alike; a caller
must not register a source relation before that admission succeeds.

This session-participation rule is a new design requirement, not a claim that the
current `toAgent` path already checks an explicit session id. Its exact authority
projection must be implemented and tested before enabling the new form. An explicit
owner invitation can be a future means of granting participation, but no invitation
tool or automatic sharing operation is added here.

A private background sub-session is not turned into a shared peer session through
this field. Reject `callAgent.sessionId` aimed at an indexed sub-session and direct
its parent to `messageSubsession`. Preserve the visible self-call with `channel`;
this extension adds explicit existing-session targeting for peers, not a new
self-activation bypass.

### 9.3 Multiple reply destinations, without broadcast

Persist each admitted source relation using precise source and destination session
identities, their owning agents, and the trusted routing/transport scope needed to
return a message. An additional caller adds a relation; it does not replace the
first or most recent origin, reparent a child, or clear earlier reply authority.
Rejected calls add no relation. Duplicate admission of the same call adds no
second relation or reply obligation.

`replyToSession {sessionId, message}` verifies the selected outward id against
this session's recorded reply destinations. Preserve valid legacy active-origin
and durable-origin replies during migration, plus existing reciprocal replies;
record newly admitted calls/replies so those relations survive later turns and
restart. Do not infer reply authority from arbitrary transcript mentions or ids
copied into a message. Revocation, session deletion, organization boundaries, and
current delivery fences still apply; a relationship is not permanent authority
against a deleted or revoked target.

Replies remain point-to-point. The model can choose A, choose C, or make two
explicit calls when both need a message. No automatic all-origins fan-out, copying
one source's result to every participant, or reply-to-latest fallback is implied.
An invalid or unavailable selected target fails rather than delivering to another
origin. Preserve existing reply result shape and admission/uncertainty semantics.

Guide and turn context must expose the admitted sources' outward reply ids and
identify which source sent each input. Keep a bounded, discoverable view when
there are many origins without deleting authorization merely because it fell out
of the prompt window. A singular `Parent session` label cannot describe all reply
destinations of a shared peer session. For a background sub-session, continue to
name its one parent origin as specified in §8.

### 9.4 Reply authority and reply obligations are different

A source relation permits B1 to send a reply to A; it does not require a reply to
A for every future turn. `needsReply` requests an outcome for one admitted call,
including calls into an existing session. Track those obligations per admitted
call/source rather than one latest-parent entry or one session-wide boolean.

C's new call must not overwrite A's outstanding obligation. An explicit reply to
A does not discharge C's obligation, and answering C does not remove A's reply
authority. Repeated calls from A can create distinct obligations even though they
share a reply destination. Sending one message must not silently settle every
pending request from that source.

Use trusted delivery/turn attribution for existing inference and failure handling.
A call's completion/failure is addressed to that call's source, never the last
caller merely because its id is newest. Where a turn combines several requests,
automatic inference must not guess that one undifferentiated final output answers
all sources. Preserve unresolved obligations explicitly when attribution is
ambiguous; the implementation must define and test correlation before shipping,
without broadening the meaning of `replyToSession.sessionId` into broadcast.

This is an intentional extension to current single-effective-origin authorization
and latest-waker reporting state. The audit in §7 remains evidence of the old
code, not a claim that storing one `originSessionId` already implements this model.
Live call/reply bodies and streams remain on the daemon/relay data plane.

### 9.5 Acceptance boundary

- A calls B1, then C calls that same B1 by session id; B1 can reply separately to
  A and C both during C's turn and in a later turn, including after restart.
- B1's owner and conversation identity stay unchanged; no new root post or
  substitute session appears on explicit-target failure.
- Target-agent mismatch, missing/invalid id, unauthorized session participation,
  and sub-session bypass attempts fail without registering an origin.
- Different source sessions of the same agent remain distinct; no current-session
  self-reply is authorized solely by the target id being known.
- A later caller never removes an earlier authorized origin, and a reply goes
  only to its selected destination. Reciprocal legacy replies still work.
- Reply obligations survive overlapping calls, retries, restarts, and distinct
  same-source requests without cross-clearing or latest-caller misdelivery.
- Source context and guide examples expose usable reply ids without leaking
  unrelated sessions; local and remote target admission enforce the same rule.
- Sub-session ownership, `messageSubsession` continuation, and parent-origin
  replies remain as specified in §8.

Implement session-id resolution, trusted session admission, durable reply
relations, per-call outcome correlation, and model-facing origin discovery as one
reviewable capability. A new optional field plus an array replacing
`originSessionId` alone is insufficient.

## 10. Runtime matrix verification

Unit suites prove the adapter's parity; they cannot show whether a runtime loads the
descriptor or whether a model picks the right action from a short description plus
an on-demand guide. Add a `sendMessage` probe to the local live runtime matrix
(`packages/daemon/test/acp-matrix/`, run with `test:runtime-matrix`) and run it once
under every admitted runtime.

- **Tools.** Serve the real descriptors from `toolsForIntegrations`, plus
  `getToolGuide`, through the matrix's HTTP MCP fixture. The fixture records each
  call's arguments and runs the real action validators; it never posts, wakes an
  agent, or injects into a session.
- **Prompts.** One prompt per case: ask a peer for a result (feedback must be
  requested), start background work, open visible work in a channel, DM a person,
  post an update into an existing thread, and reply to an origin. One negative
  prompt asks for a reply in the current conversation, where no tool call is correct.
- **Verdicts.**

  | Outcome                                                          | Cell     |
  | ---------------------------------------------------------------- | -------- |
  | `sendMessage` or `getToolGuide` absent from the runtime's tools  | `✗`      |
  | Wrong arguments, corrected after one guide lookup or error retry | Degraded |
  | Wrong action or target, or a tool call on the negative prompt    | `✗`      |
  | Provider logged out, rate-limited, or out of quota               | `U`      |

- **Baseline first.** Run the probe against the current `sendMessage` before the
  change. Its Codex result answers the truncation-or-drop question in §1.

This is a compatibility smoke test, not a quality statistic: one sample per case is
too noisy to compare designs, so it gates "loads and is used correctly" only.

## 11. Open questions

These points came out of a review of an earlier, compatibility-first revision of this
proposal and are unresolved against the current design.

1. **Required `action` versus an unchanged contract.** The earlier revision kept every
   existing call valid; a survey of one production deployment found the old forms in
   one agent description and one knowledge article. This revision rejects calls
   without `action` (§4). Is a hard break acceptable, or should missing-`action`
   calls stay valid for a transition period?
2. **Field-level unions.** The review chose to advertise one canonical spelling per
   field (`needsReply` as a boolean, `toUser` as an array, `toAgent` as a string) while
   the handler keeps accepting legacy spellings. §3.2 keeps the nested unions and
   rejects a top-level `needsReply`. Which holds if a runtime rejects nested `oneOf`?
3. **Rules that must stay in the description.** The review kept four rules because the
   model decides before reading any guide, including "a visible post opens a new
   conversation at the channel root". §3.1 records that posts can reuse the author's
   idle context, so that rule needs rewording before it can return.
4. **Consequence notes in results.** The review asked every result to state which
   operation ran and its consequence, e.g. that a call without `needsReply` returns
   nothing and must not be re-sent. §3.5 and §7.5 preserve receipt shapes unchanged.
   Can a notice field be added without breaking that parity?
5. **Naming.** The review settled on "form", `toolGuide`, and `originReply`; this
   revision uses `action`, `getToolGuide`, and `replyToSession`. Pick one vocabulary
   for the guide, the errors, and standing context.
6. **Other tools over 1024 characters.** `writeMemory`, `listChannels`,
   `listChannelAgents`, `listAgents`, and `shareFile` also exceed the limit. They are
   out of scope unless the §10 baseline shows Codex drops oversized tools rather than
   truncating them.

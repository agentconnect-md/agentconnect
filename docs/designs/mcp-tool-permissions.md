# Per-agent MCP tool permissions

**Status**: Proposed
**Scope**: protocol + control-plane + relay + daemon + web
**Depends on**: [centralized-tool-management.md](centralized-tool-management.md)
**Issue**: [#4164](https://github.com/agentconnect-md/agentconnect/issues/4164)

> **Architecture**: an administrator sets each tool of an organization MCP provider, for one
> agent, to one of the four decisions of Claude's connector settings: **Always allow**,
> **Needs approval**, **Always ask**, or **Blocked**.
>
> - A restricted `(agent, provider)` pair receives **its own grant**. The relay binds that
>   grant's hash to a per-tool decision table and parses MCP for it.
> - **Blocked** tools are hidden and refused by the relay.
> - **Approval does not happen in the relay.** The agent's runtime keeps asking the way it
>   already does: a person in a manual mode, the runtime's own automated reviewer in an
>   auto-review mode.
> - The daemon observes the outcome on ACP and sends the relay a one-time **approval
>   ticket** for that exact tool call. The relay forwards an approval-gated call only
>   against a matching ticket.
>
> The CP computes the decision table when the policy is saved and relays tickets between the
> daemon and the relay pool. It never sees call content.

## 1. Background

An organization MCP provider is enabled on an agent as a whole. Every agent that enables it
presents the same organization-shared grant to the relay, so the relay cannot tell agents
apart and every agent can call every tool. The motivating request (#4164): some agents
should read through a server but not write through it, while other agents keep full access
to the same server.

Four facts shape the design. The last three were measured (§12):

- **Enforcement must sit where the call happens.** Hiding a tool is not authorization, so the
  relay must refuse calls itself. That requires per-agent grants.
- **Tool annotations are hints, and runtimes do not act on them.**
  - The specification says clients must not base tool-use decisions on an untrusted
    server's annotations, and `readOnlyHint` defaults to `false`.
  - Claude in Auto mode ran a tool annotated `destructiveHint: true` without asking.
  - Annotations therefore only seed the console's grouping.
- **Runtimes already have approval gates, and they differ by mode.**
  - Claude asks a person in its manual modes, lets its classifier decide in Auto mode, and
    asks no one in Bypass mode unless an `ask` rule forces it.
  - Codex asks a person in its workspace and read-only modes, lets its Guardian reviewer
    decide in Auto review, and asks no one in Full access.
  - An administrator who allows automatic approval wants these gates honored, not replaced.
- **The call can be tied to its approval.** The `tools/call` request a runtime sends carries
  the ACP `toolCallId` in `params._meta`: `claudecode/toolUseId` from Claude, `callId` from
  Codex. That is the same id the daemon sees in the permission request or the reviewer's
  verdict. The call arrives 4–26 ms after the approval.

## 2. Goals / Non-goals

**Goals**

- Per agent and per provider, an administrator chooses **Full access** (today's behavior)
  or sets each tool to one of the four decisions. Presets cover the common cases.
- The relay refuses a blocked call for that agent, while another agent with full access to
  the same provider still succeeds.
- An approval-gated call reaches the upstream only after the gate the decision names has
  approved that exact call.
- Defined behavior for each runtime mode, including modes that cannot ask (§7.2).
- Defined behavior for tools without annotations, tools added after the policy was saved,
  and tools whose annotations change.
- Works for `custom` and `open_connector` providers.
- No change for agents and providers without a policy.

**Non-goals**

- Asking from the relay. MCP elicitation from the relay was evaluated (§12). It cannot honor
  a runtime's automatic approval, and it would hold a call open while a person decides.
- Remembered approvals ("allow for this session"). Every ticket covers exactly one call.
- Restricting `resources/*`, `prompts/*` or `completion/*`. The policy covers tools only.
- Argument-level rules, for example allowing a tool only for one channel.
- Restricting daemon-local `config.mcpServers` definitions, which connect directly to their
  upstreams and never pass through the relay.
- Per-agent upstream identity. A restricted agent still calls the upstream with the
  provider's single configured credential.
- Applying annotation changes automatically (§5.3).

## 3. Model

### 3.1 Groups

The console sorts a provider's tools into three groups, matching the grouping Claude's
connector settings use. The grouping is derived from the catalog (§4) and only steers the
console:

| Group            | Rule                                                      | Notes                                                                    |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Read-only**    | `annotations.readOnlyHint === true`                       |                                                                          |
| **Write/delete** | `annotations.readOnlyHint === false`                      | A **Destructive** badge when `destructiveHint` is not `false`            |
| **Other**        | `readOnlyHint` absent (including no `annotations` at all) | Not merged into Write/delete, so an administrator sees what is unlabeled |

`open_connector` actions carry no annotations, so all of them land in **Other**. A tool with
`_meta.ui.resourceUri` shows an **Interactive** badge; it is not a separate group.

### 3.2 Decisions

| Decision           | Console description                                                     | Gate the relay requires                                               |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Always allow**   | The agent uses it without asking.                                       | None                                                                  |
| **Needs approval** | The agent asks before each use, except in a mode with automatic review. | A ticket from a person, or from the runtime's automated review (§7.2) |
| **Always ask**     | A person approves each use, even in a mode with automatic review.       | A ticket from a person                                                |
| **Blocked**        | The agent cannot see or use it.                                         | Refused; hidden from `tools/list`                                     |

### 3.3 Policy

A policy exists per `(agentId, providerId)`. No policy means **Full access**, today's
behavior: every tool is allowed and the shared grant is used. A policy holds:

- `groups`: a decision for each of the three groups;
- `overrides`: `toolName → decision`, taking precedence over the group;
- `allowTools`, `approvalTools` and `askTools`: the **expanded decision table** of exact
  tool `name`s for Always allow, Needs approval and Always ask, computed when the policy is
  saved (§5.2). Every name in none of the lists is Blocked. These are the only fields
  enforcement reads.

Presets set `groups`:

| Preset         | Read-only    | Write/delete   | Other          |
| -------------- | ------------ | -------------- | -------------- |
| Full access    | no policy    | no policy      | no policy      |
| Read-only      | Always allow | Blocked        | Blocked        |
| Approve writes | Always allow | Needs approval | Needs approval |
| Ask for writes | Always allow | Always ask     | Always ask     |
| Custom         | any          | any            | any            |

In every preset, **Other** is never more permissive than **Write/delete**. This follows the
specification's default of `readOnlyHint: false`. An administrator who has checked an
unlabeled tool can loosen it with an override.

## 4. Tool catalog (CP)

The console needs each provider's tool list. The CP fetches it and stores one snapshot per
provider:

```prisma
model McpToolCatalog {
  mcpProviderId String   @id @db.Uuid
  tools         Json     // CatalogTool[]
  fetchedAt     DateTime @db.Timestamptz(6)
  failure       String?  // closed reason code; never a host or a secret
  provider McpProvider @relation(fields: [mcpProviderId], references: [id], onDelete: Cascade)
  @@map("mcp_tool_catalog")
}
```

`CatalogTool` is `{ name, title?, description?, readOnlyHint?, destructiveHint?,
idempotentHint?, openWorldHint?, interactive }`, with `description` truncated to 1,000
characters. It is metadata, not message content, so it does not cross the base design's
content invariant.

**Fetch.**

- `custom` providers: the CP acts as a minimal Streamable HTTP MCP client over its guarded
  egress (`net/guarded-fetch.ts`, the precedent set by the OAuth discovery probe in
  [mcp-provider-oauth.md](mcp-provider-oauth.md) §10).
  - It sends `initialize`, `notifications/initialized`, then `tools/list` following
    `nextCursor`, and ends the session with `DELETE`.
  - It authenticates with the provider's resolved upstream headers or OAuth access token.
  - It accepts `application/json` and `text/event-stream` responses.
  - Limits: 10 pages, 1,000 tools, 1 MiB in total, and the guarded per-request timeout.
- `open_connector` providers: the CP's OpenConnector client lists the service's actions
  from the same `/v1/actions?service=` endpoint the relay adapter translates to.

**When.** On provider creation and update, on demand from the console, and when the policy
panel opens on a snapshot older than 24 hours. A fetch failure keeps the previous snapshot
and records `failure`.

**Without a catalog.** The CP may be unable to reach the provider, for example because its
egress allowlist excludes a host the relay can reach. Group settings then cannot be
expanded. The console accepts tool names typed by hand as overrides, and the decision table
consists of those overrides alone.

## 5. Control plane

### 5.1 Data model

```prisma
model AgentMcpToolPolicy {
  agentId          String
  mcpProviderId    String    @db.Uuid
  groups           Json      // { readOnly, write, other: 'allow' | 'approval' | 'ask' | 'block' }
  overrides        Json      @default("{}")
  allowTools       String[]
  approvalTools    String[]
  askTools         String[]
  catalogFetchedAt DateTime? @db.Timestamptz(6) // snapshot the expansion used
  updatedByUserId  String?
  updatedAt        DateTime  @updatedAt @db.Timestamptz(6)
  @@id([agentId, mcpProviderId])
  @@map("agent_mcp_tool_policy")
}
```

`McpGrant` gains `agentId String?`:

- `null` is the organization-shared grant, unchanged.
- A non-null value is the grant of one restricted `(agent, provider)` pair.

`currentMcpGrant` selects the newest active grant **per slot**, and rotation applies per
slot with the existing overlap rule. Deleting an agent or a provider cascades to its
policies and grants and unassigns their hashes.

### 5.2 Expansion

On save, the CP computes the decision table from the current catalog. For each decision `d`:

```
decision(tool) = overrides[tool.name] ?? groups[group(tool)]
tools(d)       = { tool.name | tool ∈ catalog, decision(tool) = d } ∪ { name | overrides[name] = d }
```

The second term covers hand-typed names. Expansion happens **only on save**.

### 5.3 Drift

A later catalog refresh never changes the decision table. It compares the snapshot against
each policy and reports drift to the console:

- tools that are new since `catalogFetchedAt`;
- tools whose group changed;
- names in the table that the upstream no longer lists.

New tools stay **Blocked** until an administrator re-saves. This is deliberate: annotations
are self-declared, and an upstream that relabels a write tool as read-only must not loosen an
agent's access by itself.

### 5.4 Grant lifecycle and projection

| Event                                      | Effect                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First policy saved for `(agent, provider)` | Mint an agent grant. Push the relay binding (§6.1) **before** the agent-scoped definition (§7.1) to the daemons serving the agent, the existing order for a new key.    |
| Policy changed                             | Re-push the relay binding, and push the definition again only for its decision table (§7.1). The key is unchanged, and the next call is judged against the new table.   |
| Policy removed (Full access)               | Push `mcpserver/remove{agentId}` so the agent falls back to the shared definition, then revoke the grant and send `rc/mcp-unassign{providerId, grantKeyHash}`.          |
| Agent disables the provider                | The policy row and its grant persist, and no definition is projected while the provider is disabled. Re-enabling restores the same restriction rather than Full access. |

`mcpDefsForAgents` projects, for each agent that enables a provider:

- the shared definition, as today, when the agent has no policy;
- an agent-scoped definition carrying the agent grant and its decision table, when it has
  one.

The register snapshot, `duty/fetch`, and live pushes all go through this one projector.

### 5.5 HTTP surface

| Route                                                          | Purpose                                    |
| -------------------------------------------------------------- | ------------------------------------------ |
| `GET /api/v1/mcp-providers/:id/tools`                          | Catalog snapshot, `fetchedAt`, `failure`   |
| `POST /api/v1/mcp-providers/:id/tools/refresh`                 | Fetch the catalog now                      |
| `GET /api/v1/agents/:agentId/mcp-tool-policies`                | Every policy of an agent, with drift       |
| `PUT /api/v1/agents/:agentId/mcp-tool-policies/:providerId`    | Save `groups` and `overrides`, then expand |
| `DELETE /api/v1/agents/:agentId/mcp-tool-policies/:providerId` | Return to Full access                      |

Each route carries `tags`, `summary`, `description` and a unique `operationId`.

Authorization:

- Reading a policy requires viewing the agent.
- Writing one requires editing the agent and viewing the provider, the same checks as
  enabling the provider.
- `PUT` and `DELETE` set `config: { interactiveOnly: true }`. An agent holding the admin MCP
  server or an API key could otherwise loosen its own tools, so `openapi.test.ts` gains these
  two routes.

### 5.6 Ticket routing

Approval tickets (§7.3) travel daemon → CP → every relay:

- D→C `mcp/approval-ticket { agentId, providerId, tool, toolCallId, source }`;
- C→R `rc/mcp-approval-ticket { grantKeyHash, tool, toolCallId, source, expiresAt }`,
  broadcast to every relay advertising `mcp-tool-policy-v1`.

`source` is `person` or `runtime-review`.

Before broadcasting, the CP checks three things, then stores nothing:

- the daemon currently serves the agent;
- the agent has a policy for the provider;
- `tool` is in that policy's `approvalTools` or `askTools`.

It resolves the agent grant's hash and sets `expiresAt` to two minutes from receipt. A
ticket carries no arguments and no content.

## 6. Relay

### 6.1 Binding

`rc/mcp-assign` gains two optional fields, sent only to relays advertising
`mcp-tool-policy-v1`:

```ts
toolPolicies?: { allow: string[]; approval: string[]; ask: string[] }[] // deduplicated tables
restrictedGrants?: { grantKeyHash: string; policy: number }[]           // index into toolPolicies
```

- `grantKeyHashes` keeps carrying the unrestricted hashes. It stays non-empty, because the
  shared grant exists while the provider exists.
- Tables are deduplicated because agents usually share a few policies. The frame relies on
  `rc/fragment` beyond the frame size limit.
- `McpBindingTable.resolve` returns `{ upstream, policy? }`.
- `rc/mcp-unassign` with a `grantKeyHash` already retires one restricted grant.

### 6.2 Enforcement

When `policy` is absent, the request takes the transparent path of base §5.1 unchanged.
When it is present, the relay applies the following.

**Request side.** The POST body is already buffered under `MCP_BODY_LIMIT`.

- Parse the body as JSON-RPC. A single message and a batch array are both accepted.
  Unparseable JSON gets a JSON-RPC parse error and is not forwarded (fail closed).
- `tools/call` with `params.name` in `allow` is forwarded.
- `tools/call` with a name in `approval` or `ask` goes through the ticket check (§6.3).
- Any other `tools/call` is refused with a tool result, so the model sees why and stops
  retrying:
  `{ content: [{ type: 'text', text: 'The tool "<name>" is blocked for this agent.' }], isError: true }`.
- A batch containing a call that is not in `allow` is answered entirely by the relay. Each
  request member receives the refusal or an error naming the refused member. This is not
  worth more complexity for a construct the 2025-06-18 protocol removed.
- Every other method is forwarded unchanged.

**Response side.** This applies only when the forwarded POST contained a `tools/list`.
Tools in `allow ∪ approval ∪ ask` are kept; all others are removed.

- `application/json`: buffer up to 4 MiB, filter `result.tools` for the matching request
  ids, and re-serialize.
- `text/event-stream`: parse events incrementally, rewrite only `data:` payloads that answer
  a `tools/list` id, and pass every other event through byte for byte.
- Exceeding the buffer limit, or a malformed matching payload, ends the response with a
  JSON-RPC error rather than unfiltered data.

Each page is filtered independently, so pagination needs nothing extra; an empty page with a
`nextCursor` is valid. Responses to `tools/call` and other methods are never parsed or
buffered.

**Unchanged.** `GET` streams and `DELETE` pass through. A `notifications/tools/list_changed`
only makes the client list again, and that list is filtered.

**`open_connector`.** The relay already terminates MCP for these providers. The same policy
and ticket check guard `callTool` and filter `listTools`.

**Logging.** A refused call logs at info with the provider id, tool name and reason, never
the grant key or the arguments. It increments
`relay_mcp_tool_denied_total{providerId, reason}`.

### 6.3 Ticket check

1. Read the call id from `params._meta`. Known keys are `claudecode/toolUseId` (Claude) and
   `callId` (Codex); this list grows as harnesses are verified. A call without a known id is
   refused: "requires approval, and this runtime cannot be matched to one".
2. Look up the ticket `(grantKeyHash, toolCallId)`. The call usually arrives before the
   ticket (§12), so the relay waits up to 3 seconds for it.
3. Accept only when:
   - `tool` equals `params.name`;
   - the ticket has not expired;
   - for an `ask` tool, `source` is `person`.
4. Consume the ticket and forward the call.
5. Otherwise refuse with an `isError` result: "The tool "<name>" requires approval, and this
   call was not approved."

Tickets live in memory, bounded per grant, and are dropped on expiry. The relay reads no
annotations and holds no catalog. Group logic and drift live in the CP, so a relay never
loosens access on its own.

## 7. Daemon

### 7.1 Agent-scoped definitions

- `McpServerSpec` and `McpServerRemove` gain `agentId?: string`. The spec also gains the
  decision table as `toolDecisions?: { allow, approval, ask, block }`. That is the policy,
  not a secret. The CP sends both only to daemons advertising `mcp-agent-defs-v1`.
- `CpMcpDefs` gains an agent layer keyed `(orgId, agentId, name)`, included in `converge`.
- `effective(orgId, agentId)` overlays it as `local ∪ org ∪ agent`, with the agent layer
  winning. `mcpDefsForAgent(agentId)` is already the single call site feeding
  `resolveAgentMcpServers`.
- The MCP Apps host keys a connection to an agent-scoped `ui` definition on
  `(orgId, agentId)` instead of `orgId`. Otherwise a restricted agent would reach the
  provider's tools through the bridge with the shared grant.
- Facts are unchanged. Agent-scoped definitions, like other CP definitions, are not folded
  into the daemon's fact set.

### 7.2 Runtime gates

The daemon arranges each runtime's own gate so that it asks where the decision requires, and
reads the gate's outcome. The Claude tool name is `mcp__<server>__<tool>`, with the
runtime's name normalization applied.

| Runtime and mode                                       | Needs approval                                                                                                                                                                  | Always ask                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude manual modes (`default`, `acceptEdits`, `plan`) | Runtime asks a person: ticket `person` on an allow answer                                                                                                                       | Same                                                                        |
| Claude `auto`                                          | Claude's classifier decides. ACP shows no verdict, so the daemon issues ticket `runtime-review` when the call's `tool_call` appears; a call the classifier blocks is never sent | Daemon adds a `permissions.ask` rule, so a person is asked: ticket `person` |
| Claude `bypassPermissions`                             | Daemon adds a `permissions.ask` rule, so a person is asked: ticket `person`                                                                                                     | Same                                                                        |
| Claude `dontAsk`                                       | Runtime denies the call                                                                                                                                                         | Same                                                                        |
| Codex `read-only`, `workspace-write`                   | Runtime asks a person: ticket `person` on an allow answer                                                                                                                       | Same                                                                        |
| Codex `agent` (Auto review)                            | The Guardian Review update for `targetItemId` with `review.status: "approved"`: ticket `runtime-review`                                                                         | Refused: the reviewer, not a person, decides                                |
| Codex `agent-full-access`                              | Refused: nothing asks                                                                                                                                                           | Refused                                                                     |
| Any other runtime                                      | Refused until its gate and call id are verified                                                                                                                                 | Refused                                                                     |

The daemon applies session settings as follows:

- **Always allow:** adds a `permissions.allow` rule, so a manual mode does not ask.
- **Blocked:** adds a `permissions.deny` rule, as defense in depth.
- **Needs approval and Always ask:** never use `_meta["anthropic/requiresUserInteraction"]`,
  because it would also force a person in Auto mode. They use `permissions.ask` rules
  instead, added only where the table calls for one.

The daemon tracks the session's current mode, including mid-session changes, and applies
the row in force when the permission request or `tool_call` arrives.

A person's approval follows the existing permission-request answer rules: the turn's
caller or an agent editor, including the Slack approval DM of
[slack-approval-dm.md](slack-approval-dm.md). A permission card for an approval-gated tool
offers only once-options (allow once, reject). Claude already offers only these, and an
"always" answer would produce no ticket for later calls.

### 7.3 Tickets

When a row above yields a ticket, the daemon sends `mcp/approval-ticket` (§5.6) carrying
the ACP `toolCallId`. It sends nothing for a refusal, a rejection, or a refused row. A
refused row also appears in the turn's tool result and in the console (§10).

## 8. Compatibility and rollout

Each mixed-version case fails closed:

| Peer lacks the feature             | CP behavior                                                                                                                        | Effect                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Relay without `mcp-tool-policy-v1` | Its `rc/mcp-assign` omits restricted grants, and it receives no tickets                                                            | A restricted agent's call through that relay gets 401  |
| Daemon without `mcp-agent-defs-v1` | Drops the restricted provider from that agent's projected `AgentSpec.mcpServers`, so the shared definition is never attached to it | The restricted agent loses the provider on that daemon |

The console shows both conditions on the policy panel. A relay pool in mid-upgrade can
therefore return intermittent 401s for restricted agents. That is the accepted cost of never
falling open.

Delivery order: relay and daemon land first and stay dormant, because no CP sends them the
new fields. The CP and console follow. The migration is additive, and nothing changes until a
policy row exists.

## 9. Security

- **Boundary.** The relay's per-call check on the agent grant enforces Blocked and the
  presence of a valid ticket. Hiding tools is a convenience on top.
- **What a ticket proves.**
  - `person`: a person allowed that exact call.
  - Codex `runtime-review`: the Guardian approved it.
  - Claude Auto `runtime-review`: only that the call went through the runtime in a mode
    whose classifier gates it. This is the trust the administrator chose with Needs
    approval. An administrator who wants a person chooses Always ask.
- **Key confidentiality.** A ticket binds to the agent grant and one `toolCallId`. An agent
  that extracts its grant key can only replay an id that the daemon already ticketed, once,
  within two minutes, for the same tool.
  - In a sandbox pod, a runtime receives only its own session's definitions.
  - On a self-hosted daemon without sandboxing, agents run under the daemon's user and share
    one trust domain, as they already do for the daemon's other credentials.
  - The public documentation states this.
- **Self-loosening.**
  - Policy writes are interactive-only (§5.5).
  - Disabling and re-enabling a provider does not reset a policy (§5.4).
  - Switching to a mode that cannot ask makes approval-gated tools refused, not allowed
    (§7.2).
- **Annotations.** Annotations never reach an enforcement decision. They seed the groups,
  and the administrator's save fixes the table.
- **Content stays on the data plane.** A ticket carries ids, a tool name and a source.
  Arguments stay between the runtime, the daemon's approval card, and the relay.
- **CP outage.** Relays keep their bindings and tables, and daemons keep their definitions,
  so Always allow and Blocked keep working. Tickets cannot travel, so approval-gated calls
  are refused until the CP returns. Policy edits and catalog refreshes wait.

## 10. Console

The agent's Tools card lists each enabled provider with **Full access** or **Restricted**,
plus counts per decision. Opening a provider shows the panel, modeled on Claude's connector
settings:

- a preset selector: Full access, Read-only, Approve writes, Ask for writes, Custom;
- the three collapsible groups with counts, each with an
  **Always allow / Needs approval / Always ask / Blocked** selector carrying the §3.2
  descriptions;
- per-tool rows with title, description excerpt, Interactive and Destructive badges, and
  the same selector, shown as following the group until overridden;
- a catalog timestamp with a refresh action;
- a drift banner ("3 new tools are blocked until you review them");
- the mixed-version warnings of §8;
- a runtime warning when the agent's runtime and mode refuse an approval decision under
  §7.2. For example, Codex Full access refuses both approval decisions, and Codex Auto
  review refuses Always ask;
- hand-entered tool names when no catalog is available.

The provider page shows the same grouped catalog read-only. Both form factors follow the
console's responsive rules in `packages/web/STYLE.md`.

## 11. Tests

- **Protocol:**
  - codec round-trips for the new `rc/mcp-assign` fields, both ticket frames, and `agentId`
    and `toolDecisions` on `mcpserver/*`;
  - old-shape decoding unchanged.
- **CP `test:unit`:**
  - group derivation, including absent annotations;
  - expansion of all four decisions with overrides and hand-typed names;
  - drift detection never altering the table;
  - per-relay and per-daemon gating;
  - projection of shared versus agent-scoped definitions;
  - ticket validation: an agent not served, a tool not gated, and expiry.
- **CP `test:int`:**
  - policy CRUD and its RBAC;
  - interactive-only refusal for API keys and delegated calls;
  - grant mint, unassign and revoke ordering;
  - cascade on agent and provider deletion;
  - disable and re-enable keeping the policy;
  - catalog fetch against a fake MCP server (JSON, SSE, pagination, limits, failure codes).
- **Relay:**
  - blocked `tools/call` never forwarded, allowed one forwarded;
  - batches;
  - `tools/list` filtering over JSON and SSE, including pagination and the 4 MiB limit;
  - an unrestricted grant on the same provider stays byte-transparent;
  - `open_connector` enforcement;
  - snapshot replay prunes restricted grants;
  - tickets: a ticket arriving before and after the call, the 3-second wait, expiry, and
    single use;
  - tickets: a mismatched tool, `runtime-review` rejected for an `ask` tool, and a call
    without a known id.
- **Daemon:**
  - `CpMcpDefs` agent-layer precedence and convergence;
  - the Apps host connection scope for agent-scoped `ui` definitions;
  - every §7.2 row, driven by recorded ACP traces, including a mid-session mode change;
  - settings rules per decision;
  - once-only permission options.
- **Acceptance (#4164):** two agents enable one provider, one with the Read-only preset. A
  write call from the restricted agent is refused at the relay, while the same call from the
  other agent succeeds. A Needs approval call goes through after an approval and is refused
  after a rejection.

## 12. Live check

**Setup.** Measured on 2026-11-20 with the pinned harnesses, `claude-agent-acp` 0.109.0 and
`codex-acp` 2.8.0-agentconnect.1 (`codex` 0.170.0):

- a fake Streamable HTTP MCP server with four tools: one annotated read-only, one annotated
  destructive, one carrying `_meta["anthropic/requiresUserInteraction"]`, and one
  unannotated;
- an ACP client declaring the daemon's client capabilities.

| Runtime and mode            | Setup                                                                    | Observed                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Claude `bypassPermissions`  | `requiresUserInteraction` tool                                           | `request_permission` with only allow-once and reject; the call ran 23 ms after the answer                            |
| Claude `bypassPermissions`  | session `permissions.ask` rule                                           | `request_permission`; the call ran after the answer                                                                  |
| Claude `bypassPermissions`  | unannotated tool, no rule                                                | No prompt; the call ran                                                                                              |
| Claude `bypassPermissions`  | `requiresUserInteraction`, answer reject                                 | The call never reached the server                                                                                    |
| Claude `auto`               | `destructiveHint: true` tool                                             | No prompt and no verdict on ACP; the call ran 1.1 s after its `tool_call` appeared                                   |
| Claude `default`            | `destructiveHint: true` tool                                             | `request_permission`; the call ran 26 ms after the answer                                                            |
| Codex `agent` (Auto review) | destructive tool                                                         | Guardian Review update with `review.status: "approved"` and `targetItemId`; the call ran 4 ms later; no person asked |
| Codex `agent-full-access`   | destructive tool                                                         | No prompt; the call ran                                                                                              |
| Codex `workspace-write`     | unannotated tool                                                         | `request_permission` keyed by the call's `toolCallId`                                                                |
| Codex, any mode             | per-tool `approval_mode` via `CODEX_CONFIG` on an ACP-provided server    | Rejected at session start: "invalid transport"                                                                       |
| Codex `agent-full-access`   | full server definition in `CODEX_CONFIG` with `approval_mode = "prompt"` | Ignored; no prompt                                                                                                   |
| Codex `agent` (Auto review) | same                                                                     | The Guardian decided; no person asked                                                                                |

**Call ids.** Every `tools/call` carried the ACP `toolCallId` in `params._meta`: Claude as
`claudecode/toolUseId`, Codex as `callId`.

**Relay asking via elicitation (evaluated alternative).**

- The question reached the client for Claude `bypassPermissions`, Codex `agent` and Codex
  `workspace-write`. Codex `agent-full-access` declined it automatically within 3 ms.
- A call held for 75 seconds completed on both harnesses.

That alternative was set aside because it cannot honor a runtime's automatic review
(§2 Non-goals).

**Remaining before the approval stage ships:**

- a run on a real daemon with a chat card;
- a Claude Auto classifier refusal, to confirm the call is never sent;
- the ticket path across two relay pods.

## 13. Delivery

1. This design, with the matching updates to
   [centralized-tool-management.md](centralized-tool-management.md).
2. Protocol fields and relay allow/block enforcement behind `mcp-tool-policy-v1`.
3. Daemon agent layer and Apps host scope behind `mcp-agent-defs-v1`.
4. CP schema, catalog fetch, policy routes, grant lifecycle, projection and gating.
5. Console panel and public documentation. **Needs approval** and **Always ask** are
   selectable only once stage 6 has shipped.
6. Approval:
   - the relay ticket check;
   - the ticket frames and CP routing;
   - the daemon's runtime-gate observation and settings rules.

   It ships after the remaining checks of §12.

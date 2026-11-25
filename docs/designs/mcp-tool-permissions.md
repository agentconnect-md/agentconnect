# Per-agent MCP tool permissions

**Status**: Proposed
**Scope**: protocol + control-plane + relay + daemon + web
**Depends on**: [centralized-tool-management.md](centralized-tool-management.md), [github-app-git-credentials.md](github-app-git-credentials.md) (Phase 2: the daemon credential proxy)
**Issue**: [#4164](https://github.com/agentconnect-md/agentconnect/issues/4164)

> **Architecture**: an administrator sets each tool of an organization MCP provider, for one
> agent, to one of the four decisions of Claude's connector settings: **Always allow**,
> **Needs approval**, **Always ask**, or **Blocked**.
>
> - A restricted `(agent, provider)` pair receives **its own grant**, and the relay binds
>   that grant's hash to a per-tool decision table. For restricted grants only, the relay
>   parses MCP: it hides and refuses Blocked tools.
> - The restricted grant key **never enters the runtime**. The runtime holds a placeholder,
>   and the daemon's credential proxy exchanges it for the key, the way code-host tokens and
>   provider API keys already work.
> - **Approval does not happen in the relay.** The runtime keeps asking the way it already
>   does: a person in a manual mode, its own automated reviewer in an auto-review mode. The
>   daemon observes the outcome on ACP. Because every restricted call passes through the
>   daemon's proxy, the daemon forwards an approval-gated call only when the call matches an
>   approval it recorded: the same tool call id, tool and arguments, used once.
>
> The CP computes the decision table when the policy is saved and is absent from the call
> path.

## 1. Background

An organization MCP provider is enabled on an agent as a whole. Every agent that enables it
presents the same organization-shared grant to the relay, so the relay cannot tell agents
apart and every agent can call every tool. The motivating request (#4164): some agents
should read through a server but not write through it, while other agents keep full access
to the same server.

Five facts shape the design. The last three were measured (§12):

- **Enforcement must sit where the call happens.** Hiding a tool is not authorization, so
  something on the call path must refuse calls. That requires per-agent grants.
- **An approval is only as strong as the custody of the key.** A runtime that holds the
  grant key can call the relay without the approval it was supposed to wait for. The daemon
  is the only party that sees the approval, so the daemon should hold the key, which is the
  rule the credential proxy already established for code hosts and model providers.
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
- **The call can be tied to its approval.**
  - The `tools/call` request a runtime sends carries the ACP `toolCallId` in
    `params._meta`: `claudecode/toolUseId` from Claude, `callId` from Codex. That is the same
    id the daemon sees in the permission request or the reviewer's verdict.
  - The call's `arguments` equal the `rawInput` that ACP showed for that id (Codex nests them
    under `rawInput.arguments`).

## 2. Goals / Non-goals

**Goals**

- Per agent and per provider, an administrator chooses **Full access** (today's behavior)
  or sets each tool to one of the four decisions. Presets cover the common cases.
- A blocked call is refused for that agent, while another agent with full access to the
  same provider still succeeds.
- An approval-gated call reaches the upstream only when it matches an approval that the
  decision accepts, for the same tool and the same arguments, once.
- Defined behavior for each runtime mode, including modes that cannot ask (§7.3).
- Defined behavior for tools without annotations, tools added after the policy was saved,
  and tools whose annotations change.
- Works for `custom` and `open_connector` providers, and through a CP outage.
- No change for agents and providers without a policy.

**Non-goals**

- Guarding against the agent's editors. The policy restricts the agent:
  - any editor of the agent can return it to Full access;
  - a new agent starts at Full access;
  - a restricted agent that delegates work to an unrestricted agent gets that agent's
    access for the delegated work.
- Asking from the relay, and relay-side approval tickets. Both were evaluated (§12.2).
- Remembered approvals ("allow for this session"). Every approval covers exactly one call.
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

| Decision           | Console description                                                     | What lets a call through                                         |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Always allow**   | The agent uses it without asking.                                       | Nothing more                                                     |
| **Needs approval** | The agent asks before each use, except in a mode with automatic review. | A matching approval from a person or the runtime's review (§7.3) |
| **Always ask**     | A person approves each use, even in a mode with automatic review.       | A matching approval from a person                                |
| **Blocked**        | The agent cannot see or use it.                                         | Nothing; hidden from `tools/list`                                |

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

## 4. Tool catalog

The console needs each provider's tool list. The CP stores one snapshot per provider:

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
characters. It is metadata, not message content.

**The relay fetches it.** The CP never presents an upstream credential: the base goal keeps
upstream secrets used only by relays.

- The CP sends a control request, `rc/mcp-catalog { providerId }`, to a relay connected to
  its process that advertises `mcp-tool-policy-v1`.
- The relay answers with `rc/mcp-catalog/ok { tools } | { failure }`. It uses the binding
  it already holds and its authoritative §5.3 egress, so an upstream the operator allowed on
  the relay is reachable here too.
- For a `custom` provider the relay acts as a minimal Streamable HTTP MCP client.
  - It sends `initialize`, `notifications/initialized`, then `tools/list` following
    `nextCursor`, and ends the session with `DELETE`.
  - It accepts `application/json` and `text/event-stream` responses.
  - Limits: 10 pages, 1,000 tools, 1 MiB in total, and a 10-second budget.
- For an `open_connector` provider it lists the service's actions as its adapter already
  does.

**When.** On provider creation and update, on demand from the console, and when the policy
panel opens on a snapshot older than 24 hours.

- A failure keeps the previous snapshot and records `failure`. One code is
  `relay_unavailable`, when the CP process has no capable relay.
- This is a control operation outside the call path. It waits for a relay like any other
  control request.

**Without a catalog.** When no snapshot exists yet, the console accepts tool names typed by
hand as overrides, and the decision table consists of those overrides alone.

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

`McpGrant` gains `agentId String?` and `custody String?`:

- `agentId` `null` is the organization-shared grant, unchanged.
- A non-null `agentId` is the grant of one restricted `(agent, provider)` pair. Its
  `custody` is `daemon` or `runtime` and never changes (§5.6).

`currentMcpGrant` selects the newest active grant **per slot**, `(provider, agent, custody)`, and rotation applies per
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

| Event                                      | Effect                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First policy saved for `(agent, provider)` | Mint the agent grant of the custody each serving daemon needs (§5.6). Push the relay binding (§6.1) **before** the agent-scoped definition (§7.1) to the daemons serving the agent, the existing order for a new key.                                     |
| Policy changed                             | Re-push the relay binding and the definition's decision table. The keys are unchanged, and the next call is judged against the new table, mid-session included. Names that become approval-gated stay Blocked for a `runtime` grant (§5.6).               |
| Policy removed (Full access)               | Push `mcpserver/remove{agentId}` so the agent falls back to the shared definition, then revoke the grant and send `rc/mcp-unassign{providerId, grantKeyHash}`.                                                                                            |
| Agent disables the provider                | The policy row and its grant persist, and no definition is projected while the provider is disabled. Re-enabling restores the same restriction rather than Full access.                                                                                   |
| Agent moves                                | The target receives the agent-scoped definition through the owned activation, after placement commits and before `agent/activate` (base §7), carrying the grant whose custody matches the target (§5.6). The source's agent-scoped definition is removed. |

`mcpDefsForAgents` projects, for each agent that enables a provider:

- the shared definition, as today, when the agent has no policy;
- an agent-scoped definition carrying the agent grant for the receiving daemon (§5.6) and
  its decision table, when it has one.

The register snapshot, `duty/fetch`, live pushes and the move path all go through this one
projector.

### 5.5 HTTP surface

| Route                                                          | Purpose                                    |
| -------------------------------------------------------------- | ------------------------------------------ |
| `GET /api/v1/mcp-providers/:id/tools`                          | Catalog snapshot, `fetchedAt`, `failure`   |
| `POST /api/v1/mcp-providers/:id/tools/refresh`                 | Ask a relay to fetch the catalog now       |
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

### 5.6 Grant custody

The relay may accept an approval only for a grant whose key no runtime has ever held. One
rule decides this, and every other row derives from it:

- **`daemon` custody.** The CP delivers the grant only to daemons advertising
  `mcp-tool-approval-v1`. Those daemons hand their runtimes a placeholder, never the key
  (§7.2), and keep CP definitions in memory only. The relay's table for the grant carries
  the approval-gated names.
- **`runtime` custody.** Every other agent grant, including every grant minted before stage 6. A runtime may hold its key. The relay's table for the grant always has the
  approval-gated names as Blocked, whatever the policy says.
- **Projection.** A daemon advertising `mcp-tool-approval-v1` receives the agent's `daemon`
  grant; any other daemon receives its `runtime` grant. The CP mints each one when it is
  first needed. Both may be active at once, for example on two daemons or during an upgrade,
  and the relay judges each hash by its own custody.
- **No grant changes custody.** Serving the agent from a capable daemon for the first time
  mints a `daemon` grant; it never promotes an existing `runtime` grant. That direction
  needs no overlap, because the `runtime` grant never had approvals to lose. A grant of
  either custody is revoked once no daemon serving the agent needs it.

So a key delivered during stages 2–5, or to an older daemon, or kept by a runtime after the
policy changed, can never carry an approval past the relay, even with a forged header.

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
- Each restricted grant points at the table its custody allows (§5.6). `approval` and
  `ask` are non-empty only for a `daemon` grant, and only toward relays that also advertise
  `mcp-tool-approval-v1`. Everywhere else those names are sent as Blocked (§8).
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
- `tools/call` with a name in `approval` or `ask` must carry the daemon's approval header
  (§7.2). For an `ask` tool, the header's source must be `person`. Such names exist only in
  the table of a `daemon` grant, whose key only the daemon holds (§5.6), so the header is a
  consistency check behind the daemon's own judgment, not the approval itself.
- The relay removes `X-AC-Tool-Approval` before forwarding upstream.
- Any other `tools/call` is refused with a tool result, so the model sees why and stops
  retrying:
  `{ content: [{ type: 'text', text: 'The tool "<name>" is blocked for this agent.' }], isError: true }`.
- A batch containing a call that is not in `allow` is answered entirely by the relay. Each
  request member receives the refusal or an error naming the refused member. This is not
  worth more complexity for a construct the 2025-06-18 protocol removed.
- **The relay forwards what it judged.** It re-serializes the parsed message rather than
  forwarding the original bytes, so a difference between its parser and the upstream's
  (duplicate keys, for example) cannot carry a Blocked call past it.
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

**Unchanged.**

- `GET` streams and `DELETE` pass through.
- A `notifications/tools/list_changed` only makes the client list again, and that list is
  filtered.
- A `tools/list` response replayed on a resumed `GET` stream is not filtered. That affects
  hiding only: a call to a Blocked tool is still refused.

**`open_connector`.** The relay already terminates MCP for these providers. The same checks
guard `callTool` and filter `listTools`.

**Logging.** A refused call logs at info with the provider id and tool name, never the grant
key or the arguments. The relay has no general metrics surface today, so a refusal counter
waits for one.

The relay reads no annotations and holds no table other than the CP's. Group logic and drift
live in the CP, so a relay never loosens access on its own.

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
- The Apps host dials the relay from the daemon with the agent grant, not through the proxy.
  It applies the same table: Always allow passes, Blocked is refused, and approval-gated
  tools are refused, because no runtime gate stands in front of a bridge call.
- Facts are unchanged. Agent-scoped definitions, like other CP definitions, are not folded
  into the daemon's fact set.

### 7.2 Restricted calls through the credential proxy

The CP delivers an agent-scoped definition to the daemon with the grant key, as every
definition is delivered today.

- A daemon without `mcp-tool-approval-v1` receives a `runtime` grant (§5.6) and hands that
  definition to the runtime unchanged. Allow and block are then enforced by the relay alone,
  and approval-gated tools are Blocked there.
- A daemon advertising `mcp-tool-approval-v1` receives a `daemon` grant and hands the
  runtime a **placeholder** in the `Authorization` header instead, never the grant key:

- The credential proxy gains a third placeholder kind, `mcp-grant`, sealed for the agent,
  the provider and the relay origin. It joins the existing kinds, code-host tokens and
  provider API keys. The name keeps it apart from the proxy's existing `mcp` helper channel.
- It rides the listeners and tunnels those kinds already use in every execution strategy.
  Executor tunnels gain an `mcp-grant` scope.
- Only sessions of an agent with a `daemon` grant get a route for the relay origin. The
  proxy passes any request without its placeholder through unjudged, as it does for other
  hosts, so agents without a policy and unrestricted grants are unaffected.
- A `GET` stream on this route is exempt from the code-host tunnels' five-minute idle cut,
  because MCP server streams are idle and long-lived. It is capped at four concurrent
  streams per session instead. A cut stream is reopened by the client, as Streamable HTTP
  allows. POSTs follow the existing request limits.
- The proxy terminates TLS for the relay origin with the daemon CA that sessions already
  trust.
- A runtime that bypasses the proxy reaches the relay with the placeholder and is refused
  with 401. Whether a client honors the proxy is a usability question, never an exposure
  (§12.3).

For each request to the relay origin, the proxy does the following:

1. It drops any inbound `X-AC-Tool-Approval`, opens the placeholder, and resolves the
   agent's agent-scoped definition. A
   placeholder for another agent, or one presented at another origin, is refused.
2. `GET` and `DELETE` are forwarded with the grant key swapped in.
3. A POST is parsed as JSON-RPC, and every `tools/call` is judged against the definition's
   table:
   - **Always allow:** forwarded.
   - **Blocked:** refused locally, with the relay's wording.
   - **Needs approval and Always ask:** the proxy reads the call id from `params._meta`
     (`claudecode/toolUseId` or `callId`) and looks up the approval record (§7.4). It
     accepts the call only when all of these hold:
     - the record exists and has not been used;
     - the record has not expired;
     - its tool equals `params.name`;
     - its argument digest equals the digest of `params.arguments`;
     - its source satisfies the decision (`person` for Always ask).

     It then consumes the record and adds the approval header
     `X-AC-Tool-Approval: <source>`. Otherwise it refuses with an `isError` result: "The
     tool "<name>" requires approval, and this call was not approved."
4. The proxy forwards the message it judged, re-serialized, with the grant key in place of
   the placeholder.

Approval is enforced on the daemon, next to the record. It needs no CP and no relay state,
and it survives a CP outage.

### 7.3 Runtime gates

The daemon arranges each runtime's own gate so that it asks where the decision requires, and
records the gate's outcome. The Claude tool name is `mcp__<server>__<tool>`, with the
runtime's name normalization applied.

| Runtime and mode                                       | Needs approval                                                                                                                                                            | Always ask                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude manual modes (`default`, `acceptEdits`, `plan`) | Runtime asks a person: record `person` on an allow answer                                                                                                                 | Same                                                                        |
| Claude `auto`                                          | Claude's classifier decides. ACP shows no verdict, so the daemon records `runtime-review` when the call's `tool_call` appears; a call the classifier blocks is never sent | Daemon adds a `permissions.ask` rule, so a person is asked: record `person` |
| Claude `bypassPermissions`                             | Daemon adds a `permissions.ask` rule, so a person is asked: record `person`                                                                                               | Same                                                                        |
| Claude `dontAsk`                                       | Runtime denies the call                                                                                                                                                   | Same                                                                        |
| Codex `read-only`, `workspace-write`                   | Runtime asks a person: record `person` on an allow answer                                                                                                                 | Same                                                                        |
| Codex `agent` (Auto review)                            | The Guardian Review update for `targetItemId` with `review.status: "approved"`: record `runtime-review`                                                                   | Refused: the reviewer, not a person, decides                                |
| Codex `agent-full-access`                              | Refused: nothing asks                                                                                                                                                     | Refused                                                                     |
| Any other runtime                                      | Refused until its gate and call id are verified                                                                                                                           | Refused                                                                     |

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
"always" answer would produce no record for later calls.

### 7.4 Approval records

A record is `{ agentId, toolCallId, tool, argsDigest, source, expiresAt }`.

- It is kept in the daemon's memory for two minutes, bounded per agent, and dropped on
  expiry or use.
- `argsDigest` is the SHA-256 of the canonical JSON (sorted keys) of the arguments ACP showed
  for that id: Claude's `rawInput`, Codex's `rawInput.arguments`.
- A record is created only by a row of §7.3 that yields one. For Claude Auto, a later
  `tool_call_update` that reports the call failed or was refused deletes the record.

## 8. Compatibility and rollout

Each mixed-version case fails closed:

| Peer lacks the feature                     | CP behavior                                                                                                                                   | Effect                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay without `mcp-tool-policy-v1`         | Its `rc/mcp-assign` omits restricted grants, and it is never asked for a catalog                                                              | A restricted agent's call through that relay gets 401                                                                                                                            |
| Daemon without `mcp-agent-defs-v1`         | Drops the restricted provider from that agent's projected `AgentSpec.mcpServers`, so the shared definition is never attached to it            | The restricted agent loses the provider on that daemon                                                                                                                           |
| Relay without `mcp-tool-approval-v1`       | Sends `approval` and `ask` names as Blocked                                                                                                   | Approval-gated tools are refused through that relay                                                                                                                              |
| Daemon without `mcp-tool-approval-v1`      | Delivers the `runtime` grant, whose relay table has `approval` and `ask` names as Blocked (§5.6), and sends them as Blocked in the definition | Approval-gated tools are refused at the relay, even with a forged header                                                                                                         |
| Runtime shim without the `mcp-grant` scope | Nothing; the daemon reads the shim's version                                                                                                  | The daemon attaches the provider to none of that shim's sessions and reports which shim needs an upgrade; a placeholder could not reach the proxy, and the key must not leave it |

`mcp-tool-approval-v1` belongs to stage 6 alone (§13), so the CP and the console can tell a
peer that enforces allow and block from one that also handles approvals.

The console shows each condition on the policy panel. A relay pool in mid-upgrade can
therefore return intermittent refusals for restricted agents. That is the accepted cost of
never falling open.

Delivery order: relay and daemon land first and stay dormant, because no CP sends them the
new fields. The CP and console follow. The migration is additive, and nothing changes until a
policy row exists.

## 9. Security

- **Who the policy restricts.** The agent, not its editors (§2 Non-goals).
- **Boundary.**
  - Blocked is enforced twice: by the daemon's proxy and by the relay's per-call check on
    the agent grant.
  - Approval is enforced by the daemon's proxy, which alone holds the restricted grant key.
  - Hiding tools is a convenience on top.
- **What an approval proves.**
  - `person`: a person allowed that call, with those arguments, once.
  - Codex `runtime-review`: the Guardian approved that call.
  - Claude Auto `runtime-review`: only that the runtime proposed that call in a mode whose
    classifier gates it. ACP shows no verdict. A party holding the session's placeholder
    could therefore run a call the classifier refused, with exactly the proposed arguments,
    before the refusal arrives. This is the trust the administrator chose with Needs
    approval. An administrator who wants a person chooses Always ask.
- **Key custody.** A `daemon` grant's key never enters a runtime, and only such a grant can
  carry an approval past the relay (§5.6). A `runtime` grant's key may sit in a runtime, and
  its approval-gated names are Blocked at the relay.
  - A placeholder is useful only through the daemon's proxy, for its own agent and origin,
    and within that agent's table and records.
  - On a self-hosted daemon without sandboxing, agents run under the daemon's user and share
    one trust domain with the daemon's memory, as they already do for its other
    credentials. The public documentation states this.
- **Self-loosening.**
  - Policy writes are interactive-only (§5.5).
  - Disabling and re-enabling a provider does not reset a policy (§5.4).
  - Switching to a mode that cannot ask makes approval-gated tools refused, not allowed
    (§7.3).
- **Annotations.** Annotations never reach an enforcement decision. They seed the groups,
  and the administrator's save fixes the table.
- **Upstream credentials.** Only relays present them, including for the catalog fetch (§4).
- **Content stays on the data plane.** Arguments are seen by the runtime, the daemon's
  approval card and proxy, and the relay. The CP sees policies and catalog metadata only.
- **CP outage.** Relays keep their bindings and tables, and daemons keep their definitions
  and records, so every decision keeps working. Policy edits and catalog refreshes wait.

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
  §7.3. For example, Codex Full access refuses both approval decisions, and Codex Auto
  review refuses Always ask;
- hand-entered tool names when no catalog is available.

The provider page shows the same grouped catalog read-only. Both form factors follow the
console's responsive rules in `packages/web/STYLE.md`.

## 11. Tests

- **Protocol:**
  - codec round-trips for the new `rc/mcp-assign` fields, `rc/mcp-catalog`, and `agentId`
    and `toolDecisions` on `mcpserver/*`;
  - old-shape decoding unchanged.
- **CP `test:unit`:**
  - group derivation, including absent annotations;
  - expansion of all four decisions with overrides and hand-typed names;
  - drift detection never altering the table;
  - per-relay and per-daemon gating for both capabilities;
  - custody: a capable daemon receives the `daemon` grant and an older one the `runtime`
    grant; the `runtime` table never carries approval-gated names; first service from a
    capable daemon mints rather than promotes; revocation once unused;
  - projection of shared versus agent-scoped definitions, including the move path.
- **CP `test:int`:**
  - policy CRUD and its RBAC;
  - interactive-only refusal for API keys and delegated calls;
  - grant mint, unassign and revoke ordering;
  - cascade on agent and provider deletion;
  - disable and re-enable keeping the policy;
  - catalog refresh through a fake relay, including `relay_unavailable`.
- **Relay:**
  - blocked `tools/call` never forwarded, allowed one forwarded;
  - batches;
  - the re-serialized message forwarded instead of the original bytes;
  - the approval header required, and `person` required for `ask` tools;
  - a `runtime` grant refused for an approval-gated tool even with the header;
  - the header removed before the upstream;
  - `tools/list` filtering over JSON and SSE, including pagination and the 4 MiB limit;
  - an unrestricted grant on the same provider stays byte-transparent;
  - `open_connector` enforcement;
  - snapshot replay prunes restricted grants;
  - catalog fetch against a fake MCP server (JSON, SSE, pagination, limits, failure codes).
- **Daemon:**
  - `CpMcpDefs` agent-layer precedence and convergence;
  - the Apps host connection scope for agent-scoped `ui` definitions;
  - the `mcp-grant` placeholder kind: wrong agent, wrong origin, a bypass with the
    placeholder, and an inbound approval header dropped;
  - a request without the placeholder passing through unjudged;
  - the Apps host refusing approval-gated tools;
  - a shim without the scope: the provider is not attached;
  - the proxy's judgment for each decision;
  - approval records: a mismatched tool, mismatched arguments, a reused record, expiry, a
    call without a known id, and a Claude Auto refusal deleting the record;
  - every §7.3 row, driven by recorded ACP traces, including a mid-session mode change;
  - settings rules per decision, and once-only permission options.
- **Acceptance (#4164):**
  - Two agents enable one provider, one with the Read-only preset. A write call from the
    restricted agent is refused, while the same call from the other agent succeeds.
  - A Needs approval call goes through after an approval and is refused after a rejection.
  - The same call replayed with other arguments is refused.

## 12. Evidence and alternatives

### 12.1 Live check

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

**Call ids and arguments.** Every `tools/call` carried the ACP `toolCallId` in
`params._meta`: Claude as `claudecode/toolUseId`, Codex as `callId`. Its `arguments` equaled
the `rawInput` that ACP showed for that id (Codex: `rawInput.arguments`).

### 12.2 Alternatives

| Approach                                                                  | Why not                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The relay asks** through MCP elicitation and holds the call             | It works mechanically:<br>• the question reached the client for Claude `bypassPermissions`, Codex `agent` and Codex `workspace-write`;<br>• Codex `agent-full-access` declined it within 3 ms;<br>• a call held for 75 seconds completed on both harnesses.<br>But it replaces the runtime's gate instead of honoring its automatic review, and an answer reaching another relay pod needs a cross-pod hop. |
| **Daemon tickets** broadcast through the CP to every relay                | • The CP joins the per-call path, against base §3.<br>• A broadcast ticket consumed per pod is not single-use across the pool.<br>• The ticket binds no arguments.<br>• While the runtime holds the key, a caller can post first and wait for the ticket.                                                                                                                                                   |
| **The daemon's credential proxy** holds the key and checks a local record | Chosen. The approval and the check live in the same process, the record binds the arguments, and nothing crosses the CP or the relay pool.                                                                                                                                                                                                                                                                  |

### 12.3 Remaining before the approval stage ships

- Claude's and Codex's MCP HTTP clients honoring the proxy variables and the trust bundle,
  in every execution strategy. A client that does not still fails closed, with a 401 at the
  relay.
- `params.arguments` equal to ACP `rawInput` (Codex: `rawInput.arguments`) for large,
  deeply nested and non-ASCII arguments. A mismatch refuses an approved call.
- A run on a real daemon with a chat card.
- A Claude Auto classifier refusal: the call is never sent, and the record is deleted.

## 13. Delivery

1. This design, with the matching updates to
   [centralized-tool-management.md](centralized-tool-management.md).
2. Protocol fields, relay allow/block enforcement and the relay catalog fetch, behind
   `mcp-tool-policy-v1`. This stage also refreshes item 3 (the MCP proxy) of
   `.oss-scanner/threat_model.md`.
3. Daemon agent layer and Apps host scope behind `mcp-agent-defs-v1`.
4. CP schema, catalog storage, policy routes, grant lifecycle, projection and gating.
5. Console panel and public documentation. **Needs approval** and **Always ask** are
   selectable only once stage 6 has shipped.
6. Approval, behind `mcp-tool-approval-v1`:
   - the credential proxy's `mcp-grant` placeholder;
   - the proxy's judgment and approval records;
   - the runtime-gate observation and settings rules;
   - the relay's approval-header check and per-custody tables;
   - folding the restricted path into base §3 and §7 and into the Phase 2 placeholder
     kinds of github-app-git-credentials.md, which carry pointers to this document now.

   It ships after the checks of §12.3.

# Administering AgentConnect: MCP tools and the REST API

Two channels exist for inspecting and changing platform state. Always prefer the
first that is available:

1. **AgentConnect admin MCP tools** — present when this session was granted the
   admin toolset. Names match the catalog below. This is the ONLY channel through
   which you execute admin calls yourself.
2. **The user's own client** — without admin MCP tools you never execute admin
   calls: point the user at the console, or use the REST reference below to help
   them run the API from their own credentialed environment. Never ask for, hold,
   or use an API key yourself — a static key would make every call execute and
   audit as the key's owner rather than the person talking to you.

Both channels hit the same routes with the same permission model (RBAC + resource
visibility of the acting user) and the same audit trail; the MCP layer adds
confirmation gates and rate limiting on top.

## The admin MCP toolset

Ground every admin task with **`whoami`** first — it returns the authenticated user,
the bound organization, and the caller's role.

### Read tools

| Tool               | Arguments                                                                                                    | Returns                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `whoami`           | —                                                                                                            | Acting user + organization + role. Call first.                                   |
| `listAgents`       | —                                                                                                            | Visible agents (id, name, status, runtime, placement).                           |
| `getAgent`         | `agentId`                                                                                                    | One agent's full configuration and status.                                       |
| `listDaemons`      | —                                                                                                            | Daemons (edge units) with status and reported runtimes.                          |
| `listCrons`        | —                                                                                                            | Scheduled-task definitions.                                                      |
| `getCron`          | `cronId`                                                                                                     | One cron definition.                                                             |
| `listCronRuns`     | `cronId`                                                                                                     | Run history, newest first (status, duration, session link).                      |
| `listSessions`     | `agentId?`, `platform?` (slack/telegram/webchat/discord/hook/dream), `channel?`, `limit?` (≤200, default 50) | Recent sessions — metadata only (title, status, channel, last activity, tokens). |
| `getSession`       | `sessionId`                                                                                                  | One session's metadata (phase, link, summary — not the transcript).              |
| `getUsage`         | `range?` (`d1`/`d7`/`d30`/`d90`, default `d7`)                                                               | Token/cost aggregates, totals + per-agent breakdown.                             |
| `listIntegrations` | —                                                                                                            | Platform integrations (bot ↔ agent bindings) with per-channel triggers.          |
| `listBots`         | —                                                                                                            | Durable bot identities (metadata only — never token material).                   |
| `listMembers`      | —                                                                                                            | Org members and roles.                                                           |
| `listAgentHooks`   | `agentId`                                                                                                    | Inbound-webhook triggers of an agent.                                            |
| `listHookRuns`     | `hookId`                                                                                                     | Webhook delivery/run history, newest first.                                      |

### Write tools

May be hidden entirely when the credential is read-only (`mcp:read` without
`mcp:write`). Credential, member, organization, access-control, bot, and hook
**writes are deliberately not exposed** — direct users to the console for those.

| Tool                | Arguments                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `createAgent`       | `name` (immutable slug), `runtime` (from the daemon's reported runtimes), `displayName?`, `description?`, `model?`, `reasoningEffort?`, `outputMode?` (none/minimal/low/medium/high), `fastMode?`, `permissionMode?`, `approvalsReviewer?`, `daemonId?` (omit → unplaced), `pause?`                            | Workspace, env vars, secrets, memory, and sharing are console-only.                                                          |
| `updateAgent`       | `agentId` + any subset of the fields above (minus `name`/`daemonId`); `null` clears a nullable field (`model: null` resets to runtime default); `pause: true/false` pauses/resumes                                                                                                                             | Partial update; the slug is immutable. A delegated session cannot mutate its own agent.                                      |
| `deleteAgent`       | `agentId`, `confirm`                                                                                                                                                                                                                                                                                           | **IRREVERSIBLE.** `confirm` must exactly equal the agent's `name` slug.                                                      |
| `renameDaemon`      | `daemonId`, `name` (≤64 chars)                                                                                                                                                                                                                                                                                 | Display name only; identity and placement unaffected.                                                                        |
| `upsertCron`        | `agentId`, `schedule` (croner syntax, e.g. `"0 9 * * MON-FRI"`), `trigger` (the prompt sent each firing), `cronId?` (edit existing; omit → create), `name?`, `timezone?` (IANA), `targetPlatform?` (slack/telegram/discord/feishu), `targetChannel?` (omit → headless run), `targetIntegrationId?`, `enabled?` |                                                                                                                              |
| `runCron`           | `cronId`                                                                                                                                                                                                                                                                                                       | Fire once now (async), in addition to the schedule.                                                                          |
| `deleteCron`        | `cronId`, `confirm`                                                                                                                                                                                                                                                                                            | **IRREVERSIBLE.** `confirm` = the cron's `name`, or its id when unnamed.                                                     |
| `setChannelTrigger` | `integrationId`, `channelId`, `trigger?` (`off`/`mention`/`any`), `agentId?` (owning agent for the channel; `null` clears the override)                                                                                                                                                                        | The per-conversation behavior switch.                                                                                        |
| `removeIntegration` | `integrationId`, `confirm`                                                                                                                                                                                                                                                                                     | **IRREVERSIBLE** (bot identity survives and can be re-linked; channel wiring is lost). `confirm` = the integration's `name`. |

### Confirmation gate (destructive tools)

`deleteAgent`, `deleteCron`, and `removeIntegration` require a `confirm` argument
that must **exactly** equal the resource's name. This is a deliberate re-type
representing the user's decision:

1. Look the resource up and restate to the user exactly what will be removed and
   what is lost.
2. Wait for the user's explicit approval.
3. Only then call the tool with `confirm` set to the resource name.

A mismatch returns HTTP 412 without revealing the expected value. Never loop:
fetch-name → immediately-pass-as-confirm without the user's go-ahead defeats the
gate's purpose.

### Limits and failure modes

- Rate limit: ~120 calls / 30 writes per credential per minute. Batch reads; don't
  poll tightly.
- `403` on a write → the credential lacks `mcp:write`, or the target is protected
  (e.g. the `agentconnect` preset cannot be renamed or deleted).
- Empty lists may mean "not visible to this user," not "none exist."

## The REST API (reference for the user's own client)

This section exists so you can EXPLAIN the API and DRAFT commands — not run them.
You never call these routes yourself: doing so would require an API key, and any
key available to you (in chat, in the environment, in a file) is a static
credential whose calls execute and audit as the key's owner rather than the
initiating user — a model the platform design explicitly rejects. The user runs
these requests from their own machine: they mint a personal key in the console
(profile → API keys), export it in their own shell, and paste your drafted
commands. The key never enters the conversation.

### Connecting (what the user sets up in their own shell)

- **Base URL**: the Control Plane / console origin of the org's deployment. The
  URL is not a secret; discussing it in chat is fine.
- **Auth header**: `Authorization: Bearer <personal API key>` — minted in the
  console, exported by the user as e.g. `$AGENTCONNECT_API_KEY`, never shared
  with you.
- **Versioning**: everything lives under `/api/v1`.
- **Self-description**: `GET {base}/api/v1/openapi.json` returns the complete
  OpenAPI 3.1 document (Swagger UI at `{base}/docs`) — point the user there when
  they need payload shapes beyond the map below.

### Route map

Identity and org discovery:

```
GET /api/v1/me            # the caller's profile and memberships
GET /api/v1/orgs          # organizations visible to the caller
GET /api/v1/orgs/{orgId}  # one organization
```

Org-scoped resources (all under `/api/v1/orgs/{orgId}`); this mirrors the MCP
catalog one-to-one:

```
GET    /agents                     GET    /agents/{id}
POST   /agents                     PATCH  /agents/{id}        DELETE /agents/{id}
GET    /agents/{id}/hooks          GET    /hooks/{hookId}/runs
GET    /daemons                    PATCH  /daemons/{id}          # rename
GET    /sessions?agentId&platform&channel&limit
GET    /sessions/{id}
GET    /crons                      GET    /crons/{id}
GET    /crons/{id}/runs            # run history, newest first
PUT    /crons/{id}                 # upsert (client-generated UUID to create)
POST   /crons/{id}/run             DELETE /crons/{id}
GET    /integrations               DELETE /integrations/{id}
PATCH  /integrations/{integrationId}/channels/{channelId}   # trigger / owning agent
GET    /bots
GET    /members
GET    /usage?range=d7             # d1 | d7 | d30 | d90
```

### Example commands to draft for the user

These assume the user exported `$AGENTCONNECT_API_URL` and `$AGENTCONNECT_API_KEY`
in their own shell; fill in the non-secret placeholders (`$ORG`, ids) from what
you learned in conversation and let the user run them.

```bash
# Who am I, and which orgs can I see?
curl -sS -H "Authorization: Bearer $AGENTCONNECT_API_KEY" "$AGENTCONNECT_API_URL/api/v1/me"
curl -sS -H "Authorization: Bearer $AGENTCONNECT_API_KEY" "$AGENTCONNECT_API_URL/api/v1/orgs"

# List agents, then one agent's full config
curl -sS -H "Authorization: Bearer $AGENTCONNECT_API_KEY" "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/agents"
curl -sS -H "Authorization: Bearer $AGENTCONNECT_API_KEY" "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/agents/$AGENT_ID"

# Create an agent (runtime must come from a daemon's reported runtimes)
curl -sS -X POST -H "Authorization: Bearer $AGENTCONNECT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"reviewer","displayName":"Reviewer","runtime":"claude-code"}' \
  "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/agents"

# Pause an agent
curl -sS -X PATCH -H "Authorization: Bearer $AGENTCONNECT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"pause":true}' "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/agents/$AGENT_ID"

# Weekday-morning schedule (upsert with a fresh UUID to create)
curl -sS -X PUT -H "Authorization: Bearer $AGENTCONNECT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"agentId":"'$AGENT_ID'","name":"Standup digest","schedule":"0 9 * * MON-FRI",
       "timezone":"America/New_York","trigger":"Summarize yesterday'\''s merged PRs."}' \
  "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/crons/$(uuidgen)"

# Mute a bot in one channel
curl -sS -X PATCH -H "Authorization: Bearer $AGENTCONNECT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"trigger":"off"}' \
  "$AGENTCONNECT_API_URL/api/v1/orgs/$ORG/integrations/$INTEGRATION_ID/channels/$CHANNEL_ID"
```

When drafting destructive `DELETE`s, spell out the blast radius next to the
command so the user decides with full context; note the raw REST routes carry no
`confirm` re-type gate (that is MCP-layer protection), and the `agentconnect`
preset agent rejects rename/delete by design.

## Common diagnostic flows

**"My agent isn't answering in Slack."**
`listDaemons` (is the owning daemon online?) → `getAgent` (placed? paused? runtime
ready?) → `listIntegrations` (does a binding exist; is that channel's trigger
`off`?) → `listSessions` filtered to the agent (did a session start and fail?).

**"What is this costing us?"**
`getUsage` with `d1`/`d7`/`d30`/`d90` for totals and the per-agent breakdown;
`listSessions` to attribute spikes to specific runs.

**"Set up a daily job."**
`listAgents` → pick the agent → `upsertCron` with schedule + timezone + trigger
prompt; optionally target a platform channel for delivery, or omit `targetChannel`
for a headless run. Verify with `listCronRuns` after the first firing or `runCron`
to test immediately.

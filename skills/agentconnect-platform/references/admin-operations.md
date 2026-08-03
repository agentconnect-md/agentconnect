# Administering AgentConnect: MCP tools and the REST API

Two channels exist for inspecting and changing platform state. Always prefer the
first that is available:

1. **AgentConnect admin MCP tools** — present when this session was granted the
   admin toolset. Names match the catalog below.
2. **REST API** — direct HTTP calls to the Control Plane, only with a credential
   that was provisioned into the agent's environment outside the conversation.
   Without either, admin changes go through the console — never ask the user for
   a key in chat.

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

## The REST API (fallback — pre-provisioned credential only)

Use when no admin MCP tools are present in the session AND the agent's environment
already carries a credential an org admin provisioned outside the conversation
(e.g. `AGENTCONNECT_API_URL` / `AGENTCONNECT_API_KEY` set in the agent's
configuration). **Never solicit a credential in chat** — a key pasted into the
conversation enters model context and transcripts, and every call made with it
executes and audits as the key's owner, not the person talking to you. With no
configured credential, do not attempt admin operations: direct the user to the
console surface that performs the change, or to the org's AgentConnect MCP
endpoint (console → Help → "Connect your AI").

### Connecting

- **Base URL**: from the configured environment (the Control Plane / console origin
  of the org's deployment). The URL is not a secret; asking the user for it is fine.
- **Auth header**: `Authorization: Bearer <the configured key>` — never invent, log,
  or echo key material.
- **Versioning**: everything lives under `/api/v1`.
- **Self-description**: `GET {base}/api/v1/openapi.json` returns the complete
  OpenAPI 3.1 document (Swagger UI at `{base}/docs`). Fetch it before assuming an
  endpoint or payload shape — the surface below is a map, not the full contract.

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

### Examples

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

The same safety rules apply as over MCP: destructive `DELETE`s only after the user's
explicit approval, and the `agentconnect` preset agent rejects rename/delete by
design.

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

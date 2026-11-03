# Local doorbell

A process on the daemon's own host can ask one of the daemon's agents for a
turn. The process names an agent and a doorbell the agent's config declares; the
daemon either posts a new top-level message at that doorbell's target and runs
the turn in its thread, or runs the turn in an existing thread of the target's
channel. A typical caller is a companion process that watches something only
this host sees (a build, a log, a local queue) and wants the agent to act on it.

The doorbell is the first route of the daemon's **local API**: HTTP served on a
local IPC socket that only the daemon's OS user can open. Issue #3579 proposed
it. The second is the choice-card routes, which place a card at the same declared
targets: see [choice-cards.md](choice-cards.md).

## Why a host-local seam in addition to webhook triggers

[Generic webhook triggers](webhook-triggers-and-github-events.md) already map
one external event to one agent turn. A hook is defined in the Control Plane
(CP), reached through the relay at a capability URL, and its runs are reported
to the CP. The doorbell does not replace that, and it is not a second hook
system. It covers two cases a hook cannot:

- **No relay.** A self-hosted daemon with direct platform connections and no
  relay deployment has no public ingress for a hook to arrive on.
- **Same-host latency and reach.** The caller is on the daemon's machine. A
  round trip through the public relay adds latency and asks the caller to hold an
  internet-facing capability URL for an event that never left the host.

How the two relate:

|                   | Webhook trigger                  | Doorbell                                            |
| ----------------- | -------------------------------- | --------------------------------------------------- |
| Declared in       | the CP (console)                 | the agent's `agent.json`, like a hand-authored cron |
| Reached through   | the relay, over the internet     | `<root>/run/local.sock`, on the host                |
| Caller proves     | the capability URL and signature | that it runs as the daemon's OS user                |
| Place it posts to | the hook's configured target     | the doorbell's configured `target`                  |
| Session trigger   | `hook:<hookId>`                  | `doorbell:<doorbellId>`                             |
| CP sees           | definition, runs, sessions       | sessions only                                       |

**What the CP sees.** A doorbell session is reported on the ordinary
`event/session` path, like a cron's. Its `platform`, `channel` and `thread` are
the target's real coordinates (for example `slack`, the channel id and the
anchor's ts). Its `triggeredBy` is `doorbell:<doorbellId>`, from the message's
`sessionTriggerId` (`session-manager.ts`, `triggeredBy:
msg.sessionTriggerId ?? msg.sender.id`). `triggeredBy` is first-wins, so a
doorbell turn that continues a session a person opened keeps that person as the
trigger. The CP's `classifySession` treats the `doorbell:` prefix as automation
(`AUTOMATION_TRIGGER_PREFIXES` in `domain/session-visibility.ts`): the session
is `org`-visible with no owner, the same as a cron or hook session. The CP does
not receive the doorbell declarations themselves, and it records no per-ring run
history. A deployment that needs CP-defined, CP-audited triggers uses a webhook
trigger.

## Trust premise

The socket is the authority. There is no token.

- **Listener.** `localIpcPath(root, 'local')` — `<root>/run/local.sock`, beside
  the MCP control socket (`mcp`) and the git-credential socket (`gitcred`).
  `LocalApiServer` (`daemon/src/local-api/server.ts`) uses the start and stop
  discipline of the MCP control server: the `run/` directory is created and
  chmodded `0700`, a stale socket is removed, `node:http` listens on the path,
  and the socket is chmodded `0600`. If that chmod fails, the server stops and
  startup reports the error. Stop destroys open connections, closes the
  server and removes the file. There is no TCP listener, so no address can be
  bound beyond the host.
- **Who can ring.** Only processes of the daemon's OS user (and root). On a
  shared host another local user cannot open the socket. An agent without an
  AgentConnect sandbox runs as the daemon's user and can reach the socket; the
  [execution trust model](architecture.md#91-execution-trust-model) already
  makes such an agent operator-trusted, with the same reach to `agent.json` and
  daemon state.
- **Sandboxed agents cannot reach it.** The `srt` boundary hides the daemon root
  and carves back only the MCP socket (`sandboxBoundary`'s `mcpSocketPath`). The
  `microsandbox` VMs and the pool's pods receive only the `mcp` and `gitcred`
  tunnels (`sockets: { mcp, gitcred }` in the microsandbox install options,
  `tunnelsForAgent` for pods).
  The local socket is added to none of these lists.
- **No Windows.** On Windows `localIpcPath` is a named pipe, which has no
  owner-only file mode for this design to rely on. `LocalApiServer.start`
  refuses, logs one warning and returns `false`; the daemon runs without the
  local API.
- **Opt-in.** The listener exists only with `localApi.enabled: true` in the
  daemon's `config.json`. The default is off.

## Targets and threads

An agent declares the places a doorbell may ring it at:

```json
"doorbells": [
  {
    "id": "builds",
    "name": "Build alerts",
    "target": { "platform": "slack", "channel": "C0123ABC", "integrationId": "…" }
  }
]
```

`target` has the cron target's shape. `integrationId` picks the posting
integration; when it is absent, the daemon uses the agent's first integration on
`target.platform`. `id` is 1–64 characters of `[A-Za-z0-9_-]`. `name` is the
sender name the agent sees and defaults to `Doorbell`.

The declaration is the consent. An editor of the agent chose the place, so a new
post goes through `anchorTrigger` exactly as a cron's does: the §5.3 place
check runs, and `postIntoConfiguredTarget` joins a public channel the bot is not
in (#2979). The caller cannot name a channel. The request schema is strict, so
a body with `channel` or `integrationId` is refused with 400.

A `thread` is accepted only as a thread of the target's channel; the channel
comes from the declaration and the caller supplies only the thread id. On that
path the daemon probes whether the channel is a DM, then calls `keySession`
before dispatch. An `append`-mode room, or a room a task holds, therefore keys
the turn on the same session coordinate a person's message in that thread would
reach. The message carries the integration's `transportScope` before
`keySession` runs, as platform ingress does, because the append coordinate is
keyed on it.

## Request contract

`POST /v1/doorbell` on the socket, a JSON body of at most 64 KiB:

```json
{ "agent": "<agent id>", "target": "<doorbell id>", "thread": "<optional>", "text": "…", "post": "<optional>" }
```

- `agent` is the agent **id**. Display names are not looked up: crons and hooks
  name agents by id too.
- `text` is the turn's prompt. `post` is the top-level message that opens a new
  thread and defaults to `text`; it is ignored with `thread`.

| Status | Meaning                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 202    | admitted; the body has the `channel` and `thread` the turn runs in                                                          |
| 400    | the body fails the schema                                                                                                   |
| 404    | unknown agent, or the agent declares no such doorbell                                                                       |
| 409    | the agent is served by another member, the doorbell names no integration of the agent, or the daemon did not admit the turn |
| 503    | the new post could not be made (agent paused, draining, or not connected)                                                   |

Example:

```sh
curl --unix-socket ~/.agentconnect/run/local.sock http://local/v1/doorbell \
  -H 'content-type: application/json' \
  -d '{"agent":"<agent id>","target":"builds","text":"Build 42 failed; look at it"}'
```

## Message contract

A doorbell is its own trigger kind, beside `cron` and `hook`:

| Field                 | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `msgId`               | `doorbell:<agentId>:<doorbellId>:<uuid>`                                   |
| `source` / `trigger`  | `doorbell` / `doorbell`                                                    |
| `sender`              | `{ id: 'doorbell:<doorbellId>', isBot: true, name: <name or 'Doorbell'> }` |
| `sessionTriggerId`    | `doorbell:<doorbellId>`                                                    |
| `platform`, `channel` | the target's integration platform and channel                              |
| `thread`              | the caller's `thread`, or the new anchor's thread                          |
| `transportScope`      | the integration's, as ingress sets it                                      |

`source: 'system'` stays reserved for daemon-minted continuations (PR feedback,
capability wakes).

## How each source and trigger check treats a doorbell

Every comparison on `source` and `trigger` in the daemon was audited. A doorbell
falls on the non-person side of each, as a cron or a hook does. Only one site
changed.

- **Changed — model selection** (`sessionDecisionState` in `daemon.ts`). A
  doorbell builds the same state as a cron: `modelSelectionState('cron', text)`,
  a configured trigger whose prompt is judged on its own text with no
  conversation history. The `source` values a decision sees
  (`'chat' | 'agent' | 'cron'`) are unchanged, so no CP decision contract moves.
- **Person-only gates stay closed** (`source === 'user'` or `!== 'user'`):
  `place-members.ts`, `memory/layers.ts`, `mcp/ops/assistant-items.ts`,
  `webchat/narrowed-scope.ts`, `daemon/steering-admission.ts`,
  `daemon/loop-guard-scope.ts`, `platforms/observed-channels-sync.ts`,
  `platforms/malformed-turn.ts`, the per-platform turn-output and reaction
  files, `session-manager.ts` (no `[sender]` prompt prefix, no advertised
  commands, no sender time zone) and the `daemon.ts` sites for the reminder
  requester, the task stopper, the external asker, the admission and repair
  notices, conversation discovery, bot-sender routing and the search origin. A
  doorbell is not a person: "who is asking" rules see nobody, no
  person memory is captured, it does not steer into a live turn, and the person
  loop guard does not count it.
- **`auto` session mode** (`autoCoordinateFor`): a non-person message keeps its
  own session, as a cron or hook does. `keySession` still applies a task-held
  room and `append` mode.
- **Batching** (`coordinator-turns.ts`, `coordinator-sessions.ts`, the batch
  cut in `daemon.ts`): a non-person message heads its own turn and is treated as
  a report, as a cron is.
- **Acknowledgement** (`acknowledgeTrigger`, `user` or `hook` only): no
  reaction, as for a cron. There is no person's platform message to react to;
  a new post's anchor is the bot's own message.
- **External binding** (`daemon.ts`, "a system turn binds only when its
  destination is attributable"): a doorbell always has its integration and
  realm, so it binds.
- **Durable replay** (`source === 'agent' || source === 'system'` attaches a
  webchat wake context): a doorbell is not included, so a replayed doorbell row
  on a Slack integration is not given a webchat wake.
- **Cron-only and hook-only sites** (`cronRun` bookkeeping, `handleRelayHookMsg`,
  the hook dispatch context, code-host decision state): not applicable.
- **`isBot: true` sender.** `commandSenderAllowed` refuses bot senders, so a
  doorbell text that starts with `/` is not run as a control command. Name
  resolvers do not look up `doorbell:<id>` as a platform user.
- **Control plane.** `AUTOMATION_TRIGGER_PREFIXES` gains `doorbell:`. The three
  `HOOK_TRIGGER_PREFIX` sites (`http/routes/sessions.ts`,
  `persistence/repositories/session.repo.ts`, `ws/handlers/event-session.ts`)
  are unchanged: they resolve `hook:<id>` to a CP hook definition, which a
  doorbell does not have.
- **Console label.** The web console's `sessionTriggerKind`
  (`web/src/lib/session-trigger.ts`) classifies a `doorbell:` trigger as its own
  `doorbell` kind, so the Sessions trigger filter lists it under Doorbells with a
  bell glyph and the sender's configured name, never under People.

## Not in scope

- A CP-side definition, console editing or run history for doorbells.
- Ringing a place that is not declared, including a place the agent already
  has a session in.
- Windows support.

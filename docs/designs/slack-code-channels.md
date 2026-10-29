# Slack Code Channels Integration

> **Status:** Draft — a design against the generally available Slack Code API; nothing here is
> implemented. Slack opened the code-channel API to every app on 2026-10-28 (§2.3), which
> replaces this document's earlier "partner-only beta" assessment and answers most of its open
> questions (§7). File/line references describe the shipped machinery as of 2026-10-29.
>
> **Scope:** protocol + daemon, with a console row change (§5.10) and a manifest change that
> costs existing installs a reauthorization (§5.11). Slack only — a code channel is a Slack
> construct, and the daemon's Slack module already owns every primitive it extends (§4).
>
> Related documents:
> [integration-plugin-architecture.md](integration-plugin-architecture.md) (the seam every
> host change lands in),
> [slack-streaming-turn-output.md](slack-streaming-turn-output.md) (why body streaming
> stays rejected),
> [slack-integration-install.md](slack-integration-install.md) (scopes and reinstall),
> [slack-approval-dm.md](slack-approval-dm.md) (the approval wait §5.1 surfaces),
> [session-visibility.md](session-visibility.md) (`conversationKind`),
> [webchat-side-panels.md](webchat-side-panels.md) (the console's diff and PR panels),
> [../product-conventions.md](../product-conventions.md).

## 1. Background and goal

On 2026-08-20 Slack announced Slack Code and its _code channel_: a channel that an agent opens
for one piece of longer-running work, where a team watches the agent's plan, diff, and previews
in dedicated tabs, steers it, and approves before anything ships. On 2026-10-28 Slack made the
Slack Code API generally available on all plans, after more than 150 customers and partners
asked to build code-channel experiences for their own agents.

This document answers: how does AgentConnect put its agents into code channels? Up front:

- **It can now, as a true code channel.** Any app holding `code_channels:manage` with
  `features.code_channels.enabled` in its manifest can create one, write its tabs and context
  bar, and archive it (§2.3–§2.4). Socket Mode apps qualify (§2.5).
- **Most of the foundation is shipped.** Agent Sessions, the native Stop, the plan renderer,
  canvases, and channel creation all exist in the daemon's Slack module (§4).
- **One structural gap is real.** A code channel is one session per _channel_ with top-level
  replies; AgentConnect's Slack sessions are one per _thread_ (§5.3). Closing that gap is the
  heart of the work.
- **The differentiator is the runtime.** Every launch partner hosts the agent itself.
  AgentConnect is the self-hosted entry: Claude Code or Codex running over ACP on the
  organization's own daemon, with the workspace, diff, and plan produced next to the checkout
  and written straight to Slack (§3).

## 2. What Slack Code is

### 2.1 The product

- **Only an agent can open one.** A member mentions the agent in a conversation and the agent
  decides whether the request warrants a code channel; or the member picks _Create a code
  channel_ in the sidebar and selects an agent. With an origin conversation, the new channel
  inherits its privacy unless the agent overrides `is_private`.
- **What it carries.** The conversation; agent-written _views_ (tabs): a plan canvas, a
  diff, a pull request, HTML pages, Block Kit panels; a _context bar_ of up to five pinned items
  (repository, branch, PR, CI status); agent-registered slash commands. Anyone in the channel
  can talk to the agent without a mention, request changes, or stop it.
- **Lifecycle.** Active code channels sit in their own sidebar section and show _Working_,
  _Idle_, _Needs attention_, _Done_, or _Inactive_ — the Agent Sessions states. When the work
  is done the agent archives the channel, optionally sharing a summary back to the message
  that started it; the archive stays searchable as the audit log.
- **Availability.** All Slack plans, no extra cost.

### 2.2 The generally available foundation it extends

| Primitive                  | Wire surface                                                                                                                                                               | Note                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agent messaging experience | `features.agent_view` manifest block                                                                                                                                       | Supersedes `assistant_view`, deprecated 2026-08-20, retired February 2027 |
| Agent Sessions             | `agents.sessions.setStatus` with `processing` / `active` / `suspended` / `closed`; `agents.sessions.rename`; events `agent_session_stopped`, `agent_session_title_changed` | `suspended` means the agent needs user input; `closed` means done         |
| Native streaming           | `chat.startStream` / `chat.appendStream` / `chat.stopStream`; `task_update` and `plan_update` chunks render as task cards                                                  | A stream expires after about five minutes                                 |
| Active-view context        | `app_context_changed` event; `app_context` on DM messages                                                                                                                  |                                                                           |

A code channel is an Agent Session whose scope is a whole channel instead of a thread: for a
session channel `agents.sessions.setStatus` and `agents.sessions.rename` take `channel_id`
and **must omit** `thread_ts`, and renaming the session renames the channel.

### 2.3 The API: `agents.conversations.*`

Nine methods, all requiring the bot scope `code_channels:manage` and a bot token; the calling
bot becomes the channel's agent. Shapes are from Slack's own SDKs (§2.7).

| Method                                  | Arguments                                                                                                                                                               | Behavior and limits                                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.conversations.create`           | `name`; `session_id?`; `is_private?`; `origin_channel_id?` + `origin_message_ts?` (together); `team_id?` (org tokens without an origin)                                 | Returns `channel_id`. `session_id` makes the call idempotent. With an origin, the channel is named from the origin message, its author is invited, and Slack seeds the request (mention included) into the new channel. No Slack Connect origin.            |
| `agents.conversations.setView`          | `channel_id`; `type` = `html` / `diff` / `block_kit` / `canvas` / `pull_request`; `view_key`; `content` / `blocks` / `canvas_id` / `pr_url`; `name`; type-specific args | Upsert by `view_key` (a `diff` view is a per-channel singleton). `html` is a self-contained document and `diff` is raw unified diff, each capped at 1,000,000 bytes (`content_too_large`). Diff takes `base_branch` / `head_branch`; canvas `access_level`. |
| `agents.conversations.listViews`        | `channel_id`                                                                                                                                                            | The views currently attached.                                                                                                                                                                                                                               |
| `agents.conversations.removeView`       | `channel_id`; exactly one of `view_key` / `view_id`                                                                                                                     |                                                                                                                                                                                                                                                             |
| `agents.conversations.setCanvasContent` | `channel`; `canvas_id`; `content` (full markdown)                                                                                                                       | Slack diffs it against the current content and rewrites only changed sections, so comments on untouched sections survive.                                                                                                                                   |
| `agents.conversations.getCanvas`        | `channel`; `canvas_id`; `content_format?`; `include_resolved?`                                                                                                          | Reads the canvas and its comment threads — the team's feedback on the plan.                                                                                                                                                                                 |
| `agents.conversations.setProperties`    | `channel_id`; `code_channel { context_bar_items[], summary_message }`; `agent_resource { url, resource_type, title, provider }`                                         | Partial update, except `context_bar_items` (≤ 5, replaced as a set). An item is `key`, `label`, `icon`, `url`, `item_type` = `info` or `action` (a click delivers `code_channel_action`). Read back through `conversations.info` → `channel.properties`.    |
| `agents.conversations.setCommands`      | `channel_id`; `commands[] { name, description, argument_hint, should_escape }`                                                                                          | Replaces this agent's set; at most 10 commands across all agents in the channel.                                                                                                                                                                            |
| `agents.conversations.archive`          | `channel_id`; `summary_message_ts?`                                                                                                                                     | The summary is shared as a thread reply on the origin message; `no_origin_link` when the channel was started from Slack's UI.                                                                                                                               |

A code channel is recognizable from `conversations.info`: `channel.properties.record_channel.record_type`
is `agent_channel`, and `channel.properties.agent_session.origin_link` carries the origin
`{ channel_id, ts }`.

### 2.4 Manifest, scope, and events

From Slack's reference coding agent (§2.5):

```json
"features": {
  "agent_view": { "...": "..." },
  "code_channels": { "enabled": true, "slash_command_url": "https://<host>/slack/events" }
},
"oauth_config": { "scopes": { "bot": ["...", "code_channels:manage"] } },
"settings": {
  "event_subscriptions": {
    "bot_events": ["agent_session_stopped", "app_mention", "channel_archive", "group_archive", "message.channels", "message.groups", "message.im", "..."]
  },
  "socket_mode_enabled": true
}
```

- `code_channels:manage` is a **separate** bot scope. Slack's original developer post spelled it
  `code.channels:manage` "under `assistant:write`"; the shipped SDKs, the method references, and
  the sample all request `code_channels:manage` alongside `assistant:write`. Existing installs
  must reauthorize (§5.11).
- `slash_command_url` is where agent-registered commands are delivered for HTTP apps.
- `channel_archive` / `group_archive` tell the agent that a human archived the channel.

### 2.5 What Slack's reference agent does

`slack-samples/bolt-js-coding-agent` (Claude Agent SDK and OpenAI Agents SDK variants, read at
commit `effa7a5`) is the authoritative usage pattern, and it is close to AgentConnect's shape —
an agent running commands in a local checkout:

- **Entry.** A mention (or DM) runs a turn whose only tool is `create_code_channel`; the model
  decides between answering in place and creating a channel. `session_id` is derived from the
  triggering message, not the model, so a retried event reuses the channel. The origin thread
  gets "Follow along in #channel"; the seeded mention in the new channel starts the first turn
  there, with the origin conversation fetched as context.
- **Addressing.** Inside a code channel every human message is a turn, mention or not. A
  message that arrives during a turn joins an inbox the next turn drains.
- **Session identity.** One session per code channel, keyed by channel id, found after a
  restart through `conversations.info` properties. Replies are top-level `chat.postMessage`
  with `markdown_text`; the sample does not stream.
- **Status.** `processing` at turn start, `active` at turn end, `suspended` while an Approve /
  Deny card waits, `closed` before archiving. On `agent_session_stopped` the agent stops the
  turn and writes `active` itself — Slack does not.
- **Tabs.** Plan: `canvases.create`, then `setView` `type: canvas`, `access_level: comment`
  (agent is sole author, the team comments), later `setCanvasContent`; `read_plan` reads comments
  through `getCanvas`. Diff: `git diff <cloned commit>` plus untracked files, `setView`
  `type: diff` with base and head branch. Context bar: repo, branch, PR, CI.
- **Commands.** The agent registers per-channel commands (`/run-tests`); each invocation becomes
  the next turn's text.
- **End.** Post a summary, `setStatus closed`, `archive` with `summary_message_ts`, retry
  without it on `no_origin_link`. A human archive (`channel_archive`) discards the session and
  deletes its working directory.
- **Manifest.** `socket_mode_enabled: true` — Socket Mode apps reach code channels.

### 2.6 The launch partners

Anthropic (Claude Code), Cognition (Devin), GitHub (Copilot coding agent), and Vercel launched in
August, with OpenAI named. Every one runs the agent in the vendor's cloud. The GA API opens the
same surface to custom and self-hosted agents.

### 2.7 Source reliability

The research environment could not reach `slack.com`, `slack.dev`, or `docs.slack.dev`:

| Source                                                                                                 | How it was read             | Confidence                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------- |
| `slackapi/node-slack-sdk` `packages/web-api/src/types/request/agents.ts` and response types            | Fetched raw from GitHub     | High — generated from Slack's API definitions |
| `slackapi/python-slack-sdk` `slack_sdk/web/client.py`                                                  | Fetched raw from GitHub     | High                                          |
| `slack-samples/bolt-js-coding-agent` at `effa7a5`                                                      | Cloned and read             | High for the pattern it demonstrates          |
| Slack docs (_Slack Code_, _Lifecycle of a code channel_, _Code channel properties_, method references) | Search-index summaries only | Medium; consistent with the SDKs              |
| Slack Code API GA coverage, launch press                                                               | Search-index summaries      | Medium                                        |

## 3. Why this matters for AgentConnect

**The product shape is ours already.** A code channel is a team watching one agent work,
steering it, and approving its output — the interaction AgentConnect sells on Slack today, now
with a native home in the sidebar. Once teams are used to that section, an agent that cannot
appear in it looks less capable than the partner ones, whatever it can actually do.

**The runtime is the differentiator, and the invariant holds by construction.** A code channel
is a rendering target, like a thread is today. The daemon creates it, writes its tabs from the
checkout it owns, and archives it; the diff, the plan, and HTML views go daemon → Slack and
never cross the daemon–CP WebSocket. The CP records only control-plane metadata — the session
row, the channel id, a conversation subtype (§5.10)
([architecture.md](architecture.md)).

**The seam tells us where it lands.** A platform name is never core knowledge: a code channel is
a Slack capability read through the host contracts (§6), not a `switch` in core
([integration-plugin-architecture.md](integration-plugin-architecture.md)).

## 4. What already exists

| Slack Code needs                                | AgentConnect today                                                                                   | Where                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The `agent_view` manifest and `assistant:write` | Declared and emitted by the one code-generated manifest                                              | `packages/protocol/src/slack-app-manifest.ts:10`, `:130`                                                               |
| Agent Sessions status and the native Stop       | `agents.sessions.setStatus` / `rename`; `agent_session_stopped` handled                              | `packages/daemon/src/slack/connection.ts:3304`, `:3322`, `:3343`                                                       |
| A plan the team can watch                       | The native plan container on streaming turns; the in-place plan message otherwise                    | `connection.ts:1884`, `packages/daemon/src/slack/render.ts:360`                                                        |
| Open a channel and pull people in               | `createConversation` → `conversations.create` + `invite`, agent-callable                             | `connection.ts:3126`, `packages/daemon/src/mcp/tools.ts:586`                                                           |
| Canvases                                        | `createCanvas` → `conversations.canvases.create` / `canvases.create`, `updateCanvas`                 | `connection.ts:3178`                                                                                                   |
| Both transports                                 | Socket Mode, and HTTP Events through the relay, from one manifest builder                            | `packages/relay/src/platforms/slack/http-ingest.ts`, `packages/web/src/components/console/platforms/slack/manifest.ts` |
| Scope drift detection                           | Install checks and setup reconciliation name a missing scope                                         | `packages/control-plane/src/http/slack-manifest.ts`, `packages/setup/src/slack-app.ts`                                 |
| Every-message addressing                        | The per-conversation trigger (Off / every message / @-mention)                                       | [product-conventions.md](../product-conventions.md), _Per-conversation trigger_                                        |
| A local checkout and its git state              | The daemon owns the session workspace                                                                | [webchat-side-panels.md](webchat-side-panels.md) §3–§4                                                                 |
| PR coordinates from a turn                      | The code-host seam owns a delivery's reply target and final poster; Linear extracts links from prose | `packages/daemon/src/codehost/turn-final.ts:75`, `packages/daemon/src/platforms/linear/turn-output.ts:240`             |

What is missing:

| Need                                  | Gap                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One session per channel               | Slack normalization keys every message by `thread_ts ?? ts` (`packages/message/src/slack-message.ts:189`), so each top-level message in a code channel would be a new session |
| Channel-scoped lifecycle writes       | `setSessionLifecycle` always sends `thread_ts` and dedupes per `channel:thread`; a session channel requires it omitted                                                        |
| _Needs attention_ and _Done_          | The lifecycle union is `processing` / `active` only (`connection.ts:3346`)                                                                                                    |
| Create, tabs, context bar, commands   | No `agents.conversations.*` caller; no `code_channels:manage` scope; no `features.code_channels`                                                                              |
| Archive                               | Nothing calls `conversations.archive` or `agents.conversations.archive`; `channel_archive` / `group_archive` are not subscribed                                               |
| A code-channel session in the console | `conversationKind` is a closed enum of `dm` / `group_dm` / `channel` (`packages/protocol/src/frames/telemetry.ts:111`)                                                        |
| A diff                                | File edits arrive as ordinary tool calls; nothing captures a unified diff for a chat platform                                                                                 |

## 5. Design

### 5.1 The two missing session states

`SlackConnection.setStatus` maps any non-empty status text to `processing` and an empty one to
`active`. The `set-status` action (`SlackAction`, `render.ts`) gains an optional
`lifecycle: 'processing' | 'active' | 'suspended' | 'closed'`, and the converger emits:

- `suspended` while a `session/request_permission` or `elicitation/create` waits on a human —
  the wait [slack-approval-dm.md](slack-approval-dm.md) already narrates — and `processing`
  again once it resolves;
- `closed` before an archive (§5.7) and when the logical session closes.

This keeps the convention that Slack's lifecycle API takes a state, not phase text
([product-conventions.md](../product-conventions.md), _Session startup shows what the turn is
waiting for_). It applies to thread sessions too, so it ships first and on its own.

### 5.2 Recognizing a code channel

The Slack module classifies a channel once, on first sight, through `conversations.info`
(`record_channel.record_type === 'agent_channel'`, plus `agent_session.origin_link`), caches the
answer per channel id, and re-reads it after a restart. A channel this daemon created is known
without the read. The classification is a Slack-module fact handed to normalization and to the
renderer — core never sees the property names.

### 5.3 The channel-scoped session

In a code channel the conversation _is_ the session. Inbound, every message in a code channel —
top-level or a thread reply — normalizes to one coordinate `{ channel, thread: channel }`, so
the session key is `slack:<channel>:<channel>:<agentId>` and the existing per-session queue and
"a message sent during a running turn steers that turn" behavior carry over unchanged. Outbound,
the Slack module reads `thread === channel` as "session channel" and:

- posts top-level (no `thread_ts`), using `markdown_text`;
- calls `agents.sessions.setStatus` / `rename` without `thread_ts`;
- maps `agent_session_stopped` without a `thread_ts` back to the channel session.

The pure normalizer in `@agentconnect.md/message` takes the classification as an input instead
of looking it up. The Discord rule against using a parent channel as the thread-affinity key
(_Self-authored channel roots_) is about Discord's native threads and does not apply: a Slack
code channel has no root to thread from.

### 5.4 Addressing

Slack's model is that the people in a code channel are talking to the agent. The code
channel's conversation row is therefore seeded with the **every message** trigger when it is
first observed — the same mechanism that makes a newly observed DM start On — and an editor can
still change it. Bot messages, edits, and joins are ignored as everywhere else. Because the
fact is per channel and read at observation time, not a static platform property, it is not a
platform-manifest field (§5 of the plugin architecture).

### 5.5 The creation flow

The decision to open a channel is the agent's, exposed as an option on the existing tool, never
a core policy:

- `PlatformConversationSpec` gains an optional
  `code?: { origin?: { channel: string; messageTs: string } }` that Slack honors and other
  platforms reject as unsupported. The Slack member calls `agents.conversations.create` with
  `session_id` derived from the origin coordinates (idempotent on a retried turn), `name` from
  the agent, and privacy inherited unless the agent asked otherwise.
- The origin turn replies in place with the channel link and ends. It does not continue the
  work: Slack seeds the origin request into the new channel and that mention runs the first
  code-channel turn, under the session of §5.3.
- That first turn receives the origin conversation as preceding context, wrapped in the
  untrusted-content markers of `packages/daemon/src/messages/hook-message.ts`, never pasted as
  instructions.
- A channel created from Slack's sidebar has no origin; the first human message in it starts the
  session.

How the agent decides is two layers, both outside core:

- **Whether it can.** The `code` option is offered in the tool's schema only when the agent's
  _code channels_ setting is on and the install holds `code_channels:manage`; otherwise the model
  never sees it and answers in place.
- **Whether it should.** The tool description carries the criteria Slack's reference agent uses:
  open a channel when the work takes more than one message — several steps or back-and-forth,
  changing code, running builds or tests, opening a pull request, long output that would crowd
  the thread, or an explicit ask for a working space; answer in place for a question, a short
  explanation, or anything about the surrounding conversation; when unsure, answer in place and
  offer to go deeper. Unlike Slack's sample, which routes through a tool-less model that cannot
  read the repository, the origin turn is the full agent with its workspace, so it can look
  before deciding.

The deterministic parts stay in code: the `session_id`, privacy inheritance, and the tool result
that tells the model the work moved and to reply with the link only.

```mermaid
sequenceDiagram
    participant U as Team member
    participant S as Slack
    participant D as Daemon (Slack module)
    participant A as Agent runtime (ACP)
    U->>S: @agent "build X" in a thread
    S->>D: app_mention (Socket Mode, or HTTP Events via the relay)
    D->>A: session/prompt (origin thread session)
    A-->>D: tool call: createConversation { code: { origin } }
    D->>S: agents.conversations.create (session_id, origin)
    D->>S: "Follow along in #channel" in the origin thread
    S->>D: seeded app_mention in the code channel
    D->>A: session/prompt (channel session, origin context)
    D->>S: setStatus processing (no thread_ts)
    loop turn
        A-->>D: plan / tool_call / agent_message_chunk
        D->>S: top-level posts; Plan canvas; diff view; context bar
    end
    D->>S: setStatus active (Idle)
    U->>S: "change Y" (no mention needed)
    D->>S: setStatus suspended while an approval waits
    A-->>D: tool call: archiveConversation
    D->>S: summary post; setStatus closed; agents.conversations.archive
```

### 5.6 Views and the context bar

| Surface      | Slack call                                                            | Daemon source                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation | `chat.postMessage` (top-level)                                        | The existing output converger and post IR; tool chrome and approval cards unchanged                                                                                               |
| Plan         | `canvases.create` → `setView canvas` (`comment`) → `setCanvasContent` | ACP `plan` updates, rendered to markdown, written debounced; `getCanvas` comments are offered to the next turn as team feedback                                                   |
| Diff         | `setView diff` with `base_branch` / `head_branch`                     | `git diff` of the session workspace against the commit it started from, plus untracked files, at turn end; over 1 MB, truncated per file with a note and a console deep link      |
| Pull request | `setView pull_request`                                                | PR coordinates from the code-host seam where a code-host turn produced one, otherwise `codeHostLinks` lifted from the Linear module into a shared helper (its second implementer) |
| HTML         | `setView html` with `csp.resource_domains`                            | An agent-callable tool, for previews and reports the agent produced; never a page the daemon fetched                                                                              |
| Context bar  | `setProperties code_channel.context_bar_items`                        | Repository, branch, PR, and CI from the workspace and code-host state; rewritten as a set                                                                                         |
| Resource     | `setProperties agent_resource`                                        | The console's session URL, `provider: AgentConnect`, so the team can open the transcript and dock                                                                                 |

Plan and diff are written by the daemon on its own schedule, not by the agent; HTML is the only
agent-authored view. Publishing a diff shows code to everyone in the channel; the channel
inherits its origin's visibility, which is right, so the diff view is on by default for code
channels (unlike the earlier proposal of a `.patch` upload into an ordinary channel).

### 5.7 Archive

`archiveConversation?(channel: string, summaryTs?: string): Promise<void>` joins the
`PlatformConnection` contract beside `leaveChannel` (`packages/daemon/src/platforms/contract.ts:370`)
and the agent's platform actions beside `createConversation`. On a code channel the Slack member
posts the summary, writes `closed`, calls `agents.conversations.archive` with
`summary_message_ts`, and retries without it on `no_origin_link`.

Archiving is destructive for everyone in the channel, so the tool is fenced to code channels
whose agent is the calling bot and whose session this daemon owns; anything else requires an
explicit human decision through the elicitation path. A human archive arrives as
`channel_archive` / `group_archive`: the session closes, its workspace becomes reclaimable, and
the console row follows _Leaving a conversation and removing its row_ — it stays, marked
archived.

### 5.8 Stop

The existing `agentSessionStopped` already cancels the slot's displayed owner and settles to
`active`. For a session channel it resolves the channel session (§5.3) instead of a thread; the
sample confirms Slack never moves the status itself.

### 5.9 Commands

`setCommands` lets the agent offer per-channel shortcuts, delivered as slash commands over
Socket Mode or to `slash_command_url` (the relay's Slack endpoint) for HTTP apps. The
first version registers nothing automatically and exposes no tool; when it ships, a command
invocation becomes the next turn's text, as in the sample. AgentConnect's own control commands
are not re-registered here — they already work through the message shortcut and mention syntax.

### 5.10 A conversation subtype, not a wider `conversationKind`

`conversationKind` exists for visibility classification
([session-visibility.md](session-visibility.md) §4.1), and a code channel classifies exactly as
`channel`, so it does not earn a value there. Instead an optional, platform-defined
`conversationSubtype: z.string()` joins the session telemetry frame, stored verbatim by the CP
and read by the console only to pick a glyph and a grouping. Readers stay tolerant of unknown
strings; Slack writes `code_channel`.

### 5.11 Manifest and the reinstall cost

Scopes arrive with implemented callers. The change that ships §5.5 adds, together:
`code_channels:manage` to `SLACK_BOT_SCOPES`; `channel_archive` and `group_archive` to
`SLACK_BOT_EVENTS`; `features.code_channels { enabled: true }` to the manifest builder, with
`slash_command_url` set to the relay's Slack endpoint on the HTTP arm only. The install check
and setup reconciler then flag every existing install as missing a scope, which is the intended
prompt to reauthorize. Until an install has the scope the tool option is reported unsupported
and the agent answers in place; nothing degrades. `org_deploy_enabled` stays `false`.

### 5.12 The shared-bot arm

On the relay-forwarded, send-only arm a Slack event reaches every participant daemon, so a code
channel must have one writer. The daemon whose agent was mentioned creates it and owns it under
_Shared-bot conversation ownership_ ([product-conventions.md](../product-conventions.md)); tab
writes, status, and the archive are the owner's. Several agents of one shared bot in one code
channel are not designed here: Slack binds the channel to the calling bot, so they would share
one Slack agent identity (§7 Q3).

### 5.13 Deliberately not done

- **Body streaming** stays rejected until §7 Q1 is answered: a channel stream is live for one
  `recipient_user_id` ([slack-streaming-turn-output.md](slack-streaming-turn-output.md) §1), and
  Slack's own sample does not stream in code channels.
- **The agent picker.** Nothing to build: any app with `features.code_channels` is offered, and
  a sidebar-created channel is handled by §5.2–§5.3.
- **Core does not decide to open a channel.** No "Slack coding mention ⇒ code channel" branch;
  the agent chooses, as in the sample.

## 6. Where it lands in the four host contracts

- **protocol** — the scope, events, and `features.code_channels` in
  `slack-app-manifest.ts`; `conversationSubtype` on the telemetry frame; the `lifecycle` field on
  the status action.
- **message** — the code-channel input to Slack normalization and the channel-scoped coordinate
  (§5.3).
- **daemon** — the Slack module only: classification, the session-channel posting and lifecycle
  paths, `code` on `PlatformConversationSpec`, `archiveConversation`, and view / context-bar
  writers as optional connection members driven by the Slack turn output
  (`packages/daemon/src/platforms/slack/turn-output.ts`). The diff capture lives with the
  workspace and is platform-neutral, so the console's viewer and the Slack diff tab read one
  capture.
- **relay** — nothing structural. Code-channel events and agent commands are Slack events and
  slash commands on the existing endpoint; they demux on `api_app_id` / `team_id` as today.
- **control plane** — no new persistence beyond the subtype string.
- **web** — the row glyph and grouping; the wizard's manifest picks up scope and feature from the
  protocol constants.

## 7. Open questions

1. **Channel streaming.** Whether a top-level stream in a code channel is visible to every member
   or still to one `recipient_user_id`. Slack's lifecycle guide shows a top-level streaming
   message; only a live test decides whether the rejection is revisited for code channels.
2. **DM origins.** One summary of `agents.conversations.create` excludes DMs and group DMs as
   origins; Slack's sample README says a DM request "gets a code channel linked back to your
   message". Verify against the method reference before exposing the option in DMs.
3. **Multiple agents.** `setCommands` limits commands "across all agents in the channel", so
   Slack expects several agents in one code channel; how a second agent joins and whether it can
   write views is undocumented.
4. **Rate limits.** The Java SDK lists `archive` at tier 2 and `setView` / `getCanvas` at tier 3;
   the plan and diff writers debounce to stay well under them.

## 8. Risks

- **Reinstall.** Every existing install must reauthorize for `code_channels:manage`; §5.11 keeps
  everything else working until it does.
- **Session-key change.** §5.3 changes how Slack messages map to sessions, but only in channels
  classified as code channels; ordinary channels and DMs keep the per-thread key. Tests pin both.
- **A destructive archive.** §5.7 fences the tool to the agent's own code channels.
- **Carried context is untrusted.** Origin context is wrapped as untrusted content (§5.5).
- **Diff exposure.** The diff tab publishes workspace code to the channel's members, including
  any secret the agent wrote into a tracked or untracked file; the capture skips gitignored files,
  and an agent-level switch turns the diff view off.

## 9. Recommended sequencing

1. **§5.1 lifecycle states**, alone, with daemon unit tests passing on the Windows leg.
2. **§5.2–§5.4 and §5.8**: classification, the channel-scoped session, every-message seeding,
   channel-scoped Stop. Testable against a channel created from Slack's sidebar once the scope is
   granted on a test install.
3. **§5.5, §5.7, §5.10, §5.11**: create and archive, the subtype, the manifest change — the PR
   that costs reinstalls, so it ships with the feature that justifies them.
4. **§5.6**: Plan, diff, PR, and context bar, then HTML views and the resource link.
5. **§5.9** commands, and §7 Q1 streaming, once teams are using code channels.

## 10. Sources

Read directly:

- Slack Node SDK, `agents.*` request and response types —
  <https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/types/request/agents.ts>
- Slack Python SDK, `WebClient.agents_*` —
  <https://github.com/slackapi/python-slack-sdk/blob/main/slack_sdk/web/client.py>
- Slack sample, _Coding Agent for Slack_ — <https://github.com/slack-samples/bolt-js-coding-agent>

Read through search-index summaries only (§2.7):

- Slack, _Slack Code API_ — <https://slack.com/blog/developers/slack-code-api>
- Slack developer docs, _Slack Code_ — <https://docs.slack.dev/ai/slack-code/>
- _Lifecycle of a code channel_ — <https://docs.slack.dev/ai/slack-code/lifecycle/>
- _Code channel properties_ — <https://docs.slack.dev/ai/slack-code/code-channel-properties/>
- `agents.conversations.create` — <https://docs.slack.dev/reference/methods/agents.conversations.create/>
- `agents.conversations.setProperties` — <https://docs.slack.dev/reference/methods/agents.conversations.setProperties/>
- `agent_session_stopped` — <https://docs.slack.dev/reference/events/agent_session_stopped/>
- _Agent sessions_ — <https://docs.slack.dev/ai/agent-sessions/>
- Unite.AI, _Slack Code API Reaches General Availability on All Slack Plans_ —
  <https://www.unite.ai/slack-code-api-reaches-general-availability-on-all-slack-plans/>
- Slack Developers, _Slack Code: A dedicated place for agent work_ —
  <https://slack.dev/slack-code-a-dedicated-place-for-agent-work/>

# Slack Code Channels Integration

> **Status:** Proposed — a research assessment with a phased plan; nothing here is
> implemented. Slack's code-channel API is a partner-only beta (§2.3), so §5 is what
> AgentConnect can ship now on generally available Slack primitives and §6 is what waits on
> that API. File/line references describe the shipped machinery as of 2026-09-15.
>
> **Scope:** protocol + daemon, with one console row change (§5.3). Slack only — a code
> channel is a Slack construct, and the daemon's Slack module already owns every primitive
> Slack says it extends (§4).
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

On 2026-08-20 Slack announced Slack Code and its _code channel_: a new kind of channel that
an agent opens for one piece of longer-running work, where a team watches the agent's plan,
diffs, and a live preview in dedicated tabs, steers it, and approves before anything ships.
Five coding agents launched with it, every one of them running in its vendor's cloud.

This document answers one question: can AgentConnect put its agents into code channels, and
what does it take? The answer, up front:

- **Not as a true code channel today.** The code-channel API is a beta "available only to
  select partners", with no public documentation and no public application path (§2.3).
- **The foundation is already here.** Slack says code channels build on the Agent messaging
  experience, Agent Sessions, and native streaming — all shipped in the daemon's Slack
  module (§4).
- **A useful subset ships now** (§5), and every piece of it is groundwork the real
  integration needs rather than throwaway.
- **The differentiator is the runtime.** Every launch partner hosts the agent itself.
  AgentConnect would be the self-hosted entry: Claude Code or Codex running over ACP on the
  organization's own daemon, appearing in a code channel — the "any custom agent" case Slack
  says the API will open to (§3).

## 2. What Slack Code is

### 2.1 The product

- **Only an agent can open one.** A member tags a supported agent in any conversation and
  the agent decides whether the request warrants a code channel; or the member picks
  _Create a code channel_ in the sidebar, selects an agent from a dropdown, and chooses the
  visibility. The channel inherits the visibility of the conversation it came from.
- **What it carries.** Tabs for the conversation, the agent's plan, code diffs, and a live
  HTML preview, plus the repository and branch the agent is working in and the pull request
  it opens. Anyone in the channel can request changes or stop the agent.
- **Lifecycle.** Active code channels sit in their own sidebar section. Each shows one of
  _Working_, _Idle_, _Needs attention_, _Done_, or _Inactive_. When the work is done the
  agent archives the channel; it stays searchable and serves as the audit log.
- **Availability.** All Slack plans, no extra cost. Access to each partner agent is a separate
  purchase.

### 2.2 The generally available foundation it extends

Slack's developer post says the experience "builds on familiar Slack events and OAuth scopes
while introducing additional primitives designed specifically for Slack Code". The familiar
part is the Agent messaging experience of 2026-06-30, which is fully implemented in the open
source Chat SDK Slack adapter this assessment read (§2.5):

| Primitive                  | Wire surface                                                                                                                                                               | Note                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agent messaging experience | `features.agent_view` manifest block                                                                                                                                       | Supersedes `assistant_view`, deprecated 2026-08-20, retired February 2027 |
| Agent Sessions             | `agents.sessions.setStatus` with `processing` / `active` / `suspended` / `closed`; `agents.sessions.rename`; events `agent_session_stopped`, `agent_session_title_changed` | `suspended` means the agent needs user input; `closed` means done         |
| Native streaming           | `chat.startStream` / `chat.appendStream` / `chat.stopStream`; `task_update` and `plan_update` chunks render as task cards                                                  | A stream expires after about five minutes                                 |
| Active-view context        | `app_context_changed` event; `app_context` on DM messages, carrying channel / canvas / list / message entities                                                             |                                                                           |
| Feedback buttons           | `context_actions` block with a `feedback_buttons` element                                                                                                                  |                                                                           |

The status words a code channel shows (§2.1) are the Agent Sessions states with product
names on them, which is the strongest hint about the shape of the beta API: a code channel
is an Agent Session with a channel, tabs, and an archive step around it.

### 2.3 The API: a partner-only beta

Everything below is quoted from Slack's developer post through search-index summaries
(§2.5):

- "The Slack Code APIs are currently in beta and available only to select partners." They
  "allow agents to create code channels from existing conversations, carry context into
  those sessions, and manage the lifecycle of longer-running agent work."
- One new primitive is named: the scope `code.channels:manage`, "included under the parent
  `assistant:write` scope".
- "Soon these APIs open to the broader developer community, so any custom agent, doing any
  kind of work, can join a code channel." No date is given, and no application process is
  documented; the Slack Partner Program is the only door named anywhere.

An independent check confirms the API is private even in partner open source. Vercel Agent
is live in code channels, and Vercel's Chat SDK (`github.com/vercel/chat`, commit `6adca36`)
ships the Slack adapter that implements every §2.2 primitive — yet a search of the whole
monorepo for code channels finds nothing but an unrelated test about code fences. The
code-channel integration lives in Vercel's closed product, not the SDK.

### 2.4 What the launch partners do

All five run the agent in the vendor's cloud, and none offers a self-hosted runtime:

- **Claude Code** joins through the Claude app (individual accounts) or Claude Tag (an
  organization-shared identity with an organization-shared cloud environment). Every
  session runs on Claude Code on the web, GitHub repositories only, and Slack receives
  status updates, a summary, and _View Session_ / _Create PR_ buttons. Verified against the
  Claude Code documentation.
- **Devin** starts cloud sessions from a mention and answers in-thread.
- **GitHub Copilot** uses the GitHub coding agent.
- **Vercel Agent** posts "deployments, logs, errors, and diffs in the channel as it works,
  and follows the conversation while recognizing which messages are for it". Public beta
  for Pro and Enterprise teams.
- **ChatGPT** is announced as coming soon.

### 2.5 Source reliability

The research environment could not reach `slack.com`, `slack.dev`, `docs.slack.dev`, or the
launch partners' sites, so the Slack-side facts have two tiers:

| Source                                                               | How it was read             | Confidence                                                                                   |
| -------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| Slack blog, developer blog, developer changelog, help center         | Search-index summaries only | Quotes are verbatim from those summaries; every API name in §2.3 is unverified until re-read |
| Claude Code in Slack documentation (`code.claude.com/docs/en/slack`) | Fetched directly            | High                                                                                         |
| Vercel Chat SDK source (`vercel/chat` at `6adca36`)                  | Cloned and read             | High for what it contains; its silence on code channels is a fact about the SDK only         |
| Press coverage (The New Stack, Computerworld, Salesforce)            | Search-index summaries      | Medium                                                                                       |

§7 lists what must be re-verified against Slack's documentation before §6 is designed in
detail.

## 3. Why this matters for AgentConnect

**The product shape is ours already.** A code channel is a team watching one agent work,
steering it, and approving its output — the interaction AgentConnect sells on Slack today,
now with a native home in the sidebar. Once teams are used to that section, an agent that
cannot appear in it is an agent that looks less capable than the partner ones, whatever it
can actually do.

**The runtime is the differentiator.** Every launch partner hosts the agent in its own cloud
(§2.4). AgentConnect's defining choice is the opposite: agent execution happens on a daemon
the organization operates, over ACP the Control Plane never sees
([architecture.md](architecture.md)). A code channel changes none of that. It is a rendering
target, like a thread is today: the daemon creates it, writes its tabs, and archives it; the
CP records only control-plane metadata — the session row, the channel id, a conversation
subtype (§5.3) — and never a tab body or a diff. The invariant holds by construction because
the platform module that would speak the API is the daemon's.

**The seam already tells us where it lands.** Per
[integration-plugin-architecture.md](integration-plugin-architecture.md) a platform name is
never core knowledge: a code channel is a Slack capability read through the host contracts
(§6.1), not a `switch` in core. And a manifest field is earned only by a pre-dispatch read
(§5 there), which decides §6.7.

## 4. What already exists

Most of what a code channel needs is shipped, because AgentConnect adopted the §2.2 primitives
as they arrived:

| Slack Code needs                                | AgentConnect today                                                                                              | Where                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The `agent_view` manifest and `assistant:write` | Declared and emitted by the one code-generated manifest                                                         | `packages/protocol/src/slack-app-manifest.ts:50`, `:167`                                                                   |
| Agent Sessions status and the native Stop       | `agents.sessions.setStatus` / `rename`; `agent_session_stopped` handled                                         | `packages/daemon/src/slack/connection.ts:2934`, `:2967`, `:2901`                                                           |
| A plan the team can watch                       | The native plan container (`task_display_mode: 'plan'`) on streaming turns; the in-place plan message otherwise | `connection.ts:1657`, `packages/daemon/src/slack/render.ts:344`                                                            |
| Open a channel and pull people in               | `createConversation` → `conversations.create` + `invite`, agent-callable                                        | `connection.ts:2749`, `packages/daemon/src/mcp/tools.ts:722`                                                               |
| Tab-like surfaces                               | Canvases tabbed onto a conversation, bookmarks, lists                                                           | `connection.ts:2791`, `packages/daemon/src/platforms/contract.ts:353-382`                                                  |
| Channel-management scopes                       | `channels:manage`, `groups:write`, `canvases:write`, `bookmarks:write` already granted                          | `slack-app-manifest.ts:53-59`                                                                                              |
| Both transports                                 | Socket Mode, and HTTP Events through the relay, from one manifest builder                                       | `packages/relay/src/platforms/slack/http-ingest.ts:504`, `packages/web/src/components/console/platforms/slack/manifest.ts` |
| Scope drift detection                           | Install checks and setup reconciliation name a missing scope                                                    | `packages/control-plane/src/http/slack-manifest.ts:55-63`, `packages/setup/src/slack-app.ts:156`                           |
| A diff and PR UI                                | The console dock (Files / Git / PR / Tasks) and the unified-diff viewer                                         | [webchat-side-panels.md](webchat-side-panels.md) §3–§4                                                                     |
| PR coordinates from a turn                      | The code-host seam owns a delivery's reply target and final poster                                              | `packages/daemon/src/codehost/turn-final.ts:71`                                                                            |

What is missing:

| Need                                  | Gap                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Create a code channel, write its tabs | The beta API itself                                                                                                                       |
| Archive on completion                 | Nothing in the repository calls `conversations.archive`                                                                                   |
| _Needs attention_ and _Done_          | Lifecycle writes are limited to `processing` and `active` (`connection.ts:2923`); `suspended` and `closed` are never sent                 |
| A code-channel session in the console | `conversationKind` is a closed enum of `dm` / `group_dm` / `channel` (`packages/protocol/src/frames/telemetry.ts:107`)                    |
| A diff on a chat platform             | None; file edits arrive as ordinary tool calls and render as tool output                                                                  |
| A PR link on Slack                    | Only Linear extracts code-host links, by regex over the agent's prose (`packages/daemon/src/platforms/linear/turn-output.ts:235`)         |
| A live preview                        | None                                                                                                                                      |
| Streaming the answer                  | Rejected by design ([slack-streaming-turn-output.md](slack-streaming-turn-output.md) §1): a channel stream is live for one recipient only |

## 5. Phase 1: what ships now, on generally available primitives

Each item below is independent, small, and useful on its own. Together they are the
groundwork §6 assumes.

### 5.1 The two missing session states

`SlackConnection.setStatus` maps any non-empty status text to `processing` and an empty one
to `active` (`connection.ts:2884-2887`), and the lifecycle union stops there (`:2923`). Slack
defines two more: `suspended` when the agent needs user input, `closed` when the
conversation is complete — and a code channel shows them as _Needs attention_ and _Done_.

Proposal: the `set-status` action (`SlackAction`, `render.ts:79`) gains an optional
`lifecycle: 'processing' | 'active' | 'suspended' | 'closed'`, and the converger emits:

- `suspended` when a `session/request_permission` or `elicitation/create` is waiting on a
  human — the wait [slack-approval-dm.md](slack-approval-dm.md) routes to a DM and
  `render.ts:577` already narrates as "is waiting on an approval" — and `processing` again
  once it resolves;
- `closed` when the logical session closes (`session-manager.ts:426`), and on the archive
  of §5.2.

This keeps the product convention that Slack's "lifecycle API accepts a state, not phase
text" ([product-conventions.md](../product-conventions.md), _Session startup shows what the
turn is waiting for_). The dedupe-per-`(channel, thread, identity)` rule in
`setSessionLifecycle` carries over unchanged. Verify before shipping: that a `closed`
session accepts a later `processing` write (Slack documents `setStatus` as create-or-update,
which suggests it does) so a follow-up message in a closed thread still shows the working
indicator.

### 5.2 An archive port

A new optional member next to `leaveChannel` on `PlatformConnection`
(`packages/daemon/src/platforms/contract.ts:325`):

```ts
archiveConversation?(channel: string): Promise<void>
```

The Slack implementation calls `conversations.archive`; the scopes it needs,
`channels:manage` for public and `groups:write` for private channels, are already granted,
so no reinstall. `read-ports.ts` declares `conversationArchive: true` for Slack, and
`mcp/ops/platform-actions.ts` exposes it beside `createConversation` (`:390`).

Archiving is destructive for everyone in the channel, so the tool is fenced: in its first
version an agent may archive only a channel this daemon created through `createConversation`
(the store records the creator), and any other channel requires an explicit human decision
through the elicitation path. The console row follows _Leaving a conversation and removing
its row_ ([product-conventions.md](../product-conventions.md)): the row stays, marked
archived, and the session moves to `closed` (§5.1).

### 5.3 A conversation subtype, not a wider `conversationKind`

The first instinct is to add `code_channel` to `conversationKind`. It is the wrong shape:
that field exists for visibility classification
([session-visibility.md](session-visibility.md) §4.1 — `dm` is private to its owner,
`channel` is organization-visible), and a code channel inherits its origin conversation's
visibility, so it classifies exactly as `channel`. A value that changes no classification
is not earned there — the same doctrine the manifest applies to its fields.

Proposal: an optional, platform-defined `conversationSubtype: z.string()` on the session
telemetry frame beside `conversationKind` (`telemetry.ts:107`), stored verbatim by the CP
and read by the console only to pick a glyph and, later, a sidebar-like grouping. Readers
are tolerant by construction (§6.2 of the plugin architecture: unknown strings stay inert);
writers emit `code_channel` only from §6. Phase 1 needs the field so the row can already
distinguish a §5.4 project channel (`project_channel`) from an ordinary one.

### 5.4 An agent-driven project channel

An approximation of the tag-to-channel flow, built entirely from shipped ports and opted
into per agent through a skill or preset, never by core policy:

1. A member mentions the agent in a thread. The agent judges the task large enough for its
   own channel — a prompt-level decision, like the partners' agents make it.
2. The agent calls `createConversation` with a name derived from the task and
   `isPrivate` set when the origin conversation is private (`PlatformConversationSpec`,
   `contract.ts:167`), inviting the origin thread's participants through the existing read
   ports.
3. It posts a root in the new channel linking back to the origin thread
   (`platforms/slack/permalink.ts`) and replies in the origin thread with the channel link.
   Per _Self-authored channel roots_ ([product-conventions.md](../product-conventions.md))
   that root opens the agent's session for the new channel without running a turn; the
   carried context arrives with the first real prompt, the way the partners "carry context
   into those sessions".
4. Work continues in the channel under the ordinary session key
   `slack:<channel>:<thread>:<agentId>` (`local-store.ts:524`), with the plan container,
   bookmarks, and canvas of §5.5.
5. On completion the agent archives the channel (§5.2) and the session closes (§5.1).

What this is not: a code channel. It is an ordinary channel with no tabs, no sidebar
section, no code-channel status. It buys the workflow — one channel per task, the team
inside it, an archived audit trail — and it lets the team try the shape before Slack's API
arrives.

### 5.5 Plan, diff, and PR on the channel

- **Plan.** Already rendered: the native plan container on streaming turns and the
  strike-through `rich_text_list` plan message otherwise (`render.ts:344`, `:2864`).
  Optional addition: mirror the plan into a canvas tabbed onto the channel
  (`createCanvas(title, markdown, channel)` → `conversations.canvases.create`,
  `connection.ts:2791`; `updateCanvas` on each ACP `plan` update). A canvas is the closest
  generally available thing to a tab.
- **PR.** Extract `codeHostLinks` from the Linear module
  (`packages/daemon/src/platforms/linear/turn-output.ts:235`) into a shared platform helper
  — Slack is its second implementer, which is when this repository extracts an interface —
  and pin each pull request the turn produced as a bookmark (`addBookmark`,
  `contract.ts:353`). A prose regex is honest about what it reads; the seam-owned PR
  coordinates of the code-host turn final replace it in §6.4.
- **Diff.** The daemon owns the workspace checkout, so a `git diff` at turn end is local.
  Upload it through `uploadFile` as a `.patch` snippet, which Slack renders with diff
  highlighting, and bookmark the console's viewer deep link for the same files
  ([webchat-side-panels.md](webchat-side-panels.md) §4). Publishing a diff shows code to
  everyone in the channel, so this is off by default and enabled per agent (§8).

### 5.6 Deliberately not done

- **Body streaming** stays rejected. A channel stream is live for exactly one
  `recipient_user_id` and every other member sees an italic "Thinking…" placeholder
  ([slack-streaming-turn-output.md](slack-streaming-turn-output.md) §1). Nothing generally
  available changes that; whether a code channel's conversation tab does is §7 Q3.
- **Live preview** has no generally available analogue. Where a sandbox already exposes a
  preview URL it can be bookmarked; designing that surface is out of scope.
- **Core does not decide to open a channel.** The decision is the agent's (prompt) or an
  explicit per-agent setting. A hardcoded "Slack coding mention ⇒ channel" branch in core
  is the `switch` the plugin architecture forbids.

## 6. Phase 2: real code channels, once the API opens

Written against what §2 establishes; the contract members below are placeholders whose
exact shape follows the documentation (§7).

### 6.1 Where it lands in the four host contracts

- **protocol** — `code.channels:manage` joins `SLACK_BOT_SCOPES` unless `assistant:write`
  already implies it (§6.2); any code-channel events Slack introduces join `SLACK_BOT_EVENTS`;
  `conversationSubtype` (§5.3) gains its `code_channel` writer.
- **daemon** — the Slack module only. `PlatformConversationSpec` gains an optional
  `kind: 'code'` that Slack honors and other platforms ignore (a capability, so it lives in
  the host contract); the connection gains tab writers as optional members; the renderer
  seam (§7.3 of the plugin architecture) already turns ACP `plan` updates into `plan`
  actions and tool calls into cards, so `applySlackAction`
  (`packages/daemon/src/platforms/slack/turn-output.ts:494`) gains tab-directed variants
  rather than core gaining Slack knowledge.
- **relay** — nothing structural. Code-channel events are Slack events: they pass through
  `SlackHttpIngest.handleEvent` and demux on `api_app_id` / `team_id` as today.
- **control plane** — no new persistence beyond the subtype string. The install check and
  the setup reconciler already name a missing scope, so an existing install that needs
  `code.channels:manage` is flagged the day the constant changes.
- **web** — the row glyph from `conversationSubtype`; the wizard's manifest picks the scope
  up from `SLACK_BOT_SCOPES` automatically.

### 6.2 Manifest and the reinstall cost

Every scope added later costs a reinstall of every installation, which is why
`channels:join`, `team:read`, and `users:read.email` were declared ahead of a caller
(`slack-app-manifest.ts:62-67`; `channels:join` has one now — the on-demand join in
daemon-detailed-design.md §9.4 "Channel reach"). If `code.channels:manage` is granted through the parent
`assistant:write` as the developer post suggests, existing installs need nothing. If it is
a separate grant, it rides the next reinstall bundle rather than forcing its own. §7 Q2
decides which.

### 6.3 The creation flow

```mermaid
sequenceDiagram
    participant U as Team member
    participant S as Slack
    participant D as Daemon (Slack module)
    participant A as Agent runtime (ACP)
    U->>S: @agent "build X" in a thread
    S->>D: app_mention (Socket Mode, or HTTP Events via the relay)
    D->>A: session/prompt with the thread context
    A-->>D: session/update (plan)
    D->>S: create code channel from the origin conversation (beta API)
    D->>S: agents.sessions.setStatus processing
    loop turn
        A-->>D: tool_call / plan / agent_message_chunk
        D->>S: conversation posts, plan tab, diff tab
    end
    A-->>D: turn end; PR opened through the code-host seam
    D->>S: PR coordinates; setStatus active (Idle)
    U->>S: "change Y" / approve
    D->>S: setStatus suspended while an approval waits (Needs attention)
    D->>S: setStatus closed; archive (Done)
```

The daemon is the only writer at every step, and no step crosses the daemon–CP WebSocket
with content: the CP learns the channel id and subtype through the existing session
telemetry, nothing more.

### 6.4 Tabs and their ACP sources

| Tab          | ACP source                                                                | Existing machinery                                                      | New in Phase 2                                                                                             |
| ------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Conversation | `agent_message_chunk`; tool chrome on the card stream                     | `OutputConverger` (`render.ts:2214`), the existing post / live-reply IR | Nothing if the tab is an ordinary channel; the streaming decision of §7 Q3                                 |
| Plan         | `plan` updates with per-entry status                                      | `renderPlan`, `plan_update`, `upsertPlan`                               | A plan-tab writer fed from the same action                                                                 |
| Diff         | No ACP diff kind; file edits are tool calls; the daemon owns the checkout | The console's unified-diff viewer (web only)                            | Daemon-side diff capture at tool-call boundaries or turn end; the repository and branch from the workspace |
| PR           | The code-host seam (`CodeHostTurnFinal`, `turn-final.ts:71`)              | GitHub and GitLab posters                                               | PR coordinates from the seam instead of the §5.5 prose regex                                               |
| Preview      | None                                                                      | None                                                                    | Only where a sandbox exposes a URL; otherwise the tab stays empty                                          |

### 6.5 Lifecycle mapping

| Code channel status | Agent Sessions state | Source in the daemon                                     |
| ------------------- | -------------------- | -------------------------------------------------------- |
| Working             | `processing`         | Turn start, as today                                     |
| Idle                | `active`             | Turn end, as today                                       |
| Needs attention     | `suspended`          | A pending permission or elicitation (§5.1)               |
| Done                | `closed` + archive   | Session close, or the agent's explicit completion (§5.2) |
| Inactive            | —                    | Slack's own inactivity timer; nothing to write           |

### 6.6 The shared-bot arm

On the relay-forwarded, send-only arm a Slack event reaches every participant daemon
(`connection.ts`, the `agentSessionStopped` note), so creating and archiving a code channel
must be single-writer. The channel is created by the daemon whose agent was mentioned, and
its ownership follows _Shared-bot conversation ownership_
([product-conventions.md](../product-conventions.md)); the archive is the owner's. A
multi-agent code channel — two agents of one shared bot in the same channel — is not
designed here (§7 Q8).

### 6.7 Manifest field or capability flag?

A manifest field is earned by a pre-dispatch read. Nothing above needs one: messages in a
code channel route like channel messages, and "which messages are for the agent" is either
a mention or the agent's own judgement, as Vercel describes it. So code-channel support is
a capability on the daemon's host contract, not a manifest field. The one thing that would
change this is §7 Q5: if Slack delivers un-mentioned code-channel messages to the agent as
addressed, the routing layer reads that before a target resolves, and the manifest earns a
field for it.

## 7. Open questions to verify against Slack's documentation

1. **Method names.** How a code channel is created (a `conversations.create` variant or a new
   family), whether it must originate from an existing conversation, and how its lifecycle
   is driven.
2. **The scope.** Whether `code.channels:manage` is granted implicitly by `assistant:write`
   on existing installs, or is a separate grant that costs a reinstall.
3. **Conversation-tab streaming.** Whether a stream there is still visible to one recipient
   only, or to the whole channel. This alone decides whether the body-streaming rejection
   is revisited, and only for code channels.
4. **Tab formats.** Whether the plan, diff, and preview tabs are written by the agent through
   the API (and in what formats: unified diff, file list, canvas markdown) or derived by
   Slack from a linked repository and pull request.
5. **Addressing.** Whether Slack delivers un-mentioned code-channel messages to the agent as
   addressed (§6.7).
6. **Transport eligibility.** Whether Socket Mode apps qualify or only HTTP Events apps, and
   how Enterprise Grid / org-wide deployment behaves (`org_deploy_enabled` is `false` today).
7. **The agent picker.** How _Create a code channel_ lists agents: Marketplace apps only, any
   app holding the scope, or a manifest feature flag. This can be decisive — a per-workspace
   custom app, which is what a self-hosted AgentConnect install is, may reach code channels
   only through the mention path if the picker is Marketplace-only.
8. **Multiple agents.** Whether more than one agent can join one code channel.
9. **Limits.** Rate limits on tab writes, and whether the five-minute stream expiry applies
   inside a code channel.

## 8. Risks

- **Beta timing is unknown.** Mitigation: §5 stands on its own and is worth shipping
  regardless.
- **Scope reinstall.** Covered in §6.2; the answer to Q2 sets the cost.
- **A destructive archive.** An agent archiving the wrong channel is loud and hard to undo
  for a team. §5.2 fences the tool to bot-created channels and routes anything else through
  a human decision.
- **Carried context is untrusted.** The Claude Code documentation warns that an agent "may
  follow directions from other messages in the context". Thread context carried into a
  channel gets the same treatment hook bodies get today — wrapped in the untrusted-content
  markers of `packages/daemon/src/messages/hook-message.ts:47-49` — rather than pasted as
  instructions.
- **Diff exposure.** A diff tab or a `.patch` snippet publishes code to everyone in the
  channel. The channel inherits its origin's visibility, which is right for private
  channels and a policy decision for public ones; hence per-agent opt-in in §5.5.
- **Two diff renderers.** The console viewer and a Slack diff surface must be fed by the
  same daemon-side capture, or they will disagree about what the agent changed.

## 9. Recommended sequencing

1. **Ask for beta access** through the Slack Partner Program now; there is no other
   documented path, and the lead time is unknown.
2. **Ship §5.1, §5.2, §5.3, and the PR bookmark of §5.5** as separate small changes, each
   with daemon unit tests that pass on the Windows leg. None depends on Slack.
3. **Ship §5.4 and the rest of §5.5 opt-in**, and measure whether teams use the project
   channel before investing further.
4. **When the documentation is readable**, answer §7, then revise §6 into concrete contract
   members and move this document to _Accepted_.

## 10. Sources

Read directly:

- Claude Code in Slack — <https://code.claude.com/docs/en/slack>
- Vercel Chat SDK, Slack adapter and its documentation — <https://github.com/vercel/chat>

Read through search-index summaries only (see §2.5):

- Slack, _Slack Code: Where Your Team and Agents Build Together_ —
  <https://slack.com/blog/news/slack-code-channels-for-agents>
- Slack Developers, _Slack Code: A dedicated place for agent work_ —
  <https://slack.dev/slack-code-a-dedicated-place-for-agent-work/>
- Slack developer changelog, _Announcing Slack Code_ —
  <https://docs.slack.dev/changelog/2026/08/20/slack-code/>
- Slack developer changelog, _Introducing the Agent messaging experience_ —
  <https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/>
- Slack developer docs, _Agent sessions_ — <https://docs.slack.dev/ai/agent-sessions/>
- Slack help center, _Build with AI as a team using Slack Code_ —
  <https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code>
- Vercel changelog, _Vercel Agent is now available in Slack code channels_ —
  <https://vercel.com/changelog/vercel-agent-is-now-available-in-slack-code-channels>
- The New Stack, _Slack has a new channel type — but only agents can create one_ —
  <https://thenewstack.io/slack-code-agent-channels/>
- Salesforce press release, 2026-08-25 —
  <https://www.salesforce.com/ap/news/press-releases/2026/08/25/salesforce-launches-slack-code-to-make-ai-software-development-multiplayer-2/>
- Computerworld, _New 'Slack Code' turns AI coding into a team activity_ —
  <https://www.computerworld.com/article/4212446/new-slack-code-turns-ai-coding-into-a-team-activity.html>

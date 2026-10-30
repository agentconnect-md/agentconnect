# Slack native reports and code channels

## Reports

Slack sessions expose `presentSlackReport` for substantial findings and comparisons. Sections
use native collapsible Container blocks; tables use Data Table blocks with pagination
and numeric sorting. Ordinary replies retain Markdown, including Markdown tables.
Sections accept Slack mrkdwn, while table strings are plain text. The tool validates
row widths and message limits before posting. Reports use the current turn's physical
delivery thread and the configured agent identity and attribution.
They carry finalized authorship with the live turn's hop count and enter the normal
outbound transcript. A headless or ended turn cannot publish through this surface.
The agent chooses this format when expandable details or sortable rows help the reader;
the user does not need to name the tool or request a particular format.

## Code channels

The app manifest enables `features.code_channels.enabled` and requests
`code_channels:manage`. Existing installations need their manifest refreshed and the
app reauthorized before code channel management works. Socket Mode and HTTP delivery
use the existing message subscriptions; no new public callback is required.

A code channel is recognized from the provider's conversation metadata reporting
`properties.record_channel.record_type == "agent_channel"`. Assigned bot IDs come
from `properties.agent_session.encoded_agent_bot_user_ids`. Each host caches that
provider answer for one minute. Discovery is best effort: lookup failures preserve the
existing coordinates and allow ordinary message admission to continue. Relay API calls
have a short timeout, no automatic retries, and fail immediately on rate limiting.

The canonical thread coordinate of a code channel is its channel ID. Every message in
that channel therefore reaches the same active channel session. Ingress also preserves
an actual thread reply's parent as `replyThread`: reply bodies, streams and file shares
return there, while a top-level request receives a top-level response. Native status,
renames and views remain channel-scoped and omit `thread_ts`. Native Stop without a
thread timestamp addresses the same channel coordinate on both ingress transports.
History reads use channel history.

The console groups these conversations under Code channels, below direct messages and collapsed by default,
without per-row trigger or session-mode controls. Membership snapshots carry the
provider's classification and exclude archived channels; archive events refresh that
snapshot so completed sessions disappear from the list.

Archiving ends the channel session. The agent's archive first marks the session
`closed` (Slack's _Done_), then archives with the optional summary. When a person
archives the channel instead, `channel_archive` / `group_archive` arrive on either
transport at the channel coordinate: all sessions and delegated tasks sharing the
channel are cancelled. Native Stop keeps its existing displayed-owner behavior on
Socket Mode. An archive of a channel the provider reports is not a code channel is
ignored. A turn waiting on an approval shows the session as `suspended` (_Needs
attention_) until the last request settles, as in ordinary threads.

An assigned bot is an implicit recipient of human messages in its code channel. This
does not count as an explicit mention: session mute still applies, other explicit
mentions take precedence, and the conversation's Off fence remains authoritative.
Other bots do not acquire implicit activation from this field.

## Agent tools

The platform-owned session tool registry exposes four tools only to Slack sessions:

- `presentSlackReport`: publish collapsible sections and a paginated table here.
- `createSlackCodeChannel`: create a task channel linked to the current live triggering
  message. Slack matches origin privacy and invites its author. An origin-derived
  idempotency key prevents duplicate channels when a call is retried. Creation inside
  an existing code channel returns that channel without creating another one, including
  when the copied origin request arrives under a new message timestamp.
- `setSlackCodeView`: publish a unified diff, self-contained HTML preview, or PR tab.
  HTML keys are stable upsert identities; content is bounded by UTF-8 bytes.
- `manageSlackCodeChannel`: replace up to three informational context links, list/remove tabs, or
  archive a completed task with an optional existing summary message.

The native context bar reserves two items for session controls: model and effort
together, then current context usage such as `42k/200k`. These use monochrome code
and terminal icons. Unknown capacity is omitted; cumulative token totals are never
used as context usage. The controls update independently of the optional message
header, including after settings change while idle. Clicking either opens the
existing settings modal, where output mode remains configurable.

Informational items use native monochrome icons (a branch for repositories). PR
checks use `◷`, `✓`, or `✕` for pending, all passing, or failed checks on the current
head. The agent supplies observed check status through the context tool; this is not
a background CI polling service. Unknown or absent checks have no pass indicator.
The connection serializes context replacements and preserves the session controls
when informational links change, and links when model or usage changes.

Context-bar action keys are delivered as slash-command payloads. Socket Mode routes
them to Bolt command listeners; HTTP apps set `features.code_channels.slash_command_url`
to the existing signed `/slack/interactions` endpoint. Both verify code-channel
ownership and resolve the channel-wide session before opening the modal. Subsequent
settings changes retain the existing actor and session authorization checks.

Tools use the session's own bot connection and the existing place write rule. Creating
something new requires an eligible human asker. Cross-channel view/context/archive
writes require that every asker may access the target, and the provider must report
that this bot owns it. Tools never accept a privacy override or an arbitrary origin.

Requested coding work with multiple steps uses a code channel unless the user asks
to stay in the original conversation or the task needs earlier discussion that the
originating message does not contain; quick answers stay in place. This platform
workflow takes precedence over delegating the same work to a background task.
Creation leaves the current runtime turn in its original conversation. Slack brings
the originating request into the new channel, whose session continues the task. The
original turn links the channel and ends without repeating the work or requiring
the user to repeat the request. No additional transcript history is copied. Work
that needs the existing context, or cannot create a channel, uses ordinary delegation.

Channel discovery supplies standing context identifying an existing code channel.
The agent continues work there, maintains repository/branch/PR context items, and
publishes PR views when opened and useful HTML previews.
The agent does not auto-archive a channel at the end of a turn.
Views initially cover diffs, HTML and PR links, plus the Plan tab below. Arbitrary
interactive Block Kit views and runtime-registered slash commands are follow-up
capabilities.

The Plan tab is written by the daemon, not by a tool. In a code channel this bot owns,
each ACP `plan` update is rendered as a markdown checklist and kept in a canvas
attached as view `plan` with comment access: the team can read and comment, and only
the agent edits. The first update creates and attaches the canvas; later updates
replace its content through `agents.conversations.setCanvasContent`, which rewrites
only changed sections so comments on unchanged steps survive. Updates that arrive
during a write collapse into the newest one. After a restart the canvas is found again
through `agents.conversations.listViews`. The in-conversation plan message is
unchanged.

### Automatic task diffs

The daemon maintains the Code view for a task with isolated, assigned Git repositories.
Before its first runtime prompt it pins each clean repository's HEAD under a session-scoped
Git ref. Later turns and daemon restarts reuse that ref. Commits made during the task remain
in the diff, alongside staged, unstaged and untracked files; ignored files are excluded.
Reads use the session's execution-plane Git runner and never change its working tree or index.
Other directories and shared checkouts are not scanned. An existing task without a saved
baseline is not adopted automatically, and a dirty initial checkout is refused. These
ineligible sessions retain their existing output path without a recurring error message.

One serialized publisher samples the workspace every five seconds while the turn runs and
flushes once at settlement. Unchanged content is deduplicated, secrets are masked, and oversized
patches are refused instead of displayed as complete. Reverting all changes removes the stale
Code view. Stop discards in-flight read results and cancels queued publications before the turn
releases its connection; an HTTP request already accepted by Slack cannot be recalled.

Only the current owned Code channel is eligible. The registered session's live-turn and
conversation-write authorization is checked before opening the workspace and before every
publication. A refusal or synchronization failure stops updates for the turn and produces a
visible reason. Moving output into the platform does not authorize a previously refused send.
The runtime is told when the platform owns its diff; it retains the HTML/PR tools and manual
diff publication for separately authorized work outside automatic synchronization.

All message content, API egress and ACP execution stay on the daemon/relay data plane.
The Control Plane continues to hold control metadata only.

## API references

- [Slack Code](https://docs.slack.dev/ai/slack-code/)
- [Code channel properties](https://docs.slack.dev/ai/slack-code/code-channel-properties/)
- [Container block](https://docs.slack.dev/reference/block-kit/blocks/container-block/)
- [Data Table block](https://docs.slack.dev/reference/block-kit/blocks/data-table-block/)
- [Code channel views](https://docs.slack.dev/reference/methods/agents.conversations.setView/)

# Slack native reports and code channels

## Reports

Slack sessions expose `presentSlackReport` for explicitly structured output. Sections
use native collapsible Container blocks; tables use Data Table blocks with pagination
and numeric sorting. Ordinary replies retain Markdown, including Markdown tables.
Sections accept Slack mrkdwn, while table strings are plain text. The tool validates
row widths and message limits before posting. Reports use the current turn's physical
delivery thread and the configured agent identity and attribution.
They carry finalized authorship with the live turn's hop count and enter the normal
outbound transcript. A headless or ended turn cannot publish through this surface.

## Code channels

The app manifest enables `features.code_channels.enabled` and requests
`code_channels:manage`. Existing installations need their manifest refreshed and the
app reauthorized before code channel management works. Socket Mode and HTTP delivery
use the existing message subscriptions; no new public callback is required.

A code channel is recognized only from `conversations.info` reporting
`properties.record_channel.record_type == "agent_channel"`. Assigned bot IDs come
from `properties.agent_session.encoded_agent_bot_user_ids`. Each host caches that
provider answer for one minute. Discovery is best effort: lookup failures preserve the
existing coordinates and allow ordinary message admission to continue. Relay API calls
have a short timeout, no automatic retries, and fail immediately on rate limiting.

The canonical thread coordinate of a code channel is its channel ID. Every message in
that channel therefore reaches the same active channel session. At the Slack API
boundary this coordinate means channel-level output: posts, streams, file shares,
status updates and renames omit `thread_ts`. Ordinary thread coordinates retain their
existing behavior. Native Stop without a thread timestamp addresses the same channel
coordinate on both ingress transports. History reads use channel history.

An assigned bot is an implicit recipient of human messages in its code channel. This
does not count as an explicit mention: session mute still applies, other explicit
mentions take precedence, and the conversation's Off fence remains authoritative.
Other bots do not acquire implicit activation from this field.

## Agent tools

The platform-owned session tool registry exposes four tools only to Slack sessions:

- `presentSlackReport`: publish collapsible sections and a paginated table here.
- `createSlackCodeChannel`: create a task channel linked to the current live triggering
  message. Slack matches origin privacy and invites its author. An origin-derived
  idempotency key prevents duplicate channels when a call is retried.
- `setSlackCodeView`: publish a unified diff, self-contained HTML preview, or PR tab.
  HTML keys are stable upsert identities; content is bounded by UTF-8 bytes.
- `manageSlackCodeChannel`: replace informational context links, list/remove tabs, or
  archive a completed task with an optional existing summary message.

Tools use the session's own bot connection and the existing place write rule. Creating
something new requires an eligible human asker. Cross-channel view/context/archive
writes require that every asker may access the target, and the provider must report
that this bot owns it. Tools never accept a privacy override or an arbitrary origin.

Creation leaves the current runtime turn in its original conversation. The agent can
publish context into the new channel through `sendMessage`, link it for the user, and
continue there when the user speaks. It does not silently copy private transcript
history, move an existing runtime, or auto-archive a channel at the end of a turn.
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

All message content, API egress and ACP execution stay on the daemon/relay data plane.
The Control Plane continues to hold control metadata only.

## API references

- [Slack Code](https://docs.slack.dev/ai/slack-code/)
- [Code channel properties](https://docs.slack.dev/ai/slack-code/code-channel-properties/)
- [Container block](https://docs.slack.dev/reference/block-kit/blocks/container-block/)
- [Data Table block](https://docs.slack.dev/reference/block-kit/blocks/data-table-block/)
- [Code channel views](https://docs.slack.dev/reference/methods/agents.conversations.setView/)

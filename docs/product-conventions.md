# Product conventions

This document records user-facing product behavior that implementations must preserve.
Architecture and protocol details belong in [`designs/`](designs/); this document is
the source of truth for cross-cutting product conventions.

## User-facing language

User-facing UI copy must describe concepts, actions, and outcomes that matter to the
user, not AgentConnect's internal architecture. Internal component names such as `CP`,
`Control Plane`, and `Relay` must not appear in labels, help text, settings descriptions,
empty states, toasts, or error messages. Rewrite the copy around what the user can do or
needs to know; if an implementation detail does not change either, omit it. Technical
component names belong in logs, developer tooling, and architecture documentation.

Visibility controls use audience language: show **Everyone** for the internal `org`
value, never **Org** or "org-visible". Keep **Organization** only when the copy is
actually about organization management, membership, or ownership.

## Planned daemon lifecycle status

A pending daemon upgrade or restart is a planned transition, not an unexpected outage.
While that lifecycle operation is pending, the console shows the daemon and its active
placed agents as `upgrading` or `restarting` with the paused-state color. An agent that
an operator explicitly paused remains `paused`. Once the operation succeeds, fails, or
expires, the console returns to the daemon's current connection status; a daemon that
did not return then reads `offline`.

## Slack message attribution footer

The attribution footer for an agent response must be attached to the final Slack
message containing that response. It must never be posted as a separate Slack message.

For example, a footer can render as:

```text
sent by <https://app.example.com/acme/agents/agent-id|agent-name> (Codex · model-name) · <https://app.example.com/acme/sessions/session-id|open in session>
```

If a response is split across multiple Slack messages, attach the footer only to the
last message. If streaming, retries, or later output change which message is last, move
or re-anchor the footer so it remains attached to the latest response message without
leaving a stale footer on an earlier message.

## Slack multi-agent mention routing

An explicit Slack mention wakes only the AgentConnect agent represented by that bot.
When a daemon receives a thread message containing mentions but none matches one of its
local agents, it must not fall back to thread affinity. It may retain the message for
later transcript catch-up, but it must not start a model turn. Thread affinity applies
only to follow-ups with no explicit mention.

A third-party Slack app or bot may wake an AgentConnect agent only by explicitly
mentioning that agent's bot. It must not enter through DM, thread-affinity, keyword, or
auto ("every message") routing.

A message authored by any AgentConnect-managed agent bot never wakes another
AgentConnect agent through Slack, even when it explicitly mentions that agent or the
channel uses auto routing. Agent-to-agent activation uses the trusted internal
`messageAgent` path exclusively — never a re-entry through a visible mention. That path
delivers the message directly to the target agent and wakes it; it is never a second
platform delivery path.

Whether the hand-off is _visible_ is the caller's choice, set by the `sendMessage`
target it uses:

- `to.toAgent` **alone** — a postless wake: nothing is posted to the channel/thread and
  nothing is recorded in the shared transcript, so this coordination never appears as
  channel history.
- `to.toAgent` **with a `channel`** — the daemon posts one visible message to that
  channel (root by default, or an explicit `thread`) and lands the woken agent's session
  in that post's thread, so the collaboration is intentionally visible and threaded. The
  woken agent is still activated through `messageAgent`, not by the visible post — the
  post's timestamp is carried into the wake (across the relay for a cross-daemon target)
  so the visible message and the direct delivery collapse to a single transcript row
  (never a duplicate hand-off).

The visible post is suppressed when the wake would be refused for a locally-decidable
reason (capability disabled, invalid target id, self, hop limit, or a local target that
disallows the caller), so a rejected hand-off leaves no misleading post. One accepted
best-effort edge: a target on another daemon whose call policy terminally rejects the
caller can still leave a visible post, because that policy verdict is only known on the
target's daemon after the post is made.

## Self-authored channel roots

When an agent uses `sendMessage` to publish a new channel-root message without waking
another agent, the returned platform message creates the agent's session for that new
thread but does not run a model turn. The root is already the agent's own output, not a
new request: treating it as an activation can make the agent post it again recursively.

The session starts idle, retains its parent-session lineage, and records the root for
transcript display. The first real reply in that thread receives the root as preceding
context before the new message. Session initialization itself produces no agent output,
tool calls, memory recall or capture, turn evaluation, or token usage.

## Shared-bot channel ownership

Every active channel served by a shared bot has exactly one default agent. A newly
observed or ownerless channel converges to the bot's earliest active agent, and removing
the current owner immediately transfers ownership to the earliest remaining agent.
Console surfaces must show the same effective owner and trigger from every member
agent's integration; they must not expose a `No default` state. The trigger is
replicated across every active membership row, backfilling a missing sibling, so
removing the owner does not discard the channel or its trigger.

A Console owner change preserves the channel's trigger. An in-Slack owner change or
automatic fallback to a restricted agent instead leaves the channel Off, because only
an authorized Console editor may enable it. Direct messages remain separate:
restricted agents may independently enable or disable their own DM conversation rows.

## Group direct messages

A Slack multi-person DM is a conversation between people that the agent happens to sit
in, not a room addressed to the agent. It therefore follows a channel's rule, not a
DM's: the agent answers when explicitly @-mentioned, and follow-ups in a thread it has
joined need no further mention. A group DM never activates on an unmentioned message the
way a DM does.

Slack never reports a group DM as bot membership, so one is surfaced the way a DM is —
on observation, when an inbound message names the bot — and never through a membership
snapshot. Conversation rows therefore exist only where observation creates them, which
gives the two visibilities different surfaces, matching how DMs already behave:

- An **org-visible** agent answers a group DM whenever it is @-mentioned, with no
  per-conversation row and nothing to configure — the same way it always answers its
  DMs.
- A **restricted** agent's group DM is surfaced as a row that starts Off and stays
  unroutable until a Console editor enables it, exactly like its DM rows. Because the
  conversation is channel-like, that row carries a channel's trigger choice, so an
  editor may also opt it into every message.

A preserved row does not outlive the visibility that created it. When a restricted agent
becomes org-visible its group-DM and DM rows go inert — the Console stops showing them,
so honouring one would leave the agent answering a conversation with no visible control
to stop it. It falls back to the same defaults every org-visible agent has: mention in a
group DM, every message in a DM.

A shared bot is one Slack identity, so a mention in a group DM cannot name which agent
behind it is meant, and the slug that disambiguates a shared DM does not apply — a DM
activates on any message, which a slug can outrank, while a group DM activates on the
mention itself. A group DM served by a shared bot therefore converges on exactly one
agent, the same way an ownerless channel does: the bot's earliest active install among
those that enabled it.

A conversation first mistaken for a channel converts to a group DM once resolved, and
that conversion returns it to Off: the trigger it carried was a channel's default, never
an operator's choice for this conversation. The resolved classification is durable — it
lives on the conversation row, not in daemon memory, so a daemon restart that re-reports
the conversation provisionally as a channel cannot flip an enabled group DM back to Off.

## No-response control marker

Every agent session receives the same standing response-choice instruction, independent
of whether it is a shared channel, DM, webchat, hook, cron, or direct agent call. Direct
messages and direct agent calls are explicitly treated as addressed. When an activation
is not for the agent, it should answer with exactly the product-specific
`AC_NO_RESPONSE` marker and no other text. At turn finalization, visible platform delivery
boundaries suppress pending reply output when either the complete trimmed body is the
marker or a non-compliant model places the marker on the final standalone line after an
explanation. The latter is a recovery rule, not a prompt format to encourage; the standing
instruction still requires the marker as the first and only output so an earlier streaming
flush cannot expose explanatory text.

Matching is case-sensitive and deliberately narrow. The generic text `NO_RESPONSE` is not
reserved and must be delivered normally, including when it appears alone or in code. An
inline mention of `AC_NO_RESPONSE`, a punctuated form, a fenced example, or a marker
followed by more content is also ordinary reply text and must not be suppressed.

An explicit platform @mention is also a trusted routing fact. The daemon carries that fact
into the turn as separate system context, so an opaque raw identifier such as Slack's
`<@U…>` cannot be mistaken for another participant merely because it does not resemble the
agent's AgentConnect name. Implicit thread, keyword, and auto routes never receive that
assertion, and the original user text is not rewritten.

## Directional agent visibility

Agent-to-agent visibility is the intersection of two independently configured directions.
The source agent decides which peer agents it may discover and message; the target agent
decides which peer agents may call it. An A → B edge exists only when both policies allow
it and both agents are otherwise eligible in the same organization and channel.

The agent-directory tool must hide peers that fail either side of this check. Message
delivery must repeat the same authorization instead of trusting discovery: a remembered,
guessed, or stale agent id must not bypass either policy. Rejection does not wake the
target and uses the same `not_allowed` result as an inbound-policy denial. Both directions
default to all peers so existing agents retain their current collaboration behavior.

An agent replying to the exact session that invoked it is a return path, not a new peer
selection. That reply remains governed by the existing origin-only session capability, so
a permitted one-way delegation can return its result without requiring a reverse
visibility grant.

## Session visibility

Every session carries its own visibility, composed with — never widening — the visibility
of the agent that owns it. Platform direct messages, Playground and webchat conversations,
and sessions launched through the Web API default to **private**: only their owner can see
them — deliberately no role exception, org owners included. Channel sessions, group direct
messages, and automation-originated sessions (cron, hook, dream, agent-to-agent) default
to **org**, visible to every member who can already view the agent. A session's initiator
is recorded regardless of tier, and re-classification belongs to that recorded initiator
alone: the person who started a channel conversation may later pull it private, and only a
private session's owner may publish it back. Roles grant no re-classification rights — an
org owner cannot flip someone else's session in either direction.

An agent-to-agent child inherits its parent's visibility, because a delegation copies the
parent's prompt into the child's transcript. Tightening a session therefore cascades to its
descendants; publishing one never does — widening a child stays that child's own decision.

A session the caller may not see is reported as missing, not as forbidden: the console must
not reveal that it exists.

Making a session private hides its transcript immediately, but agent memory is shared
across the whole agent, so the guarantee about memory is narrower and must be stated
plainly wherever the change is offered: capture into shared memory stops once the owning
daemon acknowledges the change (typically sub-second, surfaced as a pending state until
then), and anything the agent already distilled while the session was org-visible is not
retracted. Until a session's daemon has confirmed the current state, that daemon withholds
capture rather than assuming the session is shareable.

The block covers both ways a session reaches shared memory: the automatic post-turn
distillation, and an explicit write by the agent itself. A private session's memory-write
tools refuse with an explanation rather than failing silently, and reads stay available —
recalling what the agent already knows is not a disclosure of the current conversation.
Dream sessions skip private transcripts entirely.

**Agents on native runtime memory are the exception, and the product must say so.** With
that backend the runtime persists memory inside its own process for the whole agent, with
no per-session control, so a private session on such an agent gets the transcript
guarantee but not the memory one. Anywhere an agent is configured for native memory, the
private tier must be described as "hides the transcript, not what the agent learns from
it" — silence is not an option.

## Runtime memory-provider compatibility

Memory-provider semantics are part of the support contract for every agent harness, not
an incidental spawn detail:

- `managed` remains available for every harness. When a harness has its own persistent
  memory, its verified off-switch must be registered so the runtime store cannot compete
  with AgentConnect's managed store.
- `none` is supported only when AgentConnect has verified either a native-memory
  off-switch or that the harness has no persistent memory of its own. Unknown behavior
  fails closed; `none` must never silently mean "AgentConnect memory is off, but the
  harness may still remember."
- `native` may be offered only after both the harness's per-agent storage redirect and
  the console read/write root are verified. Redirecting a whole runtime home is not
  sufficient when that home also contains shared auth or unrelated state.

The single source of truth is
[`runtime-memory.ts`](../packages/daemon/src/agents/runtime-memory.ts). Match a known
registry id first and retain a command/args signature fallback for custom aliases and
package launchers such as `npx`. A new harness added to the curated ACP matrix must also
declare its expected `managed` / `none` / `native` capabilities in
[`profiles.ts`](../packages/daemon/test/acp-matrix/profiles.ts); the runtime-memory
contract test compares that declaration with the production policy. Adding or changing
a policy requires a focused env assertion and a source comment naming the verified
runtime lever.

## Managed-memory prompt provenance

The session-start `MEMORY.md` index must be enclosed in an explicit, labeled start/end
boundary. Prompt guidance must state that only text inside that boundary is memory-file
content; agent/session metadata, workspace or git status, user messages, recalled
context, and all other surrounding text are ordinary session context.

For targeted `writeMemory` edits, `oldString` must come verbatim from that bounded file
content or a current `readMemory` result. The injected index is only a start-of-session
snapshot, so instructions and replace-failure feedback must direct the agent to
`readMemory` after another write, when provenance is uncertain, or before retrying a
failed replacement.

## Memory backend selection

Present storage backends in the order `Managed`, `Native`, `External`, followed by a
visually separated `Off` choice. `Off` is the user-facing label for the protocol's
`none` value: it is the absence of persistent memory, not another storage backend.

Until narrower memory scopes are supported, the agent Memory page displays `Scope` as
a fixed, read-only `Agent` value. Its help text must explain that an agent's memory is
shared across every user who interacts with that agent; the console must not imply that
memories are isolated per user.

An existing agent's memory settings are edited as one explicit draft. Selecting a
backend, changing managed distillation, switching an external connection, or editing
external recall/capture policy must not take effect until the user saves the form. While
the draft differs, show both the currently active backend and the unsaved selection or
settings. Content and records continue to reflect the active backend until Save
succeeds.

On the agent Memory page the settings form is collapsed by default behind a one-line
summary of the persisted backend (backend name, its key policy values, and the fixed
Agent scope) so the memory content itself stays the page's focus. Expanding the form
edits the draft; closing or cancelling it discards the draft, so a collapsed form
always describes the persisted settings. A successful save collapses the form again.

External memory always requires a connection. If no connection is selected, explain
inline that the draft cannot be saved and that the current backend remains active. An
already-bound external agent must not offer an empty selection that merely looks
unbound while its previous connection is still in use; the user must choose another
connection or explicitly switch to a different backend or Off. Server-side schema and
daemon admission remain fail-closed even when the console validates the draft first.

## Managed-memory dreaming defaults

Managed memory defaults to dreaming once per day at 04:00 in the owning daemon's
timezone and automatically accepting the completed store proposal. Users can turn
dreaming off, remove its schedule to keep only manual runs, or turn automatic acceptance
off independently.

Automatic acceptance applies to every successfully completed proposal, regardless of
whether the runtime carries the dream policy through a dedicated system-prompt channel.
The console must warn that these results replace live memory without content review.
An adoption fence conflict or failed swap still leaves the completed result available
for manual review instead of replacing newer live-memory changes.

Dream proposals preserve existing topic boundaries, filenames, and byte-identical
content by default. Small wording, formatting, ordering, or consistency changes do
not justify renaming a topic. A rename, merge, or split is appropriate only when a
material content change makes the existing structure misleading; equally faithful
proposals prefer the smallest diff.

Reviewing a completed dream shows each file as the same live-to-proposed line diff
used by managed-memory history. Added and deleted files use an empty live or proposed
side respectively, so their entire contents are visibly marked as additions or
removals before adoption.

Each dream model run appears in Sessions with its runtime, model, token/cost usage,
and its original ACP activity history. Dream history uses the same transcript
representation as an ordinary session: the exact extraction prompt, raw reasoning,
merged tool call/update bodies, and the model's final proposal are visible to anyone
authorized to view that agent's sessions. Those bodies can quote memory and
source-session content, so the agent's session access boundary is also the privacy
boundary; the daemon must not publish the Dream activity to the triggering chat,
generic evaluation events, or logs. The Memory page links the execution session;
source-session selection remains input metadata and must not displace that run's own
usage in the history presentation.

## GitHub informational review checks

An Agent failure is not a code-review finding. When a GitHub review turn ends without a
formal review verdict, keep the internal run failed for observability but complete its
informational Check as non-blocking `skipped`; a runtime failure may still say
`Review could not be completed`. A successfully submitted formal verdict remains
authoritative (`REQUEST_CHANGES` stays `action_required`), and an ambiguous formal-review
write remains a visible failure until it is reconciled.

GitHub's suite-level `Re-run all checks` action starts a new generation for every current
AgentConnect informational review Check in that App suite, with the same live maintainer
authorization and revision fences as a single-Check rerun. It does not depend on the
integration's ordinary event cadence.

## GitHub review mention routing

An explicit `@<agent-name>` in GitHub targets only that AgentConnect agent's
matching review integration. An explicit `@<github-app-name>` is the broadcast
form and targets every matching review agent for the repository. When both forms
are present, broadcast wins; mentioning an unrelated GitHub user does not change
the configured review cadence.

Mention routing does not bypass the integration's event family, label filter,
installation attribution, collaborator authorization, or bot-sender veto. A
targeted agent mention narrows an otherwise broader `updated` fan-out, while an
event with no AgentConnect mention continues to follow its configured cadence.
In a pull request conversation, an authorized explicit AgentConnect mention
starts a new review generation for the current revision when the integration
allows formal reviews, so its informational Check reopens and enters in progress
when analysis starts. Turning formal reviews off must not change trigger
matching: selected PR events and authorized mentions still activate the agent,
but an authorized mention no longer requests or permits a formal review, opens a
mention-driven review generation, or requires a review verdict. Independently
configured reporting for PR revision events remains separate. Review policy does
not select or change the hook's reply/output path; existing delivery behavior
continues to own that decision. The console presents review and reporting both
being off as `None`; selecting it changes neither trigger matching nor output
delivery. An ordinary unmentioned follow-up also remains conversation-only and
does not replace the current review verdict.

## Workspace navigation and repository access

The workspace options live in the agent's Workspace tab, above the files they
configure — not in Configuration, and not behind a summary row that navigates
there. A `Source` control owns conversion between scratch and GitHub; a single
`Edit` action owns repository, branch, working-subdirectory, and
repository-access settings. Replacing a workspace must replace the file browser
with it: the tree, the open preview, and the git status below the card always
belong to the workspace the card currently describes, never to the one it
replaced.

In the Workspace tab, callers who can edit the agent may create, edit, or delete
one file at a time when the workspace is scratch. New UTF-8 files use exclusive
creation and never overwrite an existing path; slash-separated names locate an
existing subdirectory or create the missing parent directories. Existing-file
edits load the complete file and save against the mtime they opened. Deletion also
requires the last-read mtime and an inline confirmation. Saving or deleting while
the agent is working surfaces a conflict; otherwise the daemon quiesces its
runtime before atomically applying the mutation, so an agent change is never
silently overwritten or removed. GitHub workspace files remain read-only, and
workspace bodies continue to transit the control plane without being persisted.
File creation and editing stay inline in the Workspace file browser, replacing the
preview pane instead of opening a modal. Desktop keeps the file tree visible;
mobile uses the browser's existing list-to-preview drill-in and back action. The
file-browser header shows the current workspace-relative breadcrumb on the left
and `Add file`, `Edit`, and `Delete` actions on the right. New-file naming happens
in that breadcrumb; completed slash-separated directory names become breadcrumb
segments. The preview pane does not repeat the file name, path, or workspace label.

The managed and native Memory file browser uses the same shared inline file editor,
breadcrumb naming field, and header actions as Workspace. It must not introduce a
separate prompt or modal flow for adding or editing files; only the persistence API
and Memory's flat Markdown filename validation differ. File-specific capabilities
belong in the preview summary row: managed Memory exposes `History` there today, and
repository-backed Workspace history must reuse the same action slot and history pane
when it is added.

For a GitHub workspace, show the effective `read` or `write` access beside the
repository. The editor may switch freely between scratch and GitHub, choose another
repository or branch, change the working subdirectory, edit read/write access, or bind
a manual GitHub checkout to the GitHub App. Before a mode, repository, or branch
change, state clearly that saving permanently replaces the current daemon-local
workspace files and cannot be undone. Use an explicit `Replace workspace` save label
for that destructive case. A working-subdirectory or access-only edit preserves the
current checkout.

Workspace changes are cold edits: active work is drained and existing cached
credentials are cleared before the new definition becomes active. Any edit that removes
write workspace authority for a repository must be rejected while an enabled GitHub
integration for that repository submits formal reviews or reports Checks; the user must
turn those actions off first. This conflict is a server-side invariant, not only an
editor validation.

An App-backed workspace follows a GitHub repository rename without treating it as a
workspace replacement. Its displayed repository and existing checkout origin converge
to the canonical new name while the branch, working subdirectory, and local files stay
in place.

## Agent secret environment variables

A write-only secret (the console's Secrets card, `AgentSpec.secrets`) is not an
ordinary env var, and the agent must never treat it as one. Two halves, both
mandatory:

- The daemon tells the agent WHICH env var names are secrets as standing session
  context — names only, never values — with the instruction to use them in place
  and refuse to reveal them.
- The daemon masks known secret values out of every agent-emitted surface —
  platform messages, the live webchat stream, persisted transcripts (including
  tool rawInput/rawOutput shown by the console's "View detail"), GitHub comments,
  memory extraction, and permission/elicitation cards — rendering `[secret:NAME]`
  in their place.

Masking is containment for accidental echoes, not a security boundary: the agent's
processes can legitimately read the value from their environment, and a hostile
prompt can re-encode it past any literal-match filter. Values too short to mask
meaningfully are left alone rather than mangling unrelated output. Neither half
substitutes for the other: the notice is what makes the agent behave; the mask is
what keeps a slip out of chat and the permanent record.

Agent env and secret values configured in the console enter only the ACP child
process environment; they are not configuration-template inputs. Every string in
`agent.json`, including descriptions and scheduled-task trigger text, is literal.
Environment values must never be copied into model context through interpolation.

## Local GitHub credential exposure

GitHub App installation tokens are internal transport material, not a public daemon
CLI feature. Credential-helper commands must stay hidden from normal help output and
the local credential socket must reject requests that do not carry the runtime-only
capability for the selected agent. The capability is generated in daemon memory and
must never be written to a shim, git config, agent config, or log.

Do not inject an AgentConnect-minted token as a long-lived `GH_TOKEN` in the ACP
runtime environment. Fetch it only for the specific `git` or `gh` invocation that
needs it, and log only the agent, repository, credential plane, and outcome.

This is defense in depth against casual extraction, not a claim that software can
hide a bearer token from a host administrator who can inspect or modify the daemon
and its child processes.

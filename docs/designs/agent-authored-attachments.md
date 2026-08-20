# Agent-Authored Attachments

**Status:** Proposed

[#1323](https://github.com/agentconnect-md/agentconnect/pull/1323) gave the daemon an
outbound byte path: every chat platform implements `MessageGateway.uploadFile`, and
`sendMessage` can put a file into a conversation. What it did **not** give the agent is a
way to send a file it _produced_ — and, it turns out, a way to send any file into the
conversation the user is actually in. This document designs both.

## 1. The gap, stated as use cases

The transport is general. `uploadFile` takes arbitrary bytes and a MIME type; four
platforms implement it; its contract (`undefined` ⇔ nothing was posted, a `warning` for a
caption lost after the file landed) is settled and tested. What is narrow is everything
upstream of it — the **source** of the bytes and the **destination** of the send:

|                                       | …into the CURRENT conversation           | …into a DIFFERENT conversation       |
| ------------------------------------- | ---------------------------------------- | ------------------------------------ |
| **A file this conversation received** | already visible there — nothing to build | `sendMessage` + `attachment` (#1323) |
| **A file the agent produced**         | **missing — the primary case**           | **missing**                          |

"Produced" covers more than generation: the runtime image ships `curl` and the agent has
ordinary file tools, so an agent asked to _find_ images can already download them into its
workspace. It then has no way to hand them to a platform. The missing piece is not
capability, it is an entry point.

The top-right cell is what #1323 shipped. The bottom row is this design. The top-left cell
is intentionally empty.

## 2. Why `sendMessage` cannot be the whole answer

The obvious design — and the first draft of this document — extends `sendMessage` with a
workspace-file source and stops. That design fails the primary case, for a reason that is
load-bearing elsewhere:

**`sendMessage` has no in-thread form.** Every visible send lands at the channel **root**
and opens a new conversation
([send-message-routing-rework.md](send-message-routing-rework.md) §2.2). The rule exists
because speaking in the current thread is the ordinary turn reply's job, and a second
visible delivery path into the same thread would compete with it — so the branch schemas
reject a `thread` argument loudly rather than accept coordinates.

But the primary ask is: a user in a thread says "find me some images", the agent finds
them, and the images should appear **in that thread**, as part of that exchange. Routed
through `sendMessage`, they would land at the channel root as a fresh conversation the
user has to go find. That is not a smaller version of the feature; it is the wrong
feature.

The ordinary turn reply cannot carry the file either — it is a text-streaming surface, and
no platform lets `chat.postMessage`-shaped sends carry bytes at all. So the current
conversation needs a surface of its own.

## 3. Design

Two additions, one resolver between them:

### 3.1 `shareFile` — a produced file into the current conversation

A new session tool:

```jsonc
{ "path": "out/chart.png", "caption": "revenue by week" } // caption optional
```

- **No coordinates, by construction.** The daemon posts into the session's own
  conversation using the trusted `SessionContext`, the way the postless `toAgent` wake
  derives its coordinates — availability is not authorization, and a model-supplied
  destination is not evidence the agent may reach it. With no destination parameters, no
  new authorization question exists.
- **It does not compete with the turn reply**, which is §2.2's rationale. A file is a
  message kind the reply path cannot produce, so there is no second path for the same
  content — and to keep the boundary crisp, `shareFile` carries no routing semantics at
  all: no mentions, no wake, no reply correlation.
- **Identity, but no response metadata.** The post is identity-stamped (username / icon /
  `agentAuthorId`) like every agent message, but carries no `response` block — the
  precedent is the cron/hook trigger anchor, which is "authorship for the transcript, but
  it closes no response and must never be routed as one". Peers therefore never treat the
  file as an answer, and finalization ignores it.
- **Posts when called.** The image may appear before the streamed reply finishes, like a
  person sending a photo and then typing. Acceptable, and much simpler than queueing the
  file into the reply's finalization lifecycle (considered and deferred — see §7).
- Recorded in the transcript as the agent's own row, with the workspace path as
  provenance (§4).

Implementation checkpoints, recorded because each has bitten before:

- The platform anchor handed to `uploadFile` must be derived the way the **reply path**
  derives it, not `ctx.thread` verbatim — thread keys are canonicalized per platform
  (`tg:` roots, Feishu `om_` anchors, DM continuations) and the two are not the same
  string everywhere.
- Slack's own echo of the post comes back as a `file_share` subtype, which is a
  **routable** subtype — own-echo removal and thread backfill must drop it rather than
  re-ingest it as a human message. In multi-agent channels the post mentions no one, so
  the no-mention activation rules already keep peers quiet.
- A session with no platform gateway (webchat, postless/headless children) gets a clean
  port-probed refusal, same as `sendMessage`'s attachment does today.

### 3.2 `attachFile` — a produced file to a different conversation

The secondary case reuses `sendMessage`'s existing shape: a new `attachFile` field on the
`toUser` and `channel` branches, mutually exclusive with `attachment` (the strict branch
schemas give the exclusivity for free). Root-only semantics are unchanged and correct
here — posting a produced file to _another_ channel legitimately opens a new conversation
there, exactly like posting text does.

The two fields stay separate rather than overloading one string: an agent always knows
which namespace it holds — a **name** copied out of an `[attached: …]` marker, or a
**path** from its own file tools — and a daemon that has to guess between them is the
failure mode this codebase repeatedly refuses.

`attachment` keeps its name and meaning; nothing an agent has learned changes.

### 3.3 The shared resolver

Both surfaces resolve a workspace-relative path to bytes through one function, which is
where every restriction below lives once.

## 4. The fence — reuse, then add what containment cannot give

Path containment is a solved problem in this codebase.
`workspace-files.ts` already guards the console's workspace browser against exactly this
input class, and its containment is stronger than a fresh attempt would be:
`containedWorkspacePath()` rejects absolute paths, lexical escapes, and any `.git`
component; the local implementation then **re-verifies through `realpath`**, so a symlink
— including an intermediate directory component swapped after the check — cannot smuggle a
target outside the root; violations carry a typed reason. `shareFile`/`attachFile` resolve
through that same function. A model-supplied path is untrusted input, and this is the one
place already hardened against it.

**What containment cannot give: the workspace is not a safe-to-publish zone.** It holds
source; on a multi-repository workspace it holds _every authorized repository_. A path
that passes the fence can still be `.env`, a private key, or a repo the conversation's
audience must not see. Three mitigations, deliberately layered:

- **Images only, decided by magic bytes.** `sniffImageMimeType` already exists — and
  exists _because_ declared types are not trustworthy — so the gate is the bytes, never
  the extension. An agent talked into publishing a secret can only do it if the secret is
  a PNG. If document-sending is ever wanted, it needs its own answer to "what may an agent
  publish from a workspace", not an exemption here.
- **Provenance on the transcript row.** The send records the workspace path beside the
  post, so an unintended publish is visible after the fact instead of silent.
- **No new permission gate.** The ordinary reply is not gated, and this posts into the
  same conversation with a narrower payload class than text can already leak. A gate here
  would be theater; the real controls are the two above.

## 5. Size

Two caps, for two different failure modes:

- **Per file:** reuse `cfg.limits.maxAttachmentBytes` (8 MB default) — the same knob that
  bounds inbound attachment downloads, so attachments are bounded symmetrically in both
  directions and operators tune one number. The platform's own limit applies beneath it,
  and the refusal names whichever bound was hit.
- **Per turn:** a total-uploaded-bytes budget. `uploadFile` has no cap today because the
  forward path could not exceed the 160 KB transcript copy by construction; a workspace
  source removes that guarantee, and an agent in a loop could otherwise push megabytes per
  turn through daemon memory into a channel.

**Failures are loud.** An over-cap or non-image file gets a refusal naming the rule —
never a silent downscale or truncation. An image the recipient cannot tell was degraded is
worse than an error the agent can report and route around.

## 6. The real constraint: agents that run in a pod

A host-run agent's workspace is on the daemon's filesystem — the resolver is a file read.
A **sandboxed agent's workspace lives in its pod**, and the daemon reaches it over the
shim workspace-files channel, which today cannot carry an image at all:

- frames are capped at `MAX_FRAME_BYTES` = 256 KB (`REPLY_BUDGET` ≈ 252 KB);
- the existing `read` is text-only — a NUL byte in the first 8 KiB refuses the file as
  binary;
- there is no chunked binary read.

So the same feature is one function call for a host agent and a new wire capability for a
pod agent. That splits the delivery:

1. **Phase 1 — host agents.** The full feature; pod agents get a loud "not yet available
   on sandboxed agents" refusal. Honest caveat: most managed-execution agents _are_ pod
   agents, so phase 1's value is self-hosted/dev installs plus settling the tool contract
   and the fence before wire work starts.
2. **Phase 2 — single-frame `readBinary`.** A bytes read bounded to one frame (~250 KB).
   No new framing; covers charts, diagrams, small screenshots. Over-cap files keep the
   loud refusal.
3. **Phase 3 — chunked binary read.** The honest answer for real screenshots and photos,
   deferred only because phase 2 will tell us the shape of the wire surface.

**Rejected: the pod uploads directly to the platform.** Slack's reserved upload URL
happens to need no credential, which makes this look cheap — but it means punching egress
out of a namespace whose whole point is default-deny, it puts platform-facing behavior on
the half-trusted side of the shim boundary, and it generalizes to none of the other three
platforms.

## 7. Considered and rejected

- **Markdown-driven uploads** — the renderer spots `![](out/chart.png)` in the reply and
  uploads the file. Most ergonomic for a model, and wrong: publishing becomes implicit (a
  reply that merely _quotes_ a path would upload it), a mid-stream upload failure has no
  sane place to land, and "a regex over prose" becomes a security boundary. Publishing a
  workspace file must be a deliberate tool call.
- **Queueing the file into the turn reply's lifecycle** (an `attachToReply` applied at
  finalization). Better integrated on paper — the file could ride the logical response —
  but it drags per-platform applier work and finalization-edit semantics into scope for no
  user-visible gain over post-when-called. Deferred until something needs the file to be
  _part of_ the response rather than beside it.
- **A URL source** (`shareFile({url})`, daemon fetches and re-uploads). Solves the
  found-on-the-web case without touching the pod wire — but a daemon fetching
  model-supplied URLs is an SSRF surface (metadata endpoints, private ranges) that this
  codebase does not currently have and should not grow for a convenience, and the agent
  already owns a download path into its workspace.
- **Multiple images in one message, and illustrated articles.** These read like this
  feature and are not: they are message-**composition** problems, solved differently per
  platform (Block Kit image blocks referencing uploaded files; Telegram media groups with
  their own text constraints; Feishu's rich-text post type rather than `msg_type: image`).
  Designing composition on top of a single-file port would force the port into a shape it
  does not need. Several images today = several `shareFile` calls = several messages,
  which is also how a person sends three photos. Sequence: source (this document) →
  multi-file → composition, each when something concrete needs it.
- **Agent-to-agent attachments.** `sendMessage(toAgent)` and parent-session replies stay
  text-only; carrying files across a wake is a protocol-frame change with its own
  routing questions, and belongs to its own design.

## 8. Phasing

| Phase | Scope                                                                        | Unlocks                                              |
| ----- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1     | `shareFile` + `attachFile` + fence + image sniff + both caps, host-side read | Host agents send produced images, here and elsewhere |
| 2     | Single-frame `readBinary` on the shim channel                                | Pod agents, images ≤ ~250 KB                         |
| 3     | Chunked binary read                                                          | Pod agents, real screenshots and photos              |
| —     | Multi-file, composition, A2A files                                           | Deferred; §7                                         |

Phase 1 lands alone and is the whole feature for host-run agents; phases 2–3 change no
tool surface, only where the resolver can reach.

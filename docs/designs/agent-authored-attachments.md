# Agent-Authored Attachments

**Status:** Implemented through phase 2 (§7's deferrals stand)

[#1323](https://github.com/agentconnect-md/agentconnect/pull/1323) gave the daemon an
outbound byte path: every chat platform implements `MessageGateway.uploadFile`, and
`sendMessage` can put a file into a conversation. What it did **not** give the agent is a
way to send a file it _produced_ — and, it turns out, a way to send any file into the
conversation the user is actually in. This document designs that.

## 1. The gap, stated as use cases

The transport is general: `uploadFile` takes arbitrary bytes and a MIME type, four
platforms implement it, and its partial-send contract is settled and tested. What is
narrow is everything upstream — the **source** of the bytes and the **destination**:

|                                       | …into the CURRENT conversation           | …into a DIFFERENT conversation       |
| ------------------------------------- | ---------------------------------------- | ------------------------------------ |
| **A file this conversation received** | already visible there — nothing to build | `sendMessage` + `attachment` (#1323) |
| **A file the agent produced**         | **missing — this design**                | deferred (§7) — no cited demand yet  |

"Produced" covers more than generation: the runtime image ships `curl` and the agent has
ordinary file tools, so an agent asked to _find_ images can already download them into its
workspace. It then has no way to hand them to a platform. The missing piece is not
capability, it is an entry point.

## 2. Why `sendMessage` cannot serve it

**`sendMessage` has no in-thread form.** Every visible send lands at the channel **root**
and opens a new conversation
([send-message-routing-rework.md](send-message-routing-rework.md) §2.2): speaking in the
current thread is the ordinary turn reply's job, and a second visible delivery path into
the same thread would compete with it, so the branch schemas reject a `thread` argument
loudly rather than accept coordinates.

But the primary ask is: a user in a thread says "find me some images", and the images
should appear **in that thread**, as part of that exchange. Routed through `sendMessage`
they would land at the channel root as a fresh conversation the user has to go find. That
is not a smaller version of the feature; it is the wrong feature.

The ordinary turn reply cannot carry the file either — it is a text-streaming surface, and
no platform's `chat.postMessage`-shaped send carries bytes. The current conversation needs
a surface of its own.

## 3. `shareFile`

A new session tool:

```jsonc
{ "path": "out/chart.png", "caption": "revenue by week" } // caption optional
```

**No coordinates, by construction.** The daemon posts into the session's own conversation;
the model names no destination, so no new authorization question exists (the postless
`toAgent` wake's precedent). It carries no routing semantics — no wake, no reply
correlation, and the daemon adds no mention. The **caption**, being model-authored free
text delivered as e.g. Slack `initial_comment`, is where mention syntax could still
resolve — so mention syntax is escaped in the caption (a caption labels a file; escaping
costs nothing) rather than promised away.

**Posts when called.** The image may appear before the streamed reply finishes, like a
person sending a photo and then typing — much simpler than queueing the file into the
reply's finalization lifecycle (§7).

### 3.1 The anchor — one rule, four platform shapes

The anchor is the **active turn's** `(channel, thread?)` — an _optional_ thread, where
absent legitimately means "post in the channel" — never `SessionContext.thread`, which is
a required session key (`msg.thread ?? msg.msgId`) and not a platform coordinate. The
reply path resolves this per platform, and it is four shapes, not one:

- **Slack** — `thread_ts`. Directly what `uploadFile` already accepts.
- **Telegram** — placement in a non-forum group comes from `replyTo`, not from a thread
  id: the session thread key there (`tg:<id>` / `dm`) is deliberately non-numeric and
  `postMessage` documents itself as ignoring it. `uploadFile` today has **no reply slot**,
  so a share in every plain group would land at the chat root — §2's disqualifying
  outcome — and a human reply to that root post would fork a new session key. The port
  therefore gains a reply anchor (mirroring `postMessage`'s), applied to the photo send
  and to the over-1024-char caption overflow alike.
- **Discord** — the thread IS a channel id when one exists. The unrepresentable state is a
  guild conversation whose thread promotion failed: the session key is then
  `discord:<ch>:<msgId>`, which no channel fetch resolves, and the share would report
  "nothing was posted" in a turn whose ordinary reply lands fine. Top-level guild slash
  commands sit permanently in that state (their message id is the interaction id, which
  thread promotion cannot fetch) — and until [#1328](https://github.com/agentconnect-md/agentconnect/pull/1328)
  the bot invite requested MANAGE_THREADS instead of CREATE_PUBLIC_THREADS, so promotion
  has only ever worked where a server's `@everyone` default supplied the permission. The
  channel fallback, exactly as the reply path's `replyTarget` does it, is therefore a
  **phase-1 requirement**, not a caveat.
- **Feishu** — the session thread key IS the platform anchor: normalization already sets
  it to the `om_` root (or the chat id for a DM), and the reply path passes it through
  unchanged. Never derive it via `threadKeyForPost`. The trap is the opposite one:
  `sendImage` prefix-sniffs the anchor and **silently falls back to a chat-root post** for
  anything unrecognized (a hook-anchored turn's `hookId:deliveryKey`, for instance) — in
  topic mode that manufactures a new topic and reports success. The port must refuse an
  anchor it cannot honor rather than repurpose it.

### 3.2 Who may not call it

Three refusal classes, and only the first is port-probeable — the doc'd earlier claim that
"postless/headless children get a clean port-probed refusal" was wrong on two of them:

1. **No gateway** — webchat, which the port probe answers, but the refusal is a
   deferral rather than a verdict: the console already renders images in transcript rows
   (`WebchatImageAttachment`, png/jpeg/webp ≤ 160 KB), so the missing piece is only an
   outbound agent→browser image frame — the current schema is inbound-only. Deferred in
   §7; worth naming because phase 1's audience (self-hosted installs) is exactly where
   webchat is used most.
2. **No conversation** — a postless A2A child keeps the caller's real platform and a live
   gateway, so the probe _passes_; the tell is the synthetic `a2a:<caller>` channel. Gate
   on the coordinate, before the file is read.
3. **Posting forbidden** — a headless turn has a real channel and a live gateway and must
   post nothing; that is its point. `SessionContext` carries no headless flag today, so
   adding one is a phase-1 checkpoint, and the gate again runs before the read.

### 3.3 Identity, caption, and the result

**The file post carries no message id of its own, and Slack needs a second read to get
one.** `files.completeUploadExternal` answers with the FILE, not the message it became — and
an unnamed post is not an ANCHOR: a human replying under a shared image lands in a thread
whose root the daemon does not recognize as its own, so the reply wakes nobody, while the
same reply under a forwarded TEXT message (a `chat.postMessage`, which returns its `ts`)
always worked. `uploadFile` therefore reads `files.info` after the share and returns
`shares.public|private[channel][0].ts` as the outcome's `messageId`. The read is
best-effort by construction: the file is already in the conversation, so a failure degrades
to an unanchored share, never to a failed one.

**Only Slack can identity-stamp a file post, and the API's own arguments are the only way
to do it.** `chat.postMessage` cannot attach a file at all, so the upload's completion IS
the message — which is why the file path and the text path diverge in the first place, and
why every consequence of that divergence lands here. `files.completeUploadExternal`
documents `username`/`icon_url`/`icon_emoji` for the share message (behind
`chat:write.customize`), so `uploadFile` passes the turn's identity there and falls back to
the undecorated call when — and only when — Slack refused the DECORATION itself
(`missing_scope`, `invalid_arguments`). The completion is one-shot, and Slack documents
`internal_error`/`fatal_error` as possibly raised after part of it succeeded, so those join
"no provider code at all" as outcomes that forfeit the proof of refusal and stay
`indeterminate` rather than being retried into a second share. The other three
implementations do not declare the parameter, and Telegram ignores identity by platform
design. A file post still carries no `agentAuthorId`, so on a shared bot it stays invisible
to peer backfill; the fix for that remains a paired anchor post, deferred until shared-bot
usage demands it. Phase 1 states this degradation per platform rather than claiming otherwise; if
attribution matters on shared bots, the fix is a paired zero-content anchor post stamped
with `agentAuthorId` — which would also supply Slack's missing message id — and it is
deferred until shared-bot usage demands it.

**Caption contract:** a short, single-message, plain-text line with an explicit bound,
refused **up front** when exceeded — the platforms otherwise diverge silently (Feishu fans
long captions into N messages inside one queue task, Telegram re-sends the overflow,
Slack fails the whole share opaquely). On Slack the caption is mrkdwn (`initial_comment`
suppresses `blocks`), so `**bold**` reads literally there; stated, not fixed.

**Result contract:** a `warning` from the port surfaces as the same in-turn `notice`
`sendMessage` already raises; `undefined` is a thrown error; where the platform returns no
message id, the transcript row synthesizes one exactly as `sendMessage` does. One thing it
must **not** do: reuse `sendMessage`'s post path, whose returned message id seeds and
anchors a NEW session — correct for a channel-root post, and quietly relocating for
`shareFile`, whose thread already has the session the turn is running in. The id is a
transcript detail here, never a seed.

## 4. The resolver and the fence

One resolver serves the tool; every restriction lives in it once.

**Containment is reused — and it is two fences, one per phase, not one.** On a host
agent's local tree the resolver runs `canonicalWorkspacePath()`: the lexical check
(absolute/`..`/`.git`) plus **realpath re-verification**, so a symlink — including an
intermediate component swapped after the check — cannot smuggle a target outside the
root; its `null` (absent path) becomes the resolver's own refusal. There this is hygiene,
not a boundary: a host agent runs as the daemon's uid and can read anything the daemon
can. In the pod phase the boundary is real, and it is **not** the daemon's realpath —
there is nothing daemon-side to realpath — but the pod's own fd-anchored descent, which
is stronger than any name check. The daemon then contributes only the lexical half
(`containedWorkspacePath()`, which carries the `.git` rule the pod-side check lacks) as
defence-in-depth on the relative path before the read.

**The read is single-shot:** resolve once, read once into a buffer; the sniff, the size
cap, and the upload all consume that same buffer. (The console's workspace `read` cannot
be reused here — it refuses binary content by design — so this is new, small I/O code.)

**Images only, decided by magic bytes:** the accepted set is **PNG, JPEG, WEBP** —
exactly `sniffImageMimeType`'s set, and that is a principled boundary, not a sniffing
convenience: it is `SessionImageAttachment`'s enum, i.e. what the console can render back
from a transcript row, and that enum is a wire schema shared with the webchat ingress
validator, so widening it ripples across wire surfaces. GIF is therefore **deferred, not
two lines away** (§7): beyond the enum, an animated GIF on Telegram must route through
`sendAnimation` — `sendPhoto` silently de-animates it, the categorical form of the
degradation this design forbids. Since an animated GIF is a plausible result of §1's
find-me-images case, the refusal **names GIF** rather than saying "not an image". SVG
stays out for the provable-bytes reason. The outbound **filename and MIME type derive
from the sniffed type, never from the model-supplied path** — Discord renders by
extension alone, so `out/chart` (or any curl output without an extension) would otherwise
land as a non-previewable attachment in the feature's primary case.

**What the gate is honestly for:** it stops the wrong file and the injected "attach your
.env" instruction. It is _not_ a control against deliberate exfiltration — a secret
appended after a PNG's IEND still sniffs as PNG — and the reason that residual is
acceptable is that the ordinary text reply already exfiltrates to the same audience.

**Provenance is a forensic aid, not a detection control:** the transcript row records the
workspace path (a model-chosen label) plus the **sniffed type, byte length, and a digest**
of what was actually published — and, when the bytes fit the existing 160 KB
`SessionImageAttachment` cap, the bytes themselves, exactly as an inbound image does, so
the console can render what the agent shared and not only that it shared something. Above
the cap the row is digest-only; nothing else is kept daemon-side. Without this, a user's
uploaded PNG would preview while the chart the agent produced in reply would not.

## 5. Size, time, and refusals that say why

- **Per file:** an outbound cap, its own config entry defaulting to
  `limits.maxAttachmentBytes` (8 MB). It is not the same knob semantically — inbound
  overflow degrades gracefully to a `resource_link`, outbound overflow is a hard
  refusal — so it must be tunable separately even if the default is shared.
- **Per turn:** a total-bytes budget with a named owner and a **synchronous charge
  point** — tool calls dispatch concurrently, so the declared size is reserved in the
  same tick as the check, before the read allocates, settled to actual after the upload,
  released on failure. Headless and cron turns budget like any other.
- **Time is the sharper bound than bytes.** Every platform runs one serial send queue per
  connection, the whole upload is one queue task, and the queue abandons a task at 30 s
  with the rejection racing _outside_ it — the abandoned upload keeps running and may
  land. An 8 MB share therefore (a) freezes the streamed reply and every other chat on
  that bot while it transfers, and (b) can produce the port's worst answer: "nothing was
  sent" for a file that arrived, inviting a double-post retry. The port's failure
  vocabulary gains a typed reason —
  `missing_scope | too_large | not_found | forbidden | indeterminate | platform_error` —
  where **`indeterminate` means "may have landed; do not retry"**, and every
  implementation already holds the material to classify (scope trackers, permission-issue
  helpers). Whether the default cap must also drop below what 30 s carries is §9.2.
- **Fidelity is stated per platform, not promised globally.** Telegram routes every image
  through `sendPhoto`, which re-encodes server-side — on a text-dense chart that may be
  exactly the silent degradation this design forbids (§9.1). The eventual fix is a
  `preview | file` hint on the port (deferred; MIME mislabelling is not an option — it
  collides with Feishu's images-only refusal and with the sniff-derived name above).

Failures are loud and **named**: an over-cap or non-image file gets a refusal quoting the
rule; a missing Slack `files:write` scope (the likeliest first-run failure, and
operator-fixable) is distinguishable from a deleted thread root.

## 6. Reaching a pod agent's workspace

A host agent's workspace is a local read. A sandboxed agent's workspace lives in its pod —
and the first draft of this document wrongly concluded that reaching it needs new wire
work. It does not:

- the **workspace-fs channel** (the fd-anchored channel the managed memory tree rides,
  pointed at the workspace tree per agent) already carries **chunked base64 reads** with
  no binary refusal, mtime/size-fenced, under the `read` grant every sandbox already
  holds;
- the only genuine gap is a port shape: `WorkspaceFs.readFile` types its result as text.
  Phase 2 is a bytes read on that seam — local = the same buffer read, shim = the existing
  base64 op — bounded by the §5 cap, **not** by a frame. (A single-frame variant was
  considered and dropped: the honest single-frame ceiling after base64 expansion is
  ~189 KB, and the existing op would need a fit-to-budget fix anyway.)
- one containment caveat travels with it: that channel's pod-side check has **no `.git`
  rule** (absolute/`..`/NUL only), so the daemon applies the lexical fence to the relative
  path before the read — the pod-phase division of labor §4 spells out, with the symlink
  guarantee owned by the pod's fd-anchored descent rather than by a daemon-side realpath
  it cannot run.

Host-first is therefore **sequencing, not a wire constraint**: phase 1 settles the tool
contract, the anchor, and the fence where iteration is cheap; phase 2 is small.

**Rejected: the pod uploads directly to the platform.** Slack's reserved upload URL
happens to need no credential, which makes this look cheap — but it punches egress out of
a default-deny namespace, puts platform-facing behavior on the half-trusted side of the
shim boundary, and generalizes to none of the other three platforms.

## 7. Considered and rejected / deferred

- **`attachFile` on `sendMessage`** (a produced file to a _different_ conversation) —
  deferred, by this document's own rule: §2 argues the current-conversation case, and no
  concrete request exists for the other cell (§9.3). The shared resolver makes it a
  one-field addition later. If added: exclusivity with `attachment` must be an **explicit
  refusal** (the strict branch schemas only reject _unrecognized_ keys, so two recognized
  fields would otherwise resolve by silent precedence), and three shipped tool-description
  sentences must be edited in the same change — "you can neither attach a file you were
  not sent nor produce one", "the ONLY way to put an image on another platform" (scope to
  _received_), and `sendMessage`'s "write your ordinary turn reply instead" pointer, which
  must name `shareFile` or agents will keep being steered to channel-root posts. The last
  of these three edits is phase-1 work regardless, since `shareFile` obsoletes the
  sentence on its own.
- **Markdown-driven uploads** — the renderer spots `![](out/chart.png)` in the reply and
  uploads it. Ergonomic and wrong: publishing becomes implicit (quoting a path uploads
  it), a mid-stream failure has no sane place to land, and a regex over prose becomes a
  security boundary. Publishing a workspace file must be a deliberate tool call.
- **Queueing the file into the reply's finalization lifecycle** — better integrated on
  paper, but drags per-platform applier and finalization-edit semantics into scope for no
  user-visible gain over post-when-called. Deferred until something needs the file to be
  _part of_ the response rather than beside it.
- **A URL source** (`shareFile({url})`, daemon fetches and re-uploads) — rejected, on the
  reasons that hold: a model-supplied fetch is a new egress _decision_, and the agent
  already owns a download path into its workspace. (Not on SSRF novelty: Discord's
  `downloadFile` is already a bare fetch of a tool-supplied URL with no origin pinning —
  a pre-existing gap to fix separately, not a precedent to extend.)
- **Multiple images per message; illustrated articles** — message-**composition**
  problems, solved differently per platform (Block Kit references, media groups, Feishu
  rich posts); composing on a single-file port would force the port into a shape it does
  not need. Several images today = several `shareFile` calls = several messages, which is
  how a person sends three photos. Sequence: source → multi-file → composition.
- **GIF** — needs the `SessionImageAttachment` enum widened across its wire surfaces and
  a `sendAnimation` shape on the Telegram arm; until then a GIF gets a refusal that names
  it (§4).
- **Webchat** — not a refusal on principle: the console already renders transcript
  images, so this is one outbound agent→browser image frame on the relay content plane.
- **Agent-to-agent attachments** — a protocol-frame change with its own routing
  questions; its own design.

## 8. Phasing

| Phase | Scope                                                                                                                                                     | Unlocks                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1     | `shareFile`; resolver + fence + sniff + caps; port widenings (reply anchor, typed failure reason, anchor refusal); refusal-class gates; description edits | Host agents, current conversation |
| 2     | Bytes read on the `WorkspaceFs` seam (shim = existing base64 op), daemon-side fence on the relative path                                                  | Pod agents                        |
| —     | `attachFile`, GIF, webchat image frame, multi-file, composition, `preview \| file` fidelity hint, A2A files                                               | Deferred; §7                      |

## 9. Open questions

1. **Telegram:** does `sendPhoto` re-encode a ≤8 MB PNG chart badly enough to blur axis
   labels? Decides whether the `preview | file` hint is deferrable.
2. **Slack:** wall time of an 8 MB external upload on a typical self-hosted uplink vs the
   30 s queue bound — decides whether the default cap drops, the byte transfer gets its
   own lane, or `indeterminate` carries the weight.
3. **Slack transport (settled):** the external upload's middle step is a POST to a reserved
   URL that is not a Slack API endpoint and has no published wire contract. Driving it by
   hand was refused with HTTP 500 on every live attempt. Matching the SDK's multipart shape
   — one part named `body`, an untyped `Blob` — did not lift the 500; the one divergence
   left was that the SDK sends `Authorization: Bearer <token>` to the reserved URL, which
   the hand-written POST asserted in a comment was unnecessary. Rather than test that guess
   in production, `uploadFile` now calls `files.uploadV2`, which owns all three steps and
   inherits the `WebClient` agent/proxy/timeout configuration. Two consequences: it builds
   its completion arguments from an explicit key list, which is what removed the identity
   decoration above; and it raises one `WebAPIHTTPError` for every non-200 across all three
   steps, so an HTTP failure can never prove which step it came from. Only Slack answering
   `{ok:false}` counts as proof that nothing was published — everything else is
   `indeterminate`.
4. **Why the two paths differ at all (settled).** Slack has no way to attach a file to a
   message: `chat.postMessage` takes no file, and the upload's completion creates its own
   message instead. So a caption rides as `initial_comment` on a message the UPLOAD endpoint
   built, and everything `chat.postMessage` returns for free — a `ts`, per-message identity —
   has to be recovered separately here. `blocks` + `slack_file` would collapse the two paths
   into one, but a file uploaded without `channel_id` is documented as private, and whether a
   block reference makes it visible to anyone else is not documented either way; that is the
   open question standing between this design and one code path.
5. **Demand:** is there a concrete request behind "produced file → different
   conversation", or only the table's symmetry? Decides whether `attachFile` leaves §7.

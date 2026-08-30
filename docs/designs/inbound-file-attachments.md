# Inbound File Attachments

**Status:** Proposed — no part of this is implemented yet.

Users can already hand an agent an image: webchat uploads one (re-encoded to WebP,
≤ 160 KB), and every chat platform's inbound images reach the agent's prompt as ACP
`image` blocks. What users cannot do is hand an agent a **file** — a PDF, a zip, a CSV, a
log dump — and have the agent actually work on it. This document designs that, for the two
entry points that matter: the web console's chat composer, and the files users already
attach on Slack / Telegram / Discord / Feishu.

## 1. What exists, and where it dead-ends

The inbound pipeline (daemon-detailed-design.md §9.2) already carries generic files most
of the way:

- Normalization keeps **every** attachment kind — `PlatformAttachment` is metadata plus a
  provider reference, with a free-form MIME type; nothing filters non-images out.
- The daemon downloads the bytes itself, with the platform connection's credentials,
  bounded by `limits.maxAttachmentBytes` (8 MB default). The relay and the CP never see
  content, and nothing here changes that.
- `attachmentToBlock` then hands the bytes to the runtime: an `image` block for images, an
  embedded `resource` (UTF-8 text or base64 blob) when the runtime advertises
  `embeddedContext`, a `resource_link` otherwise or when the download was refused.

And that is where it dead-ends, three ways:

1. **A blob in the prompt is not a file.** A coding agent cannot `unzip` a base64
   `resource` block, cannot run `pandoc` on it, cannot read it with its file tools. For
   anything that is not small readable text, embedding is a courtesy the agent cannot act
   on.
2. **The `resource_link` fallback is unfetchable half the time.** Discord and Feishu
   declare no attachment-read tool at all, and the Slack/Telegram tools return a
   byte-count stub for non-text binaries. An over-cap file, or any file toward a runtime
   without `embeddedContext`, is effectively lost.
3. **Nothing ever lands on disk.** Even when the agent can see the content, it cannot obey
   "put this logo under `assets/`" — it has bytes in context and no file to move.

Webchat is narrower still: the composer accepts `image/*` only, the browser re-encodes to
WebP ≤ 160 KB, and the wire schema (`WebchatImageAttachment`) is a png/jpeg/webp enum. A
generic file cannot enter at all — and even an _image_ reaches the agent only as the lossy
160 KB projection, where the same image sent on Slack arrives at full resolution.

## 2. The landing zone: every attachment becomes a workspace file

The unifying move: **the daemon materializes inbound attachment bytes into the session's
workspace**, and the prompt names the path. Both entry points converge on it:

```
web console:  browser ──(chunked frames; relay forwards, stores nothing)──▶ daemon ─┐
platforms:    provider ──(metadata)──▶ daemon ──(credentialed download, ≤ cap)──────┤
                                                                                    ▼
                                                       <session working root>/uploads/spec.pdf
                                                                                    │
              prompt: [attached: spec.pdf (application/pdf, 1.2 MB) — saved to uploads/spec.pdf]
```

The workspace — not a daemon-side attachment store with a read tool — because the
workspace is the only filesystem the agent's tools and shell are guaranteed to reach, on
both deployment shapes: a sandbox pod cannot see the daemon's local disk, but the
`WorkspaceFs` seam already reaches the pod's volume over the fd-anchored shim channel. No
new tool surface, no new mount, no reach problem.

### 2.1 Placement rules

- **Directory:** `uploads/` at the session's **working root** — the per-session worktree
  when one exists, the agent's primary checkout otherwise. The file lands where the agent
  is already working, so relative paths in the prompt resolve without ceremony, and the
  file's lifetime is the conversation's: a reclaimed worktree takes its uploads with it,
  so no separate retention machinery exists.
- **Names are hostile input.** The stored name is derived from the platform-supplied one
  by sanitization: path separators, `..`, control characters, and leading dots are
  stripped or replaced; an empty survivor gets a generated name from the sniffed type. The
  resolved path must stay under `uploads/` — the same containment discipline the console
  workspace channel already enforces.
- **Never overwrite.** Creation is exclusive; a name collision appends a numeric suffix
  (`report.pdf`, `report-2.pdf`). One exception makes redelivery idempotent: if the target
  exists with byte-identical content (digest match), it is reused rather than suffixed, so
  a replayed inbox message does not litter.
- **Git workspaces are allowed, plainly.** The upload is an ordinary untracked file —
  visible in the git status panel, no hidden directory, no automatic exclude. If the point
  of the upload is "commit this", the agent moves it and commits it; if not, it stays
  untracked and dies with the worktree. Magic exclusions would hide exactly the file the
  user just asked the agent to handle.
- **Writes are atomic.** Staged beside the target and published by one rename —
  `WorkspaceFs.writeFile`'s existing discipline — so an aborted turn leaves no partial
  file. The seam gains a **`writeFileBytes`** sibling of `readFileBytes`; the shim channel
  already stages chunked appends and publishes by rename, so the pod side is the same
  pattern with a base64 leg.

### 2.2 Timing and scope

Materialization happens at **prompt-build time, for the triggered turn only** — the same
place the download already runs and memoizes today, wrapped in the same abort. Messages
that merely pass by (context frames to non-targeted webchat participants, observer rows)
carry the `[attached: …]` marker without the path and without bytes: fanning 8 MB into
every roster member's workspace is neither wanted nor bounded. An agent that was only
shown the marker and is later asked about the file does not have it — an accepted
limitation, stated rather than papered over.

### 2.3 Division of labor: the platform never parses the prompt

`uploads/` is a landing zone, not a destination. The daemon does one deterministic thing —
write the bytes, name the path — and never interprets user text into filesystem
coordinates. "Put it under `assets/` and rename it" is the agent's job: by the time the
model reads the message, the file is on disk and the marker names it, so following the
instruction is one `mv`, indistinguishable from any other file operation the user asks
for.

## 3. Prompt representation

The `[attached: …]` marker (the string `sendMessage`'s forwarding contract already keys
on) gains the saved path:

```
[attached: spec.pdf (application/pdf, 1.2 MB) — saved to uploads/spec.pdf]
```

Around it, `attachmentToBlock`'s ladder changes rung by rung:

- **Images keep their block.** The full-resolution bytes still become an ACP `image` block
  when the runtime supports one — the model should _see_ the image — and now the same
  bytes are also on disk, so "add this screenshot to the README" is executable.
- **Non-images stop being embedded once the write succeeds.** The blob `resource` rung
  disappears for a materialized file: the path in the marker replaces it, and the agent
  reads what it needs with its own tools instead of hauling an 11 MB base64 string through
  its context. Small UTF-8 text keeps nothing either — uniformity beats a special case the
  agent cannot predict.
- **Failure falls back to today.** If the workspace write fails (no workspace mount, disk
  refusal, suspended pod), the block ladder runs exactly as it does now — embedded
  resource or `resource_link` — so the feature degrades to the current behavior, never
  below it.
- **Over-cap stays a `resource_link`.** A file the daemon refused to download is unchanged
  by this design. Raising the materialization cap above `maxAttachmentBytes` (streaming to
  disk does not hold bytes in RSS the way prompt embedding does) is a natural follow-up
  with its own knob, deferred.

## 4. The web console entry

### 4.1 Wire shape: a sibling, not a wider enum

`SessionImageAttachment` / `WebchatImageAttachment` (png/jpeg/webp, ≤ 160 KB, ≤ 1 per
row) is a wire schema shared across the webchat ingress validator, the transcript row, and
the CP history DTO — agent-authored-attachments.md §4 records why widening it ripples.
It is not widened. Files ride a new **`SessionFileAttachment`**: name, MIME type, size,
digest, and — once materialized — the workspace-relative path. Bytes never appear in it:
on the browser wire they travel as upload chunks (§4.2); in the transcript it is
metadata only (§5).

### 4.2 Transport: chunked over the socket that already exists

The relay's browser WebSocket caps frames at `MAX_FRAME_BYTES` (256 KiB) — the reason the
160 KB image cap fits in one frame, and the reason an 8 MB file cannot. Rather than a new
HTTP surface with its own auth story, the upload rides the already-authenticated webchat
socket as a chunk sequence:

- `upload/begin { uploadId, name, mimeType, size }` → `upload/chunk { uploadId, seq,
dataB64 }` (raw chunk ≈ 180 KB, the console workspace-edit precedent, so the framed
  base64 stays under the cap) → `upload/end { uploadId, sha256 }`.
- **The relay forwards each frame to the owning daemon and keeps nothing** — no
  reassembly, no buffering beyond the frame in flight. Its only checks are per-frame:
  schema, chunk size, and a declared `size` within the cap.
- **The daemon is the one stateful party.** It stages chunks to a temp file (ordering is
  the socket's; a gap or duplicate `seq` aborts), enforces the cumulative cap
  authoritatively, verifies the digest at `end`, and answers with an upload token. The
  turn frame then references the token in its `files` list; materialization into
  `uploads/` happens at prompt-build like every other attachment. Staged uploads not
  referenced by a turn are dropped on socket close and after a short TTL.

Per-file cap: `maxAttachmentBytes`, same knob as platform downloads. Phase 1 allows **one
file per message**, matching the existing `.max(1)` attachment shape; a larger file is
refused in the composer with the limit named, before any chunk is sent.

### 4.3 Images through the same door

Today's webchat image path is a lossy projection: the browser re-encodes to WebP ≤ 160 KB
and that _is_ what the agent sees — where Slack hands the agent the full-resolution
original. With the file channel in place, webchat aligns to the platform model:

- The **original** bytes (≤ cap) ride the upload channel and land in `uploads/`; the
  `image` block is built from them, full resolution.
- The browser still produces the ≤ 160 KB WebP — demoted from sole payload to **transcript
  preview**, carried in the existing image slot so the console render path and the
  ≤ 160 KB bound are untouched.
- An image too large for the cap falls back to exactly today's behavior: preview-only,
  no file. A non-image file too large is refused outright (§4.2) — there is no lossy
  projection of a zip.

The composer routes by type automatically; `accept` opens up to any file. The existing
gate stays: continuable external sessions take no attachments of either kind.

## 5. Transcript and console

A file attachment's transcript row stores **metadata only** — name, MIME type, size,
digest, saved path — never bytes. The 160 KB image copy remains the only content the
transcript retains, so transcript growth and the console history DTO stay bounded. The
console renders a file chip (name, type, size) beside the message; there is nothing to
preview and, in phase 1, nothing to download back — the Workspace file browser can already
navigate to `uploads/` for text, and byte download-back is deferred. The CP continues to
proxy without persisting; nothing new touches it beyond the DTO carrying the metadata row.

`sendMessage`'s cross-conversation forwarding contract is **unchanged**: it resolves only
the retained ≤ 160 KB transcript image copies. A file's marker names it, but forwarding
bytes the transcript never kept is a different feature (§7).

## 6. What each platform gains

Slack, Telegram, Discord, and Feishu change **nothing on the wire**: metadata in, daemon
downloads with its own credentials, exactly as today. The delta is daemon-side only —
materialization plus the marker path — and it retires dead-end №3 for every platform at
once, and dead-end №2 for every file under the cap: a Feishu PDF the agent previously
could neither embed-read nor fetch is now simply a path. Feishu's octet-stream image
sniffing, Telegram's photo/document model, and Discord's public-CDN downloads are all
untouched upstream of the landing zone.

Two adjacent sores this design touches but does not fix (tracked as cleanups, not
phases): the `resource_link` description is Slack-worded on every platform, and the
Slack/Telegram read tools return a stub for binaries. Both matter less once
materialization exists — the link rung only fires on over-cap files and write failures.

## 7. Deferred

- **Multiple files per webchat message** — the platform side already handles N; the
  webchat wire starts at 1 to match the image shape.
- **Materialization above `maxAttachmentBytes`** — streaming to disk unlocks a higher cap
  than prompt embedding could afford; wants its own knob and its own look at download
  streaming (today's downloads buffer whole).
- **Console download-back** of an uploaded or agent-produced file.
- **Forwarding non-image files** across conversations (`sendMessage` stays images-only).
- **A2A attachments** — collaboration context frames carry markers only.
- **Peer materialization on demand** — a roster member asked about a file it only saw the
  marker of.

## 8. Phasing

1. **Foundation (daemon only, no wire change):** `WorkspaceFs.writeFileBytes` (+ shim
   channel leg), the `uploads/` landing zone with sanitization / exclusive-create /
   digest-reuse, materialization at prompt build, marker gains the path, blob-embedding
   rung retired for materialized files. Ships value to all four chat platforms
   immediately.
2. **Web console files:** `SessionFileAttachment`, the chunked upload frames, relay
   forwarding, daemon staging, composer + transcript chip + history DTO.
3. **Webchat image unification:** original bytes through the upload channel, WebP demoted
   to transcript preview.

Each phase is independently shippable and independently revertible; phase 2 and 3 degrade
to phase 1's platform behavior when the new frames are absent (older daemon or older
console), because every new field is optional and the image path survives untouched.

## 9. Verification items before implementation

- The relay browser socket's tolerance for a sustained ~45-frame burst (8 MB at 180 KB
  chunks) — backpressure, not correctness, since ordering is the socket's.
- The staged-upload TTL and cleanup interaction with daemon restart (staged temp files are
  daemon-local and disposable; the inbox does not persist webchat turns today).
- Whether prompt-build materialization needs the console write path's quiesce, or whether
  exclusive-create into `uploads/` is safely concurrent with a running turn (expected:
  the latter — nothing existing is mutated).

# Generated Images in Webchat

**Status:** Implemented. §8 records the implementation choices this document left open.

Publish the preview first and upload the
original asynchronously. Upload failure does not invalidate a shared preview. Renew
expired signed URLs automatically; label missing cache objects as expired without
re-uploading them. Send preview base64 to the browser, not back into model context.
Support self-contained static SVG inline below the limit and as a PNG preview above
it. Both Codex and Claude require real image-generation acceptance. With S3 enabled,
remove the legacy 8 MiB share limit and its derived per-turn budget; use the existing
transfer policy and bounded file/image processing instead.

## 1. Decision and user experience

Ship a daemon-owned `agentconnect-images` skill and extend the existing
`shareFile` session tool to webchat. The runtime creates the image using capabilities
actually available to it; the daemon publishes a workspace file into the current
conversation. Generation and publication have separate contracts.

A shared image is published when its valid preview is durably recorded and can be
displayed. Waiting for S3 would delay or prevent an otherwise usable preview, so
original delivery runs asynchronously and updates the same image after the generating
turn finishes or is stopped. Delivery failure never retracts the preview or creates
another message. The browser receives preview bytes directly, while the model receives
a short publication receipt; rendering does not depend on the model repeating encoded
image data.

Original delivery uses a process-local task. A daemon interruption may leave the
original unavailable, but the retained preview remains useful. Durable upload jobs
and restart recovery are outside this feature's scope.

For example, a user asks for a product illustration. The agent invokes its available
image-generation tool, saves the result as `outputs/images/<unique-name>.png`, and calls:

```json
{
  "path": "outputs/images/product-illustration.png",
  "caption": "Product illustration"
}
```

Webchat displays an image card under that agent's name, with a caption,
**View original** and **Download** actions. A text reply may follow.
Reloading the conversation preserves the image as its own message. Several images
use several calls; a reply containing only an image is a complete, valid response.

Use inline bytes for small images and the configured S3 transfer cache for large
originals. Keep a bounded preview in the transcript in either case. A cached original
is a snapshot: editing or deleting the workspace file does not affect it while the
cache object exists. An expired original is labeled **Original expired** while its
preview remains visible. Expired signed URLs are renewed automatically while their objects remain available;
missing cache objects are not automatically re-uploaded. Small inline originals
and all saved previews follow transcript
retention. Permanent archival of large originals is outside this cache-based proposal.

The publication policy is automatic; the agent supplies only the file path and caption:

| Image size              | S3 transfer cache | Preview sent as base64                              | Original and returned download                                                        |
| ----------------------- | ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Within the inline limit | Either            | Original bytes, without resizing                    | Original is inline; the browser can view or download it directly                      |
| Above the inline limit  | Enabled           | A generated preview no larger than the inline limit | Upload the unchanged original to S3 and return its signed download URL and expiry     |
| Above the inline limit  | Disabled          | A generated preview no larger than the inline limit | Keep the original in the workspace; use the existing authenticated workspace download |

Here the inline limit is the preview transport limit, initially 160 KiB of decoded
image bytes. Crossing it triggers preview generation, not rejection. With S3 enabled, the legacy outbound-file cap does not apply to the original.
The configured transfer limit and bounded image-processing policy still apply. The card always displays the inline preview
first; **View original** loads the full-resolution image, and **Download** saves the
original rather than silently saving the compressed preview.

## 2. Existing foundations and actual gaps

| Foundation                          | Existing behavior                                                                                           | Required change                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `daemon/src/mcp/ops/share-file.ts`  | Current-conversation image publication, path validation, MIME sniffing, budgets and provenance              | Add a webchat publication path with durable-before-visible semantics          |
| `daemon/src/daemon.ts`              | `readWorkspaceImage` uses session workspace scope and `WorkspaceFs.readFileBytes`, including pod workspaces | Preserve that seam; enforce no fallback from an unavailable isolated checkout |
| `daemon/src/mcp/tools.ts`           | `shareFile` discovery is inside `platforms.length > 0`                                                      | Make it available to eligible webchat sessions without an IM integration      |
| `daemon/src/webchat/turn-output.ts` | Ordered text/tool events and canonical reply segments                                                       | Add an independently identified image message                                 |
| `protocol/src/frames/webchat.ts`    | Bounded inbound images; canonical posts already allow one image                                             | Add a live image event and agree on publication identity across copies        |
| `SessionImageAttachment`            | PNG/JPEG/WebP, at most 160 KiB, persisted with transcript rows                                              | Retain a generated preview through the same bounded representation            |
| `web/src/lib/shared-file.ts`        | Share markers, source-session download and digest checks                                                    | Reuse original-file downloads; render the same card live and from history     |

[Agent-authored attachments](agent-authored-attachments.md) explicitly deferred
webchat. It also records originals above the inline cap without a preview today.
[Workspace transfers](source-cache-file-transfer.md) already support larger
downloads through an optional bucket; that cache expires and is not an archive.
Workspace Markdown image references currently open the file viewer, according to
[product conventions](../product-conventions.md). This proposal keeps that behavior;
publishing remains an explicit tool call, not a side effect of parsing Markdown.

## 3. The generation skill

The skill is a workflow, not an image engine. Its instructions are:

1. For illustrations or image edits, use a native generation capability or an
   already configured image tool that the current runtime actually exposes. Do not
   infer availability from a runtime ID or model name.
2. For charts and technical diagrams, use available plotting/rendering tools when
   appropriate. Produce a supported raster image or SVG; retain editable sources separately.
   Do not silently substitute a plotted diagram for a requested generated illustration.
3. Save the completed original inside the active session's workspace, preferably
   `outputs/images/`, with a unique name. A native tool may return bytes, a temporary
   path, or a downloadable result; use the runtime's permitted file/network tools to
   materialize it. A result outside the workspace must be copied into it first.
4. Inspect the result if the runtime offers image inspection, then call `shareFile`
   with a workspace-root-relative path and optional short caption. Runtime cwd may
   be a subdirectory; resolve the path against the trusted session workspace root.
5. Do not repeat the image as Markdown after a successful share. A generation failure
   and a publication failure are different: if publication fails, retain the image and
   report that it was created but could not be displayed.

If no generation tool is available, explain the missing capability. Do not invent
a tool name, install a provider, request new credentials automatically, or imply that
AgentConnect can call runtime-internal tools through ACP. A skill cannot create a
capability that the runtime does not expose.

Do not add `generateImage` to AgentConnect MCP in this phase. Such a tool would need
an independently configured provider, credentials, usage accounting and cancellation
contract. Here the runtime owns its existing generation flow and permissions; the
daemon owns workspace publication. Native ACP image-output normalization can be a
later adapter feature, not a prerequisite for the workspace-file path.

### Installation and discovery

Package the versioned skill source with the daemon and reconcile it through the
existing skill installation ledger and sandbox publication path. Add an explicit
builtin source kind if needed; do not label it as an accepted Dream skill or write
directly into runtime discovery directories outside the ledger.

The installer checks the resolved runtime's `skillsAgentId`. Reserve the
`agentconnect-images` name, diagnose collisions instead of overwriting a user skill,
and update it at the ordinary cold-host preparation boundary. Installation must work
without fetching a public skill repository and without rebuilding the sandbox image.
The skill may be installed at agent scope, but its instructions apply only when the
active turn exposes image publication.

For runtimes without filesystem skill discovery, put the short save-and-share
instructions in `shareFile`'s description. The tool still works without a skill.
Gate builtin injection before computing mandatory desired skills: cluster preparation
currently refuses desired skills on unsupported runtimes. An optional helper must not
prevent an otherwise usable runtime from starting.
Expose it based on the turn's output capability, including webchat, rather than the
number of configured chat integrations. Continue enforcing the active-turn,
headless and synthetic-conversation gates at execution time.

## 4. Publication and protocol

Use the existing turn-output capability seam; webchat remains core-owned and does
not become a chat-platform module. The webchat implementation must own the durable
post and live event together. The existing IM sequence (upload, then best-effort
`recordShare`) cannot simply be reused: webchat has no external platform holding a
copy if recording fails. Refactor the internal publication result so that an already
persisted webchat share is not recorded a second time by the generic handler.

The operation proceeds as follows:

1. Resolve trusted session/turn coordinates, verify active authority, and reserve
   bounded file-processing resources before staging or decoding.
2. Snapshot the original once through the existing workspace boundary into private
   staging, using bounded chunked I/O and incremental SHA-256. Preview generation
   and original upload consume the same immutable snapshot. A source mutation during
   staging fails that snapshot rather than mixing file revisions.
3. Prepare a bounded preview from that snapshot. Small static SVGs stay SVG;
   oversized SVGs become PNG previews. The original is never overwritten.
4. Mint one canonical `postId` and `at`, commit the preview and original descriptor,
   then immediately emit the image event and canonical post. A valid preview committed
   to the transcript is the publication success boundary. For a large image with S3,
   the original begins in `pending` state.
5. Return a short tool receipt immediately. Upload the staged original asynchronously;
   no S3 signing or upload wait delays preview display. The retained snapshot prevents
   workspace edits after publication from changing the upload's bytes.
6. After upload verification, commit original metadata and publish an update to the
   same card with `ready` state and a signed download URL. Upload failure changes only
   original state to `upload_failed`; signing failure leaves the stored object ready
   and exposes a retryable download error. Neither failure withdraws the preview or
   invites a second `shareFile` call.

The asynchronous original update carries `postId`, a monotonic persisted revision,
original state and optional temporary download, not another copy of the preview.
Browser reducers ignore older revisions. Canonical peer copies and historical reads
receive the same state without persisted signed URLs. A missing initial event is
recovered through history, rather than creating a second post from an update alone.

Original delivery belongs to the published image. Completing the model turn, stopping
generation or closing the browser does not cancel it. The daemon retains the immutable
snapshot until delivery reaches a terminal state, subject to its resource policy.
Before preview commit, cancellation still prevents publication. After commit, stopping
generation neither withdraws the preview nor requests cancellation of original delivery.

Deliver subsequent original-state changes through a conversation/post update channel,
not through a model turn stream that has already emitted `done`. Updates must reach
other open tabs, survive history refresh, preserve the same post identity and never
wake another model turn. Pending work must not depend on a live ACP runtime process.
This independence does not extend expired daemon ownership or signing authority;
the worker must respect data-plane fencing and current authorization.

Use an ordinary process-local background task for original delivery. Do not introduce
a durable upload queue, restart recovery, multipart resume or a custom retry scheduler
for this feature. Existing transfer-client retry behavior may remain, but delivery
failure is an acceptable outcome once the preview has been published.

A daemon interruption may lose unfinished original delivery. On a later read, an
owning daemon with no live task for a still-pending original reports it unavailable
rather than displaying an endless upload spinner. This is a read-time status fallback,
not a recovery scan or automatic re-upload. Its preview remains readable. Staging is
temporary and uses normal cleanup; ordinary model-turn completion is not an interruption.

Proposed new `WebchatEvent` member:

```ts
type ImageEvent = {
  kind: 'image'
  postId: string
  at: number
  text: string // Caption plus existing share marker for original-file provenance.
  attachment: OutboundImagePreview // Bounded raster or SVG preview.
  original: ImageOriginal
  download?: { url: string; expiresAt: string } // Temporary signed GET; omitted from persistence.
}

type OutboundImagePreview = {
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'
  data: string // Canonical base64 within decoded-byte and envelope limits.
}

type ImageOriginal =
  | { kind: 'inline' } // The attachment contains the complete original bytes.
  | {
      kind: 'cache'
      attachmentId: string
      mimeType: string
      bytes: number
      sha256: string
      status: 'pending' | 'ready' | 'upload_failed' | 'expired'
    }
  | { kind: 'workspace' } // No transfer cache; download uses the existing share marker.
```

The existing output envelope supplies `conversationId`, `turnId`, agent attribution
and per-turn `index`. The canonical post uses `attachments: [attachment]`; history
uses the same `postId` and attachment on the saved row. Original MIME, bytes and digest
come from the share marker, not the preview. Keep the marker compatible with existing
readers; validate and bound its path before persistence or fan-out. Add the optional
original descriptor to canonical posts and transcript DTOs as well as live events;
the originating session owns its resolution even when another agent holds a peer copy.
Outbound SVG requires a distinct preview schema on all these surfaces. Today's
`SessionImageAttachment` aliases the inbound raster-only image schema; widening it
globally would also change user-upload acceptance, which is outside this decision.

### Separate browser payload and model-facing receipt

The browser receives `ImageEvent` with the bounded base64 preview. `shareFile` returns
only a small versioned JSON receipt to the runtime/model, for example:

```json
{
  "type": "agentconnect.image",
  "version": 1,
  "postId": "<canonical-post-id>",
  "published": true,
  "original": {
    "kind": "cache",
    "attachmentId": "<opaque-attachment-id>",
    "status": "pending"
  }
}
```

Small images return `original.kind: 'inline'`; larger images without S3 return
`original.kind: 'workspace'`. A ready original may include a `download` object with
`url` and `expiresAt`, but an asynchronous upload normally has no URL at initial return.
The eventual URL is delivered to the browser as a card update, not by delaying or
retroactively modifying the completed tool response.

Do not include preview base64 or original bytes in the model-facing receipt. Today's
MCP bridge converts ordinary JSON results to text, so this separation avoids pushing
encoded image data into the model context and duplicate tool-body persistence. The
existing typed-image MCP path is unnecessary for publishing a user-visible preview;
image inspection remains a separate runtime capability.

The daemon owns validation, persistence and browser delivery at tool execution, rather
than relying on ACP echo or model-authored Markdown. Tool receipts and image events
name the same publication and must not render two cards. Arbitrary tool-result text
or assistant Markdown cannot acquire attachment authority by mimicking this schema.

For cached originals, the stable reference is the attachment ID. Signed URLs are
transient and are omitted from canonical peer posts, persisted image descriptors and
AgentConnect's tool-result projection, including captured ACP copies. A runtime may
retain any URL it receives under its own context policy. The skill tells the agent
not to paste download URLs into the final answer; the card provides those actions.

Flush and close the preceding text segment before publishing the card, using the
existing message-boundary machinery. A subsequent text chunk starts another segment.
Do not generate an empty text bubble when an image is the only answer.

Only the originating daemon creates the post. Peer copies and browser reducers dedupe
by canonical identity, including a post received before its live event. Peer context
follows the existing conversation audience and activation policy: a caption must not
create mentions or extra wakes. Image sharing does not introduce automatic vision
calls in every peer agent.

The publication operation retains its ID across internal retries. Replaying an event
or retrying the same operation must not mint another post. A separate model invocation
of `shareFile` is a new share; do not promise exactly-once behavior across unrelated
tool calls. A disconnect after commit means the image is published and recoverable
from history, not that generation or publication should be repeated. Cancellation or
loss of turn authority before commit prevents publication; after commit the card stays.

## 5. Preview, limits, and original downloads

Keep the existing 160 KiB decoded inline cap and 256 KiB frame ceiling. One event
carries one preview. Budget the complete serialized event and canonical post, including the caption, path, signed URL and envelope, rather than checking
base64 alone. Bound URL length and reduce preview bytes further if envelope overhead
requires it; never split a base64 string into ordinary chat messages.

Use a daemon-owned, bounded decoder/encoder to fit the preview to the cap, preserving
aspect ratio and transparency. Reuse original bytes if they fit and validate; otherwise
reduce dimensions/quality until the preview fits. Start with a 1280-pixel longest edge.
Validate the encoded result's actual byte length before publication; do not assume
a target dimension or encoder quality guarantees the limit. Failure to produce a
valid bounded preview is an explicit error before commit.
Set explicit pixel, memory, concurrency and execution-time limits; reject corrupt or
unsupported images. PNG/JPEG/WebP and SVG are initial formats; animated-image support
remains out of scope. A small SVG is sent as base64 SVG without mandatory rasterization.
An oversized SVG is rendered to PNG and reduced until the PNG fits; viewing/downloading
the original still targets the unchanged SVG and its original MIME type and digest.
Only self-contained static SVG is supported. Reject scripts, event handlers, external
resources, DTD/entity declarations, embedded HTML and unsupported active content.
Render SVG only as an image resource in the controlled viewer, never inline DOM,
`object`, `embed` or standalone navigation. The PNG renderer has no network or external
file-fetch capability and runs within bounded CPU, memory and time. Preserve accepted
original bytes rather than silently rewriting their contents. Font availability and
renderer packaging must be verified, including diagrams containing Chinese text. Codec selection and cross-platform packaging are an
implementation checkpoint, including Linux sandbox deployments and Windows daemons.

With S3 enabled, webchat original publication does not inherit
`maxOutboundFileBytes`, its 8 MiB fallback from `maxAttachmentBytes`, or the derived
16 MiB per-turn default. Those limits remain unchanged for existing IM delivery and
for the non-S3 workspace path. Do not replace the removed S3 share cap with an invented
32 MiB cap.

S3-backed originals use the deployment's existing file-transfer policy. Its current
default is 512 MiB and its existing single-PUT implementation accepts at most 5 GiB;
these are transfer configuration/implementation limits, not the old image-share cap.
Honor explicitly configured transfer limits and report the actual bound on refusal.
Beyond the transfer's supported envelope requires separate transfer work, not an
implicit promise of unlimited uploads.

Large originals must not pass through the current whole-file `Buffer` reader. Reuse
private staging and bounded chunked transfer, with incremental hashing and bounded
rendering from the snapshot. Reserve processing slots, staging capacity and upload
concurrency before allocating; release them on completion/failure. Encoded file size
alone does not bound decoded pixels, SVG complexity or renderer memory. Keep explicit
pixel, memory, time and disk limits without deriving them from the old 8 MiB cap.

The browser renders preview bytes as a local image resource and releases object URLs
when unused. It does not fetch arbitrary model-authored URLs. Small images retain their
complete original in the inline attachment and can be downloaded directly from it.
For large images, show the retained preview immediately and load the original only
when the user selects **View original** or **Download**. With S3, use the returned
download URL while valid. Renew through the attachment resolver automatically when the URL expires
or is absent on a historical row, provided the cache object still exists.
**View original** opens a full-resolution viewer with
zoom and fit-to-screen controls, while **Download** preserves the original filename
and bytes. Both actions have loading/error states and work on desktop and mobile.
Without S3, both actions use the existing authenticated workspace download, subject
to its limits; failure leaves the preview visible and does not substitute it for the
original. Small inline originals support both actions without another network request.

### S3 cache transport for large images

Reuse the configured `AC_FILE_TRANSFER` bucket, CP signer, checksum validation,
private staging and daemon/shim upload plumbing from
[source-cache-file-transfer.md](source-cache-file-transfer.md). Do not require bucket
credentials in the runtime, daemon or pod. The byte path is:

```text
Runtime workspace -> Daemon or shim snapshot -> S3 transfer cache -> Browser
                            |
                            +-> Bounded preview -> Relay -> Browser
```

This requires extensions to the existing transfer contract; its current browser-driven
workspace route is not already a daemon-initiated attachment publication API:

1. The daemon allocates an opaque attachment ID and requests a scoped
   upload ticket for the authorized agent/session, publication ID, exact size and
   full digest. CP verifies the daemon's current authority and chooses an org-scoped
   object key. The daemon cannot request signatures for arbitrary bucket keys.
2. Upload a single immutable snapshot using the existing signed PUT machinery. Its
   checksum must match the bytes used to prepare the preview. If the pipeline stages
   a file again, compare full digests and refuse to upload changed bytes. A valid
   preview from the original read can still be published.
3. Store the attachment ID, object identity, full digest and original workspace
   locator with the post in the data-plane store. Mark the original ready only after
   upload verification and metadata commit. Preview publication does not depend on
   upload success. Failed commits may leave an expiring orphan cache object; upload
   retries reuse the publication identity and must not create another image card.
4. Deliver the signed GET and expiry in the asynchronous card update. For
   history or an expired URL, the browser asks an authenticated attachment resolver
   for a fresh GET. The resolver
   checks current agent/session/repository access and the saved attachment binding;
   the CP signer accepts only that authorized binding. Check the cached object first,
   without requiring the mutable workspace file to exist or match its current stat.
5. On a cache hit with the expected length and checksum, return a short-lived GET.
   An expired original is labeled expired without removing its preview. Never
   regenerate an image or substitute a newer file as a cache-recovery operation.
   Renew expired URLs automatically for the same available object. If the object is
   missing, mark the original expired; do not regenerate or re-upload it automatically.

The resolver's reference is stable, while its returned GET is temporary. Do not persist signed
URLs in the transcript or expose raw object keys as model-selectable input. CP handles
only authorization and transfer metadata; it never receives the original bytes.
Read-time signing is distinct from publication authority: readable historical sessions
may resolve their saved attachments after an agent moves, under existing history rules.

Existing signed downloads use `application/octet-stream` and attachment disposition.
Do not assume those URLs can be inserted directly into an `<img>` element. For image
enlargement, fetch the object using narrowly configured bucket CORS, check its length
and digest, and construct a local Blob with the validated original MIME type. SVG
viewing must use a constrained image renderer, not live markup in the console document.
Download may use the existing signed download directly. Release preview/original Blob
URLs and limit concurrent original fetches and decoding.

URL expiry and object expiry differ. Current transfer GETs default to 30 minutes,
workspace cache reuse is limited to 24 hours, and transfer objects use the bucket's
two-day `pending` lifecycle. The attachment resolver checks its saved object identity
and renews GETs while the expected object remains available, rather than applying the
workspace route's 24-hour reuse cutoff or requiring the workspace file to exist. A
missing object is expired. Network or signer errors are retryable availability errors,
not proof of expiry. This proposal makes no permanent full-resolution retention promise.

Without a configured transfer cache, large originals retain the workspace descriptor
and existing authenticated, digest-checked download path. If a configured cache upload
fails, publish the valid preview, retain the workspace original, and report original
upload failure without claiming a working S3 download. Preview publication does not
depend on CP signing availability.
No presigned URL or absolute host path is saved in AgentConnect history.

If no cached or inline original survives and the workspace original changed, was
deleted, or its isolated checkout was purged, keep the preview and explain why the
original is unavailable. Never fall back to a same-named
file in another workspace. No promise is made to migrate originals or previews to a
new daemon when an agent moves; historical reads follow the recorded session owner.

## 6. Data plane, persistence, and recovery

Generation executes in the runtime's current host or sandbox. Inline images and
previews travel from its workspace through the owning daemon and relay to the browser.
Large cached originals travel through S3 directly to the browser. Live image bytes
never use the daemon-to-CP control WebSocket.

Previews are persisted in the daemon's configured data-plane transcript store: local
SQLite for self-hosted mode or the shared data-plane store for the managed pool. CP
stores neither the preview nor original bytes. Authorized historical reads and original
downloads may use the existing bounded BFF proxy exception; bucket transfers carry
bytes directly. Neither path creates a new publicly accessible file endpoint.

Transcript pagination must account for base64 attachments in its response-byte budget.
An image row must remain retrievable even when a page is full; return fewer rows and a
continuation instead of silently dropping its preview. History replacement must retire
a live image only when the corresponding saved post is present, preserving the existing
reply-boundary convention. Replay-window exhaustion falls back to transcript retrieval.

Retained previews use the transcript's access, retention and deletion policies. No
separate artifact database or permanent full-image object store is required for phase 1.
Workspace originals follow workspace lifecycle; cache-backed attachment bindings live
with their transcript posts, while cache objects retain their existing short lifetime.
Deleting or losing access to a post prevents fresh URL issuance; already issued URLs
retain only their bounded validity. After a committed publication, live notification failure is a
delivery notice, not a tool failure that invites an automatic duplicate share.

## 7. Scope, rollout, and validation

Support native webchat conversations, including multi-agent conversations, host and
pod workspaces, and agents with no IM integration. Also support Console continuation
of hook/webhook-origin sessions whose human reply surface is the Console: the image
belongs there and is not posted to the originating code-host issue, PR or webhook.

For Console continuation of an IM session, retain the origin platform's existing
`shareFile` delivery semantics. The browser watcher does not redirect publication away
from that platform. Resolve these choices from the active turn's output capability;
the mere presence of a webchat sink is insufficient. Headless and synthetic sessions
remain subject to the existing no-visible-publication gates.

Negotiate a proposed `webchat-images-v1` feature across daemon, relay and browser.
Older validators may reject a new event kind. Expose the new webchat tool path only
when the publication pipeline supports it; require a browser update when necessary,
and never claim a successful inline display on an incompatible client. Existing IM
shares remain supported. Ship protocol/readers before enabling writers.

Implementation order:

1. Add protocol coverage, the tool-result contract, preview preparation, durable
   canonical publication and webchat tool discovery. Refactor `recordShare` ownership
   without changing IM delivery; add the scoped S3 upload and attachment-resolution flow.
2. Render one image-card component for live and historical messages in the webchat
   stream/lane reducers and `SessionDetailView`, including desktop and mobile.
3. Package and reconcile the builtin skill; verify actual skill discovery and a real
   generation-to-workspace-to-share flow in each runtime declared supported.

Acceptance checks:

- Both Codex and Claude complete real image generation from a natural-language request
  through workspace output and `shareFile` display. Record each runtime/version/tool
  and entitlement prerequisites; do not infer tool availability from the runtime name. A plotting script or existing image fixture alone
  is insufficient. Unsupported runtimes report unavailable generation without failing
  ordinary startup merely because the builtin skill cannot be installed.
- A multi-megabyte original produces an inline preview without a configured bucket;
  download returns the unchanged original with its matching digest.
- With a transfer cache, a large original uploads independently of preview publication, and enlargement
  fetches its original directly from S3. Changing or deleting the workspace file does
  not prevent reading the existing cache snapshot.
- Files at, below and above the inline limit choose the correct policy: small images
  retain original bytes, larger ones produce a valid preview within the cap, and no
  complete event or tool result exceeds its serialized transport budget.
- With S3 enabled, publish the base64 preview before upload completes, return a short
  receipt without base64 to the model, and update the same card with the original's
  signed URL after upload. Persisted projections keep the attachment ID, not the URL.
- S3-backed originals above 8 MiB and cumulative shares above the legacy 16 MiB turn
  budget are not rejected by those old caps. Transfer policy and bounded staging,
  decoding and upload resources still apply; large files are not fully buffered.
- **View original** opens full-resolution bytes and **Download** saves those same bytes,
  rather than the preview, on desktop and mobile. Loading or failure leaves the existing
  preview visible; expired signed URLs renew automatically and missing objects show
  an expired state without automatic re-upload.
- Expired originals show an expired state while their previews remain visible. Cache
  upload failure permits successful preview publication with a distinct original-upload
  failure state. Unauthorized attachment IDs cannot obtain signed URLs.
- A valid self-contained static SVG below the cap appears inline as SVG; an oversized SVG yields a bounded PNG preview
  while original viewing/download targets unchanged SVG bytes. Inbound user-upload
  support does not widen implicitly.
- Small inline originals remain downloadable after workspace deletion. JSON tool
  receipts and live events produce one card, without requiring model-authored Markdown.
- Host, sandbox and isolated-checkout reads target the correct workspace; path escape,
  symlink escape, missing checkout and invalid image cases do not publish a card.
- Image-only replies, interleaved text/images, concurrent shares, two agents and two
  browser tabs preserve author, ordering and one card per canonical post.
- Reconnect, refresh during an unfinished turn, replay eviction and transcript page
  boundaries retain the image without duplication or disappearance.
- Model completion, user cancellation after preview publication, runtime exit and
  browser closure do not cancel original delivery. Its state update reaches the
  existing post after the turn stream ends and does not create a new model turn.
- A daemon interruption may leave the original unavailable, but its preview survives;
  a pending record without live delivery does not remain an endless spinner. There
  is no new durable task queue or restart recovery subsystem.
- Console-only hook continuation displays the new image card without posting it to
  its trigger's external subject. IM continuation still delivers through its origin
  platform; watching in the Console does not change the destination.
- File mutation/deletion leaves the saved preview intact; workspace fallback refuses
  stale bytes while retained inline or cached originals remain usable.
- Pre-commit failure publishes nothing; post-commit disconnect does not request a retry;
  turn cancellation and ownership fencing prevent stale publication.
- Permissions and session visibility apply to previews and originals; no image content
  enters CP persistence, telemetry or live control frames.
- Protocol tests and daemon, relay, CP and web typechecks cover the shared schema change;
  codec packaging and the generation workflow receive runtime/platform smoke checks.

The webchat deferral in [agent-authored-attachments.md](agent-authored-attachments.md) and
the image-card behavior in [product conventions](../product-conventions.md) describe the
shipped behavior.

## 8. Implementation record

Choices this design left to implementation, and where the code settled them:

- **Wire shapes.** `SharedImagePreview` extends the inbound image schema with
  `image/svg+xml` and optional dimensions; inbound uploads keep the raster-only schema.
  Posts carry the image as `WebchatPost.image` and history rows as `SessionMessage.sharedImage`
  (`{ attachment, original, revision }`), not through `attachments`, so peer context never
  hands the pixels to a peer model. A cached original also records its file `name`.
- **Read-time state.** `ImageOriginal.status` gains `unavailable`: the read-time answer
  for a pending original with no live task in the owning process. It is never persisted.
- **Ordering.** History pages webchat by insertion order, so publishing an image first
  commits the reply text streamed before it, then the image row; later text commits at
  turn end as usual. A reply that ends with an image therefore carries no activating hop
  depth, like the image post itself.
- **Update channel.** `rd/webchat-image-update` (daemon → relay) carries
  `WebchatImageUpdate`; the relay binds it to the authoring daemon, delivers it to the
  conversation's browsers as `image_update`, and fans it to peer daemons as the
  `image_update` webchat op, which applies it to their copies by revision and never
  starts a turn.
- **Negotiation.** `webchat-images-v1` is advertised by the daemon to the relay
  (`rd/hello`), by the relay to the daemon (`rd/hello/ok`) and the browser (`ready`), and
  by the daemon and CP to each other (`capabilities`, `serverFeatures`). The relay ships
  with the console it serves, so the daemon publishes cards only while every ready relay
  advertises the feature; otherwise `shareFile` refuses by name in a console turn.
- **Transfer.** `register/ok.fileTransfer` tells the daemon whether a cache exists before
  any signing. The daemon stages the immutable snapshot privately, then asks
  `image/original/put` for a PUT on the CP-derived key
  `src/<org>/transfer/img/<agentId>/<attachmentId>` (publication authority: the CP's
  placement check). `image/original/get` signs a GET while the object holds the expected
  length and checksum — no 24-hour reuse cutoff — for a daemon that may act for the agent
  or one answering a CP resolve ticket.
- **Resolver.** `POST /api/v1/orgs/:orgId/sessions/:id/shared-images/:attachmentId/original`
  authorizes like the session's history read, mints a short-lived resolve ticket and asks
  the owning daemon (`image/original/resolve`). Only the authoring agent's session resolves
  its own original; a missing object is recorded as expired and never re-uploaded.
- **Codecs.** The published daemon has no runtime dependencies and runs on Windows, so
  previews use pure-JS PNG/JPEG codecs and WebAssembly WebP decoding and SVG rendering
  (resvg), staged into `dist/wasm`. Decoding, resizing and encoding run in a worker thread
  with a 768 MiB heap, a 30 s timeout, two concurrent jobs and a bounded queue; headers are
  checked against a 40-megapixel limit before decoding. SVG text renders with a bounded set
  of system fonts, preferring CJK-capable families.
- **Bounds.** A console share reads at most 64 MiB from the workspace: decoding needs the
  whole file, so this bounds memory, not the transfer. Staged originals are capped at
  2 GiB in total and upload two at a time; past the staging cap, or above the transfer
  limit, the original stays in the workspace and the receipt says so.
- **Builtin skill.** `agentconnect-images` ships in the daemon package
  (`builtin-skills/`, staged to `dist/builtin-skills`) and installs as a managed source
  keyed `builtin:agentconnect-images:<digest>`, so older shims accept it. It is added after
  the cluster support gate, wins its reserved name over configured sources, and a
  user-owned directory of the same name leaves the runtime starting without it.
- **Not yet verified here.** The real generation-to-share runs for Codex and Claude, bucket
  CORS for **View original**, and Windows codec packaging need environment smoke checks
  (§7); EXIF orientation is not applied to JPEG previews.

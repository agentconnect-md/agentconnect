# Console File Transfer Through the Source Cache Bucket

**Status:** Implemented.

**Scope:** control plane (the signer and its routes), daemon (any daemon: pool member,
self-hosted or local, and the in-sandbox shim), relay webchat ingress, web console, Helm
chart. A deployment offers it once its Control Plane has a transfer bucket
(`AC_FILE_TRANSFER`, §7); every other deployment keeps today's paths.

## 1. What it adds

1. **Webchat uploads any file.** A non-image file the user attaches in the console is
   PUT by the browser straight into the bucket. The agent's prompt names the file and
   carries a presigned GET, which the agent downloads into its own workspace when it
   needs the bytes. Images keep their inline path.
2. **Large and binary workspace files download through the bucket.** The owning daemon
   snapshots the file where it lives (a sandbox pod, or its own disk) and PUTs it on a
   URL the Control Plane signs; the browser then fetches a presigned GET. A revision
   already in the bucket is reused.
3. **The whole workspace is downloadable.** The CP's proxied download no longer requires
   a path under `uploads/` or a share digest. Small text files keep the existing preview
   and slice-proxied download; the console uses the transfer for binary files and for
   text above `WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES` (1 MiB).

Neither the CP nor the relay ever carries the bytes: they forward metadata and URLs.

## 2. Storage layout and lifetime

Transfer objects live in the [Source Cache](source-cache.md) bucket, beside bundles and
under the same org scope:

```
<prefix>/src/<org>/transfer/up/<agentId>/<uuid>        one browser upload, for one agent
<prefix>/src/<org>/transfer/dl/<sha256(identity)>      one revision of one workspace file
```

`identity` is `[agentId, sessionId, repo, path, size, mtime]`, so a rewritten file gets a
new key. Every transfer PUT signs `x-amz-tagging: ac-cache=pending`, so the bucket's
2-day `pending` rule ([source-cache.md](source-cache.md) §10) collects it. No store row
tracks a transfer: nothing counts toward the org quota and the sweep never sees one.

The CP reads the bucket's lifecycle configuration at start and every 10 minutes. While
the `pending` rule is missing, nothing would collect a transfer, so the CP refuses with
`WORKSPACE_TRANSFER_UNAVAILABLE`. The window length is part of the check: a transfer
object must outlive the one-day reuse window plus the GET signed at its end
(`limits.urlSeconds`) and the 5-minute grace, which rounds up to 2 days for every
allowed `urlSeconds`. The CP takes the shortest expiration any enabled rule can give a
`pending` object under `src/` (a `pending` rule at any narrower prefix such as
`src/<org>/transfer/`, a size-filtered one, or an untagged rule) and refuses the same
way while it is under that minimum, so a shortened abandoned-write-back window cannot
break live download links. Transfers keep sharing the `pending` rule rather than a
rule of their own, which would add a third rule every operator must merge. A read that
fails (no `s3:GetLifecycleConfiguration`) leaves transfers on and logs the gap. A cached
download is reused only while its `Last-Modified` is under one day old, well inside the
2-day rule, its length still matches, and the store reports its signed SHA-256 checksum. A copy without a checksum
cannot prove its bytes, so it is uploaded again.

## 3. Trust model

- **The Control Plane is the only transfer signer.** It holds the bucket credentials
  (`AC_FILE_TRANSFER`), mints every URL, and never sees file bytes. This is consistent
  with the CP's content rule: it stores and forwards no attachment bytes, only URLs and
  metadata. Daemons hold no transfer credentials, which is what lets a self-hosted or
  local daemon take part without a bucket of its own.
- **Pods still hold no credentials** ([source-cache.md](source-cache.md) §6 item 4). A pod
  receives a presigned URL only inside a daemon-initiated shim operation.
- **The browser's URLs** (the upload PUT and the download GET) are signed against
  `publicEndpoint`.
- **A daemon's URLs** are signed for the network it names (`TransferNetwork`):
  - `cluster`: a pool member, or its sandbox pods, gets the in-cluster `endpoint`.
  - `public`: any other daemon gets `publicEndpoint`.

  The daemon picks the network, which is harmless: both origins reach the same objects.

- **A PUT** signs `content-length`, `x-amz-checksum-sha256` and the tagging header, so the
  store accepts exactly the declared bytes.
- **The agent's GET for an upload.** The CP `HEAD`s the object first and requires the
  declared length, and the declared checksum when the store returns one.
- **The agent's GET is a bearer URL.** Anyone holding it can read that one object on the
  origin its network names until it expires. The agent may pass it to the model provider's API,
  so it can leave the cluster for up to `limits.urlSeconds`.
- **An upload is bound to the agent it was reserved for.** `POST /agents/:id/uploads`
  puts the agent's id in the key. `transfer/get` looks the upload up under the agent the
  frame names, and the CP has already checked that the requesting daemon may act for that
  agent. A daemon serving a different agent in the org therefore finds no object for that
  uuid and gets no URL. In a multi-agent conversation, a file reaches only the agent it was
  reserved for (the composer's agent). Other targeted agents see the file named as
  unavailable.
- **A daemon may sign only what it was asked to upload.** `transfer/sign` names a ticket
  the CP minted for one `workspace/upload` to that daemon. The ticket is bound to:
  - the object key;
  - the revision's size, so a PUT for any other length is refused as `stale`;
  - the daemon;
  - a 16-minute expiry, set and checked with database time.
  - for a begun upload (§5.1), the agent and path it was opened for. Only that agent's
    callers can poll it.

  Tickets live in PostgreSQL (`transfer_upload_ticket`), so any CP replica can answer
  `transfer/sign`, including the daemon's socket owner when the HTTP request reached another
  replica ([high-availability.md](high-availability.md#connection-ownership-and-forwarding)).
  A single-shot ticket is deleted once the upload answers. A begun ticket signs nothing
  after `transfer/settle` records its outcome; it then stays readable for 10 minutes. The
  next mint sweeps expired tickets.

- **`transfer/get`** answers only for an agent the requesting daemon may act for, and only
  under that agent's own upload prefix.
- **A download GET** carries `response-content-disposition: attachment` and
  `response-content-type: application/octet-stream`, so nothing renders on the bucket's
  origin.
- **Route authorization** is the same as for any workspace read: agent visibility,
  session visibility for a named session, and an authorized `repo`.

## 4. Wire

- **Feature:** `FILE_TRANSFER_FEATURE` (`file-transfer-v2`). A daemon that advertises it
  answers `workspace/upload` and asks `transfer/sign` and `transfer/get`; every current
  daemon advertises it.
  - `workspace-upload-begin-v1` (`WORKSPACE_UPLOAD_BEGIN_FEATURE`) adds
    `workspace/upload/begin` and `transfer/settle` (§5.1). The CP sends the single-shot
    `workspace/upload` only to a daemon without it, and a current daemon still answers
    that frame, so either side can be upgraded first.
  - Both routes answer 409 `DAEMON_FEATURE_MISSING` for a daemon without it.
  - Both answer 409 `WORKSPACE_TRANSFER_UNAVAILABLE` when the CP has no bucket.
  - `file-transfer-v1`, where a pool member signed its own URLs, is retired.
- **Frames** (`protocol/src/frames/file-transfer.ts`):
  - `workspace/upload` (C→D: `agentId`, `sessionId?`, `repo?`, `path`, `revision`,
    `maxBytes`, `ticket`) → `workspace/upload/ok` (`bytes`, base64 `sha256`).
    Single-shot with a 16-minute ack budget, because the daemon stages and uploads the
    file before it answers. Kept only for daemons without `workspace-upload-begin-v1`.
  - `workspace/upload/begin` (C→D: the same payload) → `workspace/upload/begin/ok` (`{}`).
    The daemon acknowledges at once and runs the upload in the background. A re-sent
    begin for a running ticket joins that upload.
  - `transfer/settle` (D→C: `ticket`, `outcome`) → `transfer/settle/ok` (`{}`). The outcome
    is either `{ ok: true, bytes, sha256 }` or `{ ok: false, code, reason?, message }`: the
    same code, reason and message the single-shot error frame would carry. Recording it is
    idempotent and bound to the ticket's daemon.
  - `transfer/sign` (D→C: `ticket`, `bytes`, `sha256`, `network`) → `transfer/sign/ok`
    (`url`, `headers`).
  - `transfer/get` (D→C: `agentId`, `uploadId`, `size`, `sha256`, `network`) →
    `transfer/get/ok` (`url?`, `expiresAt?`; both absent when the bucket does not hold
    exactly those bytes).
- **Webchat turn:** `RelayWebchatOp.turn.files` holds up to `WEBCHAT_FILES_MAX` (4)
  `WebchatFileAttachment`s (`uploadId`, `name`, `mimeType`, `size`, `sha256`). The relay
  validates and forwards them.
- **Errors** reuse the workspace error frame and reasons, plus:

  | Reason                 | HTTP |
  | ---------------------- | ---- |
  | `not-found`            | 404  |
  | `transfer-unavailable` | 409  |
  | `transfer-failed`      | 503  |
  | `too-large`            | 400  |

- **Runtime config:** `GET /runtime-config` carries `fileTransfer: { maxBytes } | null`.
  The console offers non-image uploads and transfer downloads only when the deployment
  has a bucket and the agent's daemon advertises the feature.

## 5. Control plane

`file-transfer/service.ts` holds the transfer logic; `file-transfer/transfer.ts` builds
keys and signs.

| Route                                                  | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `POST /agents/:id/uploads`                             | Reserve an upload; answers the presigned PUT                   |
| `POST /agents/:id/workspace/file/transfer`             | Presigned GET for one workspace file; may upload first         |
| `GET /agents/:id/workspace/file/transfer/:operationId` | A begun transfer: 202 while it uploads, then the GET           |
| `GET /agents/:id/workspace/file/download`              | Proxied download; any path, `sessionId` optional, `repo` added |

A workspace transfer runs in four steps:

1. **Stat.** A one-byte `workspace/read` to the owning daemon serves as the stat, so
   containment, the `.git` rule, symlink refusal and root selection are the read's.
2. **Cache check.** The CP `HEAD`s the revision key.
3. **Upload on a miss.** The CP mints a ticket and starts the upload (§5.1). The daemon
   asks `transfer/sign` for its snapshot, then PUTs it.
4. **Sign the download.** The CP signs the browser's GET.

### 5.1 Begin and poll

An upload can take up to 16 minutes, longer than a control RPC or an HTTP request should
stay open across a CP failover. For a daemon with `workspace-upload-begin-v1`, the upload
is an operation whose state lives in PostgreSQL ([high-availability.md](high-availability.md)):

1. **Begin.** The CP opens a ticket that records the agent and path, then sends
   `workspace/upload/begin`. The daemon acknowledges within the normal ack budget. If it
   never accepts, the CP deletes the ticket and answers the daemon's error.
2. **Answer.** A caller that sends `poll: true` gets `202 { operationId, path, size }`;
   the operation id is the ticket. The console always sends it and polls once a second.
   Any other caller is held while the CP reads the ticket once a second. This matches the
   single-shot behaviour, but the upload no longer depends on that request.
3. **Settle.** The daemon reports the outcome with `transfer/settle` to whichever CP holds
   its socket at that point. It retries for about 4 minutes while it is disconnected.
4. **Poll.** `GET …/transfer/:operationId` reads the ticket on any replica:
   - a failed outcome is answered as the single-shot error would have been, for example
     409 `WORKSPACE_STALE` or 503 `WORKSPACE_TRANSFER_FAILED`;
   - a successful outcome, or an unsettled ticket whose object the bucket already holds,
     returns the signed GET. A lost settle therefore costs nothing;
   - an unknown or expired operation answers 404 `WORKSPACE_TRANSFER_UNKNOWN`. A held
     request whose ticket expired unsettled answers 503 `WORKSPACE_TRANSFER_FAILED`.

A transfer request for a revision that is already uploading joins the open ticket and
re-sends its begin under the same ticket. A retry after a failover therefore joins the
running upload instead of starting a second one. A daemon that restarted mid-upload
starts it again.

The transfer route accepts a shared file's digest prefix (`sha256`), as the proxied
download does. It compares that prefix with the object's digest and answers
`409 WORKSPACE_FILE_CHANGED` on a mismatch. A shared file rewritten after its marker was
recorded is therefore refused on this path too
([inbound-file-attachments.md](inbound-file-attachments.md) §5.1).

## 6. Daemon

- **`workspace/upload`** (`cp/control/workspace.ts`) runs `WorkspaceFiles.upload` with a
  signer that asks `transfer/sign` for the frame's ticket. A refused signature is a
  `stale` conflict when the CP saw another size, and `transfer-failed` otherwise.
- **`workspace/upload/begin`** runs the same upload under `UploadBegins`, which keys
  running uploads by ticket, and reports the outcome with `transfer/settle`.
- **Prompt:** a webchat file becomes an `Attachment` with `transfer`.
  - At prompt build the daemon asks `transfer/get`. `buildAttachmentBlocks` then emits a
    text block naming the file and a sample `curl -o uploads/<name>` with the presigned
    GET and its expiry.
  - A file the bucket no longer holds is named as unavailable.
  - The transcript keeps the `[attached: …]` marker only, never the URL.

### 6.1 Where the snapshot is taken

`WorkspaceFiles.upload` snapshots the file, asks its signer for a PUT of the snapshot's
exact length and digest, and streams it (`source-cache/put-object.ts`, shared with bundle
upload).

The snapshot is bound to the revision the object key names:

- The stat's `size` and `mtime` travel as `revision`.
- The copy refuses a file that no longer matches `revision`.
- After the last chunk it stats the file again and refuses one whose size, mtime or
  ctime moved while it was copied, such as an equal-length rewrite between chunks.

Either refusal is a `stale` conflict (409), so a snapshot never mixes two revisions or
lands under a key that names another one.

- **Local root:** the daemon copies the file to a private temp directory and PUTs it.
- **Sandbox root:** the shim does both:
  - The shim advertises `workspace-transfer-v1` beside `source-cache-bundle-v1`. The
    daemon then grants it `transfer` (beside `bundle`).
  - The `transfer` capability's `stage-file` op (`root`, `path`, `maxBytes`, `revision?`)
    copies the file into the shim's private bundle staging directory, opening it through
    the same fd-anchored descent as console reads. It returns a handle with `bytes` and
    `sha256`.
  - The daemon gets the PUT signed, then uploads and discards the handle over the
    existing `bundle` `upload` / `discard` ops, whose signed-header checks are unchanged.
  - A shim without the grant answers `sandbox-outdated`.

## 7. Configuration

`AC_FILE_TRANSFER` is one JSON document on the Control Plane
(`file-transfer/config.ts`). The chart renders it from `sourceCache.*` whenever
`sourceCache.enabled`; a Compose deployment passes it through.

| Field                                          | Chart value                  | Meaning                                                   |
| ---------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| `endpoint`                                     | `sourceCache.endpoint`       | In-cluster https origin; AWS regional when omitted        |
| `publicEndpoint`                               | `sourceCache.publicEndpoint` | https origin for browsers and daemons outside the cluster |
| `region`, `bucket`, `prefix`, `forcePathStyle` | `sourceCache.*`              | As for the Source Cache                                   |
| `credentials`                                  | `sourceCache.credentials`    | Mounted static keys, or a web identity                    |
| `limits.maxBytes`                              | `limits.transferMaxBytes`    | Per-file cap, default `512Mi`, at most `5Gi`              |
| `limits.urlSeconds`                            | `limits.transferUrlLifetime` | Download link lifetime, default `30m`, `1m` to `12h`      |
| `limits.putUrlSeconds`                         | `limits.putUrlLifetime`      | Upload PUT lifetime, default `15m`, `1m` to `1h`          |

A web identity's role must trust the CP's ServiceAccount as well as the pool's. Its
session must outlive the longest URL it signs plus 6 minutes. When
`credentials.durationSeconds` is omitted it is derived as the larger of 1 hour and that
sum; the chart's `sourceCache.credentials.serviceAccount.sessionDurationSeconds` pins it
for both the CP and the pool. The CP needs `s3:PutObject`, `s3:PutObjectTagging` and
`s3:GetObject` under `src/*/transfer/`, and `s3:GetLifecycleConfiguration` on the bucket.

The bucket also needs a CORS rule admitting the console origin for `GET` and `PUT` with
the `x-amz-checksum-sha256` and `x-amz-tagging` headers (chart README).

## 8. Limitations

- **No steering with files.** A steered turn carries only the attachment marker, so the
  console never steers a turn that has files, and the daemon refuses to: a message with an
  upload queues behind the live turn, and a steer-only one is refused `busy`. The live
  turn's context fences do not fold that message in either, so it always runs as its own
  turn with its download links
  ([turn-final-context-refresh.md](turn-final-context-refresh.md) §5.4).
- **Peers see the marker only.** In a multi-agent conversation the relay gives the
  participants a turn does not address the `[attached: …]` marker in their context copy,
  never the upload itself.
- **Single-shot for older daemons.** A daemon without `workspace-upload-begin-v1` still
  gets the single-shot `workspace/upload`. That holds the HTTP request open while the
  daemon uploads, so a CP failover mid-upload loses the reply. Retrying is cheap once the
  upload has finished, because the revision is then cached.
- **Mixed CP versions.** During a CP rollout a daemon may settle to a CP that predates
  `transfer/settle`. That CP refuses the frame. A successful upload is still found in the
  bucket. A failed one is reported only when its ticket expires.
- **No automatic placement.** The agent downloads an upload itself; nothing
  materializes it into `uploads/` automatically
  ([inbound-file-attachments.md](inbound-file-attachments.md) §2 remains the design for
  that).
- **Browser memory.** The browser hashes the file in memory before upload, so the cap is
  also bounded by what a browser tab holds comfortably.

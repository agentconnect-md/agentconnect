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
<prefix>/src/<org>/transfer/up/<uuid>                  one browser upload
<prefix>/src/<org>/transfer/dl/<sha256(identity)>      one revision of one workspace file
```

`identity` is `[agentId, sessionId, repo, path, size, mtime]`, so a rewritten file gets a
new key. Every transfer PUT signs `x-amz-tagging: ac-cache=pending`, so the bucket's
2-day `pending` rule ([source-cache.md](source-cache.md) §10) collects it. No store row
tracks a transfer: nothing counts toward the org quota and the sweep never sees one.

The CP reads the bucket's lifecycle configuration at start and every 10 minutes. While
the `pending` rule is missing, nothing would collect a transfer, so the CP refuses with
`WORKSPACE_TRANSFER_UNAVAILABLE`. A read that fails (no `s3:GetLifecycleConfiguration`)
leaves transfers on and logs the gap. A cached download is reused only while its
`Last-Modified` is under one day old, well inside the 2-day rule, its length still
matches, and the store reports its signed SHA-256 checksum. A copy without a checksum
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
- **A daemon may sign only what it was asked to upload.** `transfer/sign` names a ticket
  the CP minted for one `workspace/upload` to that daemon. The ticket is bound to:
  - the object key;
  - the revision's size, so a PUT for any other length is refused as `stale`;
  - the daemon's connection;
  - a 16-minute expiry.

  The CP deletes the ticket once the upload answers.

- **`transfer/get`** answers only for an agent the requesting daemon may act for, and only
  under that agent's organization's key prefix.
- **A download GET** carries `response-content-disposition: attachment` and
  `response-content-type: application/octet-stream`, so nothing renders on the bucket's
  origin.
- **Route authorization** is the same as for any workspace read: agent visibility,
  session visibility for a named session, and an authorized `repo`.

## 4. Wire

- **Feature:** `FILE_TRANSFER_FEATURE` (`file-transfer-v2`). A daemon that advertises it
  answers `workspace/upload` and asks `transfer/sign` and `transfer/get`; every current
  daemon advertises it.
  - Both routes answer 409 `DAEMON_FEATURE_MISSING` for a daemon without it.
  - Both answer 409 `WORKSPACE_TRANSFER_UNAVAILABLE` when the CP has no bucket.
  - `file-transfer-v1`, where a pool member signed its own URLs, is retired.
- **Frames** (`protocol/src/frames/file-transfer.ts`):
  - `workspace/upload` (C→D: `agentId`, `sessionId?`, `repo?`, `path`, `revision`,
    `maxBytes`, `ticket`) → `workspace/upload/ok` (`bytes`, base64 `sha256`).
    Single-shot with a 16-minute ack budget, because the daemon stages and uploads the
    file before it answers.
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

| Route                                      | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `POST /agents/:id/uploads`                 | Reserve an upload; answers the presigned PUT                   |
| `POST /agents/:id/workspace/file/transfer` | Presigned GET for one workspace file; may upload first         |
| `GET /agents/:id/workspace/file/download`  | Proxied download; any path, `sessionId` optional, `repo` added |

A workspace transfer runs in four steps:

1. **Stat.** A one-byte `workspace/read` to the owning daemon serves as the stat, so
   containment, the `.git` rule, symlink refusal and root selection are the read's.
2. **Cache check.** The CP `HEAD`s the revision key.
3. **Upload on a miss.** The CP mints a ticket and sends `workspace/upload`. The daemon
   asks `transfer/sign` for its snapshot, then PUTs it.
4. **Sign the download.** The CP signs the browser's GET.

The transfer route accepts a shared file's digest prefix (`sha256`), as the proxied
download does. It compares that prefix with the object's digest and answers
`409 WORKSPACE_FILE_CHANGED` on a mismatch. A shared file rewritten after its marker was
recorded is therefore refused on this path too
([inbound-file-attachments.md](inbound-file-attachments.md) §5.1).

## 6. Daemon

- **`workspace/upload`** (`cp/control/workspace.ts`) runs `WorkspaceFiles.upload` with a
  signer that asks `transfer/sign` for the frame's ticket. A refused signature is a
  `stale` conflict when the CP saw another size, and `transfer-failed` otherwise.
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
  console never steers a turn that has files; it queues it instead.
- **A long-held request.** A workspace transfer holds the HTTP request open while the
  daemon uploads, and a CP failover mid-upload loses the reply.
  - An ingress idle timeout shorter than the upload fails the request.
  - Retrying is cheap once the upload has finished, because the revision is then cached.
- **No automatic placement.** The agent downloads an upload itself; nothing
  materializes it into `uploads/` automatically
  ([inbound-file-attachments.md](inbound-file-attachments.md) §2 remains the design for
  that).
- **Browser memory.** The browser hashes the file in memory before upload, so the cap is
  also bounded by what a browser tab holds comfortably.
- **Tickets live in memory.** Upload tickets are process memory on the single CP replica
  ([high-availability.md](high-availability.md)). A CP restart mid-upload fails that
  transfer, and the retry starts a new one.

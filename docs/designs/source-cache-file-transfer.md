# Console File Transfer Through the Source Cache

**Status:** Implemented.

**Scope:** daemon (pool members and the in-sandbox shim), control plane routes, relay
webchat ingress, web console, Helm chart. Only a daemon with a
[Source Cache](source-cache.md) bucket offers it; every other daemon keeps today's paths.

## 1. What it adds

1. **Webchat uploads any file.** A non-image file the user attaches in the console is
   PUT by the browser straight into the bucket. The agent's prompt names the file and
   carries a presigned GET, which the agent downloads into its own workspace when it
   needs the bytes. Images keep their inline path.
2. **Large and binary workspace files download through the bucket.** The owning daemon
   snapshots the file where it lives (the sandbox pod, or its own disk), uploads it, and
   hands the browser a presigned GET. A revision already in the bucket is reused.
3. **The whole workspace is downloadable.** The CP's proxied download no longer requires
   a path under `uploads/` or a share digest. Small text files keep the existing preview
   and slice-proxied download; the console uses the transfer for binary files and for
   text above `WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES` (1 MiB).

Neither the CP nor the relay ever carries the bytes: they forward metadata and URLs.

## 2. Storage layout and lifetime

Transfer objects live beside bundles, under the same org scope:

```
<prefix>/src/<org>/transfer/up/<uuid>                  one browser upload
<prefix>/src/<org>/transfer/dl/<sha256(identity)>      one revision of one workspace file
```

`identity` is `[agentId, sessionId, repo, path, size, mtime]`, so a rewritten file gets a
new key. Every transfer PUT signs `x-amz-tagging: ac-cache=pending`, so the bucket's
existing 2-day `pending` rule ([source-cache.md](source-cache.md) §10) collects it and the
existing `<prefix>/src/*` IAM grant covers it. No store row tracks a transfer: nothing
counts toward the org quota and the sweep never sees one.

Transfers are gated on the same lifecycle check as write-back: while the bucket lacks its
rules, nothing would collect a transfer, so the daemon refuses with
`transfer-unavailable`. A cached download is reused only while its `Last-Modified` is
under one day old, well inside the 2-day rule, and only when its length still matches and
the store reports its signed SHA-256 checksum. A copy without a checksum cannot prove its
bytes, so it is uploaded again.

## 3. Trust model

- The pool daemon is the only signer, as for bundles. Pods only ever receive presigned
  URLs inside daemon-initiated shim operations; the runtime cannot request one.
- Browser URLs (the upload PUT and the download GET) are signed against
  `publicEndpoint`, the origin browsers reach; the agent's GET is signed against the
  in-cluster `endpoint`.
- An upload PUT signs `content-length`, `x-amz-checksum-sha256` and the tagging header,
  so the store accepts exactly the declared bytes. Before handing the agent a GET, the
  daemon `HEAD`s the object and requires the declared length and, when the store returns
  one, the declared checksum.
- A download GET carries `response-content-disposition: attachment` and
  `response-content-type: application/octet-stream`, so nothing renders on the bucket's
  origin.
- The CP authorizes as for any workspace read (agent visibility, session visibility for a
  named session, authorized `repo`), forwards the scope, and returns the URL.

## 4. Wire

- **Feature:** a daemon with a transfer advertises `FILE_TRANSFER_FEATURE`
  (`file-transfer-v1`) at register. The CP refuses both routes with 409
  `DAEMON_FEATURE_MISSING` otherwise.
- **Frames** (`protocol/src/frames/file-transfer.ts`):
  - `transfer/upload` (`agentId`, `name`, `mimeType`, `size`, base64 `sha256`) →
    `transfer/upload/grant` (`uploadId`, `url`, `headers`, `expiresAt`).
  - `workspace/transfer` (`agentId`, `sessionId?`, `repo?`, `path`) →
    `workspace/transfer/grant` (`path`, `size`, `url`, `expiresAt`, base64 `sha256`,
    `cached`). The `sha256` is the object's own digest, whether the file was uploaded
    now or reused from the cache.
- **Webchat turn:** `RelayWebchatOp.turn.files` holds up to `WEBCHAT_FILES_MAX` (4)
  `WebchatFileAttachment`s (`uploadId`, `name`, `mimeType`, `size`, `sha256`). The relay
  validates and forwards them.
- **Errors** reuse the workspace error frame and reasons, plus `not-found` (404),
  `transfer-unavailable` (409) and `transfer-failed` (503). `too-large` stays 400.

## 5. Daemon

- `source-cache/transfer.ts` builds keys, signs, and runs the `HEAD` checks.
- `cp/file-transfer.ts` answers both frames:
  - **Upload:** checks the cap and reserves a fresh `uploadId`.
  - **Workspace transfer:** a one-byte `workspace/read` is the stat, so containment, the
    `.git` rule, symlink refusal and root selection are the read's. It then `HEAD`s the
    revision key and, on a miss, uploads through `WorkspaceFiles.upload`.
- **Prompt:** a webchat file becomes an `Attachment` with `transfer`. At prompt build,
  `buildAttachmentBlocks` emits a text block naming the file and a sample
  `curl -o uploads/<name>` with the presigned GET and its expiry. A file the bucket no
  longer holds is named as unavailable. The transcript keeps the `[attached: …]` marker
  only, never the URL.

### 5.1 Where the snapshot is taken

`WorkspaceFiles.upload` snapshots the file, signs a PUT for the snapshot's exact length
and digest, and streams it (`source-cache/put-object.ts`, shared with bundle upload).

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
    copies the
    file into the shim's private bundle staging directory, opening it through the same
    fd-anchored descent as console reads. It returns a handle with `bytes` and `sha256`.
  - The daemon signs the PUT, then uploads and discards the handle over the existing
    `bundle` `upload` / `discard` ops, whose signed-header checks are unchanged.
  - A shim without the grant answers `sandbox-outdated`.

## 6. Control plane

| Route                                      | Purpose                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `POST /agents/:id/uploads`                 | Reserve an upload; answers the presigned PUT                   |
| `POST /agents/:id/workspace/file/transfer` | Presigned GET for one workspace file; may upload first         |
| `GET /agents/:id/workspace/file/download`  | Proxied download; any path, `sessionId` optional, `repo` added |

`workspace/transfer` is single-shot with a 16-minute ack budget, because the daemon may
stage and upload the file before it answers.

The transfer route accepts a shared file's digest prefix (`sha256`), as the proxied
download does. It compares that prefix with the grant's object digest and answers
`409 WORKSPACE_FILE_CHANGED` on a mismatch. A shared file rewritten after its marker was
recorded is therefore refused on this path too
([inbound-file-attachments.md](inbound-file-attachments.md) §5.1).

## 7. Configuration

`AC_SOURCE_CACHE` gains these fields (chart values in parentheses):

- `publicEndpoint` (`sourceCache.publicEndpoint`): the https origin for browser URLs;
  defaults to `endpoint`.
- `limits.transferMaxBytes` (`limits.transferMaxBytes`): the per-file cap, default
  `512Mi`, at most `5Gi`.
- `limits.transferUrlSeconds` (`limits.transferUrlLifetime`): the download link lifetime,
  default `30m`, from `1m` to `12h`.

A web-identity session must outlive the longest URL lifetime, this one included, plus
6 minutes. When `credentials.durationSeconds` is omitted, the daemon derives it as the
larger of 1 hour and that sum. The chart exposes it as
`sourceCache.credentials.serviceAccount.sessionDurationSeconds`. The bucket needs a CORS rule admitting the console origin for `GET` and `PUT`
with the `x-amz-checksum-sha256` and `x-amz-tagging` headers (chart README).

## 8. Limitations

- A steered turn carries only the attachment marker, so the console never steers a turn
  that has files; it queues it instead.
- A workspace transfer holds the HTTP request open while the daemon uploads. An ingress
  idle timeout shorter than the upload fails the request; retrying is cheap once the
  upload has finished, because the revision is then cached.
- The agent downloads an upload itself; nothing materializes it into `uploads/`
  automatically ([inbound-file-attachments.md](inbound-file-attachments.md) §2 remains
  the design for that).
- The browser hashes the file in memory before upload, so the cap is also bounded by what
  a browser tab holds comfortably.

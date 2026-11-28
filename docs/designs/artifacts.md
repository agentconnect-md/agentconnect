# Artifacts

**Status:** Steps 1 to 4 and the concurrent-update rule's base check and agent tools (§5.6)
implemented (#4442); step 5 and the removal of unfinished revisions are not yet built.
Product decisions recorded 2026-11-24 and 2026-11-26 (§3); the open questions are in §13
and the rollout in §14.

**Builds on:** [agent-authored-attachments.md](agent-authored-attachments.md) (`shareFile`
and the session snapshot), [source-cache-file-transfer.md](source-cache-file-transfer.md)
(the transfer bucket and its trust model),
[inbound-file-attachments.md](inbound-file-attachments.md) (the session files directory),
[session-visibility.md](session-visibility.md) (session audiences and the share-by-link
shape of §8), [webchat-mcp-apps.md](webchat-mcp-apps.md) (the console's sandboxed frame),
and [webchat-side-panels.md](webchat-side-panels.md) (the session dock).

## 1. Background and goals

Agents produce reports, dashboards, charts and documents. Today those reach a person in
one of two ways:

- As a file posted into the current conversation with `shareFile`. In the console it is
  an image card or a download chip; HTML is never rendered.
- As a file left in the session's `outputs/` directory, listed in the dock only while the
  daemon is online and the directory has not been reclaimed.

Neither gives the work an identity. There is no version history, no way to open an
interactive page in place, and no way to hand one revision to someone outside the
session.

An **artifact** is that identity: a deliverable the agent publishes, a person opens in
the console, the agent revises on request, and anyone with access can share.

**Goals**

1. An agent can publish a file or a directory as an artifact, then fetch, update, delete
   and share it.
2. An artifact may be an interactive page made of many files, not one inlined HTML file.
3. Inside a session, a person can always view and download its artifacts in the console.
4. Any one revision can be shared as a link, and the share can be revoked.
5. Artifacts outlive the session and the agent that made them, and have their own place
   in the console.

**Non-goals**

- Editing an artifact in the console. People view and download; changes go through the
  agent, which publishes a new revision.
- Artifacts with a backend. An artifact is static files: no server process, port or
  database.
- Building source in the browser. The agent has a full execution environment and builds
  before it publishes.
- Faithful rendering of office documents (see §9 for the alternative).
- An organization-wide switch that disables public sharing.

## 2. Concepts

| Layer           | What it is                                                                             | Owner and lifetime                                                      |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Workspace       | The code and data the agent works in (checkout, repositories)                          | Allocated per the agent's configuration and session; mutable; reclaimed |
| Session outputs | Working files a session produced (`files/<leaf>/outputs/`)                             | The session; reclaimed with its workspace (7 days by default)           |
| Artifact        | An explicitly published deliverable with revisions, rendered in the console, shareable | A person or the organization; kept until deleted                        |

- An **artifact** has a title, an owner and an audience. Its identity is not a file path.
- A **revision** is the complete content of one publication and never changes. Changing an
  artifact means appending a revision.
- **Outputs are the draft, the artifact is the publication.** The agent works in
  `outputs/`; publishing copies content into a revision; fetching puts a revision back into
  `outputs/` to keep working. Outputs stay a plain file list. Anything that must render,
  persist or be shared has to be published; nothing is published implicitly.
- **The workspace definition does not change.** It is where the work happens; an artifact
  is what leaves it.

### 2.1 Relation to `shareFile`

`shareFile` posts one workspace file into the current conversation: one file per call, no
destination argument, and HTML, SVG and scripts only ever as downloads. On a chat platform
it becomes that platform's own file message; with a transfer bucket the bytes are also kept
as the session's snapshot for the session's lifetime.

The two run side by side and `shareFile` does not change. `shareFile` delivers a file into
the conversation; the artifact tools register an openable, versioned deliverable. An agent
may do both for the same report. Whether `shareFile` should change is revisited once
artifacts exist.

## 3. Decisions

| #   | Decision                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Interactive pages made of many files are supported                                                                                                                   |
| D2  | Artifacts require a wildcard content domain on a registrable domain of its own; without one the feature is off. The managed service provides one (§5.5, §12)         |
| D3  | An agent can always revise the artifacts it produced                                                                                                                 |
| D4  | Inside a session, a person can always view and download its artifacts in the console                                                                                 |
| D5  | One revision can be shared as a link and the share revoked; the audience is chosen per share: `public` (anyone with the link) or `org` (signed-in members)           |
| D6  | An artifact link the agent writes anywhere opens through the console, after sign-in and the artifact's access check                                                  |
| D7  | A file uploaded to a chat platform belongs to that platform and is out of scope                                                                                      |
| D8  | Agents also get tools to delete, share and unshare                                                                                                                   |
| D9  | An artifact belongs to a person, not to the agent, and survives the agent's deletion; every revision records the agent that produced it                              |
| D10 | An artifact from a private session belongs to that person; one from a non-private session is visible to whoever can see that session, always within the organization |
| D11 | A headless cron or hook makes artifacts private to the person who set it up; one with a target conversation follows that session's audience                          |
| D12 | Old revisions are kept for the session retention window; the latest revision is always kept, and so is every revision with an active share                           |
| D13 | Deletion is immediate and final                                                                                                                                      |
| D14 | The console has a top-level Artifacts page                                                                                                                           |
| D15 | The first version adds no rendering library (§9)                                                                                                                     |
| D16 | The share page shows the artifact only; changing a share's audience keeps its link; a new revision does not move an existing share                                   |
| D17 | `shareFile` stays as it is                                                                                                                                           |
| D18 | No organization-wide switch for public sharing                                                                                                                       |
| D19 | A revision may be appended from a session whose audience is narrower than the artifact's; the person asking for it is responsible                                    |
| D20 | Artifact pages may make outbound requests; isolation comes from the content domain and the sandboxed frame (§5.5)                                                    |
| D21 | When a member leaves the organization, their artifacts pass to the organization owners                                                                               |
| D22 | The viewer has three places: the right dock, the left conversation pane, and a standalone page; it opens on the side opposite the card (§11.2)                       |
| D23 | On desktop, the viewer opens by itself when the agent publishes in the session being watched                                                                         |
| D24 | Rollout in five steps (§14)                                                                                                                                          |
| D25 | An update names the revision it was built on; one built on a superseded revision is refused, and the agent merges and publishes again (§5.6)                         |
| D26 | The content domain is served by the existing web service, which answers only the shim and its service worker on that domain; there is no separate artifact server    |

Also settled, with details in their sections: every file is read through a short-lived
presigned URL fetched by the console, and nothing in the bucket is publicly readable (§5.2);
the feature requires an object store and a content domain (§12); an agent's link pins its revision (§8.2); the audience is
copied from the session at creation (§6.2); agent tools change and delete only that agent's
artifacts (§7.2); an over-limit publish is refused rather than evicting old content (§10.2);
a multi-file download is zipped in the browser (§8.1).

## 4. Data model

The Control Plane stores metadata only, never file bytes.

**Artifact**

| Field                        | Meaning                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`, `orgId`                | Belongs to one organization                                                                     |
| `title`                      | Given at publication; may be renamed                                                            |
| `ownerIdentity`              | The owner as a namespaced identity, as `session_meta.ownerIdentity` (§6.1); nullable            |
| `visibility`, audience scope | `private`, `org`, `external` with its recorded source scope, or `editors` with its agent (§6.2) |
| `originSessionId`            | The session it was created in; used for the back link only, and may dangle after a purge        |
| `latestRevision`             | Number of the newest ready revision; it only moves forward (§5.6)                               |

**Revision**

| Field                                    | Meaning                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `artifactId`, `number`                   | Numbered from 1 and increasing; a number can be skipped (§5.6)                |
| `state`                                  | `pending` while uploading, then `ready`, or `closed` if refused (§5.6)        |
| `baseRevision`                           | The revision an update was built on; null for revision 1 and a replacement    |
| `manifest`                               | Entry path, and each file's relative path, SHA-256, size and media type       |
| `storageMode`, `storagePrefix`           | Where the bytes live (§5.2); every revision is `signed` today                 |
| `producedByAgentId`, agent name snapshot | The producer; the snapshot keeps the name readable after the agent is deleted |
| `producedInSessionId`, `initiatedBy`     | The session and the identity that started the turn that published it          |
| `createdAt`, `totalBytes`, `fileCount`   | For retention and limits                                                      |

**Share**

The shape [session-visibility.md](session-visibility.md) §8 reserved for share-by-link:

| Field                                         | Meaning                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `artifactId`, `revisionNumber`                | Pinned to one revision                                                       |
| `tokenHash`, `displayTail`                    | Only a peppered hash is stored; lists show the tail                          |
| `audience`                                    | `public` or `org`                                                            |
| `createdByIdentity`, `createdAt`, `revokedAt` | "Public" is the existence of an unrevoked share, not a state on the artifact |

Where the manifest is stored is open question P1.

## 5. Storage and the byte path

### 5.1 What exists

- The browser already uploads to and downloads from the object store directly, through
  presigned URLs the CP signs; a download URL lives 30 minutes by default.
- The store's public origin is not the console's: a separate host in the Helm chart, a
  separate port on the console's host in the Compose HTTPS overlay.
- Every download GET is signed with `attachment` and `application/octet-stream`, so nothing
  renders on the bucket's origin
  ([source-cache-file-transfer.md](source-cache-file-transfer.md) §3).
- The bucket's CORS rule admits only the console origin.
- The `icon/` prefix, and only it, is publicly readable
  ([icon-uploads.md](icon-uploads.md)).
- Session snapshots are content-addressed, recorded in `session_file_snapshot`, and deleted
  by the CP once the session is purged.
- The console already has a sandboxed frame (the MCP App card): `srcdoc` with one inline
  HTML document, `allow-scripts allow-forms`, and a `<meta>` CSP. It withholds
  `allow-same-origin` because the console's sign-in state is in `localStorage`.

### 5.2 Storage

Every file is stored under its revision's prefix and its manifest path, and is read only
through a presigned GET the CP signs after the access check (§8.1). Nothing in the bucket
is publicly readable, its CORS rule still admits only the console origin, and the
`attachment` / `octet-stream` download signature is unchanged: bytes never render on the
bucket's origin. Each revision is a full copy; nothing is deduplicated across revisions.

Objects are tagged `ac-cache=live`, which no lifecycle rule collects; the CP deletes them
under §10, and when the organization is deleted. Keys are organization-scoped beside the
existing transfer keys:

```
<prefix>/src/<org>/artifact/<artifactId>/<revision>/<path>
```

Revoking access is immediate: no new URLs are signed, and signed ones expire within their
lifetime. A viewer who loses access stops getting URLs on their next open.

Artifact bytes are kept until deleted, unlike session snapshots. For an organization whose
daemons are self-hosted on a managed Control Plane, published deliverables therefore live
in the operator's bucket indefinitely; publishing is the explicit act that puts them there.

### 5.3 Publishing

1. The agent calls the publish tool with a path, a title and, for a directory, an entry
   file.
2. The daemon resolves the path with `shareFile`'s resolver and fence (the checkout or the
   session files directory; `.git`, escapes and symlink escapes refused), lists the files,
   checks §10.2's limits and §5.4's path rules, and hashes every file.
3. The daemon sends the manifest to the CP. The CP checks that the daemon is placed on the
   agent, that the session belongs to the agent, that the organization's limit is not
   reached and, for an update, that its base is still the latest revision (§5.6). It records
   a pending revision under the next number and returns one PUT per file, signed for its
   length and checksum.
4. The daemon uploads. A sandboxed agent's files travel over the existing shim channel; the
   pod holds no credentials.
5. The daemon reports completion. The CP checks every object against the manifest and, for
   an update, checks the base again while holding the artifact's row lock (§5.6). It then
   marks the revision ready and returns the artifact id, revision number and console link.

Bytes go daemon → bucket → browser; the CP only signs and records, as for every other
transfer. The publish, complete and fetch frames are advertised under a CP feature,
`artifacts-v1`, as `file-transfer-v2` is, so an older daemon offers no artifact tools and
an older CP refuses them cleanly. A retried publish carries the same idempotency key and gets the same revision
back rather than a second one.

### 5.4 Path rules

Manifest paths are relative POSIX paths. Absolute paths, `.` and `..` segments, `.git`
components, backslashes, NUL, and two paths that collide after Unicode normalization or
case folding are refused, as is a file inside another file's path. The entry must be one of the
paths. Empty files are not carried: a PUT is signed for its checksum and a positive length.

Paths under `__ac/` are reserved for the shim on the content domain (§5.5) and are refused.
Because each revision renders at the root of its own origin, root-relative references such
as `/assets/app.js` resolve inside the revision, and no build setting is required.

### 5.5 Where a page runs: the content domain

Non-HTML entries render in the console from bytes it fetched (§9): images and PDF from typed
`blob:` URLs, SVG from a `data:` URL, Markdown and source as text. An HTML entry, single file
or site, runs on the **content domain**.

**The content domain.** A wildcard domain on a registrable domain of its own, for example
`*.example-usercontent.net`, never a subdomain of the console's site: a same-site host would
receive and could set the console site's cookies. The managed service's content domain is
also submitted to the Public Suffix List, so that every label under it is a separate site.
The CP refuses to enable artifacts with a content domain that is same-site with any origin
the deployment knows: the console, the CP and API host, the relay, the MCP host, the
identity provider and the object store. The content domain must be a DNS name under a public
suffix; an IP address, a single-label name or `localhost` is refused, since the Public
Suffix List cannot classify it.

Without a Public Suffix List entry, as on a self-hosted deployment, revisions are still
separate origins, so their storage, service workers and DOM stay apart; what they share is
the content domain's site, so one artifact could set a cookie the others receive. No
artifact feature uses cookies on the content domain.

**Who serves it.** The existing web service, behind a route of its own. The edge, not web,
decides what reaches a host: the console's route sends `/cp` (and, in Compose, `/relay`) to
other backends before web sees the request. So the content domain gets its own HTTPRoute in
the chart and its own site block in Compose, with web as the only backend; it is never added
to the console's route. Web's request proxy checks the `Host` first and covers every path on
the content domain, including `_next` and the icon paths its matcher skips today: it answers
only `/__ac/shim` and `/__ac/sw.js`, with their own strict headers and no cookies, and 404 for
everything else. The shim carries `frame-ancestors` naming the console's origin. The worker
script carries `Service-Worker-Allowed: /`, without which a script under `/__ac/` may only
control `/__ac/`. The identity provider's redirect URIs never include the content domain, so
a sign-in cannot complete on it even if a page were served by mistake.

**One origin per revision.** Revision `r` of artifact `a` renders at
`https://a<artifact id without dashes>r<r>.<content domain>/`, so two artifacts, or two
revisions of one artifact, never share an origin or its storage. The label is not secret:
access is decided when the console fetches the bytes, not by the origin.

**How a page loads.**

1. The console embeds `https://<label>.<content domain>/__ac/shim` in an iframe with
   `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` is what lets the shim
   register a service worker; it does not let the page read the console, which is cross-site.
   It does let the page frame other sites at their real origin, including the console under
   a top-level page that is the console, where a browser's storage partitioning decides
   whether that frame is signed in. So the console and the share pages refuse to be framed by
   anything but their own origin (`Content-Security-Policy: frame-ancestors 'self'`, with
   `X-Frame-Options: SAMEORIGIN` for older browsers). `allow-top-navigation`, `allow-popups`
   and `allow-forms` stay withheld.
2. The shim accepts messages only from the console's origin. It registers `/__ac/sw.js` with
   scope `/` and tells the console it is ready.
3. The console answers with a message port bound to the revision and the path to open. The
   shim hands the port to the worker and loads that path in a nested frame of the same origin
   once the worker acknowledges the port, so the first navigation never races it. Every
   request the nested frame makes for that origin, including navigations, goes to the worker,
   which asks the console for the path over the port. The worker leaves `/__ac/` paths to the
   network: a reload of the shim is itself in its scope.
4. The console trusts nothing that arrives on the port: the shim, the worker and the
   artifact share one origin. It binds the port to the revision it embedded and answers only
   paths in that revision's manifest, fetching the bytes through their signed URLs, as for a
   download; the worker returns them typed by the manifest.
   A navigation to a path that is not in the manifest returns the entry, so a single-page app
   with history routing works; any other missing path is a 404. The worker passes a `Range`
   header through, and the console answers it with a 206, taking the size from the manifest
   and capping an open-ended range so media streams in pieces. It must also answer an
   unranged request whole: Chromium opens media with `bytes=0-`, but WebKit's first requests
   carry no range.
5. The shim reports the nested frame's path. The console checks that it is a path outside
   `/__ac/` (a history route need not be in the manifest), coalesces rapid changes so a page
   cannot flood its history, and keeps it in its own URL, so back, forward and reload work.
6. A worker loses its ports when the browser stops it while idle, and a port whose console
   went away, after a reload or a closed tab, fails silently. So the worker drops a port once
   its shim is gone, gives each request a timeout and one retry, and when it holds no live
   port asks every shim of its origin for one (`clients.matchAll`, including uncontrolled
   clients). The console acknowledges a request as it starts answering it, so a large file
   fetched whole waits on a longer deadline instead of counting as a dead port. That shim asks the console, which issues a fresh port bound to the same revision.
   Any shim's port will do, because an origin is one revision.

Multi-page sites, relative and root-relative references, ES modules and `fetch` of local
files all work, because each revision is a whole origin.

**Opened directly.** The worker never answers a top-level navigation, and keeps no bytes, so
a content-domain address opened in its own tab falls through to the web service, which
answers 404, whether or not the browser partitions service workers. A worker cannot tell
which frame created a client: the fetch event for the shim's own navigation of the nested
frame carries no client id in any engine. So a foreign page that frames a content-domain
address is stopped by a header instead: every navigation response the worker builds carries
`Content-Security-Policy: frame-ancestors 'self' <console origin>`. With partitioned workers,
as all three engines ship them, that foreign frame finds no worker and gets the 404 anyway;
with partitioning off, the console's worker answered it, and only the header kept the page
out. No artifact page runs outside the console's frame.

**A browser without third-party service workers** gets the entry rendered as `srcdoc` in a
sandboxed frame, as in step 1, with a notice that the rest of the site cannot load in that
browser, and download stays available. The shim tells the console when it has no
`navigator.serviceWorker` or registration fails, as where a browser or a policy turns service
workers off.

Pages may make outbound requests (D20); no CSP limits what a page loads, and `frame-ancestors`
is the only policy the worker adds. With the console and share pages refusing foreign
framing, what that leaves open is limited to the artifact and its viewer:

| Risk                 | Description                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content exfiltration | A page steered by content the agent read, or a tampered third-party script, can send the artifact's own data, and what the viewer types into it, elsewhere |
| Viewer tracking      | A third party sees the viewer's IP address, browser and time of visit                                                                                      |
| Phishing             | A page can draw a fake sign-in form inside the console's frame or on a `public` share page, which makes it more credible than an ordinary phishing page    |
| Viewer resource use  | For example, a mining script                                                                                                                               |

These are accepted for the first version with two mitigations: a `public` share page
always frames the artifact with a "user-generated content" notice naming the source
organization, and organization owners can revoke any public share and delete any artifact
(§6.3).

### 5.6 Concurrent updates

People never edit an artifact's content, and only the agent that produced an artifact
appends to it (§7.2). That agent serves many sessions, though, so two of them can fetch the
same revision, change it separately and publish. Revisions are immutable, so no bytes are
overwritten either way. What can be lost is a change: without a rule, the later revision
becomes the latest without the other session's work, and nobody is told. So an update
states what it was built on (D25).

**The rule.** A publish to an existing artifact carries one of two things:

- A **base revision**: the revision the agent fetched, or last published, and then changed.
  The publish is accepted only while that revision is still the latest.
- **Replace**: the content was not derived from the current revision and is meant to stand
  in for it, such as a report a cron job regenerates. No base is compared.

The CP checks twice:

| When                                             | Check                                                                                            | Why                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| At step 3, before any PUT is signed              | A base equals `latestRevision`                                                                   | A publish that is already stale uploads nothing           |
| At step 5, while holding the artifact's row lock | A base still equals `latestRevision`; a replacement finds no ready revision with a higher number | Two publishes that both passed step 3 cannot both succeed |

Of two concurrent updates, the one that completes first becomes the latest and the other is
refused. Revisions therefore become ready in number order, and `latestRevision` only moves
forward. A number is taken at step 3, under the same row lock, which also gives each
publish its own storage prefix. A publish that is refused at step 5, or abandoned, leaves
its number unused, so numbers can skip.

**What the refusal carries.** It names the rule and describes the revision that got there
first: its number, the agent that produced it and when. The CP holds both manifests, so it
also lists the paths added, changed and removed between the base and the latest, up to a
cap. If the base is no longer kept (§10.1), only the latest is described.

On the wire the refusal is an `error` reply whose `details.reason` is `stale-base`; the rest
of `details` is the protocol's `ArtifactStaleBase`: the base named, the latest revision's
number, producing agent id and name and creation time, and `changes`. A path is changed when
its SHA-256 differs. The cap is 50 paths across the three lists (`ARTIFACT_STALE_PATHS_MAX`),
filled added first, then changed, then removed, with a count of the paths left out. A
replacement refused at step 5 has no base, so it too describes only the latest. A base on an
artifact with no ready revision yet is refused as `not-found`.

**What the agent does.** It fetches the latest revision, reapplies its own change to it,
and publishes again with that revision as the base. A fetch lands in a directory of its own
per revision (§7.1), so it never replaces the files the agent was working on. If the person
wants their version to stand regardless, the agent publishes it as a replacement. Nothing
is merged automatically: content never reaches the CP, and the agent is the one that knows
what its change meant.

**Other races.**

- **Retries.** A replayed idempotency key is answered from the revision it recorded before
  any comparison, so retrying a publish that already succeeded returns that revision, not a
  refusal. The key names the base too: the same key with another base is an
  `idempotency-conflict`. A revision refused at step 5 is closed, its state `closed` and its
  key cleared, so publishing the same content again starts a new revision. A closed revision
  never opens, stops counting toward the organization total at once, and is removed with
  the other unfinished revisions (§10.1); a repeated completion of it is refused again.
- **Deletion.** Deleting an artifact wins over a publish still uploading to it: its
  completion finds no artifact and is refused. PUTs signed before the deletion can still
  land afterwards, so the deletion is recorded and the artifact's prefix is cleared once
  more after those URLs have expired.
- **Limits.** A pending revision's bytes count toward the organization total from step 3,
  so concurrent publishes cannot pass the limit together.
- **Title and audience.** These are single fields changed by people; the last write wins.

**Compatibility.** The base and the replace mark travel in the publish frame behind a CP
feature of their own, `artifact-base-v1`, so a daemon sends them only to a CP that checks
them. A publish that carries neither is treated as a replacement, which is what a daemon
older than this rule sends.

**The object store takes no part.** Three of its mechanisms were considered and left out:

- _Bucket versioning_ versions one object at a time, while a revision is a set of files
  that must agree. It is also a switch on the whole bucket, which the Source Cache and file
  transfers share, and it turns every delete into a marker, which breaks D13.
- _Conditional writes_ would add nothing: every PUT is already signed for its length and
  checksum, under a prefix only that publish uses.
- _Server-side copies of unchanged files_ would save upload bandwidth, not correctness. It
  can be added later by having step 3 return PUTs only for the files that changed.

## 6. Ownership and audience

### 6.1 At creation

The owner is a namespaced identity, the same form as a session's `ownerIdentity`
([session-visibility.md](session-visibility.md) §2): `user:<id>` for a console user, or the
platform tuple for an IM sender.

**Owner rights belong only to an organization member.** An owner identity grants §6.3's
owner rights to a viewer whose identity set contains it, and an identity set is only ever
built for a signed-in member. So an IM sender who has not linked a console identity yet
holds no rights until they link, exactly as they cannot see their private sessions until
then; and an identity the product cannot place in the organization (an outside mail
sender, a guest or Slack Connect user) never holds them.

| The session that produced it               | Owner                                   | Audience                                               |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------ |
| A private session                          | The session's `ownerIdentity`           | The owner only                                         |
| A non-private session started by a member  | The identity that started the turn      | The session's audience, within the organization        |
| An `editors` session                       | None (its owner identity is provenance) | The recorded agent's editors                           |
| A cron or hook with a target conversation  | `user:<createdByUserId>` of the trigger | The session's audience, within the organization        |
| A headless cron or hook                    | `user:<createdByUserId>` of the trigger | The owner only                                         |
| Any of the above whose identity is unknown | None                                    | The session's audience; managed by organization owners |

- A trigger's owner is always its creator, never its last editor. `CronDef` and `HookDef`
  both carry `createdByUserId`, nullable and cleared when the user is removed; both mark
  a headless trigger by a null target channel.
- A headless trigger whose creator is unknown has no audience to copy, so its artifacts
  are visible to organization owners only.
- A non-private session started by someone who is not a member (a guest in an `external`
  channel, an unlinked sender) records that identity as provenance only; the artifact has
  no owner and is managed by organization owners.
- An artifact always belongs to one organization and its viewers must be members; a
  `public` share is the only exception.

### 6.2 The audience is copied, not followed

A session's audience is one of `private`, `org`, `external` (viewers who currently have
access to the source scope recorded at creation, such as a Slack channel's members) or
`editors` (whoever can currently edit the owning agent). Session rows are purged on the
retention schedule.

An artifact's latest revision is kept forever and its session is not, so access cannot be
answered by asking who can see the session now. At creation the session's rule is copied
onto the artifact: `external` together with its recorded source scope, `editors` together
with its agent. From then on the artifact decides alone; a later change to the session's
visibility does not touch it.

`editors` is evaluated live against the recorded agent's edit grants, as for sessions. If
that agent is deleted, the audience becomes the organization owners; it never widens to
`org`.

### 6.3 Who can do what

| Action                                                                           | Who                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| View, download                                                                   | Organization members in the audience                                      |
| Create an `org` share                                                            | Anyone who can view                                                       |
| Create a `public` share, rename, change the audience between `private` and `org` | The owner; organization owners, only on an artifact they can view         |
| Revoke a share, delete                                                           | The owner and organization owners, including without viewing the artifact |
| Revoke a share they created                                                      | The member who created it, including without viewing the artifact         |

An organization owner sees no other member's private artifact, as with private sessions,
and cannot widen it or share it publicly, since either would let them read it. They keep
moderation: they see every active public share's metadata (title, owner, share time) in
the Artifacts page and can revoke a share or delete an artifact without opening it. An
artifact with no owner is managed by organization owners within the same limit.

Revoking only narrows access, so the member who created a share may always revoke it, even
after the artifact was narrowed away from them; changing its audience stays with the owner.

When a member leaves the organization, their artifacts pass to the organization owners:
the owner is cleared, and the private ones become visible to and manageable by organization
owners. This deliberately differs from a private session, whose orphaned transcript no one
sees: an artifact is a deliverable the organization may still need, not a conversation.

## 7. Agent tools

### 7.1 Six tools

| Tool    | Input                                                                                                                                              | Effect                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Publish | Path (file or directory), title, entry file for a directory, optional artifact id; with an artifact id, the base revision or a replace mark (§5.6) | Creates an artifact, or appends a revision to the given one. Returns the id, revision number, console link and current audience |
| Fetch   | Artifact id, optional revision                                                                                                                     | Puts that revision's files into a directory of its own under the session's `outputs/`, and returns its number and path          |
| List    | None                                                                                                                                               | The artifacts the agent may see, with their latest revision                                                                     |
| Delete  | Artifact id                                                                                                                                        | Deletes the artifact: every revision, its bytes and its shares                                                                  |
| Share   | Artifact id, revision, audience                                                                                                                    | Creates a share and returns its link                                                                                            |
| Unshare | Artifact id, share id                                                                                                                              | Revokes one share                                                                                                               |

Fetch is what makes "the agent can always revise" hold: workspaces are reclaimed, and the
stored copy is the reliable source. Each fetched revision gets its own directory,
`outputs/<title>-<id>-r<n>/` (the title made path-safe, the id's first eight characters,
then the revision number), so fetching a newer revision to merge with leaves the agent's
working files alone (§5.6). Fetching the same revision again replaces its directory once
every file has arrived. An update without a base or a replace mark is refused by the tool
before anything uploads, and the refusal of a stale base tells the agent which revision to
fetch, which files changed and that it publishes again with that revision as the base.

Share defaults to the latest ready revision. Its link carries the token and is returned only
once; List carries each artifact's active shares by id, revision, audience and the token's
last characters, so the agent can unshare a link someone pastes without ever seeing a token
again.

### 7.2 What an agent can reach

One agent often serves many people, so its reach is bounded twice:

- **It sees only artifacts the current session's whole audience may see.** Otherwise anyone
  could ask the agent in their own session to fetch an artifact made in someone else's
  private session. As a comparison of audiences: a `private` session reaches what its owner
  can view; an `org` session reaches `org` artifacts; an `editors` session reaches `org`
  artifacts and `editors` artifacts of the same agent; an `external` session, whose audience
  may include non-members, reaches only artifacts with the same `external` scope.
- **It changes and deletes only artifacts it produced.** After the agent is deleted its
  artifacts remain; people view, share and delete them as before, but no agent can append
  to them.

Fetch is where this boundary ends: once fetched, the files are ordinary workspace files,
and the agent can `shareFile` them into any conversation it is in. That is accepted, as for
every other file the agent can read; the person asking is responsible (D19).

Appending a revision does not depend on the session's audience (D19): a person may ask for
an update to an organization-wide artifact from a private session. The publish result
reports the artifact's current audience so the agent can tell the person who will see the
new revision.

### 7.3 Whose authority

Delete, share and unshare act with the authority of the identity that started the turn,
under §6.3; a turn without one acts as the trigger's creator. That authority exists only
when the identity resolves to an organization member (§6.1). A turn started by a
non-member or an unlinked sender may publish and fetch, which are the agent's own work,
but cannot share, unshare or delete. This matches **What people can do in chat**
([product-conventions.md](../product-conventions.md)): console permissions apply only where
the product can tell who someone is. People and agents follow one rule set, so nothing a
person may not do becomes possible by asking the agent.

Known risk: an agent steered by instructions hidden in content it read could publish or
delete without the authorized person noticing. These rules do not prevent that. If it
becomes necessary, the three tools can go through the existing tool approval
(allow / approve / block); the first version does not.

## 8. Opening and sharing

The links people receive are always console addresses. Signed store URLs are fetched only
by the console itself, after the access check.

### 8.1 In a session

- Each publication leaves a card in the conversation; opening it opens the viewer (§11).
- Every open asks the CP to check the artifact's audience, then hands out byte addresses.
  The bytes are in the bucket, so an artifact opens while the daemon is offline.
- A single file downloads as itself; a multi-file revision is fetched by manifest and
  zipped in the browser.

### 8.2 Links the agent writes

The publish tool returns a console deep link pinned to that revision
(`/<org slug>/artifacts/<id>?revision=<n>`). The agent puts it in
its reply; on a chat platform, publishing itself posts nothing.

Opening it requires sign-in and the artifact's access check, then behaves like opening it
in the console. If that revision has aged out it opens the latest one with a notice; if a
newer one exists the viewer offers to switch.

### 8.3 Share links

- A share pins one revision; its audience is chosen when it is created.
- `public`: anyone with the link. It is served by a read-only route outside every
  organization path (the `/orgs/:orgId` subtree answers non-members 404, so public reads
  cannot live there), returns that revision only, and sends `X-Robots-Tag: noindex`.
- `org`: sign-in, then an organization membership check, then the same page.
- The share page shows the artifact: title, content, download. It shows no session,
  conversation or workspace, and does not mention newer revisions.
- Changing a share's audience keeps its link.
- A new revision does not move an existing share; sharing the new one is a new share.
- Revoking a share invalidates its link at once.
- Before a share becomes `public`, the dialog says that copies already downloaded cannot
  be recalled.
- Someone viewing a public share may also be signed in to the console, so HTML runs on the
  content domain on the share page too (§5.5).

### 8.4 Files uploaded to a chat platform

Once an agent uploads a file to Slack or another platform with `shareFile` or
`sendMessage`, that copy is the platform's: its access, retention and revocation are out
of scope.

## 9. Types and rendering

The entry file's type decides how a revision opens. The first version uses only the
browser and components the console already has:

| Entry                                      | Opens as                     | With                                            |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| HTML (single or multi-file)                | A running page               | The content domain (§5.5)                       |
| Markdown                                   | A rendered document          | The console's existing Markdown component       |
| Image, SVG                                 | An image                     | `<img>` (SVG loaded as an image runs no script) |
| PDF                                        | An embedded document         | The browser's PDF viewer                        |
| Code, plain text, JSON, CSV                | Highlighted source           | The console's existing highlighter              |
| Anything else (DOCX, PPTX, XLSX, archives) | Name and size, with download | Nothing                                         |

- **Office documents get no viewer of their own.** A multi-file revision can carry an entry
  and companion files: the agent sets a PDF as the entry and includes the DOCX original in
  the same artifact. Opening shows the PDF, downloading includes the original, and the
  conversion runs in the agent's own environment.
- **Local images a Markdown entry references** are loaded from the revision's files and shown
  from `blob:` URLs (`data:` for SVG).
- **Mobile** is mobile web reading: full-screen view and download. Some mobile browsers do
  not embed PDFs; the first version accepts that, and PDF.js can replace the native viewer
  later.

## 10. Retention and limits

### 10.1 Retention

| Case                               | Rule                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| The artifact                       | Never expires on its own; kept until deleted                                                    |
| An older revision                  | Removed once older than the publishing daemon's `sessions.retention` (default: 90 days; see P3) |
| The latest revision                | Always kept                                                                                     |
| A revision with an active share    | Kept                                                                                            |
| A revision that never became ready | Removed once its upload URLs have expired, plus a grace period; refused or abandoned alike      |
| The session is purged              | No effect                                                                                       |
| The agent is deleted               | No effect                                                                                       |
| Deletion                           | Removes every revision, its bytes and its shares at once; not recoverable                       |

The CP deletes the objects first and the rows second, so a failed delete is retried, as for
session snapshots. A deletion is the exception that keeps D13 immediate: it removes the
artifact's rows at once, so its reads answer 404 and its share links answer 404
`ARTIFACT_SHARE_NOT_FOUND` like a link that never existed, and records every revision's
object keys in a deletion record that stays until the objects are gone. The keys are deleted
right away, retried until a sweep succeeds, and deleted once more after the upload URL
lifetime plus a grace period (§5.6); only then is the record dropped.

An older revision ages from its creation against the `sessions.retention` (the console's
"Expire sessions") the CP delivers to the daemon that published it. Per-session and
per-organization history windows are ignored, and `never` keeps every revision (P3). Each
revision records the publishing daemon and its value at publish. The CP reads the daemon's
current value and falls back to the recorded one once the daemon is removed, as a retired pool
member is; a revision with neither is kept. The deletion reaper starts each tick, every five
minutes, with a retention pass over at most 100 revisions. It decides each one again under the
artifact's row lock, swaps the revision row for a deletion record in one transaction and sweeps
the objects as for a deletion; the record goes once they are gone. A share is created under the
same lock, so no share can pin a removed revision. Revoked shares on it stay, and their links
answer 410 until the artifact is deleted. A pinned link to a removed revision opens the latest
one (§8.2). Deleting an organization records every artifact of it for the reaper in the
transaction that deletes the organization, so its links stop at once and the objects follow.

### 10.2 Limits

- A revision holds at most 200 files and 200 MB (`ARTIFACT_MAX_FILES`, `ARTIFACT_MAX_BYTES` in
  the protocol package). The daemon checks both before it uploads anything, and the CP checks
  them again at step 3, refusing with `revision-limit` and the rule (`files` or `bytes`) and
  its limit. A deployment's per-file transfer cap can be lower and is refused as `too-large`.
- An organization may have a total artifact size: the bytes of every ready and pending
  revision it holds. A publish that would pass it is refused at step 3 with `org-limit`,
  the limit and the bytes in use; nothing old is evicted. The check runs under a lock per
  organization, so concurrent publishes cannot pass it together (§5.6). A pending revision
  counts until it becomes ready or is removed (§10.1); one closed at completion stops
  counting when it is closed.
- No total is set by default. It is the `artifactBytesLimit` field of the organization's
  policy, which the managed service delivers per plan
  ([org-session-policy.md](org-session-policy.md)); an operator can deliver one the same way.

## 11. Console

### 11.1 The card in a conversation

- Every publication leaves a card: type icon, title, revision number, size, and Open and
  Download.
- A card is pinned to its revision. An artifact revised three times leaves three cards, so
  the conversation is its history.
- An older card shows "newer revision available"; a deleted artifact shows "deleted"; a
  viewer without access sees "no access".
- The card appears on the session page of webchat and chat-platform sessions alike. On the
  chat platform itself there is only the link the agent wrote.

### 11.2 Where the viewer opens

The session page has a resizable right dock (Sessions, Files, Git, PR, Tasks); a
coordinator's task opens as a thread in the dock; the workspace file viewer takes over the
left conversation pane.

The viewer has three places, and opens opposite the card so the conversation in progress
keeps its composer:

| The card is in                                            | The viewer opens in                   | Why                                                                   |
| --------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| The main conversation on the left                         | The dock's Artifacts tab on the right | View and keep asking for changes                                      |
| A task thread in the dock on the right                    | The left conversation pane            | The task stays in the dock; this is where the file viewer opens today |
| A phone, an agent's link, the Artifacts page, Full screen | A standalone page                     | A phone has no dock                                                   |

- The viewer's state is in the URL, so "this revision of this artifact" is a link that
  survives a reload.
- Without an open viewer the Artifacts tab lists the artifacts this session published or
  updated, with a link to the Artifacts page.
- Opening by itself (D23) follows the same table. It switches the dock away from its current
  tab, which is accepted. It does not happen on a phone.
- A card opens the viewer by itself only when it arrives after the transcript's first page,
  below the turns the page already showed; a page of history loaded on demand never does.
- It does not reopen a revision the person closed during the visit, take the left pane from an
  open workspace file, or open a collapsed dock over a composer being typed in, where it only
  switches the dock's tab. A card for the artifact the viewer already shows is left to §11.4.
- A hidden tab keeps the newest card that arrived and opens it when the person comes back.

### 11.3 The viewer

- Header: back to the list, title, revision menu, Share, Download, Full screen.
- More menu: rename, delete, for those allowed.
- Info line: the producing agent, the audience, the update time.
- Share dialog: choose `public` or `org`, copy the link; below it, the artifact's existing
  shares, each revocable.

### 11.4 Switching revisions

- The revision menu lists every retained revision with its time and producing agent.
- While the latest revision is shown and the agent publishes another, the viewer moves to
  it with a notice.
- A deliberately chosen older revision stays put and only notes that a newer one exists.
- The standalone page follows the same way when a refresh reads a newer revision.

### 11.5 The Artifacts page

- Lists every artifact the viewer can see.
- Columns: title, type, producing agent, owner, last update, size, shared or not.
- Filters: mine or the organization's, by agent, by type, and publicly shared.
- Row actions: open, revisions, share and revoke, delete.
- A link back to the originating session while it exists and is visible.

### 11.6 Screens and states for design

| Screen                  | Where                                               | States                                                                                                                                           |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Artifact card           | The main conversation; a task thread in the dock    | Latest; newer revision available; deleted; no access; icons for page, document, image, PDF, code and other file; phone width                     |
| Artifacts tab list      | The right dock                                      | With content; empty; link to the Artifacts page                                                                                                  |
| Viewer in the dock      | The right dock                                      | Header and info line; revision menu open; More menu; how the actions collapse at the dock's 380px minimum                                        |
| Viewer in the left pane | The left pane, task thread kept in the dock         | As above, wide                                                                                                                                   |
| Viewer body             | Both of the above and the standalone page           | Page (sandboxed frame); Markdown; image; PDF; source; download-only file; loading; failed to load                                                |
| Viewer notices          | As above                                            | "Updated to vN"; viewing an older revision with a newer one available; zipping a multi-file download                                             |
| Standalone page         | An agent's link, Full screen, phone, Artifacts page | Desktop and phone; no access; revision aged out so the latest opened; deleted                                                                    |
| Share dialog            | The viewer; the Artifacts page                      | Choosing the audience; copying the link; existing shares with revoke; not allowed to create a `public` share; the "cannot recall copies" notice  |
| Share page              | `public` and `org` links                            | Artifact, title and download; the user-generated-content banner with the source organization; revoked link; an `org` link opened by a non-member |
| Artifacts page          | The console's main navigation                       | List and filters; empty; row actions; delete confirmation stating it is final; phone                                                             |

## 12. Deployment requirements

Artifacts are offered only when the deployment has both a transfer bucket and a content
domain. The CP advertises `artifacts-v1` to daemons, and the runtime configuration tells the
console the content domain, only then; otherwise agents get no artifact tools and the
console shows no artifact surfaces. `shareFile` and session files are unaffected either way.

The off state is a product choice: non-HTML entries and the `srcdoc` fallback need no content
domain, but artifacts are offered whole or not at all. Turning artifacts off, or removing the
content domain, keeps what was published: retention, deletion and organization-deletion
cleanup keep running, and the artifacts come back when a content domain is configured again.
A deployment that had step-1 artifacts loses them at step 2 unless it adds a content domain,
which the release notes say. Local development and CI use a wildcard name that resolves to
the loopback address with a locally trusted certificate.

| Deployment      | What the operator provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed service | Provided: a wildcard content domain on its own registrable domain, on the Public Suffix List                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Helm chart      | `artifacts.contentDomain`; DNS and a wildcard certificate for it; the chart renders a separate HTTPRoute for the wildcard host with web as its only backend, as it does for the MCP host                                                                                                                                                                                                                                                                                                                                                       |
| Compose         | The content-domain variable (`ARTIFACTS_CONTENT_DOMAIN`) and a site block of its own on port 443, since revision origins carry no port; DNS and a wildcard certificate for it. With a public domain, Caddy obtains a wildcard certificate only through a DNS challenge, so the operator configures their DNS provider for it. The LAN overlay (`compose.logto.https.yaml`, `tls internal`) can serve a wildcard name from Caddy's internal CA when the LAN resolves it; on an IP address or single-label host it cannot, and artifacts are off |
| Any deployment  | A transfer bucket ([source-cache-file-transfer.md](source-cache-file-transfer.md)); nothing in it becomes public                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 13. Open questions

| #   | Question                                                                                                                                                                              | Proposal                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Manifest in the database or as an object in the bucket                                                                                                                                | The database. File counts are bounded, and paths, sizes and digests are metadata of the same kind `session_file_snapshot` holds |
| P5  | Whether the daemon also checks that the session fetched or published the base it names. The refusal tells the agent the latest number, so an agent can name it without merging (§5.6) | Not at first: the refusal tells the agent to fetch and reapply. Add the check if agents are seen skipping the merge             |

### 13.1 Settled: P2, the content domain in current engines

The question was whether current browsers let the shim register a service worker in its
partitioned third-party frame and route the nested frame's requests through it. They do. A
prototype of §5.5 (`scripts/artifact-content-domain-check/`) ran on 2026-11-26 with the
console on `http://127.0.0.1:<port>` and revisions on `http://a1r1.localhost:<port>`, which
every engine treats as a secure context and as cross-site from the console.

| Check                                                                                 | Chromium 159.0.8154.6 | Firefox 159.0     | WebKit 27.2                                   |
| ------------------------------------------------------------------------------------- | --------------------- | ----------------- | --------------------------------------------- |
| The worker registers in the sandboxed cross-site frame, partitioned by top-level site | Pass                  | Pass              | Pass                                          |
| Link navigation, root-relative script, ES module and `fetch` through the port         | Pass                  | Pass              | Pass                                          |
| History route returns the entry; a missing subresource is a 404                       | Pass                  | Pass              | Pass                                          |
| Console reload and nested-frame reload                                                | Pass                  | Pass              | Pass                                          |
| A lost port is replaced on request                                                    | Pass                  | Pass              | Pass                                          |
| A stopped worker restarts and gets a new port                                         | Pass (stopped by CDP) | Pass (idle limit) | Not stopped: 5 minutes idle with live clients |
| Media seek through `Range`                                                            | Pass                  | Pass              | Pass                                          |
| A content address in its own tab is the server's 404                                  | Pass                  | Pass              | Pass                                          |
| An artifact page framing the console is blocked                                       | Pass                  | Pass              | Pass                                          |

With partitioning off, as in Playwright's defaults, a foreign page framing a content address
got the artifact from the console's worker in Chromium and Firefox until the worker added
`frame-ancestors`; §5.5 now requires it.

`node run.mjs <engine> --web` runs the same checks against web's own shim and worker
(`packages/web/src/lib/artifact-content/`), served by `next start` with the content domain
`localhost`, and its console runs web's own port server and viewer-path logic.

Both modes end with the hostile-artifact checks H1–H11: revision 1 carries a site that tries every
escape §5.5 withholds, and each attempt must fail. In `--web` mode the port checks (H8, H9, H11) test
the viewer's port server, and H7 requires web's console to refuse framing.
`.oss-scanner/threat_model.md` lists the checks with the invariants they attack.

These are Playwright 1.65.1's builds. Playwright turns Chromium's storage partitioning off
and sets Firefox's `network.cookie.cookieBehavior` to 4 by default; the check restores both
to the shipped defaults. Its WebKit is the Linux port, not Safari: Safari adds Intelligent
Tracking Prevention, which can delete a site's script-writable storage after seven days
without interaction. That costs only a registration, since the shim registers on every load,
but step 2 still needs one manual pass in Safari on macOS and iOS.

### 13.2 Settled: P3, the retention value

Settled by the owner on 2026-11-27 as proposed: old revisions follow the `sessions.retention`
the CP delivers to the installation, ignoring per-session overrides, and `never` keeps
everything. The installation is the daemon that published the revision; §10.1 describes the
sweep.

### 13.3 Settled: P4, the limit values

Settled by the owner on 2026-11-27: a revision holds at most 200 files and 200 MB, raised from
the proposed 50 MB. There is no default organization total; the managed service sets one per
plan. §10.2 describes how both are enforced.

### 13.4 Settled: P6, where a fetched revision lands

Settled by implementing the proposal, not by an owner decision: each fetch lands in a
directory of its own under the session's `outputs/`, `<title>-<id>-r<n>/`, the title made
path-safe, then the artifact id's first eight characters and the revision number (§7.1).
Before this, one directory per artifact was replaced by every fetch, which would have
discarded the working copy during a merge (§5.6). Each fetched revision is one more entry in
the session's outputs list, which the proposal accepted; fetching the same revision again
replaces its own directory, and directories left by earlier daemons, named without the
revision, are left alone.

## 14. Rollout

Each step can be verified on its own:

| Step | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Unlocks                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1    | Data model; publish, fetch and list tools; signed-prefix storage; the conversation card; the standalone viewer page; download                                                                                                                                                                                                                                                                                                                                                                         | Agent publishes, person opens. Covers single-file HTML, Markdown, images, PDF and source |
| 2    | The content domain: the configuration and its same-site check, its own route and site block, the web service's `Host` branch, the shim and service worker, every HTML entry moved onto it, `frame-ancestors 'self'` on the console and share pages, feature gating on the content domain, dropping the unused `public` storage mode, and a threat-model entry with a hostile-artifact test (framing the console, top navigation, popups, forms, other revisions' origins, paths outside the manifest) | Interactive multi-file pages                                                             |
| 3    | In-session viewer: the dock's Artifacts tab, the left-pane viewer, opening by itself, revision switching                                                                                                                                                                                                                                                                                                                                                                                              | Viewing while revising                                                                   |
| 4    | Sharing: `public` and `org` links, the share page, the agent's share and unshare tools                                                                                                                                                                                                                                                                                                                                                                                                                | Handing a revision to people outside the session                                         |
| 5    | Management: the Artifacts page, deletion including the agent's delete tool, retention cleanup, limits                                                                                                                                                                                                                                                                                                                                                                                                 | Long-term upkeep                                                                         |

Step 1 alone is a complete path; each later step adds to it. Step 2 changes deployment
requirements: once it ships, a deployment without a content domain stops offering
artifacts, including what step 1 enabled. Sharing
and management do not block using artifacts.

Steps 1 to 4 shipped before §5.6 was in place: there, two concurrent updates both succeed
and the higher number is the latest. The base revision check follows as its own change and waits
for no later step.

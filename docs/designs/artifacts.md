# Artifacts

**Status:** Draft, not implemented. Product decisions recorded 2026-11-24 (§3); the
open questions are in §13 and the rollout in §14.

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
| D2  | No new content domain or gateway: bytes are served from the object store's existing public origin                                                                    |
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
| D20 | Artifact pages may make outbound requests; isolation comes from the sandboxed frame (§5.5)                                                                           |
| D21 | When a member leaves the organization, their artifacts pass to the organization owners                                                                               |
| D22 | The viewer has three places: the right dock, the left conversation pane, and a standalone page; it opens on the side opposite the card (§11.2)                       |
| D23 | On desktop, the viewer opens by itself when the agent publishes in the session being watched                                                                         |
| D24 | Rollout in five steps (§14)                                                                                                                                          |

Also settled, with details in their sections: single-file revisions are read through
short-lived presigned URLs and HTML sites through a random public prefix (§5.2); the feature
requires an object store (§12); an agent's link pins its revision (§8.2); the audience is
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
| `latestRevision`             | Number of the newest revision                                                                   |

**Revision**

| Field                                    | Meaning                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `artifactId`, `number`                   | Numbered from 1                                                               |
| `manifest`                               | Entry path, and each file's relative path, SHA-256, size and media type       |
| `storageMode`, `storagePrefix`           | Where the bytes live and whether that prefix is publicly readable (§5.2)      |
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

### 5.2 Two storage modes

A presigned URL covers one object. `index.html` opens with its signature, but the
`./app.js` it references is requested without one and refused; S3 has no way to sign a
whole prefix for a limited time. So revisions are stored one of two ways:

|          | Signed prefix                                                           | Public random prefix                                                                                        |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Used for | A single-file revision; a multi-file revision whose entry is not HTML   | A multi-file revision whose entry is HTML                                                                   |
| Read     | On every open the CP checks access and signs a short-lived URL per file | Anonymous reads, protected by a 256-bit random prefix that is handed to the page only after the check       |
| Revoke   | Immediate: no new URLs are signed, old ones expire                      | On unshare or on narrowing the audience, the objects move to a new random prefix and the old one is deleted |

Either way, files are stored under their manifest paths, not their digests, or relative
references would not resolve. Each revision is a full copy; nothing is deduplicated
across revisions.

The public prefix has one weakness: someone who once had access and copied the underlying
address keeps it until the prefix moves. The links people are given are always console
addresses (§8); store addresses never appear in them.

Objects are tagged `ac-cache=live`, which no lifecycle rule collects; the CP deletes them
under §10, and when the organization is deleted. Keys are organization-scoped beside the
existing transfer keys:

```
<prefix>/src/<org>/artifact/<artifactId>/<revision>/<path>   signed prefix
<prefix>/src/<org>/artifact-pub/<random>/<path>              public random prefix
```

The CP performs a prefix move: it copies the objects server-side to a new random prefix,
switches the revision's row, then deletes the old prefix. Revocation is complete only once
the old prefix is gone, so the pending deletion is recorded and retried until it succeeds.
A move happens only on an explicit action (unshare, or narrowing the audience). Passive
narrowing never moves a prefix: a viewer who loses channel membership under `external`,
loses an edit grant under `editors`, or leaves the organization keeps any store address
they already copied, but is refused every console and share route from then on.

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
   agent, that the session belongs to the agent and that the organization's limit is not
   reached, records a pending revision, and returns one PUT per file, signed for its length
   and checksum.
4. The daemon uploads. A sandboxed agent's files travel over the existing shim channel; the
   pod holds no credentials.
5. The daemon reports completion; the CP marks the revision ready and returns the artifact
   id, revision number and console link.

Bytes go daemon → bucket → browser; the CP only signs and records, as for every other
transfer. The publish, complete and fetch frames are advertised under a CP feature,
`artifacts-v1`, as `file-transfer-v2` is, so an older daemon offers no artifact tools and
an older CP refuses them cleanly. A retried publish carries the same idempotency key and gets the same revision
back rather than a second one.

### 5.4 Path rules

Manifest paths are relative POSIX paths. Absolute paths, `.` and `..` segments, `.git`
components, backslashes, NUL, and two paths that collide after Unicode normalization or
case folding are refused. The entry must be one of the paths.

Because a multi-file site lives under a path prefix rather than at the root of its own
origin, a root-relative reference such as `/assets/app.js` resolves to the store's root
and fails. Publishing therefore refuses an HTML entry that references local files by
root-relative path, and the refusal tells the agent to build with relative paths. A
single-page app must use hash routing; a server-side fallback to the entry file is not
available.

### 5.5 Where a page runs, and what outbound requests leave open

**Single files keep the existing rule.** The console fetches a single-file revision's bytes
through its signed URL (the console origin is in the CORS rule) and renders them itself:
HTML as `srcdoc` in a sandboxed frame, as the MCP App card does; images and PDF from `blob:`
URLs typed by the manifest; Markdown and source as text. The download URL keeps its
`attachment` / `octet-stream` signature, so in step 1 nothing renders on the bucket's origin.

**Multi-file HTML reverses that rule.** A site's relative references only resolve when the
page is loaded from the store, so its entry opens in `<iframe sandbox="allow-scripts">`
whose `src` is the store address under the public prefix. This reverses three standing
statements, which change with step 2:

- `source-cache-file-transfer.md` §3, "nothing renders on the bucket's origin": it then holds
  for every prefix except `artifact-pub/`, whose objects are served with their manifest type.
- `icon-uploads.md`, anonymous reads on `icon/*` alone: `artifact-pub/*` joins it.
- The deployment docs (the chart README's bucket requirements and
  `self-host-caddy-https.md`), CORS for the console origin alone: `GET` opens to any origin.

Without `allow-same-origin` the framed page has an opaque origin and reaches no state of the
console's origin or the store's.

The sandboxed page's origin is `null`. Classic scripts, styles and images load regardless,
but ES modules and `fetch` of a local JSON file need CORS, so the bucket's CORS rule admits
any origin for `GET`. CORS is bucket-wide; every other object is still protected by its
signature.

Pages may make outbound requests (D20). The store cannot add response headers, so a later
restriction could only be a `<meta>` CSP injected at publication, and only for revisions
published after it.

The frame withholds `allow-same-origin`, `allow-top-navigation`, `allow-popups` and
`allow-forms`, so a page cannot read the console's sign-in state, call the CP as the
viewer, read another artifact, navigate the tab away, or open a window. What outbound
requests leave open is limited to the artifact and its viewer:

| Risk                 | Description                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content exfiltration | A page steered by content the agent read, or a tampered third-party script, can send the artifact's own data, and what the viewer types into it, elsewhere                                  |
| Viewer tracking      | A third party sees the viewer's IP address, browser and time of visit                                                                                                                       |
| Phishing             | A page can draw a fake sign-in form. It appears inside the console, and a `public` share page sits on the product's own domain, which makes it more credible than an ordinary phishing page |
| Viewer resource use  | For example, a mining script                                                                                                                                                                |

These are accepted for the first version with two mitigations: a `public` share page
always frames the artifact with a "user-generated content" notice naming the source
organization, and organization owners can revoke any public share and delete any artifact
(§6.3).

Someone who opens a store address directly in a new tab runs the page in the store's real
origin, outside the sandbox. What that page can reach depends on what is same-site with the
store: in the Compose HTTPS overlay the console and CP, the identity provider and the store
share one host on different ports, and cookies are not separated by port; the chart puts
the store on a sibling host of the same site. Settling this is open question P2, and step 2
does not ship until it is settled.

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

An organization owner sees no other member's private artifact, as with private sessions,
and cannot widen it or share it publicly, since either would let them read it. They keep
moderation: they see every active public share's metadata (title, owner, share time) in
the Artifacts page and can revoke a share or delete an artifact without opening it. An
artifact with no owner is managed by organization owners within the same limit. Narrowing
an audience moves a public-prefix revision to a new prefix (§5.2).

When a member leaves the organization, their artifacts pass to the organization owners:
the owner is cleared, and the private ones become visible to and manageable by organization
owners. This deliberately differs from a private session, whose orphaned transcript no one
sees: an artifact is a deliverable the organization may still need, not a conversation.

## 7. Agent tools

### 7.1 Six tools

| Tool    | Input                                                                             | Effect                                                                                                                          |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Publish | Path (file or directory), title, entry file for a directory, optional artifact id | Creates an artifact, or appends a revision to the given one. Returns the id, revision number, console link and current audience |
| Fetch   | Artifact id, optional revision                                                    | Puts that revision's files into the session's `outputs/`                                                                        |
| List    | None                                                                              | The artifacts the agent may see, with their latest revision                                                                     |
| Delete  | Artifact id                                                                       | Deletes the artifact: every revision, its bytes and its shares                                                                  |
| Share   | Artifact id, revision, audience                                                   | Creates a share and returns its link                                                                                            |
| Unshare | Share id                                                                          | Revokes one share                                                                                                               |

Fetch is what makes "the agent can always revise" hold: workspaces are reclaimed, and the
stored copy is the reliable source.

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

The links people receive are always console addresses. Store addresses are used only by
the page itself, after the access check.

### 8.1 In a session

- Each publication leaves a card in the conversation; opening it opens the viewer (§11).
- Every open asks the CP to check the artifact's audience, then hands out byte addresses.
  The bytes are in the bucket, so an artifact opens while the daemon is offline.
- A single file downloads as itself; a multi-file revision is fetched by manifest and
  zipped in the browser.

### 8.2 Links the agent writes

The publish tool returns a console deep link pinned to that revision. The agent puts it in
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
- Changing a share's audience keeps its link; narrowing `public` to `org` also moves a
  public-prefix revision to a new prefix.
- A new revision does not move an existing share; sharing the new one is a new share.
- Revoking a share invalidates its link at once and moves a public-prefix revision.
- Before a share becomes `public`, the dialog says that copies already downloaded cannot
  be recalled.
- Someone viewing a public share may also be signed in to the console, so HTML runs in the
  sandboxed frame on the share page too.

### 8.4 Files uploaded to a chat platform

Once an agent uploads a file to Slack or another platform with `shareFile` or
`sendMessage`, that copy is the platform's: its access, retention and revocation are out
of scope.

## 9. Types and rendering

The entry file's type decides how a revision opens. The first version uses only the
browser and components the console already has:

| Entry                                      | Opens as                     | With                                            |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| HTML (single or multi-file)                | A running page               | A sandboxed iframe                              |
| Markdown                                   | A rendered document          | The console's existing Markdown component       |
| Image, SVG                                 | An image                     | `<img>` (SVG loaded as an image runs no script) |
| PDF                                        | An embedded document         | The browser's PDF viewer                        |
| Code, plain text, JSON, CSV                | Highlighted source           | The console's existing highlighter              |
| Anything else (DOCX, PPTX, XLSX, archives) | Name and size, with download | Nothing                                         |

- **Office documents get no viewer of their own.** A multi-file revision can carry an entry
  and companion files: the agent sets a PDF as the entry and includes the DOCX original in
  the same artifact. Opening shows the PDF, downloading includes the original, and the
  conversion runs in the agent's own environment.
- **Local images a Markdown entry references** are swapped for their files' signed URLs at
  render time.
- **Mobile** is mobile web reading: full-screen view and download. Some mobile browsers do
  not embed PDFs; the first version accepts that, and PDF.js can replace the native viewer
  later.

## 10. Retention and limits

### 10.1 Retention

| Case                            | Rule                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| The artifact                    | Never expires on its own; kept until deleted                                                    |
| An older revision               | Removed once older than the session retention window (`sessions.retention`, 90 days by default) |
| The latest revision             | Always kept                                                                                     |
| A revision with an active share | Kept                                                                                            |
| The session is purged           | No effect                                                                                       |
| The agent is deleted            | No effect                                                                                       |
| Deletion                        | Removes every revision, its bytes and its shares at once; not recoverable                       |

The CP deletes the objects first and the rows second, so a failed delete is retried, as for
session snapshots. `sessions.retention` is a daemon-side setting today; which value the CP
uses is open question P3.

### 10.2 Limits

- A revision has a file-count and a total-size limit; a publish over either is refused as a
  whole, naming the rule.
- An organization has a total artifact size limit; once reached, new publications are
  refused and nothing old is evicted.
- The numbers are open question P4.

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

| Deployment                       | Artifacts                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled object store             | Everything. The chart's setup script configures the public-prefix read policy and the CORS rule                                                                                                 |
| External bucket (for example S3) | The operator configures anonymous reads for the public prefix and opens CORS `GET` to any origin. Without that, only what signed prefixes cover is available: single files and non-HTML entries |
| No object store                  | Not available. `shareFile` and session files are unaffected                                                                                                                                     |

## 13. Open questions

| #   | Question                                                                                                                                                                                                                                                | Proposal                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Manifest in the database or as an object in the bucket                                                                                                                                                                                                  | The database. File counts are bounded, and paths, sizes and digests are metadata of the same kind `session_file_snapshot` holds                                     |
| P2  | What is same-site with the store origin, and what a page opened there outside the sandbox can reach: the console's and the identity provider's cookies (the Compose HTTPS overlay shares one host across ports), the store's own administration console | Settle before step 2. Where the store is same-site with the console, serve `artifact-pub/` from a host that is not, or offer only single files and non-HTML entries |
| P3  | Which retention value the CP applies to revisions                                                                                                                                                                                                       | The `sessions.retention` the CP delivers to the installation, ignoring per-session overrides; `never` keeps everything                                              |
| P4  | Limit values                                                                                                                                                                                                                                            | 200 files and 50 MB per revision to start; no default organization total, with the managed service setting one per plan                                             |

## 14. Rollout

Each step can be verified on its own:

| Step | Scope                                                                                                                                                                                                                                                        | Unlocks                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1    | Data model; publish, fetch and list tools; signed-prefix storage; the conversation card; the standalone viewer page; download                                                                                                                                | Agent publishes, person opens. Covers single-file HTML, Markdown, images, PDF and source |
| 2    | Multi-file HTML, after P2: public random prefix, the bucket's read policy and CORS, prefix moves, the root-relative path check, the amended rules of §5.5, and a threat-model test of the public prefix, any-origin CORS, active content and the share route | Interactive multi-file pages                                                             |
| 3    | In-session viewer: the dock's Artifacts tab, the left-pane viewer, opening by itself, revision switching                                                                                                                                                     | Viewing while revising                                                                   |
| 4    | Sharing: `public` and `org` links, the share page, the agent's share and unshare tools                                                                                                                                                                       | Handing a revision to people outside the session                                         |
| 5    | Management: the Artifacts page, deletion including the agent's delete tool, retention cleanup, limits                                                                                                                                                        | Long-term upkeep                                                                         |

Step 1 alone is a complete path; each later step adds to it. Multi-file pages change
deployment configuration, so they are their own step and can be rolled back alone. Sharing
and management do not block using artifacts.

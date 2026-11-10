# Computer form filling and Vault

> Status: Design, implementation in progress. Product decisions agreed on 2026-11-09.
> Scope: Linux Chromium/Chrome; container Computers first, Linux desktops second.
> Delivery stages and acceptance: §11; S1 is in progress (#3849).
> A throwaway Linux Chromium spike ran on 2026-11-09; its results are in §8.2.

## 1. Purpose and boundary

A person can complete a website form from a Fill card in webchat while an agent
operates a Computer. The values go to the Computer's browser extension without
becoming a user message or a model-visible tool argument or result. A reusable
Vault supplies saved logins and personal details after explicit agent grants.

The guarantee is about AgentConnect's own handling of values, not isolation from
a deliberately hostile agent with shell or browser access. Existing Computer
shell permissions remain usable. This design does not introduce separate OS
users, prevent credential extraction by a compromised agent, or isolate an
already authenticated browser session from subsequent Computer users.

For example, a Google Login granted to an agent can fill automatically when its
owner asks that agent to sign in. The model sees which fields were filled, not
the password. Google may still require a phone confirmation or another step that
a person must complete; storing a login does not guarantee successful sign-in.

The product name is **Vault**. HashiCorp Vault is an optional encryption backend,
not the product resource. Domain definitions live in [CONTEXT.md](../../CONTEXT.md).

## 2. Agreed decisions

| Area                | Decision                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform            | Linux only initially; ship the container integration before Linux desktop installers.                                                                   |
| Browser integration | An AgentConnect extension discovers and fills DOM fields. No Chrome Web Store dependency for Linux distribution.                                        |
| Trigger             | An agent explicitly calls a fill tool. Discovery may add a form hint to Computer results; discovering a form never starts a fill or a card by itself.   |
| Human input         | One Fill card collects ordinary and secret fields together. Webchat embeds it; Slack links to the authenticated console form.                           |
| Temporary input     | No CP content hop or storage. Input passes through the relay/agent daemon and desktop data plane, without reaching the harness or model.                |
| Persistence         | Saving is opt-in. Default destination is Personal Vault; Organization Vault is offered only to members allowed to manage it.                            |
| Item types          | Login and Personal info, both with typed fields and optional custom fields.                                                                             |
| Grants              | Personal items grant selected agents; organization items grant selected agents or all agents. New console-created items have no agent grant by default. |
| Saved card input    | Explicitly saving also grants the current agent; the card makes that consequence visible.                                                               |
| Personal use        | A granted agent fills automatically for the item owner. Other requesters need the owner's consent for this session.                                     |
| Organization use    | Organization owners manage the shared Vault. A granted agent fills without a per-use confirmation for an authorized agent caller.                       |
| Computer type       | No additional fill restriction or confirmation based on allocation type. Explain retained browser sessions when granting access.                        |
| Site matching       | Exact origin: scheme, host, effective port; ignore path/query/fragment. Multiple explicit origins per Login, no wildcard or subdomain rule initially.   |
| Multiple matches    | Explicit authorized selection, otherwise a unique match, otherwise a human choice. Remember the choice only for this session.                           |
| Submission          | Fill only. The agent separately clicks Next/Login/Submit under existing policies. Websites may submit themselves on input.                              |
| Encryption          | Built-in encryption plus the existing HashiCorp Vault Transit option. Never persist Vault field values with the plaintext cipher.                       |
| Secret reads        | No model-facing API reads secret fields. No general Personal info value-reading tool in the first release.                                              |

## 3. Vault resources and permissions

Each organization has one Organization Vault and each member has one Personal
Vault within that organization. These are distinct product collections, not a
new hierarchy of arbitrarily nested or named vaults.

Only the member manages and browses their Personal Vault. Organization ownership
does not grant product/API visibility into members' personal items. CP necessarily
can decrypt values for authorized fills; this is not end-to-end encryption against
the deployment operator. Organization owners manage the Organization Vault.

An item grant permits an agent to use that item; it is not a general permission
to retrieve its fields. A grant is required even when the requester owns the item.
A Personal item has an explicit selected-agent list, initially empty. An
Organization item supports selected agents or all agents, initially empty.

### 3.1 Personal item use

Resolve the fill requester from the current turn's triggering sender and their
linked console identity. If the turn has no sender, use the session's owner.
Do not silently replace an unlinked triggering sender with the session owner:
an unknown requester is not proof that the owner requested this fill.

The agent grant and requester check are independent:

1. No item grant: do not use the item, regardless of requester.
2. Granted agent, requester is the owner: fill automatically.
3. Granted agent, requester differs or is unknown: obtain the owner's consent
   for this session through an authorized console decision or linked approval DM.
4. Decline, unavailable owner, or timeout: leave the item unused and offer a Fill
   card so the requester can supply their own details.

Background/cron turns may use an owner's items only when their trusted session
ownership identifies that owner. Do not infer ownership from the agent creator,
Computer owner, or an approval-route fallback to an arbitrary editor.

A discovery result must not enumerate another person's private item titles,
usernames, or even whether they have a Google login. Resolve the requester's own
items and Organization items first. An explicitly selected, granted item owned
by someone else can request owner consent, but reveals its descriptive metadata
to the requester/model only after consent. Store its opaque reference with the
pending request.

### 3.2 Organization item use

Verify that the caller may invoke the agent and the item grants that agent.
The requester does not need to be the item's creator or an organization owner.
No per-item "always confirm" switch is included initially.

### 3.3 Computer access and retained sessions

Vault permissions supplement existing Computer access, input approval and lease
checks. Vault consent cannot grant access to a Computer. Filling does not add a
new restriction for self-hosted, per-agent, manual or ephemeral Computers.

The grant UI explains that sign-in state can remain in the browser and be used
by later Computer users. Linux already supports per-agent desktops and browser
profile fork-merge: with `shareBrowserLogins` enabled, a new login may propagate
to another desktop when its browser starts. Item grants govern credential fills,
not this existing reuse of authenticated sessions. Neither a per-agent desktop
nor per-agent allocation proves exclusive human ownership. This release does not
log out automatically or alter browser profile sharing/forking policies.

A fill targets a specific desktop within a Computer. Bind it to the trusted
session's desktop assignment and the existing per-desktop lease, not just the
Computer ID. Independent desktop browsers may be running concurrently.

## 4. Item types and fields

### 4.1 Login

A Login has a title, one or more allowed origins, username, password, optional
TOTP seed and typed custom fields. Multiple items may match the same origin.

Passwords and TOTP seeds are always secret. Usernames are non-secret. The user
chooses whether each custom field is secret. A transient generated OTP follows
the secret handling path even though a website may render it visibly.

Each origin is normalized with a URL parser, including IDNA/default-port
normalization. Never match a host by substring, a query value, or an agent's
claimed URL. An accounts.google.com Login also works after a third-party site
redirects to that exact origin; it does not fill the third-party site's form.

### 4.2 Personal info

Personal info holds a title and typed name, email, phone, company and address
fields. A member can keep separate work and home items. Personal info is not
site-bound, but use still checks grants and, for personal items, requester consent.

Standard fields are non-secret; custom fields can be marked secret. Item field
values are encrypted at rest regardless of their secret flag. That flag controls
model exposure, not whether database storage is encrypted.

The initial scope excludes payment-card storage, passkey management and general
free-form notes. It does not turn Vault into agent memory.

### 4.3 What secret means

AgentConnect never supplies a secret field through model-visible tool arguments,
results, ordinary chat, card settlement text, transcript bodies, observation
streams or exported logs. Fill-card inputs, including ordinary values, follow
the same non-model path. Model-visible lists may include authorized non-secret
summaries such as item title, origins and username, never arbitrary field values.

A website may visibly render a filled address, ID number or OTP; later screenshots
can therefore expose that value to the model. Password fields normally mask it.
This design does not promise screenshot redaction, prevent revealing a password
through page controls, or protect against an agent deliberately reading the DOM.
The Fill card explains this limit for secret values destined for unmasked inputs.

## 5. Discovery and model-facing tools

The extension reports the target tab/window, top-level origin, target frame
origin, document/form identity and visible editable fields. Descriptors contain
opaque field IDs, labels, types, required state and autocomplete semantics;
they must exclude current field values. Use standard autocomplete semantics
first, then deterministic type/name/label heuristics. No LLM receives secret
values to classify or map them.

The extension must run in the relevant frame to inspect its DOM. Cross-origin
frames require explicit extension permissions and separate origin checks; an
isolated-world content script cannot freely traverse every iframe. Ambiguous or
unsupported frames return a definite unsupported/selection result rather than
silently typing into whichever window has focus.

Select the focused form first, otherwise the sole eligible visible form.
If several candidates remain, ask the agent to focus/select one. Tab, frame,
origin and document identity are rechecked before writing; a changed target
requires rediscovery instead of reusing stale coordinates or selectors.

### 5.1 Tool surface (settled)

The interview confirmed `computer_fill_login` and `computer_fill_personal_info`,
then proposed one `computer_fill_form`. The implementation settles on the single
tool, with separate item references instead of one `item`, and ships no aliases:

- `computer_fill_form { computer?, form?, reason? }`: discover the target form on
  the session's desktop, collect its values through a Fill card (S2) and fill
  them. `form` is a form ID from an earlier `ambiguous` result; `reason` is one
  line the card shows. The result reports the website origin, the form's kind and
  each field's ID, label, purpose and outcome, never a value.
- With Vault, the same tool gains `login?` (a Login item ID or username) and
  `personalInfo?` (a Personal info item ID), plus `vault_list {}`. Separate
  references say which item supplies which fields in a mixed registration form;
  the card collects the rest. Arguments arrive only with the stage that honors them.
- The kind of form is not an argument. The extension classifies each form as
  `login`, `registration`, `personal_info` or `other`, and the result reports it.

Explicit item selection never bypasses origin matching, grants or consent.
Multiple candidates require human choice unless an explicit reference or username
selects exactly one eligible item. Keep the selected item for the session's
multi-step login, subject to fresh grant checks on subsequent fills.

### 5.2 Internal operation contract

The wire schemas live in `packages/protocol/src/computer-form-fill.ts`, version 1.
The agent daemon reaches the desktop over the existing relay data plane with three
desktop-internal MCP tools, served only to channel-token callers (agent daemons),
never to local client tokens, and never offered to a model:

| Tool                     | Arguments                        | Result                                                              |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `computer_form_discover` | `v`, `form?`                     | Active tab origin, forms with value-free field descriptors, target. |
| `computer_form_fill`     | `v`, `requestId`, target, values | Per-field status, overall status, whether the page navigated.       |
| `computer_form_status`   | `v`, `requestId`                 | `done` with the stored result, `running`, or `unknown`.             |

A target names tab, frame, Chromium `documentId`, top and frame origins and form ID;
the extension rechecks all of them before writing. Overall statuses are `filled`,
`partial`, `failed`, `target_changed` (nothing written), `uncertain` (outcome unknown,
not retried), `cancelled` and `unsupported`. Field statuses are `filled`, `unverified`
(written but changed back), `not_found`, `disabled`, `invalid_value` and `skipped`.
A `requestId` is single-use: a repeat is refused, never replayed. Cancellation is
the caller abandoning the request before the desktop sends it to the extension;
after that, the outcome is final or `uncertain`, and `computer_form_status` reports it.

Negotiation: the desktop reports the `formFill` capability when its browser
integration is installed; an agent daemon treats a missing internal tool as
`unsupported` with nothing sent. The extension's `hello` carries its wire protocol
and a compiled build ID; the daemon closes a mismatch with `4426` and an
unattributed socket with `4401`.

## 6. Fill cards and saving

A Fill card presents the actual website and field descriptors from the extension.
Password fields use masked controls. It collects a whole form or its missing
fields, including ordinary information, in one interaction. It is a first-party
UI operation owned by the agent daemon, not ACP/MCP form elicitation whose
accepted content returns to the harness. Do not host it as agent-authored HTML.

Webchat renders the card inline. Slack posts a link to an authenticated console
page for the same pending request. First release does not collect secrets through
Slack messages or plain-text Slack modals. Platform cards use host contracts,
not new platform-name branches in core.

The responder must be authorized for the pending request; knowing its opaque ID
is insufficient. Save permissions are based on the authenticated responder, not
a client-supplied user ID. The requester is the default responder; explicit
owner-consent flows authenticate the item owner separately. Unlinked chat users
must sign in/link identity before saving to a Personal Vault.

Default: **use once, do not save**. If Save is selected:

- Personal Vault is the default destination.
- Offer Organization Vault only if the responder may manage it.
- Show that saving grants the current agent use of the new item.
- Separate login fields into a Login and personal fields into Personal info;
  make the resulting items visible before confirmation, rather than storing
  an entire registration form as one password blob.
- Use the extension-observed origin for the Login. On multi-page login, keep
  the explicitly chosen username in pending fill state; do not require a
  username field to still exist on the password page.
- Offer explicit item update/create choice when a matching item already exists;
  do not silently overwrite a different account.

Implementation: the agent daemon streams the card on the asking turn as a
value-free `fill_request` event, which AHP projects into the session's `fills`
metadata, and settles it with `fill_resolved`. The answer is the relay op
`fill_submit`, whose author the relay stamps from its verified verdict, or the
AHP request `agentconnect/fillSubmit`, answered with the attachment's own user
and conversation. The card is also a `fill` transcript row with its descriptors and, once settled, its outcome, so a coordinator task's thread and a reloaded page show it; a task's card is answered on the conversation's own socket and channel, like its questions. The daemon keeps pending answers in memory only. It accepts an
answer only from the asking turn's person in the card's conversation, naming
fields the card showed, and expires an unanswered card after 10 minutes. Approval
and the control lease come after the answer; a lost fill reply is settled from
`computer_form_status` or reported as `uncertain`, never resent.

On Slack the card is a link to the console session page with `?fill=<id>`. The
page asks the daemon for the card over the session's continuation (`fill_open`,
or AHP `agentconnect/fillOpen`) and answers it there. A chat-asked card is scoped
to its session, and only a console user whose linked chat identities include the
asking member (`<platform>:<tenant>:<member>`) may open or answer it. The relay
stamps those identities from its verified verdict; on AHP it sends them only to
daemons advertising `api-ahp-identities-v1`. An unlinked member must link their
chat account first.

Fill success and save success are separate outcomes. If CP is unavailable,
filling may succeed while saving fails; say "filled, not saved" and let the
person retry saving. Do not automatically replay a fill to retry a save.

## 7. Data paths and responsibilities

| Operation                      | Field-value path                                                                   | CP participation                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Temporary ordinary/secret form | User browser → relay → agent daemon → relay → desktop daemon → extension → website | Existing control grants/leases only; no field values.             |
| Fill from Vault                | CP decrypts authorized fields → desktop daemon → extension → website               | Encrypted storage, authorization and bounded credential delivery. |
| Save card input                | Temporary fill path plus an explicit credential-store write to CP                  | Receives values only after the person chooses Save.               |
| Missing/declined Vault item    | Fill card temporary path                                                           | No automatic persistence.                                         |

The relay forwards without body/token logging or content persistence. The agent
daemon may temporarily hold Fill-card values but must keep them out of the
harness, general transcript/observation pipelines and durable pending records.
CP may serve the console page without receiving its temporary input: the page
submits through the authenticated relay data-plane connection.

Vault reads/writes are explicit credential control operations, like existing
secret distribution. They are not permission to forward arbitrary webchat bodies
or live ACP streams through CP. Any architectural clarification must preserve
[architecture.md](architecture.md)'s data-plane boundary.

Desktop-to-CP Vault requests need trusted attribution to the agent/session,
requester, consent and target origin. Existing Computer channel tokens identify
the agent/session but do not by themselves establish the current human requester.
Bind a bounded use authorization to the pending fill; never accept a bare
`agentId` or `requesterId` supplied by an extension as proof of permission.

The existing Computer CP WebSocket is a proposed credential delivery channel.
Its new request/reply schemas, authorization proof and capability negotiation
belong in `protocol` and must be checked on CP and desktop. Values go only to
the target desktop; the agent daemon/model receive status. This channel choice
is proposed, not existing Vault functionality.

## 8. Linux extension and execution

Package the extension with the Computer release/image. Its ID is stable per
extension build: the CRX is signed with a P-256 key derived from the build ID,
so one build always installs under one ID and a changed extension under a new
one. The container image installs it without a store using supported Chromium
loading/installation facilities. Linux desktop packaging verifies Chrome and
Chromium distribution paths, ownership and whether elevated installation is
needed. Snap/Flatpak and Firefox are not promised initially. No macOS/Windows
extension installation is in scope.

Install the extension by managed policy: `ExtensionInstallForcelist` pointing at
a self-hosted update manifest and CRX, with no store and no `--load-extension`.
Use exactly one install mechanism per image. When an unpacked copy and a forced
install share an ID, Chromium unloads the unpacked copy and the forced install
then fails. Deliver the daemon endpoint through `3rdparty` policy, which the
extension reads from `chrome.storage.managed`. On first install that value can
arrive after the service worker starts, so the extension reconnects when the
managed area changes. Debian's Chromium wrapper passes its own
`--load-extension`, which a launcher's later `--load-extension` replaces.
The daemon bundle embeds the extension, and `agentconnect-computer
install-extension` writes the CRX, a `file://` update manifest and the policy at
image build. Chromium installs a `file://` forced CRX signed only with ECDSA.
An image with a changed extension names a new ID in the force-install list, so
Chromium removes the old extension and installs the new one when the browser
restarts. This avoids relying on in-place updates (§8.2).

A person's Linux desktop installs the same artifacts with `agentconnect-computer
form-fill install`: one confirmed `sudo` step writes the CRX and update manifest
to `/opt/agentconnect/form-fill` and the policy to `/etc/chromium/policies/managed`
and `/etc/opt/chrome/policies/managed`. Snap and Flatpak browsers, which do not
read those directories, are reported as unsupported. `doctor` reports the install
as current, another build's (reinstall and restart the browser), missing, or
without an endpoint. Checked in containers on 2026-11-10 against Debian 13
Chromium, Google Chrome deb, Fedora Chromium and Google Chrome rpm: each
force-installed the extension, which dialed the endpoint with the bundle's build ID.

The local transport is an extension service-worker WebSocket to the desktop
daemon's loopback endpoint. Bind to loopback and require the extension's
`chrome-extension://<id>` Origin, which rejects web-page WebSockets. Origin alone
does not stop a same-host client from forging the header, and an arbitrary first
connection is not necessarily the browser the agent is operating. On Linux the
daemon therefore attributes each accepted socket to its owning process, Chromium's
network service. It then walks up to the browser process, identified by its
`/proc/<pid>/exe` and the absence of a `--type=` switch, and picks the known
desktop profile under which that browser holds files open. It rejects any peer
that does not resolve to a known profile. Chromium rewrites every process title,
the browser's own included, into one space-joined string, so `--user-data-dir`
is not parsed from it. This needs read access to the browser's `/proc` entries
(same user or root).

Managed pods route browser loopback traffic through the egress forwarder
(`--proxy-bypass-list=<-loopback>` in `packages/computer/docker/chromium-flags`).
With that flag the daemon sees the forwarder as the peer and rejects every
extension connection. Exempt the extension endpoint from the proxy
(`<-loopback>;127.0.0.1:<port>`, leaving page loopback traffic proxied), or have
the forwarder attribute the tunneled socket itself; the image exempts the
endpoint. A 20-second ping keeps the
MV3 worker's socket open and an alarm reconnects a terminated worker. Native
Messaging remains a fallback if needed.

The extension resolves fields in its content scripts and returns bounded status.
Setting `.value` alone is insufficient for controlled forms, and deprecated
`execCommand` is not a universal compatibility guarantee. Assigning `.value` in
the isolated world and then dispatching `input` and `change` updated React 19 and
Vue 3 `v-model` state, including `<select>`. A site that accepts only `isTrusted`
events ignores this input. Trusted input would require the DevTools protocol,
which this design does not use, so such sites are an unsupported class. Include
custom controls, select fields, address fields, multi-page logins and
`isTrusted`-only handlers in the supported-form matrix.

Hold no input lease while a person completes a card. Once values are available,
acquire/check the target desktop's lease, revalidate the target and fill under existing
human-first arbitration. Do not route field values through the model-facing
`computer_type` tool. The extension's internal fill command is not an additional
model-visible secret-injection API.

Fill does not click submit. It reports filled/missing field IDs and whether the
page navigated, including input-triggered submission by the site. Avoid automatic
screenshots while executing a fill; after completion, ordinary Computer screenshot
behavior resumes with the screen-exposure limit in §4.3.

An action that may have reached the browser is never replayed automatically.
Return `uncertain` after a disconnect/timeout with unknown outcome. Query bounded
request status when available; retrying requires a fresh decision. Partial fills
report individual field outcomes without values. Cancellation, navigation,
expired authority and human takeover end the operation and clear temporary values.

### 8.1 Local transport threats

The project has no standalone threat model yet; this records the extension link's.

| Threat                                              | Handling                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A web page opens a WebSocket to the endpoint        | Refused before attribution: its Origin is the page's, not `chrome-extension://<id>`.                                       |
| A local process forges the extension's Origin       | Refused: `/proc` attributes the socket to its owner, which is not a Chromium browser holding a known desktop profile open. |
| One agent's fill lands in another desktop's browser | Each link is keyed by the desktop its browser's profile belongs to; a fill goes only to the caller's desktop link.         |
| A stale or other extension build answers            | Refused with `4426` unless the hello's protocol and compiled build ID match the daemon's.                                  |
| A local client token (Claude Code direct) fills     | The internal `computer_form_*` tools exist only for channel-token callers, i.e. agent daemons.                             |
| A link drop or slow page after a fill was sent      | `uncertain`; a request ID is spent once and never resent.                                                                  |
| Values reach logs or the audit                      | The audit records request ID, origin and field count; replies and results carry statuses, not values.                      |

Out of scope, as in §1: a hostile agent with shell access as the same user can
read `/proc`, the profile and the page DOM, or install its own extension.
Attribution trusts what this user can see in `/proc`; another user's browser is
never attributed.

### 8.2 Spike evidence

A throwaway harness exercised S1 and the Vault rules on Debian 13 arm64 with
Chromium 156. It used one Xvfb display and Chromium profile per desktop, a
stand-in desktop daemon, an AES-256-GCM vault with fake items and fixture sites
on two origins. The agent's submit was an ordinary GUI click. All 32 scenario
assertions and 12 encryption checks passed.

| Area                    | Observed                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Descriptors and binding | Discovery read no values. Fill targeted the discovered document ID and rechecked tab and frame origin; reloading the page while a card was open returned `target_changed`. |
| Cross-origin frame      | `<all_urls>` host permission with all-frames injection reached a cross-origin iframe, and the Login matched on the frame origin.                                           |
| Controlled inputs       | React 19 and Vue 3 forms submitted framework state, including a select.                                                                                                    |
| Masking and fill-only   | Password fields stayed masked in screenshots. No fill submitted; a site that submits on input was reported as navigated.                                                   |
| No replay               | A fill blocked by a slow page handler returned `uncertain` at the timeout; the late reply was dropped and the page saw one fill.                                           |
| Vault rules             | Exact origin, grant required even for the owner, another member's same-origin item never offered, org `*` grant, one item kept across a multi-step login.                  |
| Desktop attribution     | Two profiles connected at once and each was attributed to its desktop through `/proc`; a forged-Origin local client and a web-page WebSocket were rejected.                |
| Canary oracle           | 11 canaries reached the websites and none appeared in daemon or Chromium logs, the vault file or 22 model-visible results.                                                 |

Open after the spike, and avoided rather than solved by per-build IDs (§8): a
forced-install extension never updated in place. After
install Chromium did not fetch the update manifest again, and
`requestUpdateCheck()` returned `no_update` and then `throttled`. Until the cause
is known, assume a new extension version arrives only with a fresh profile or an
explicit reinstall (§10). An unpacked extension also kept running stale
service-worker code from its script cache after a restart, even with a version
bump. Not covered: the webchat and Slack cards, the relay and agent-daemon hop,
CP storage and consent, TOTP, branded Chrome, custom widgets, shadow DOM and real
third-party sites.

## 9. CP storage and encryption

Use a dedicated item store, separate from agent environment secrets. Vault items
must not enter `AgentSpec.env`, `AgentSpec.secrets`, prompt context, model-provider
configuration or ordinary agent secret exports.

Suggested logical records:

- Vault ownership: organization plus personal owner or organization scope.
- Item metadata: ID, Vault, type, title, matching origins, grants, timestamps and
  revision. Titles/origins are protected by API authorization but may be plaintext
  lookup metadata in the database.
- Encrypted payload: username, password, TOTP seed, address/name/contact fields
  and custom field values. Store field schema/secret classification consistently
  with that payload; decrypt only in the dedicated store/service seam.
- Consent/use metadata: item, agent, session, requester, Computer, target origin,
  decision and result. No field contents, generated OTP or hashes of passwords.

These are logical shapes, not a committed Prisma schema. Exact-origin metadata
is an index into candidate items, not a unique key: several accounts can share
one origin. No card input is persisted until Save is explicitly selected.

### 9.1 Built-in encryption

The existing `SecretCipher` defaults to `PlaintextSecretCipher`; calling it is
not evidence of encryption. Add a built-in authenticated-encryption provider,
with a persistent high-entropy deployment key supplied by a secret/file outside
the database. Never derive this key from a public identifier or silently create
an ephemeral key at every startup. All CP replicas use the same key configuration.

Bind ciphertext to organization and item identity using authenticated context,
and use a versioned envelope/key ID so rotation and backups are manageable.
Use an established AEAD construction such as AES-256-GCM with fresh nonces;
crypto details and keyring configuration are implementation design work.
Keep HashiCorp Vault Transit available through the shared encryption seam.

Vault writes fail when only the plaintext cipher is configured. Temporary filling
still works. Key loss means loss of decryption: deployment instructions require
backing up/restoring keys separately and testing rotation. Built-in encryption
does not inherit Transit per-organization crypto-shredding automatically; its
organization deletion and backup semantics must be stated accurately.

Secret management and organization lifecycle routes follow existing
`interactiveOnly` conventions. Internal credential-use routes authenticate the
specific service/Computer operation rather than exposing generic plaintext reads.
Non-secret UI display/editing is authorized; secret fields are replace-only in
the first release. Never echo a stored password into an edit form.

## 10. Availability and compatibility

Temporary fills require the relay/desktop data path and live existing Computer
credentials. CP outage does not become a new content-path dependency; grants,
leases and existing authority lifetimes still apply. Do not promise that a new
lease or a new turn can start while CP is unavailable.

Vault lookup/save requires CP and its encryption backend. On failure, offer
manual Fill-card input; do not imply "no matching account" when lookup failed.
Personal-owner consent requires a reachable authorized surface. No response
never becomes approval. Stop/cancel/expiry settles the card without values.

Negotiate extension, desktop, daemon and CP capabilities before use. Shipping the
extension with the image does not eliminate skew: persistent browsers, rolling
upgrades and old runtimes exist. The extension's hello reports a build ID
compiled into the service-worker script, not only `manifest.version`, because
Chromium can keep running cached worker code across a restart. Do not rely on
in-place extension updates in a persistent profile (§8.2); a mismatched build is
unsupported until the browser is restarted with a fresh install. Unsupported
versions fail clearly. There is no fallback that types secret values blindly
through coordinates or the active OS focus.

The running daemon reports `form fill browsers` in doctor and in its heartbeat:
which desktops' browsers are connected, and which were refused for another build,
whose agents are then told to restart the browser instead of "not connected". A
restarted Computer's extension reconnects to the new daemon and fills again on the
kept profile (image suite). Pending Fill cards live only in the agent daemon's
memory: after its restart an answer finds no card, and nothing typed is replayed.
A login card says that the browser stays signed in for later users of the Computer.

## 11. Delivery plan and acceptance

| Stage | Deliverable                                          | Completion evidence                                                                                                                                                       |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Linux container extension and internal fill contract | Real Chromium: descriptors without values, correct tab/frame/origin binding, controlled input events, masked password fill, fill-only behavior and no automatic replay.   |
| S2    | Fill cards without persistence                       | Webchat inline and Slack console link; mixed form inputs bypass model/transcript/observation/logs; cancellation and target changes work; CP receives no temporary values. |
| S3    | Encryption and Vault persistence                     | Built-in/Transit providers; plaintext writes refused; personal/org CRUD isolation, replace-only secret edits, grants, save destination and key rotation/restore checks.   |
| S4    | Authorized Vault fill                                | Exact origins, account selection, requester proof, owner consent, org automatic use, multi-step Google-style login and status-only results.                               |
| S5    | Personal info and mixed-form composition             | Standard field mapping, Login plus Personal info, missing-field cards, explicit save/update and separate fill/save outcomes.                                              |
| S6    | Linux desktop distribution and TOTP                  | Real deb/rpm Chrome/Chromium installation, extension health checks, generated-OTP flow, lifecycle/skew coverage and operator documentation.                               |

S2 and S3 can proceed after S1 fixes the operation/field contract. S4 depends on
S2/S3; S5 completes the general mixed-form experience. TOTP is a later increment;
phone prompts, SMS and passkeys require human takeover or an explicit additional
flow. Password capture from arbitrary browser activity and third-party password
manager integrations are future work, not implicit stage acceptance.

Use fake credentials and controlled fixture pages for tests. The principal
regression oracle is a recognizable canary value appearing in the website input
while absent from harness/ACP traffic, model tool input/output, transcript,
observation, card settlement, logs and CP temporary-input requests. Test ordinary
Fill-card values as well as passwords. Actual Google login is optional exploratory
validation and cannot be a deterministic CI acceptance gate.

## 12. Implementation questions to settle

These are engineering proposals or unfinished details, not missing product approval:

- Transport, profile attribution, permissions, endpoint authentication and
  policy packaging are implemented for the container image (§8). Still open: why
  forced-install updates did not apply in place, which per-build IDs avoid.
- Define fill/consent timeouts and bounded in-memory lifetimes using existing
  turn cancellation and credential expiry; never resurrect secret input after restart.
- Define the trusted requester/use authorization on CP credential operations and
  privacy-preserving discovery of another owner's explicitly referenced item.
- Specify built-in key provisioning, envelope scope, rotation and deletion
  behavior without claiming Transit-only crypto-shredding properties.

## 13. References

- [Computer resource, data plane, approvals and leases](computer-use.md)
- [MCP elicitation and why answers return through the harness](mcp-elicitation.md)
- [Shared secret cipher](secret-store-seams.md)
- [Per-org Transit encryption and crypto-shredding](per-org-secret-encryption.md)
- [Organization variables/secrets and agent assignments](organization-secrets-and-variables.md)
- [Slack approval routing](slack-approval-dm.md)
- [High availability and authority lifetimes](high-availability.md)
- [1Password Agentic Autofill architecture](https://www.1password.dev/agentic-autofill/partners/how-it-works.md)
- [1Password security model and fill-window limits](https://www.1password.dev/agentic-autofill/partners/security.md)
- [Chrome alternative extension distribution](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)

The external references are prior art. This design does not depend on access to
1Password's partner API or reuse its implementation guarantees.

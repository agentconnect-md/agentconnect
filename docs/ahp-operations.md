# Operating the AHP rollout

AHP adds an authenticated interface to the existing daemon session core. Legacy
Webchat remains available. The [design and diagram](designs/ahp-adoption.md)
describe ownership; this page records deployment controls and release checks.
Enabling the endpoint does not establish compatibility with every AHP client.
The [official SDK CLI example](../packages/daemon/examples/README.md) connects
through the public relay using a personal-key header and no private client SDK.
Clients that cannot set headers, including the official SDK's WebSocket
transport, authenticate in-band with the standard `authenticate` command.

## Controls and admission

| Owner                | Control                         | Default                         | Effect                                                                                     |
| -------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| Control Plane        | `AHP_MODE=off\|shadow\|on`      | `off`                           | Only `on` permits AHP authorization and bootstrap.                                         |
| Every relay replica  | `AHP_MODE=off\|shadow\|on`      | `off`                           | Only `on` accepts `/ahp/agents/:agentId` upgrades.                                         |
| Daemon configuration | `features.ahp.mode`             | `off`                           | `off`: no AHP serving; `shadow`: observation only; `on`: serving alongside legacy.         |
| Control Plane        | `WEBCHAT_PROTOCOL=legacy\|ahp`  | `legacy`                        | Default for new first-party attachments, exposed as `webchatProtocol` in runtime config.   |
| Control Plane        | `AHP_PUBLIC_ACCESS=true\|false` | `false`                         | Admits eligible full personal keys outside the test-key allowlist; never anonymous access. |
| Control Plane        | `AHP_TEST_KEY_IDS`              | empty                           | Comma-separated API-key row IDs for the canary audience; never secret key values.          |
| Control Plane        | `PUBLIC_RELAY_URL`              | unset                           | Public relay origin used for bootstrap; use HTTPS/WSS in deployment.                       |
| Every relay replica  | `AHP_AUTHORIZATION_SERVER`      | unset                           | OAuth issuer advertised beside the endpoint for discovery; tokens are not accepted yet.    |
| Each agent           | AHP API entry                   | absent                          | Explicitly permits this protocol for the agent.                                            |
| Serving daemon       | `api-ahp-v1` capability         | absent unless wired and enabled | Independently checked during admission and placement resolution.                           |
| Serving daemon       | `api-ahp-handshake-v1`          | advertised with `api-ahp-v1`    | Required for in-band `authenticate`; header and browser-token attachments do not need it.  |

The daemon switch belongs in `config.json` under `AGENTCONNECT_ROOT` (normally
`~/.agentconnect`). It is not a daemon `AHP_MODE` environment override:

```json
{
  "features": {
    "ahp": { "mode": "on" }
  }
}
```

A daemon started with `--ahp-mode off|shadow|on` uses that value instead of the
file's. Kubernetes pool members, which write their own config file, take it from
the chart value `daemonPool.ahpMode`. Merge that property into the existing file. Apply startup configuration through
normal service deployment/restart; do not assume live file watching or automatic
cross-service synchronization. An older daemon cannot gain a serving host by
setting a flag. Check the actual capability after registration and reconnection.

CP `WEBCHAT_PROTOCOL=ahp` requires `AHP_MODE=on`; invalid combinations fail at
startup. The design's logical `features.webchat.protocol` maps to that CP
environment variable. The runtime-config `ahp.enabled` and `ahp.publicAccess`
fields disclose only availability, never key IDs or credentials.

Public-key admission and the browser default are independent. Third-party
canaries can use AHP while Webchat remains legacy. Every participant of an AHP
browser roster needs an AHP API entry and a READY, capable serving daemon.
Bootstrap refuses unavailable rosters; it does not send the same action through
another protocol. Membership, resource audience and continuation policy still apply.

## Startup and a restricted canary

1. Back up the CP database and daemon data-plane store. Apply CP migrations with
   the deployment's configured database environment:

   ```sh
   pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy
   ```

   The schema adds AHP URI bindings and the API protocol enum value. Daemon local
   store migrations run when the store opens. Preserve data across restarts so
   sequence reservations, checkpoints and admission receipts remain durable.

2. Deploy the updated services with AHP off and Webchat on legacy. Preserve
   existing daemon/relay authentication, routing and TLS. Verify the legacy flow.
3. Optionally enable daemon `shadow`, leaving public admission off. Shadow must
   not accept client actions or create another runtime owner.
4. Enable daemon serving mode, wait for `api-ahp-v1`, add the canary agent's AHP
   API entry, then enable CP and every serving relay. Keep public access false,
   Webchat legacy, and allow only the canary personal-key row IDs.
5. Exercise the endpoint and failure cases. Change the first-party default only
   after its gates pass; widen public-key access separately after release review.

The initial native profile accepts full personal user keys. Read-only,
`agent:chat`, OAuth, daemon and relay credentials do not obtain it. A full key
still obeys its holder's organization, role, agent audience and session policy.

## Endpoint and credentials

The endpoint is `wss://<relay-origin>/ahp/agents/<agent-uuid>`. It carries standard
AHP JSON-RPC text, without public `rd/*` envelopes. Keep any deployment routing
prefix consistent with bootstrap and proxy rewrites. Query strings are rejected.

Native clients that can set upgrade headers send:

```http
Authorization: Bearer <personal-user-api-key>
Sec-WebSocket-Protocol: ahp
```

Clients that cannot set headers connect with no credential and authenticate
in-band, whether or not they offer `Sec-WebSocket-Protocol: ahp` (ahpc and VS
Code offer none; `ahp` is selected and echoed when offered). The relay admits
that upgrade into a pre-authentication state it answers itself; nothing reaches
a daemon until the key is verified:

1. `initialize` returns protocol `1.0.0`, `serverSeq: 0` and, when the client
   subscribes to `ahp-root://`, a placeholder agent whose `protectedResources`
   names `https://<dialed-host>/ahp/agents/<agent-uuid>` with `required: true`.
   When the relay sets `AHP_AUTHORIZATION_SERVER`, the entry also lists that
   issuer in `authorization_servers` with its `mcp:read`/`mcp:write` scopes.
   Other initial subscriptions are dropped as unauthorized.
2. `authenticate` with that `resource` and a full personal API key as `token`
   is verified through the same `rc/verify(ahp-client-key)` rules as the header.
   Success returns `{}`; the daemon then adopts the client and replaces the
   placeholder with a `root/agentsChanged` action. Grant renewal and expiry
   match the header path, rechecking the pushed key.
3. `reconnect` before `initialize` returns `NotFound` (`-32008`), so resuming
   clients such as VS Code fall back to `initialize` on the same socket. `ping`
   returns `{}`. Any other request returns `AuthRequired` (`-32007`) with the
   protected resource and keeps the socket; notifications are ignored. A bad key
   returns `-32007` and closes with 4401; an unadvertised resource returns
   `-32602` and closes with 1008. One attempt per socket.
4. The pre-authentication window closes with 4401 after 30 seconds and with 1008
   after 16 messages. Each relay holds at most 64 such sockets. Requests sent
   after `authenticate` wait for its verdict and are forwarded only on success.

The relay's own `initialize` answer omits the daemon's `_meta` extension flags;
first-party clients use the header or browser-token paths.

Each agent advertises one model, its configured model or `default`, because VS
Code disables sending when an agent offers none. A turn message may carry the
client's `model` and `agent` selections and any spec attachment kind, as VS
Code's do. The daemon runs the agent's own model, so it ignores both selections
and delivers only one PNG, JPEG or WebP embedded image;
other attachments are accepted, never read, and left out of the projected turn.
Clients may also set the chat's `draft` and `isRead`; the daemon publishes both to
the session's subscribers and never forwards them to the runtime.

When a runtime reports a file change as ACP `diff` content, the completed tool
call carries a `fileEdit` result whose before and after snapshots use
`session-db:` content URIs, which VS Code reads without a stat request. The daemon
answers `resourceRead` only for those URIs: it authorizes the URI's session like a
subscription, then reads the text from that tool call's transcript body, so
snapshots survive daemon restarts and never pass through the CP. A snapshot
larger than one AHP message is refused rather than truncated. Other
`resource*` methods and the workspace file system are not served.

Set `AHP_AUTHORIZATION_SERVER` to the `issuer` the CP serves at
`/.well-known/oauth-authorization-server` (the `PUBLIC_MCP_URL` origin when set,
otherwise `PUBLIC_CP_URL`). VS Code's Agents window can then resolve an auth
provider for the endpoint, but it still cannot authenticate: `authenticate`
accepts only full personal API keys, and accepting OAuth access tokens for AHP is
separate, security-reviewed work.

With [ahpc](https://www.npmjs.com/package/@softov/ahpc), export the key in
`AHPC_TOKEN_<RESOURCE>` (the resource with its scheme removed and every other
non-alphanumeric run replaced by `_`, uppercased) or pipe it to
`ahpc --host <endpoint> auth <resource>`; never pass it with `--token`, which
exposes it in process listings.

First-party browser clients obtain a short-lived, conversation-bound token from
the existing CP mint routes with `protocol: "ahp"`. The signed claim must permit
AHP; a legacy token, including an old token without this claim, cannot switch
protocol by changing the URL. An AHP token likewise cannot enter the legacy route.
Browsers offer two WebSocket subprotocol values:

```text
ahp
agentconnect.ahp-token.<base64url-of-token-utf8>
```

Only the static `ahp` value is selected and echoed. Base64url is encoding, not
encryption. Redact `Authorization` and `Sec-WebSocket-Protocol` at proxies and
observability collectors. Never put keys, tokens or grants in URLs, logs,
screenshots or example arguments. Third-party browser products should keep
long-lived personal keys on a trusted backend.

Bootstrap returns the selected protocol and per-agent endpoint/session metadata.
An attachment pins its adapter across reconnects and requests the same protocol
when refreshing a token. A legacy pin remains valid when the new-attachment
default changes. Detach before changing adapters, retain the durable conversation
identity, and reconstruct state through the selected protocol. Do not transfer
stream cursors or automatically resend an uncertain action across protocols.

## Failure, state and recovery

- **Revocation and CP outage:** grants last at most 60 seconds, capped by source
  credential expiry. Renewal starts five seconds before expiry and rechecks
  credential validity, membership, visibility, API entry, placement and capability.
  A separate deadline closes the attachment even if renewal hangs. Revocation
  takes effect within the remaining grant lifetime, at most 60 seconds. Discovery
  and creation may fail sooner; no expired grant or new registry fact is invented.
- **Either-hop loss:** losing the daemon carrier closes the public attachment.
  Replacement transports have a unique connection scope; old asynchronous work
  cannot send through or clean up the replacement. Reconnect checks current placement.
- **Execution lifetime:** detach, overload, expiry and rollback remove an
  attachment, not admitted execution. Cancellation is a separate authorized
  action. Reconcile uncertain submissions against durable admission before retrying.
- **Carrier bounds:** one message is at most 64 KiB UTF-8, with an additional
  escaped-carrier bound. Relay and daemon carrier attachment counts are capped at
  256 per server/owning connection. The daemon permits at most 32 pending frames
  and 256 KiB per attachment, with a 1 MiB aggregate queue. Socket data buffering
  is bounded at 1 MiB; the daemon reserves 64 KiB for control output. If even a
  close cannot fit, it closes the carrier hop explicitly.
- **State and history:** snapshots and replay are derived data-plane state, not
  CP content. The action journal retains at most 256 actions / 1 MiB; older
  cursors require fresh snapshots. Completed native turns are archived before
  retention removes them. The retained chat targets 32 KiB, keeping at least
  one completed turn; this target does not truncate an indivisible turn or the
  active turn. A response exceeding the 64 KiB wire limit fails explicitly.
  Durable archive pages contain at most 64 turns / 32 KiB. Standard `fetchTurns`
  emits `chat/turnsLoaded` so clients can expand their history; the host keeps
  its bounded current tail and original history cursor. Reconnect returns that
  tail, allowing a client to page again. A single archived turn larger than the
  page budget fails explicitly instead of being silently clipped.
- **Legacy history:** scoped transcript reads default to 30 records, cap requests
  at 100, and bound each emitted page to 32 KiB. Each record is a masked preview
  of at most 4 KiB text, with an ellipsis when clipped. Imports identify their
  historical origin and unknown original execution outcome. The protocol's
  completed import state does not assert that the original execution succeeded;
  imports cannot become actionable old approvals or invent original turn boundaries.
- **Catalog and permissions:** native discovery exposes the current conversation
  participant slot. Retired outward IDs are not resumable current native slots.
  Authorized platform/hook history retains its scoped identity. Every registry
  read checks the current audience, and an alias does not make its creator the
  session owner. Approval/input/cancel/configuration retain existing policy and
  pending-request ownership checks.
- **Approval parity caveat:** when `callerApproves=false`, an ordinary caller's
  standard `ChatToolCallConfirmed` (`chat/toolCallConfirmed`) with `approved: true`
  is rejected. The host does not emit an accepted confirmation; the AHP UI keeps
  the pending card and displays the caller's rejection notice. Legacy's “request
  editor approval” escalation has no negotiated AHP counterpart yet. Authorized
  editors can settle actual approvals through the existing policy and pending
  request owner. Keep explicit legacy attachments available for the escalation
  workflow; do not claim complete approval parity or silently switch adapters.
- **Optional Apps:** the presentation helper permits at most 16 cards and 16 KiB
  encoded metadata, including pending HTML; only complete HTML reaches clients.
  Settled cards may be evicted. RPC results remain private. These individual
  bounds do not by themselves prove a combined snapshot fits 64 KiB. Advertise
  optional extensions only after production wiring and combined-response tests;
  core third-party conversation must work without first-party extensions.

Before upgrade, HTTP 401 means authorization failed and 503 means unavailable.
A malformed `Authorization` header is refused with 401.
After upgrade, authorization expiry/revocation closes with 4401; overload or
service loss uses 1013. Surface failures and reattach through normal authenticated
bootstrap; do not reinterpret an AHP socket as legacy.

## Rollback

1. Apply CP `WEBCHAT_PROTOCOL=legacy` first. New attachments choose legacy;
   existing AHP attachments remain pinned until detached.
2. Stop widening public access. Set `AHP_PUBLIC_ACCESS=false` and remove canary
   key IDs when withdrawing that audience. Disable CP and relay AHP admission
   when shutting down the service. Shutdown closes attachments; CP policy also
   prevents renewal. There is no automatic cross-protocol fallback.
3. Disable daemon serving through its normal graceful lifecycle. AHP detach
   does not cancel work; restarting a daemon follows its usual execution recovery.
4. Retain bindings, outward IDs, transcripts, checkpoints and admission receipts.
   Do not undo migrations to flip a flag. Older binaries may not understand the
   AHP enum or newer store schema; binary downgrade needs a separate compatibility
   check. Prefer flag rollback on upgraded binaries.

Changing the browser default alone does not disable public AHP. Disabling AHP
must preserve pinned legacy reconnects and existing legacy endpoints.

## Verification and release gates

Record the tested SDK, deployment and client versions. Official SDK fixtures are
protocol regression evidence, not independently maintained product-client acceptance.
Before public access, verify the control matrix, mixed daemon versions, all roster
participants, rollback during a turn, credential revocation, CP outages, grant
expiry, wrong-organization/guessed-session refusal, and both-hop overload recovery.

Exercise discovery/create/attach, streaming, allowed approval/input, cancellation,
replay and snapshot fallback, durable paging, stale-writer fencing, and restart or
placement recovery. Two authorized clients observing the same session must not
create duplicate execution. Large history and active-turn tests must demonstrate
bounded memory and explicit overflow behavior, distinguishing marked previews from
complete native turns.
Approval regression coverage must distinguish an authorized editor's actual
settlement from a refused ordinary caller's attempt: the latter retains the
pending card and shows a private rejection notice without an optimistic confirmed
echo. Legacy escalation remains a separate parity requirement.

**Independent-client gate: pending.** No completed VS Code validation is recorded
here. Test a real independently maintained client without an AgentConnect reducer
or plugin, publish its version and required capabilities, and keep public access
restricted until that release decision is supported. The minimal official SDK
example has a regression fixture crossing the real relay endpoint and daemon
protocol host with fixture authorization and execution. A deployment run with a
real personal key and runtime remains a separate acceptance step; this fixture
does not establish independent-client compatibility.

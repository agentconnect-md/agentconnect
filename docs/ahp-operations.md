# Operating the AHP rollout

AHP adds an authenticated interface to the existing daemon session core. Legacy
Webchat remains available. The [design and diagram](designs/ahp-adoption.md)
describe ownership; this page records deployment controls and release checks.
Enabling the endpoint does not establish compatibility with every AHP client.
The [official SDK CLI example](../packages/daemon/examples/README.md) connects
through the public relay using a personal-key header and no private client SDK.

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
| Each agent           | AHP API entry                   | absent                          | Explicitly permits this protocol for the agent.                                            |
| Serving daemon       | `api-ahp-v1` capability         | absent unless wired and enabled | Independently checked during admission and placement resolution.                           |

The daemon switch belongs in `config.json` under `AGENTCONNECT_ROOT` (normally
`~/.agentconnect`). It is not a daemon `AHP_MODE` environment override:

```json
{
  "features": {
    "ahp": { "mode": "on" }
  }
}
```

Merge that property into the existing file. Apply startup configuration through
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

Native clients send:

```http
Authorization: Bearer <personal-user-api-key>
Sec-WebSocket-Protocol: ahp
```

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

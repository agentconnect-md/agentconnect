# Daemon API Key Authentication

**Status:** Implemented

**Owner:** AgentConnect team

Daemon-to-Control-Plane authentication uses a long-lived, database-backed,
revocable API key in the WebSocket `auth` frame. The same credential primitive
also supports personal, relay, and OAuth access tokens, while each principal
type remains confined to its intended trust boundary.

Companion references:

- [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) for the WebSocket
  handshake and close-code contract.
- [daemon-detailed-design.md](daemon-detailed-design.md) for daemon
  configuration and CLI behavior.
- [shared-bot-relay.md](shared-bot-relay.md) for relay authentication.
- [agent-assistant.md](agent-assistant.md) for OAuth access tokens.

---

## 1. Security properties

- The credential is an opaque bearer token and is sent only in the TLS-protected
  `auth` frame body. It is never placed in a URL query parameter.
- The Control Plane stores only
  `HMAC-SHA256(secret, API_KEY_PEPPER)`, never the plaintext secret.
- The required `API_KEY_PEPPER` is at least 32 characters and must be shared by
  every Control Plane replica.
- The plaintext key is returned exactly once when minted. Subsequent reads
  expose only metadata and a non-secret `displayTail`.
- Revocation and expiry are checked on every authentication attempt.
- A daemon key is bound to one daemon and one organization. A key for a user,
  relay, or OAuth principal cannot authenticate the daemon WebSocket.
- Successful daemon authentication advances the daemon's monotonic
  `sessionEpoch`; failed authentication does not.

Rotating `API_KEY_PEPPER` invalidates every stored hash. Safe pepper rotation
therefore requires a versioned-pepper migration; until that exists, treat the
configured pepper as immutable.

---

## 2. Key format and storage

Minted keys use this opaque form:

```text
<secret><crc>
```

- `secret` is 43 base62 characters generated from 32 bytes of CSPRNG entropy.
- `crc` is a six-character base62 encoding of CRC32 over `secret`.
- The checksum is only an offline typo guard; it is not an authentication
  primitive.
- The token contains no principal type, key id, organization, or other
  identifying prefix.

Documentation, tests, logs, and examples must use a placeholder such as
`<generated-key>`, not a key-shaped sample.

The codec validates the base62 shape and checksum before querying storage. It
then computes the peppered HMAC and performs a unique indexed lookup by `hash`.
A fast keyed hash is appropriate because the input is high-entropy random data;
a password hash would add handshake cost without improving resistance to
guessing.

The persisted `ApiKey` row contains:

- `principalType`: `daemon`, `user`, `relay`, or `oauth`.
- Optional bindings for `orgId`, `daemonId`, `userId`, and `oauthGrantId`.
- `hash`, `displayTail`, optional `name`, scopes, and audit attribution.
- Creation, last-use, expiry, and revocation timestamps.

`ApiKey.daemonId` has a cascading foreign key to `Daemon`, so deleting a daemon
also removes its credentials. Relay keys are infrastructure principals and are
not organization-bound. The schema in
`packages/control-plane/prisma/schema.prisma` is authoritative.

---

## 3. Daemon authentication

The daemon sends:

```json
{
  "v": 1,
  "id": "<uuid>",
  "ts": "<RFC3339 timestamp>",
  "type": "auth",
  "payload": {
    "apiKey": "<generated-key>",
    "agentVersion": "<version>"
  }
}
```

`daemonId`, `machineId`, attestation, and resume information are optional
handshake fields governed by the protocol schema. When `daemonId` is present,
it must match the daemon bound to the key.

The Control Plane authenticates in this order:

1. Parse and checksum-validate the key without a database call.
2. Look up the row by the peppered HMAC.
3. Reject a missing, revoked, expired, unbound, organization-less, or
   non-`daemon` row.
4. Reject an echoed `daemonId` that does not match the bound daemon.
5. Advance `sessionEpoch`, record the authenticating key id as `tokenFp`, and
   return `auth/ok`.
6. Best-effort update `lastUsedAt`.

Credential failures close the socket with `4401 AUTH_FAILED`. Storage or epoch
update failures close it with `1011 SERVER_INTERNAL`, allowing the daemon to
back off and retry a transient failure. Authentication failures do not mutate
the daemon epoch.

`auth/ok` returns the authoritative `daemonId`, the new `sessionEpoch`,
heartbeat configuration, server time, and optional console-link metadata. A
daemon adopts the returned identity.

---

## 4. Provisioning and daemon lifecycle

Provisioning creates the parent daemon row before its first key so the foreign
key is valid:

1. Create a UUID daemon in `provisioned` state with `sessionEpoch = 0`.
2. Mint a `daemon` key bound to that daemon and organization.
3. Persist only the key hash and metadata with `expiresAt = null`.
4. Return `{ daemonId, apiKey, displayTail, command }`, where `apiKey` appears
   only in this response.

The generated command uses:

```text
npx -y @agentconnect.md/daemon run --api-url <control-plane-websocket-url> --api-key <generated-key>
```

The daemon stores the key in `controlPlane.key`; `--api-key` is the connect
override. `AuthReq.apiKey` is the only daemon credential field.

Daemon keys currently have no fixed expiry or idle reaper. They remain valid
until one of these events:

- an operator revokes the key;
- the bound daemon is deleted, which cascades to its keys; or
- a future explicit expiry is set on the row.

The Control Plane does not emit a `key-reaped` state. Any UI handling of that
string is defensive compatibility behavior, not an active lifecycle.

---

## 5. Rotation, listing, and revocation

Daemon-key management inherits the visibility and edit permissions of the
parent daemon:

| Endpoint                          | Behavior                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `GET /daemons/:id/keys`           | Lists key metadata without plaintext or hashes.                             |
| `POST /daemons/:id/keys`          | Mints an additional key for the same daemon and returns the plaintext once. |
| `DELETE /daemons/:id/keys/:keyId` | Revokes a key owned by that daemon.                                         |

Multiple active keys per daemon are allowed for overlap rotation:

1. Mint a new key.
2. update the daemon configuration and reconnect.
3. Confirm the new credential is in use.
4. Revoke the old key.

Minting or revoking a key does not directly change `sessionEpoch`; the next
successful authentication advances it through the normal handshake path.

Revocation prevents the next authentication attempt immediately. The revoke
route also tells relays to drop the revoked daemon's relay reach. An
already-established direct daemon-to-Control-Plane WebSocket is not currently
closed by the revoke route, so urgent live-session termination also requires
the applicable drain or connection-control operation.

Audit events record the actor, daemon id, key row id, display tail, and reason.
They never include the plaintext key or stored hash.

---

## 6. Personal, relay, and OAuth keys

The principal type is stored only in the database row. The opaque token format
is shared, but authentication services enforce strict separation.

### Personal keys

`GET`, `POST`, and `DELETE /me/keys` let a user list, mint, and revoke their own
organization-bound keys.

- A key acts as its bound user in its bound organization.
- The default expiry is 90 days; callers may request a non-expiring key.
- A request authenticated by a personal key cannot mint another personal key.
- Human authentication resolves the key to `userId`, `orgId`, and scopes, then
  normal authorization applies.
- A personal key cannot authenticate the daemon WebSocket.

### Relay keys

Relay keys use `principalType = relay`, have no organization or daemon binding,
and authenticate only relay control paths. Daemon and human authentication
reject them.

### OAuth access tokens

OAuth access tokens use `principalType = oauth`, are bound to a user,
organization, scopes, and an OAuth grant, and have a finite expiry. Revoking an
OAuth grant revokes its access-token rows.

---

## 7. Scope attestation remains separate

The daemon API key authenticates the long-lived control channel. `machineId`
and scope attestation are separate protocol fields for narrowly scoped derived
authorization.

The root API key must not be passed to data-plane workers or resource servers.
Any future scope-attestation flow must exchange it at the Control Plane for a
short-lived, audience-bound capability.

---

## 8. Validation requirements

Tests should cover:

- mint/parse round trips and checksum rejection;
- valid authentication and monotonic epoch advancement;
- malformed, unknown, revoked, expired, wrong-principal, unbound, and
  wrong-daemon keys returning `4401` without an epoch write;
- storage and epoch failures returning `1011`;
- overlap rotation without epoch reset;
- one-time plaintext responses and metadata-only list responses;
- daemon-key ownership and organization isolation;
- personal-key organization binding, expiry, and self-propagation prevention;
- deletion of a daemon cascading to its key rows.

Secret-bearing fields and command-line arguments must be structurally redacted
at logging and tracing boundaries because the token deliberately has no
recognizable prefix.
